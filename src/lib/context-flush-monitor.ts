import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readJson } from "./fsx.js";

export interface ContextFlushConfig {
  enabled?: boolean;
  singleThresholdPercent?: number;
  preemptMarginPercent?: number;
  pollIntervalMs?: number;
  minFlushIntervalMs?: number;
  contextWindowTokens?: number;
  query?: string;
  autoResume?: boolean;
  autoResumeTimeoutSec?: number;
  autoResumePrompt?: string;
}

export interface SessionPressureSample {
  agentId: string;
  sessionId: string;
  percent: number;
  approxTokens: number;
}

export interface SessionRuntimeContextSample {
  sessionId: string;
  sessionKey?: string;
  channelId?: string;
  userText?: string;
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function resolveOpenClawHomeForMonitor(): string {
  return path.resolve(process.env.OPENCLAW_HOME?.trim() || path.join(os.homedir(), ".openclaw"));
}

function resolveStateHomeFromConfig(openclawConfigPath?: string): string {
  if (typeof openclawConfigPath === "string" && openclawConfigPath.trim()) {
    return path.resolve(path.dirname(openclawConfigPath));
  }
  return resolveOpenClawHomeForMonitor();
}

function uniqueStrings(list: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of list) {
    const v = (x || "").trim();
    if (!v) continue;
    const key = path.normalize(v);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function candidateStateHomes(openclawConfigPath?: string): string[] {
  const homes: string[] = [];
  const fromCfg = resolveStateHomeFromConfig(openclawConfigPath);
  homes.push(fromCfg);
  const fromEnvHome = process.env.OPENCLAW_HOME?.trim();
  if (fromEnvHome) homes.push(path.resolve(fromEnvHome));
  const fromEnvCfg = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (fromEnvCfg) homes.push(path.resolve(path.dirname(fromEnvCfg)));
  // In service-mode, cwd is often the real OPENCLAW_HOME.
  try {
    homes.push(process.cwd());
  } catch {
    // ignore
  }
  homes.push(resolveOpenClawHomeForMonitor());
  return uniqueStrings(homes);
}

function listSessionJsonlFiles(home: string, agentId: string): string[] {
  const sessionsRoot = path.join(home, "agents", agentId, "sessions");
  if (!fs.existsSync(sessionsRoot)) return [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(sessionsRoot);
  } catch {
    return [];
  }
  return names
    .filter((f) => f.endsWith(".jsonl"))
    .filter((f) => !f.includes(".jsonl.reset.") && !f.includes(".jsonl.deleted."));
}

function hasSessionsIndex(home: string, agentId: string): boolean {
  const p = path.join(home, "agents", agentId, "sessions", "sessions.json");
  return fs.existsSync(p);
}

function resolveSessionPathMultiHome(
  agentId: string,
  sessionId: string,
  openclawConfigPath?: string,
): string | undefined {
  const cleanAgentId = agentId.trim() || "main";
  const cleanSessionId = sessionId.trim();
  if (!cleanSessionId) return undefined;
  for (const home of candidateStateHomes(openclawConfigPath)) {
    const p = path.join(home, "agents", cleanAgentId, "sessions", `${cleanSessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function discoverAgentIds(openclawConfigPath: string): string[] {
  const cfg = readJson<Record<string, unknown>>(openclawConfigPath, {});
  const list = (cfg.agents as { list?: Array<{ id?: string }> } | undefined)?.list;
  if (!Array.isArray(list) || list.length === 0) return ["main"];
  const ids = list
    .map((x) => (typeof x?.id === "string" ? x.id.trim() : ""))
    .filter((x) => x.length > 0);
  return ids.length > 0 ? ids : ["main"];
}

function estimateTokensFromChars(text: string): number {
  const cjkChars = (text.match(/[\u3400-\u9FFF]/g) || []).length;
  const asciiChars = Math.max(0, text.length - cjkChars);
  return Math.ceil(asciiChars / 4 + cjkChars / 1.8);
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      parts.push((item as { text: string }).text);
    }
  }
  return parts.join("\n").trim();
}

export function collectSessionRuntimeContext(
  agentId: string,
  sessionId: string,
  openclawConfigPath?: string,
): SessionRuntimeContextSample {
  const cleanAgentId = agentId.trim() || "main";
  const cleanSessionId = sessionId.trim();
  if (!cleanSessionId) return { sessionId: "" };
  const sessionPath = resolveSessionPathMultiHome(cleanAgentId, cleanSessionId, openclawConfigPath);
  if (!sessionPath) {
    return { sessionId: cleanSessionId };
  }
  try {
    const raw = fs.readFileSync(sessionPath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      let parsed: any = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed?.type !== "message") continue;
      if (parsed?.message?.role !== "user") continue;
      const text = contentToText(parsed?.message?.content);
      if (!text) continue;
      return {
        sessionId: cleanSessionId,
        sessionKey: `agent:${cleanAgentId}:${cleanSessionId}`,
        userText: text,
      };
    }
  } catch {
    return { sessionId: cleanSessionId };
  }
  return {
    sessionId: cleanSessionId,
    sessionKey: `agent:${cleanAgentId}:${cleanSessionId}`,
  };
}

export function estimatePromptUsagePercent(
  prompt: string,
  contextWindowTokens: number,
): { percent: number; approxTokens: number } {
  const tokens = estimateTokensFromChars(prompt || "");
  const pct = clampPct((tokens / Math.max(1, contextWindowTokens)) * 100);
  return { percent: pct, approxTokens: tokens };
}

/**
 * 扫描全量 sessions：用 jsonl 文件体积近似上下文压力，避免频繁全量解析每行 JSON。
 * 这是保守估计，用于提前触发 flush 抢跑。
 */
export function collectAllSessionPressure(
  openclawConfigPath: string,
  contextWindowTokens: number,
): SessionPressureSample[] {
  const samples: SessionPressureSample[] = [];
  for (const agentId of discoverAgentIds(openclawConfigPath)) {
    // If openclawConfigPath resolves to a wrong home (env mismatch), scans can get stuck on
    // non-existent sessionIds. Pick the home that actually contains the most session files.
    const homes = candidateStateHomes(openclawConfigPath);
    let bestHome = homes[0];
    let bestCount = -1;
    for (const h of homes) {
      // Prefer homes that have a real sessions index for this agent.
      if (!hasSessionsIndex(h, agentId)) continue;
      const c = listSessionJsonlFiles(h, agentId).length;
      if (c > bestCount) {
        bestCount = c;
        bestHome = h;
      }
    }
    // Fallback: if none had sessions.json, fall back to max jsonl count.
    if (bestCount < 0) {
      for (const h of homes) {
        const c = listSessionJsonlFiles(h, agentId).length;
        if (c > bestCount) {
          bestCount = c;
          bestHome = h;
        }
      }
    }
    const files = listSessionJsonlFiles(bestHome, agentId);
    if (files.length === 0) continue;
    const sessionsRoot = path.join(bestHome, "agents", agentId, "sessions");
    for (const file of files) {
      const full = path.join(sessionsRoot, file);
      let bytes = 0;
      try {
        bytes = fs.statSync(full).size;
      } catch {
        continue;
      }
      const approxTokens = Math.ceil(bytes / 4);
      const percent = clampPct((approxTokens / Math.max(1, contextWindowTokens)) * 100);
      samples.push({
        agentId,
        sessionId: path.basename(file, ".jsonl"),
        percent,
        approxTokens,
      });
    }
  }
  return samples;
}
