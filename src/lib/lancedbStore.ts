import fs from "node:fs";
import path from "node:path";
import type { MemoryEntry } from "../store.js";
import { ensureDir } from "./fsx";

function mapGovernorTypeToCategory(
  t: string,
): MemoryEntry["category"] {
  if (t === "preference") return "preference";
  if (t === "decision" || t === "constraint") return "decision";
  if (t === "fact") return "fact";
  if (t === "entity") return "entity";
  return "other";
}

function pseudoEmbedding(text: string, dimensions = 64): number[] {
  const arr = Array.from({ length: dimensions }, () => 0);
  for (let i = 0; i < text.length; i++) arr[i % dimensions] += text.charCodeAt(i) / 255;
  return arr.map((v) => Number((v / Math.max(1, text.length / dimensions)).toFixed(6)));
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

async function tryOpenLance(dbPath: string, tableName: string) {
  try {
    const lancedb = await import("@lancedb/lancedb");
    const db = await lancedb.connect(dbPath);
    let table: any;
    try { table = await db.openTable(tableName); } catch {
      table = await db.createTable(tableName, [{ id: "bootstrap", text: "bootstrap", vector: [0, 0, 0, 0], metadata: {} }]);
      await table.delete("id = 'bootstrap'");
    }
    return { mode: "lancedb" as const, table };
  } catch {
    return { mode: "fallback_jsonl" as const };
  }
}

export async function upsertMemories(cfg: { dbPath: string; tableName: string; embeddingDimensions: number }, rows: any[]) {
  const dbInfo = await tryOpenLance(cfg.dbPath, cfg.tableName);
  if (dbInfo.mode === "lancedb") {
    const table = dbInfo.table;
    let fieldNames: Set<string>;
    try {
      const schema = await table.schema();
      fieldNames = new Set(schema.fields.map((f: { name: string }) => f.name));
    } catch {
      fieldNames = new Set(["id", "text", "vector", "metadata"]);
    }

    const payload = rows.map((r) => {
      const agentId = typeof r.agentId === "string" ? r.agentId : "main";
      const metaObj = {
        governorNightly: true,
        governorType: r.type,
        date: r.date,
        agentId,
        sessionIds: r.sessionIds,
        sourceKind: r.sourceKind,
        agentOnlyDay: r.agentOnlyDay,
        tags: r.tags,
        createdAt: r.createdAt,
        category: mapGovernorTypeToCategory(String(r.type || "fact")),
        scope: `governor:${agentId}`,
        importance:
          typeof r.importance === "number" && Number.isFinite(r.importance)
            ? r.importance
            : 0.7,
        timestamp: Date.now(),
      };
      const base: Record<string, unknown> = {
        id: r.id,
        text: r.summary,
        vector: pseudoEmbedding(r.summary, cfg.embeddingDimensions),
      };
      if (fieldNames.has("category")) base.category = metaObj.category;
      if (fieldNames.has("scope")) base.scope = metaObj.scope;
      if (fieldNames.has("importance")) base.importance = metaObj.importance;
      if (fieldNames.has("timestamp")) base.timestamp = metaObj.timestamp;
      if (fieldNames.has("metadata")) {
        const encoded = JSON.stringify({
          ...metaObj,
          summary: r.summary,
          text: r.summary,
        });
        base.metadata = encoded;
      }
      return base;
    });
    await table.add(payload);
    return { mode: "lancedb", count: payload.length };
  }
  ensureDir(cfg.dbPath);
  const fallbackPath = path.join(cfg.dbPath, `${cfg.tableName}.jsonl`);
  fs.appendFileSync(fallbackPath, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  return { mode: "fallback_jsonl", count: rows.length, fallbackPath };
}

/** 按 id 从治理向量库删除记录（幂等；不存在的 id 忽略）。 */
export async function deleteMemoryIds(
  cfg: { dbPath: string; tableName: string; embeddingDimensions: number },
  ids: string[],
): Promise<{ mode: "lancedb" | "fallback_jsonl" | "noop"; deleted: number }> {
  const uniq = [...new Set(ids.map((x) => String(x).trim()).filter(Boolean))];
  if (!uniq.length) return { mode: "noop", deleted: 0 };

  const dbInfo = await tryOpenLance(cfg.dbPath, cfg.tableName);
  if (dbInfo.mode === "lancedb") {
    let deleted = 0;
    for (const id of uniq) {
      try {
        await dbInfo.table.delete(`id = '${escapeSqlLiteral(id)}'`);
        deleted++;
      } catch {
        /* 可能已无此行 */
      }
    }
    return { mode: "lancedb", deleted };
  }

  const fallbackPath = path.join(cfg.dbPath, `${cfg.tableName}.jsonl`);
  if (!fs.existsSync(fallbackPath)) return { mode: "fallback_jsonl", deleted: 0 };
  const raw = fs.readFileSync(fallbackPath, "utf8");
  const kept: string[] = [];
  let removed = 0;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let row: { id?: string };
    try {
      row = JSON.parse(t) as { id?: string };
    } catch {
      kept.push(t);
      continue;
    }
    if (row?.id && uniq.includes(row.id)) {
      removed++;
      continue;
    }
    kept.push(t);
  }
  if (removed > 0) {
    ensureDir(cfg.dbPath);
    fs.writeFileSync(fallbackPath, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
  }
  return { mode: "fallback_jsonl", deleted: removed };
}

function overlapScore(a: string, b: string): number {
  const sa = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const sb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  let hit = 0;
  for (const x of sa) if (sb.has(x)) hit++;
  return hit;
}

function parseMetadataLike(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* ignore invalid metadata json */
    }
  }
  return {};
}

