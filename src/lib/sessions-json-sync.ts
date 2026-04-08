/**
 * 日终精炼改写/删除 transcript 后，同步 OpenClaw agents/{agentId}/sessions/sessions.json
 * 中的 sessionFile，避免指向已删除或已合并的 jsonl。
 */

import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./fsx.js";
import { sessionTranscriptStem } from "./jsonlSessions.js";

const SESSIONS_STORE = "sessions.json";

export type RotationFileChange = {
  filePath: string;
  action: string;
  targetSessionFile?: string;
  [key: string]: unknown;
};

function normPath(p: string): string {
  try {
    return path.resolve(p);
  } catch {
    return p;
  }
}

function resolveStoredSessionFile(sessionsRoot: string, raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  return path.isAbsolute(t) ? normPath(t) : normPath(path.join(sessionsRoot, t));
}

function followRedirects(direct: Map<string, string>, start: string): string {
  let cur = normPath(start);
  const seen = new Set<string>();
  for (let i = 0; i < 64; i++) {
    const nxt = direct.get(cur);
    if (!nxt || nxt === cur) return cur;
    if (seen.has(cur)) return cur;
    seen.add(cur);
    cur = nxt;
  }
  return cur;
}

/**
 * @param changes — rotateDay 返回的 changes 数组（可多日合并 flatMap）
 * @param normalize — 单会话归并结果（mergedFrom → keeper 路径重定向）
 * @param forceCanonicalSessionFile — 若设置：将所有条目的 sessionFile 收敛到该绝对路径，并把 sessionId 对齐为文件名中的 UUID
 */
export function syncOpenClawSessionsJsonAfterRotation(opts: {
  sessionsRoot: string;
  changes: RotationFileChange[];
  normalize?: { keeperPath: string; mergedFrom: string[]; created: boolean };
  forceCanonicalSessionFile?: string;
}): { updated: number; sessionsJsonPath: string; touched: boolean } {
  const sessionsJsonPath = path.join(opts.sessionsRoot, SESSIONS_STORE);
  const canonical = opts.forceCanonicalSessionFile?.trim()
    ? normPath(opts.forceCanonicalSessionFile.trim())
    : null;

  const direct = new Map<string, string>();

  for (const c of opts.changes) {
    const fp = c?.filePath;
    if (typeof fp !== "string" || !fp.trim()) continue;

    if (
      c.action === "migrated_retained_to_latest_session" &&
      typeof c.targetSessionFile === "string" &&
      c.targetSessionFile.trim()
    ) {
      direct.set(normPath(fp), normPath(c.targetSessionFile));
      continue;
    }

    if (c.action === "deleted") {
      const stem = sessionTranscriptStem(fp);
      const fallback = path.join(opts.sessionsRoot, `${stem}.jsonl`);
      const from = normPath(fp);
      const to = normPath(fallback);
      /**
       * 仅改写 sessions.json 中的路径映射，不在磁盘上预建空 jsonl。
       * reset 归档等 → 规范名 `{stem}.jsonl`；若网关下次写入时尚不存在，由运行时创建。
       * 若删的就是 `stem.jsonl` 本身，则 from===to 不写映射，条目仍指向该路径直至网关再次写入。
       */
      if (from !== to) direct.set(from, to);
    }
  }

  if (opts.normalize?.mergedFrom?.length) {
    const keeper = normPath(opts.normalize.keeperPath);
    for (const src of opts.normalize.mergedFrom) {
      if (typeof src === "string" && src.trim()) {
        direct.set(normPath(src), keeper);
      }
    }
  }

  if (!fs.existsSync(sessionsJsonPath)) {
    return { updated: 0, sessionsJsonPath, touched: false };
  }

  if (direct.size === 0 && !canonical) {
    return { updated: 0, sessionsJsonPath, touched: false };
  }

  const store = readJson<Record<string, Record<string, unknown>>>(sessionsJsonPath, {});
  let updated = 0;

  for (const [, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== "object") continue;
    const sf = entry.sessionFile;
    if (typeof sf !== "string" || !sf.trim()) continue;
    const before = resolveStoredSessionFile(opts.sessionsRoot, sf);
    const resolved = followRedirects(direct, before);

    if (canonical && normPath(resolved) !== canonical) {
      entry.sessionFile = canonical;
      const newStem = sessionTranscriptStem(canonical);
      if (typeof entry.sessionId === "string" && entry.sessionId.trim()) {
        entry.sessionId = newStem;
      }
      if (typeof entry.updatedAt === "number") {
        entry.updatedAt = Date.now();
      }
      updated++;
      continue;
    }

    if (resolved !== before) {
      entry.sessionFile = resolved;
      const oldStem = sessionTranscriptStem(before);
      const newStem = sessionTranscriptStem(resolved);
      if (
        typeof entry.sessionId === "string" &&
        entry.sessionId.trim() === oldStem &&
        newStem &&
        newStem !== oldStem
      ) {
        entry.sessionId = newStem;
      }
      if (typeof entry.updatedAt === "number") {
        entry.updatedAt = Date.now();
      }
      updated++;
    }
  }

  if (updated > 0) {
    writeJson(sessionsJsonPath, store);
  }

  return { updated, sessionsJsonPath, touched: updated > 0 };
}
