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
  const home = resolveStateHomeFromConfig(openclawConfigPath);
  const sessionPath = path.join(home, "agents", cleanAgentId, "sessions", `${cleanSessionId}.jsonl`);
  if (!fs.existsSync(sessionPath)) {
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
  const home = resolveStateHomeFromConfig(openclawConfigPath);
  const samples: SessionPressureSample[] = [];
  for (const agentId of discoverAgentIds(openclawConfigPath)) {
    const sessionsRoot = path.join(home, "agents", agentId, "sessions");
    if (!fs.existsSync(sessionsRoot)) continue;
    for (const file of fs.readdirSync(sessionsRoot)) {
      if (!file.endsWith(".jsonl")) continue;
      /* reset / deleted 归档为只读历史，不计入上下文压力（与 jsonlSessions 语义对齐） */
      if (file.includes(".jsonl.reset.") || file.includes(".jsonl.deleted.")) continue;
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