function normalizeGovernorRow(raw: any): Record<string, unknown> {
  const meta = parseMetadataLike(raw?.metadata);
  const summary =
    (typeof meta.summary === "string" && meta.summary) ||
    (typeof meta.text === "string" && meta.text) ||
    (typeof raw?.text === "string" && raw.text) ||
    "";
  return {
    ...meta,
    id: raw?.id,
    summary,
    text: summary,
    type:
      (typeof meta.governorType === "string" && meta.governorType) ||
      (typeof meta.type === "string" && meta.type) ||
      "fact",
    date:
      (typeof meta.date === "string" && meta.date) ||
      "",
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    agentId:
      (typeof meta.agentId === "string" && meta.agentId) ||
      "main",
    scope:
      (typeof raw?.scope === "string" && raw.scope) ||
      (typeof meta.scope === "string" && meta.scope) ||
      "",
  };
}

function belongsToAgent(row: Record<string, unknown>, agentId: string): boolean {
  const rid = typeof row.agentId === "string" ? row.agentId : "";
  const scope = typeof row.scope === "string" ? row.scope : "";
  return rid === agentId || scope === `governor:${agentId}`;
}

export async function queryMemories(
  cfg: { dbPath: string; tableName: string; embeddingDimensions: number },
  queryText: string,
  topK = 3,
  agentId = "main",
) {
  const dbInfo = await tryOpenLance(cfg.dbPath, cfg.tableName);
  if (dbInfo.mode === "lancedb") {
    try {
      const vector = pseudoEmbedding(queryText, cfg.embeddingDimensions);
      const rs = await dbInfo.table.search(vector).limit(Math.max(topK * 8, 24)).toArray();
      const normalized = rs.map((r: unknown) => normalizeGovernorRow(r));
      return normalized
        .filter((r: Record<string, unknown>) => belongsToAgent(r, agentId))
        .slice(0, topK);
    } catch {
      // Some older or externally created governor tables may miss a compatible
      // vector column. Fall back to lexical ranking over table rows.
      const rows = await dbInfo.table.query().toArray();
      return rows
        .map((r: any) => normalizeGovernorRow(r))
        .filter((r: any) => belongsToAgent(r, agentId))
        .map((r: any) => ({ r, s: overlapScore(queryText, String(r.summary || "")) }))
        .sort((a: any, b: any) => b.s - a.s)
        .slice(0, topK)
        .map((x: any) => x.r);
    }
  }
  const file = path.join(cfg.dbPath, `${cfg.tableName}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const rows = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  return rows
    .map((r: any) => normalizeGovernorRow(r))
    .filter((r) => belongsToAgent(r, agentId))
    .map((r: any) => ({ r, s: overlapScore(queryText, String(r.summary || "")) }))
    .sort((a: any, b: any) => b.s - a.s)
    .slice(0, topK)
    .map((x: any) => x.r);
}

function tokenizeLoose(text: string): Set<string> {
  return new Set(
    String(text || "")
      .toLowerCase()
      .split(/[\s,.;:!?，。；：！？()\[\]{}<>"'`/\\|+-]+/g)
      .map((x) => x.trim())
      .filter((x) => x.length >= 2),
  );
}

function tokenOverlapCount(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

/**
 * Governance 严格检索：先做候选召回，再按词项重叠进行强过滤，避免全量会话记忆过度注入。
 */
export async function queryMemoriesStrict(
  cfg: { dbPath: string; tableName: string; embeddingDimensions: number },
  queryText: string,
  topK = 2,
  agentId = "main",
  minOverlapTokens = 2,
) {
  const widened = Math.max(topK * 6, 24);
  const rows = await queryMemories(cfg, queryText, widened, agentId);
  const qTokens = tokenizeLoose(queryText);
  if (!qTokens.size) return rows.slice(0, topK);
  return rows
    .map((r: Record<string, unknown>) => {
      const s = String((r as any).summary || (r as any).text || "");
      const overlap = tokenOverlapCount(qTokens, tokenizeLoose(s));
      return { r, overlap };
    })
    .filter((x: { r: Record<string, unknown>; overlap: number }) => x.overlap >= minOverlapTokens)
    .sort(
      (a: { r: Record<string, unknown>; overlap: number }, b: { r: Record<string, unknown>; overlap: number }) =>
        b.overlap - a.overlap,
    )
    .slice(0, topK)
    .map((x: { r: Record<string, unknown>; overlap: number }) => x.r);
}

