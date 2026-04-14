import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import { ensureDir, toDateKey } from "./fsx";

function parseDateLike(input: unknown): Date | null {
  if (!input) return null;
  const d = new Date(input as string | number | Date);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseRecordTimestamp(rec: any): Date | null {
  const candidates: unknown[] = [
    rec?.message?.sentAt,
    rec?.message?.timestamp,
    rec?.message?.createdAt,
    rec?.sentAt,
    rec?.timestamp,
    rec?.createdAt,
  ];
  for (const c of candidates) {
    const d = parseDateLike(c);
    if (d) return d;
  }
  return null;
}

function fallbackDateKeyFromFile(filePath: string): string {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(path.basename(filePath));
  if (m?.[1]) return m[1];
  try {
    return toDateKey(new Date(fs.statSync(filePath).mtimeMs));
  } catch {
    return toDateKey(new Date());
  }
}

function resolveRecordDateKey(rec: any, fileFallbackDateKey: string): { dateKey: string; tsIso?: string } {
  const ts = parseRecordTimestamp(rec);
  if (ts) return { dateKey: toDateKey(ts), tsIso: ts.toISOString() };
  return { dateKey: fileFallbackDateKey };
}

/**
 * 活跃会话转录 `*.jsonl`，以及 OpenClaw 留档：
 * - `{sessionId}.jsonl.reset.{timestamp}`
 * - `{sessionId}.jsonl.deleted.{timestamp}`
 * （上述文件名通常不以单独的 `.jsonl` 结尾）。
 */
export function isSessionTranscriptFileName(fileName: string): boolean {
  if (!fileName || fileName === "sessions.json") return false;
  if (fileName.includes(".jsonl.reset.")) return true;
  if (fileName.includes(".jsonl.deleted.")) return true;
  return fileName.endsWith(".jsonl");
}

export function isOpenClawResetTranscriptFileName(fileName: string): boolean {
  return fileName.includes(".jsonl.reset.");
}

export function isOpenClawDeletedTranscriptFileName(fileName: string): boolean {
  return fileName.includes(".jsonl.deleted.");
}

/** reset / deleted 等非规范 `uuid.jsonl`，合并保留行时优先写入规范活跃 jsonl */
export function isOpenClawSessionArchiveTranscriptFileName(fileName: string): boolean {
  return isOpenClawResetTranscriptFileName(fileName) || isOpenClawDeletedTranscriptFileName(fileName);
}

/**
 * 与网关 session 对齐的 stem：`uuid.jsonl` → `uuid`；
 * reset / deleted 归档取文件名中 `uuid` 段。
 */
export function sessionTranscriptStem(filePath: string): string {
  const base = path.basename(filePath);
  if (base.includes(".jsonl.deleted.")) {
    return base.slice(0, base.indexOf(".jsonl.deleted."));
  }
  if (base.includes(".jsonl.reset.")) {
    return base.slice(0, base.indexOf(".jsonl.reset."));
  }
  return path.basename(filePath, ".jsonl");
}

export function listSessionFiles(sessionsRoot: string): string[] {
  if (!fs.existsSync(sessionsRoot)) return [];
  return fs
    .readdirSync(sessionsRoot)
    .filter((f) => isSessionTranscriptFileName(f))
    .map((f) => path.join(sessionsRoot, f));
}

export async function aggregateByDate(sessionsRoot: string, targetDateKey?: string) {
  const files = listSessionFiles(sessionsRoot);
  const buckets = new Map<string, { dateKey: string; messages: Array<{ role: string; text: string; ts: string }>; sourceSessionIds: Set<string>; sourceFiles: Set<string> }>();
  for (const filePath of files) {
    const fileDateFallback = fallbackDateKeyFromFile(filePath);
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const raw = line.trim();
      if (!raw) continue;
      let rec: any;
      try { rec = JSON.parse(raw); } catch { continue; }
      if (rec?.type !== "message") continue;
      const { dateKey, tsIso } = resolveRecordDateKey(rec, fileDateFallback);
      if (targetDateKey && dateKey !== targetDateKey) continue;
      const text = (Array.isArray(rec?.message?.content) ? rec.message.content : []).map((x: any) => x?.text || "").join("\n").trim();
      if (!text) continue;
      if (!buckets.has(dateKey)) buckets.set(dateKey, { dateKey, messages: [], sourceSessionIds: new Set(), sourceFiles: new Set() });
      const b = buckets.get(dateKey)!;
      b.messages.push({ role: rec?.message?.role || "", text, ts: tsIso || `${dateKey}T00:00:00.000Z` });
      b.sourceFiles.add(filePath);
      b.sourceSessionIds.add(sessionTranscriptStem(filePath));
    }
  }
  return Array.from(buckets.values()).map((b) => ({ ...b, sourceFiles: Array.from(b.sourceFiles), sourceSessionIds: Array.from(b.sourceSessionIds) }));
}

export async function rewriteRemoveDateFromFile(filePath: string, dateKey: string, archiveRoot: string) {
  const basename = path.basename(filePath);
  const archiveDir = path.join(archiveRoot, dateKey);
  ensureDir(archiveDir);
  const archived = path.join(archiveDir, basename);
  fs.copyFileSync(filePath, archived);
  const tmpPath = `${filePath}.rewrite.${Date.now()}.tmp`;
  const out = fs.createWriteStream(tmpPath, { encoding: "utf8" });
  let onlyTargetDate = true;
  let retained = 0;
  const fileDateFallback = fallbackDateKeyFromFile(filePath);
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const raw = line.trim();
    if (!raw) continue;
    let rec: any;
    try { rec = JSON.parse(raw); } catch { continue; }
    if (rec?.type !== "message") { out.write(`${raw}\n`); continue; }
    const recDate = resolveRecordDateKey(rec, fileDateFallback).dateKey;
    if (recDate !== dateKey) { onlyTargetDate = false; out.write(`${raw}\n`); retained++; }
  }
  out.end();
  await new Promise<void>((resolve) => out.on("finish", () => resolve()));
  return { tmpPath, archived, onlyTargetDate, retained };
}

export function stableMemoryId(parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("|"), "utf8").digest("hex").slice(0, 24);
}
