/**
 * Agent Tool Definitions
 * Memory management tools for AI agents
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryRetriever, RetrievalResult } from "./retriever.js";
import type { RetrievalContext } from "./retriever.js";
import type { MemoryStore } from "./store.js";
import { isNoise } from "./noise-filter.js";
import { isSystemBypassId, resolveScopeFilter, parseAgentIdFromSessionKey, type MemoryScopeManager } from "./scopes.js";
import type { Embedder } from "./embedder.js";
import {
  appendRelation,
  buildSmartMetadata,
  deriveFactKey,
  parseSmartMetadata,
  stringifySmartMetadata,
} from "./smart-metadata.js";
import { TEMPORAL_VERSIONED_CATEGORIES } from "./memory-categories.js";
import {
  appendSelfImprovementEntry,
  appendSelfImprovementAuditLine,
  ensureSelfImprovementLearningFiles,
  SI_IMPLEMENTATION_AUDIT_FILE,
} from "./self-improvement-files.js";
import {
  findSelfImprovementRuleByHumanId,
  listSelfImprovementRules,
  summarizeSiRuleText,
} from "./self-improvement/lance-rules.js";
import { getDisplayCategoryTag } from "./reflection-metadata.js";
import type { RetrievalTrace } from "./retrieval-trace.js";
import {
  filterUserMdExclusiveRecallResults,
  isUserMdExclusiveMemory,
  type WorkspaceBoundaryConfig,
} from "./workspace-boundary.js";

// ============================================================================
// Types
// ============================================================================

export const MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "entity",
  "reflection",
  "other",
] as const;

function stringEnum<T extends readonly [string, ...string[]]>(values: T) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
  });
}
export type MdMirrorWriter = (
  entry: { text: string; category: string; scope: string; timestamp?: number },
  meta?: { source?: string; agentId?: string },
) => Promise<void>;

interface ToolContext {
  retriever: MemoryRetriever;
  store: MemoryStore;
  scopeManager: MemoryScopeManager;
  embedder: Embedder;
  agentId?: string;
  workspaceDir?: string;
  mdMirror?: MdMirrorWriter | null;
  workspaceBoundary?: WorkspaceBoundaryConfig;
  /** 与 openclaw.json governor.enabledAgents 白名单一致；未设置则不限制 */
  isAgentGovernorEnabled?: (agentId: string | undefined) => boolean;
}

type ResolvedToolContext = ToolContext & {
  agentId: string;
};

/** governor.enabledAgents 白名单拒绝时供 tool execute 直接返回 */
function rejectIfGovernorAgentDisabled(
  context: ToolContext,
  agentId: string,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} | null {
  const gate = context.isAgentGovernorEnabled;
  if (!gate) return null;
  if (gate(agentId)) return null;
  return {
    content: [
      {
        type: "text",
        text:
          `Memory 功能未对该 agent（${agentId}）启用：请在 openclaw.json 的 memory 插件 config.governor.enabledAgents 中加入该 id。`,
      },
    ],
    details: { error: "governor_agent_not_enabled", agentId },
  };
}

function resolveAgentId(runtimeAgentId: unknown, fallback?: string): string | undefined {
  if (typeof runtimeAgentId === "string" && runtimeAgentId.trim().length > 0) return runtimeAgentId;
  if (typeof fallback === "string" && fallback.trim().length > 0) return fallback;
  return undefined;
}

// ============================================================================
// Utility Functions
// ============================================================================

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clamp01(value: number, fallback = 0.7): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function normalizeInlineText(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, Math.max(1, maxChars - 1)).trimEnd();
  return `${clipped}…`;
}

function isLikelyExactRecallQuery(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length < 8) return false;
  if (/\s/.test(trimmed)) return false;
  return /[_:-]/.test(trimmed) || /\d/.test(trimmed);
}

function matchesExactRecallQuery(entry: { id: string; text: string; metadata?: string }, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return false;
  if (entry.id.toLowerCase().startsWith(needle)) return true;
  if (entry.text.toLowerCase().includes(needle)) return true;
  const meta = parseSmartMetadata(entry.metadata, entry as any);
  return (
    meta.l0_abstract.toLowerCase().includes(needle) ||
    meta.l1_overview.toLowerCase().includes(needle) ||
    meta.l2_content.toLowerCase().includes(needle)
  );
}

function normalizeLiteralRecallText(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^\s*(?:undefined|null)\b(?:\s+(?:undefined|null)\b)*/i, " ")
    .replace(/^\s*@[\w.-]+\s+/, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

type RecallAnchorKind =
  | "id"
  | "exact"
  | "substring"
  | "reverse-substring"
  | "anchor"
  | "token-overlap";

type RecallAnchorScore = {
  score: number;
  kind: RecallAnchorKind;
  matchedAnchors: string[];
  queryAnchors: string[];
  missingQueryAnchors: string[];
};

type AnchorableMemoryEntry = {
  id: string;
  text: string;
  metadata?: string;
  timestamp?: number;
  category?: string;
};

type ResolveMemoryIdResult =
  | { ok: true; id: string }
  | { ok: false; message: string; details?: Record<string, unknown> };

function isResolveMemoryIdFailure(
  result: ResolveMemoryIdResult,
): result is Extract<ResolveMemoryIdResult, { ok: false }> {
  return result.ok === false;
}

function extractComparableAnchors(value: string): string[] {
  const raw = String(value || "").normalize("NFKC");
  const normalized = normalizeLiteralRecallText(value);
  if (!normalized) return [];

  const anchors = new Map<string, number>();
  const add = (raw: string | undefined) => {
    const anchor = normalizeLiteralRecallText(raw || "")
      .replace(/^[#"'`]+|[#"'`.,;:!?，。；：！？]+$/g, "")
      .trim();
    if (anchor.length < 2) return;
    anchors.set(anchor, Math.max(anchors.get(anchor) ?? 0, anchor.length));
  };

  for (const match of normalized.matchAll(/\b[a-z][a-z0-9_-]{1,31}:[a-z0-9][a-z0-9_.-]{1,63}\b/g)) {
    add(match[0]);
  }
  for (const match of normalized.matchAll(/\b(?:utc|gmt)[+-]\d{1,2}(?::?\d{2})?\b/g)) {
    add(match[0]);
  }
  for (const match of normalized.matchAll(/\b[a-z]+(?:-[a-z0-9]+)+\b/g)) {
    add(match[0]);
  }
  for (const match of normalized.matchAll(/\b[a-z][a-z0-9_.-]*\d[a-z0-9_.-]*\b/g)) {
    add(match[0]);
  }
  for (const match of normalized.matchAll(/[\p{Script=Han}A-Za-z]{2,20}-[A-Za-z0-9]{1,20}/gu)) {
    add(match[0]);
  }
  for (const match of normalized.matchAll(/\b\d{2,4}-\d{1,2}-\d{1,2}\b/g)) {
    add(match[0]);
  }
  for (const match of normalized.matchAll(/\b\d+(?:\.\d+){1,3}\b/g)) {
    add(match[0]);
  }
  for (const match of raw.matchAll(/\b[A-Z][a-z]{2,24}\b/g)) {
    const token = match[0].toLowerCase();
    if (![
      "Remember", "Please", "Plan", "What", "When", "Random", "Avoid",
      "Never", "Expose", "Hidden", "Final", "The", "This", "That",
      "Current", "Launch", "Codename", "Owner",
    ].map((x) => x.toLowerCase()).includes(token)) {
      add(match[0]);
    }
  }

  const naturalPatterns: RegExp[] = [
    /(?:负责人|归属人|owner)\s*(?:is|是|为|:|：)?\s*([\p{Script=Han}A-Za-z0-9_.-]{2,40})/giu,
    /([\p{Script=Han}A-Za-z0-9_.-]{2,40})\s*(?:负责|owner)/giu,
    /(?:项目代号|代号|codename|launch codename)\s*(?:is|是|为|:|：)?\s*([\p{Script=Han}A-Za-z0-9_.-]{2,40})/giu,
    /(?:窗口|时间|部署窗口|timezone|时区)\s*(?:is|是|为|在|:|：)?\s*([\p{Script=Han}A-Za-z0-9_\/+:-]{2,40})/giu,
    /(周[一二三四五六日天](?:上午|下午|晚上|早上)?|下周[一二三四五六日天](?:上午|下午|晚上|早上)?|月底前|晚上九点|上午|下午|晚上)/giu,
    /(上线复盘|发布计划|风险评估|协作总结|客服培训|数据迁移|渠道上线|灰度|迁移计划|风险清单|推进表|排期)/giu,
    /(先列风险|先列证据|先列负责人|先列时间线|先列依赖|先列阻塞项|先给结论|先给下一步|risk-first|concise|structured)/giu,
  ];
  for (const pattern of naturalPatterns) {
    for (const match of raw.matchAll(pattern)) {
      add(match[1] || match[0]);
    }
  }

  const values = [...anchors.keys()]
    .filter((anchor) => {
      // If a more specific extracted anchor already contains this one, keep
      // only the specific form. This is what prevents amber-river from
      // satisfying a query for amber-river-49mcr.
      return ![...anchors.keys()].some((other) =>
        other !== anchor &&
        other.length > anchor.length &&
        (other.includes(anchor) || other.startsWith(`${anchor}-`) || other.startsWith(`${anchor}:`)),
      );
    });
  return values.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function metadataComparableAnchors(meta: ReturnType<typeof parseSmartMetadata>): string[] {
  const raw = meta.recall_anchors;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string")
    .map(normalizeLiteralRecallText)
    .filter((x) => x.length >= 2);
}

function buildRecallAnchors(text: string, category?: string): string[] {
  const anchors = new Set<string>();
  for (const anchor of extractComparableAnchors(text)) anchors.add(anchor);

  const normalized = normalizeLiteralRecallText(text);
  if (category) {
    for (const anchor of [...anchors]) {
      anchors.add(`${category}:${anchor}`);
    }
  }

  const labelPatterns: RegExp[] = [
    /(?:项目代号|代号|codename|launch codename)\s*(?:is|是|为|:|：)?\s*([\p{Script=Han}A-Za-z0-9_.-]{2,40})/giu,
    /(?:owner|负责人|归属人)\s*(?:is|是|为|:|：)?\s*([\p{Script=Han}A-Za-z0-9_.-]{2,40})/giu,
    /(?:timezone|时区)\s*(?:is|是|为|:|：)?\s*([A-Za-z_\/+-]{2,40}(?:\d{1,2})?)/giu,
    /(?:ticket|issue|工单|编号)\s*(?:is|是|为|:|：)?\s*([A-Za-z]+-\d+|\d{3,})/giu,
  ];
  for (const pattern of labelPatterns) {
    for (const match of normalized.matchAll(pattern)) {
      const value = normalizeLiteralRecallText(match[1] || "");
      if (value.length >= 2) anchors.add(value);
    }
  }

  return [...anchors].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, 32);
}

function entryComparableTexts(entry: AnchorableMemoryEntry): string[] {
  const meta = parseSmartMetadata(entry.metadata, entry as any);
  const values = [
    entry.text,
    meta.l0_abstract,
    meta.l1_overview,
    meta.l2_content,
    ...metadataComparableAnchors(meta),
    typeof meta.fact_key === "string" ? meta.fact_key : "",
    typeof meta.canonical_id === "string" ? meta.canonical_id : "",
  ];
  return [...new Set(values.map(normalizeLiteralRecallText).filter(Boolean))];
}

function literalRecallAnalysis(entry: AnchorableMemoryEntry, query: string): RecallAnchorScore {
  const needle = normalizeLiteralRecallText(query);
  if (!needle) {
    return { score: 0, kind: "token-overlap", matchedAnchors: [], queryAnchors: [], missingQueryAnchors: [] };
  }
  if (entry.id.toLowerCase().startsWith(needle)) {
    return { score: 1, kind: "id", matchedAnchors: [needle], queryAnchors: [needle], missingQueryAnchors: [] };
  }

  const meta = parseSmartMetadata(entry.metadata, entry as any);
  const haystacks = entryComparableTexts(entry);

  for (const hay of haystacks) {
    if (hay === needle) {
      return { score: 1, kind: "exact", matchedAnchors: [], queryAnchors: [], missingQueryAnchors: [] };
    }
    if (hay.includes(needle)) {
      return {
        score: Math.min(0.99, 0.78 + needle.length * 0.002),
        kind: "substring",
        matchedAnchors: [],
        queryAnchors: [],
        missingQueryAnchors: [],
      };
    }
    if (needle.includes(hay) && hay.length >= 12) {
      return {
        score: Math.min(0.92, 0.72 + hay.length * 0.002),
        kind: "reverse-substring",
        matchedAnchors: [],
        queryAnchors: [],
        missingQueryAnchors: [],
      };
    }
  }

  const queryAnchors = extractComparableAnchors(query);
  if (queryAnchors.length > 0) {
    const entryAnchors = new Set([
      ...metadataComparableAnchors(meta),
      ...extractComparableAnchors(entry.text),
      ...extractComparableAnchors(meta.l0_abstract),
      ...extractComparableAnchors(meta.l1_overview),
      ...extractComparableAnchors(meta.l2_content),
      ...(typeof meta.fact_key === "string" ? extractComparableAnchors(meta.fact_key) : []),
      ...(typeof meta.canonical_id === "string" ? extractComparableAnchors(meta.canonical_id) : []),
    ]);
    const matched = queryAnchors.filter((anchor) => {
      if (entryAnchors.has(anchor)) return true;
      return haystacks.some((hay) => hay.includes(anchor));
    });
    if (matched.length > 0 && matched.length === queryAnchors.length) {
      const coverage = matched.length / queryAnchors.length;
      const longest = Math.max(...matched.map((x) => x.length));
      return {
        score: Math.min(0.995, 0.86 + coverage * 0.1 + Math.min(0.03, longest * 0.001)),
        kind: "anchor",
        matchedAnchors: matched,
        queryAnchors,
        missingQueryAnchors: queryAnchors.filter((anchor) => !matched.includes(anchor)),
      };
    }
    if (matched.length > 0) {
      return {
        score: Math.min(0.74, 0.4 + (matched.length / queryAnchors.length) * 0.3),
        kind: "token-overlap",
        matchedAnchors: matched,
        queryAnchors,
        missingQueryAnchors: queryAnchors.filter((anchor) => !matched.includes(anchor)),
      };
    }
  }

  const tokens = [...new Set(needle.split(/[\s,.;:!?，。；：！？()[\]{}<>"'`/\\|+-]+/g).filter((x) => x.length >= 2))];
  if (!tokens.length) {
    return { score: 0, kind: "token-overlap", matchedAnchors: [], queryAnchors: [], missingQueryAnchors: [] };
  }
  const bestOverlap = Math.max(
    0,
    ...haystacks.map((hay) => tokens.filter((token) => hay.includes(token)).length / tokens.length),
  );
  return {
    score: bestOverlap >= 0.75 ? bestOverlap * 0.72 : 0,
    kind: "token-overlap",
    matchedAnchors: [],
    queryAnchors: [],
    missingQueryAnchors: [],
  };
}

function literalRecallScore(entry: AnchorableMemoryEntry, query: string): number {
  return literalRecallAnalysis(entry, query).score;
}

function isStrongLiteralKind(kind: RecallAnchorKind): boolean {
  return kind === "id" || kind === "exact" || kind === "substring" || kind === "anchor";
}

function entryHasComparableAnchor(entry: AnchorableMemoryEntry, anchor: string): boolean {
  const needle = normalizeLiteralRecallText(anchor);
  if (!needle) return false;
  const meta = parseSmartMetadata(entry.metadata, entry as any);
  const anchors = new Set([
    ...metadataComparableAnchors(meta),
    ...extractComparableAnchors(entry.text),
    ...extractComparableAnchors(meta.l0_abstract),
    ...extractComparableAnchors(meta.l1_overview),
    ...extractComparableAnchors(meta.l2_content),
  ]);
  if (anchors.has(needle)) return true;
  return entryComparableTexts(entry).some((hay) => hay.includes(needle));
}

function ambiguityTokens(value: string): string[] {
  const stop = new Set([
    "what", "when", "current", "please", "create", "plan", "with", "the",
    "and", "for", "that", "this", "我的", "当前", "什么", "应该", "请问",
    "请", "一下", "怎么", "如何", "偏好", "规则",
  ]);
  return [...new Set(
    normalizeLiteralRecallText(value)
      .split(/[\s,.;:!?，。；：！？()[\]{}<>"'`/\\|+-]+/g)
      .filter((x) => x.length >= 2 && !stop.has(x)),
  )];
}

function sharedAnchorTokens(value: string): string[] {
  const keep = new Set([
    "上线复盘", "发布回答", "发布计划", "风险评估", "协作总结", "客服培训", "数据迁移",
    "渠道上线", "灰度", "迁移计划", "风险清单", "推进表", "排期",
    "rollout", "migration", "matrix", "checklist", "timeline", "risks",
    "blockers", "tradeoffs", "owner", "severity",
  ]);
  const normalized = normalizeLiteralRecallText(value);
  const anchors = [
    ...extractComparableAnchors(value).filter((anchor) => keep.has(anchor)),
    ...[...keep].filter((anchor) => normalized.includes(anchor)),
  ];
  const tokens = ambiguityTokens(value).filter((token) => keep.has(token));
  return [...new Set([...anchors, ...tokens])];
}

function distinguishingAnchorTokens(entry: AnchorableMemoryEntry): string[] {
  const meta = parseSmartMetadata(entry.metadata, entry as any);
  const all = extractComparableAnchors(
    `${entry.text}\n${meta.l0_abstract}\n${meta.l1_overview}\n${meta.l2_content}\n${metadataComparableAnchors(meta).join(" ")}`,
  );
  const shared = new Set(sharedAnchorTokens(entry.text));
  return all.filter((anchor) => !shared.has(anchor));
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const aa = new Set(a);
  const bb = new Set(b);
  let intersection = 0;
  for (const item of aa) if (bb.has(item)) intersection += 1;
  return intersection / Math.max(1, new Set([...aa, ...bb]).size);
}

function areRecallResultsSimilar(a: RetrievalResult, b: RetrievalResult): boolean {
  if (a.entry.category !== b.entry.category) return false;
  const aAnchors = extractComparableAnchors(a.entry.text);
  const bAnchors = extractComparableAnchors(b.entry.text);
  const sharedAnchors = aAnchors.filter((anchor) => bAnchors.includes(anchor));
  if (sharedAnchors.length > 0) return true;
  return jaccard(ambiguityTokens(a.entry.text), ambiguityTokens(b.entry.text)) >= 0.35;
}

function findAmbiguousSimilarRecall(
  query: string,
  results: RetrievalResult[],
): { candidates: RetrievalResult[]; queryAnchors: string[] } | null {
  if (results.length < 2) return null;
  const candidates = results.slice(0, Math.min(5, results.length));
  const queryShared = sharedAnchorTokens(query);
  if (queryShared.length > 0) {
    const topicMatched = candidates.filter((candidate) => {
      const candidateShared = sharedAnchorTokens(candidate.entry.text);
      return queryShared.some((anchor) => candidateShared.includes(anchor));
    });
    if (topicMatched.length >= 2) {
      const queryAnchors = extractComparableAnchors(query);
      const queryDistinguishers = queryAnchors.filter((anchor) => !queryShared.includes(anchor));
      const matchedDistinguishers = queryDistinguishers.filter((anchor) =>
        topicMatched.some((result) => entryHasComparableAnchor(result.entry, anchor)),
      );
      if (matchedDistinguishers.length === 0) {
        const distinctCandidateAnchors = new Set<string>();
        for (const result of topicMatched) {
          for (const anchor of distinguishingAnchorTokens(result.entry)) distinctCandidateAnchors.add(anchor);
        }
        if (distinctCandidateAnchors.size > 0) {
          return { candidates: topicMatched, queryAnchors };
        }
      }
    }
  }

  const similarToTop = candidates.filter((candidate, index) =>
    index === 0 || areRecallResultsSimilar(candidates[0], candidate),
  );
  if (similarToTop.length < 2) return null;

  const queryAnchors = extractComparableAnchors(query);
  if (queryAnchors.length === 0) {
    return { candidates: similarToTop, queryAnchors };
  }

  const distinguishingAnchors = queryAnchors.filter((anchor) => {
    const hitCount = similarToTop.filter((result) => entryHasComparableAnchor(result.entry, anchor)).length;
    return hitCount === 1;
  });

  if (distinguishingAnchors.length === 0) {
    return { candidates: similarToTop, queryAnchors };
  }

  const distinguishedHits = similarToTop.filter((result) =>
    distinguishingAnchors.some((anchor) => entryHasComparableAnchor(result.entry, anchor)),
  );
  if (distinguishedHits.length !== 1) {
    return { candidates: similarToTop, queryAnchors };
  }

  return null;
}

function resultWithLiteralAnalysis(
  result: RetrievalResult,
  query: string,
): RetrievalResult & { _literal?: RecallAnchorScore } {
  return { ...result, _literal: literalRecallAnalysis(result.entry, query) };
}

function compareLiteralAwareResults(
  a: RetrievalResult & { _literal?: RecallAnchorScore },
  b: RetrievalResult & { _literal?: RecallAnchorScore },
): number {
  const aLit = a._literal;
  const bLit = b._literal;
  const aStrong = aLit && aLit.score > 0 && isStrongLiteralKind(aLit.kind) ? 1 : 0;
  const bStrong = bLit && bLit.score > 0 && isStrongLiteralKind(bLit.kind) ? 1 : 0;
  if (aStrong !== bStrong) return bStrong - aStrong;
  const aLitScore = aLit?.score ?? 0;
  const bLitScore = bLit?.score ?? 0;
  if (Math.abs(aLitScore - bLitScore) > 0.000001) return bLitScore - aLitScore;
  return b.score - a.score || b.entry.timestamp - a.entry.timestamp;
}

function stripLiteralAnalysis(result: RetrievalResult & { _literal?: RecallAnchorScore }): RetrievalResult {
  const { _literal, ...clean } = result;
  return clean;
}

async function mergeLiteralRecallFallback(params: {
  store: MemoryStore;
  query: string;
  results: RetrievalResult[];
  limit: number;
  scopeFilter?: string[];
  category?: string;
  workspaceBoundary?: WorkspaceBoundaryConfig;
}): Promise<RetrievalResult[]> {
  const existing = new Set(params.results.map((r) => r.entry.id));
  const scanLimit = Math.max(500, params.limit * 100);
  const listed = await params.store.list(params.scopeFilter, params.category, scanLimit, 0);
  const literal = listed
    .filter((entry) => !existing.has(entry.id))
    .map((entry) => {
      const analysis = literalRecallAnalysis(entry, params.query);
      return { entry, score: analysis.score, analysis };
    })
    .filter((x) => x.score > 0 && x.analysis.kind !== "token-overlap")
    .sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp)
    .slice(0, params.limit)
    .map((x, index): RetrievalResult => ({
      entry: x.entry,
      score: x.score,
      sources: {
        bm25: { score: x.score, rank: index + 1 },
        fused: { score: x.score },
      },
    }));
  const ambiguousCandidates = findAmbiguousSimilarRecall(
    params.query,
    listed.map((entry): RetrievalResult => ({
      entry,
      score: literalRecallAnalysis(entry, params.query).score,
      sources: { bm25: { score: 0, rank: 0 }, fused: { score: 0 } },
    })),
  )?.candidates ?? [];

  const merged = [...ambiguousCandidates, ...literal, ...params.results]
    .map((result) => resultWithLiteralAnalysis(result, params.query))
    .sort(compareLiteralAwareResults)
    .map(stripLiteralAnalysis);
  const seen = new Set<string>();
  const deduped = merged.filter((result) => {
    if (seen.has(result.entry.id)) return false;
    seen.add(result.entry.id);
    return true;
  });
  return filterUserMdExclusiveRecallResults(deduped, params.workspaceBoundary).slice(0, params.limit);
}

function deriveManualMemoryLayer(category: string): "durable" | "working" {
  if (category === "preference" || category === "decision" || category === "fact") {
    return "durable";
  }
  return "working";
}

function sanitizeMemoryForSerialization(results: RetrievalResult[]) {
  return results.map((r) => ({
    id: r.entry.id,
    text: r.entry.text,
    category: getDisplayCategoryTag(r.entry),
    rawCategory: r.entry.category,
    scope: r.entry.scope,
    importance: r.entry.importance,
    score: r.score,
    sources: r.sources,
  }));
}

const _warnedMissingAgentId = new Set<string>();

/** @internal Exported for testing only — resets the missing-agent warning throttle. */
export function _resetWarnedMissingAgentIdState(): void {
  _warnedMissingAgentId.clear();
}

function resolveRuntimeAgentId(
  staticAgentId: string | undefined,
  runtimeCtx: unknown,
): string {
  if (!runtimeCtx || typeof runtimeCtx !== "object") {
    const fallback = staticAgentId?.trim();
    if (!fallback && !_warnedMissingAgentId.has("no-context")) {
      _warnedMissingAgentId.add("no-context");
      console.warn(
        "resolveRuntimeAgentId: no runtime context or static agentId, defaulting to 'main'. " +
        "Tool callers without explicit agentId will be scoped to agent:main + global + reflection:agent:main."
      );
    }
    return fallback || "main";
  }
  const ctx = runtimeCtx as Record<string, unknown>;
  const ctxAgentId = typeof ctx.agentId === "string" ? ctx.agentId : undefined;
  const ctxSessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : undefined;
  const resolved = ctxAgentId || parseAgentIdFromSessionKey(ctxSessionKey) || staticAgentId;
  const trimmed = resolved?.trim();
  if (!trimmed && !_warnedMissingAgentId.has("empty-resolved")) {
    _warnedMissingAgentId.add("empty-resolved");
    console.warn(
      "resolveRuntimeAgentId: resolved agentId is empty after trim, defaulting to 'main'."
    );
  }
  return trimmed ? trimmed : "main";
}

function resolveToolContext(
  base: ToolContext,
  runtimeCtx: unknown,
): ResolvedToolContext {
  return {
    ...base,
    agentId: resolveRuntimeAgentId(base.agentId, runtimeCtx),
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function retrieveWithRetry(
  retriever: MemoryRetriever,
  params: RetrievalContext,
): Promise<RetrievalResult[]> {
  let results = await retriever.retrieve(params);
  if (results.length === 0) {
    await sleep(75);
    results = await retriever.retrieve(params);
  }
  return results;
}

async function resolveMemoryId(
  context: ToolContext,
  memoryRef: string,
  scopeFilter: string[] | undefined,
): Promise<ResolveMemoryIdResult> {
  const trimmed = memoryRef.trim();
  if (!trimmed) {
    return {
      ok: false,
      message: "memoryId/query 不能为空。",
      details: { error: "empty_memory_ref" },
    };
  }

  const uuidLike = /^[0-9a-f]{8}(-[0-9a-f]{4}){0,4}/i.test(trimmed);
  if (uuidLike) {
    return { ok: true, id: trimmed };
  }

  const results = await retrieveWithRetry(context.retriever, {
    query: trimmed,
    limit: 5,
    scopeFilter,
  });
  if (results.length === 0) {
    return {
      ok: false,
      message: `No memory found matching "${trimmed}".`,
      details: { error: "not_found", query: trimmed },
    };
  }
  if (results.length === 1 || results[0].score > 0.85) {
    return { ok: true, id: results[0].entry.id };
  }

  const list = results
    .map(
      (r) =>
        `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}${r.entry.text.length > 60 ? "..." : ""}`,
    )
    .join("\n");
  return {
    ok: false,
    message: `Multiple matches. Specify memoryId:\n${list}`,
    details: {
      action: "candidates",
      candidates: sanitizeMemoryForSerialization(results),
    },
  };
}

function resolveWorkspaceDir(toolCtx: unknown, fallback?: string): string {
  const runtime = toolCtx as Record<string, unknown> | undefined;
  const runtimePath = typeof runtime?.workspaceDir === "string" ? runtime.workspaceDir.trim() : "";
  if (runtimePath) return runtimePath;
  if (fallback && fallback.trim()) return fallback;
  return join(homedir(), ".openclaw", "workspace");
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function registerSelfImprovementLogTool(api: OpenClawPluginApi, context: ToolContext) {
  api.registerTool(
    (toolCtx) => ({
      name: "self_improvement_log",
      label: "Self-Improvement Log",
      description:
        "Log structured learning/error rules into LanceDB (opencl_si_rule). Appends one audit line to .learnings/SI_IMPLEMENTATION_AUDIT.md only.",
      parameters: Type.Object({
        type: stringEnum(["learning", "error"]),
        summary: Type.String({ description: "One-line summary" }),
        details: Type.Optional(Type.String({ description: "Detailed context or error output" })),
        suggestedAction: Type.Optional(Type.String({ description: "Concrete action to prevent recurrence" })),
        category: Type.Optional(Type.String({ description: "learning category (correction/best_practice/knowledge_gap) when type=learning" })),
        area: Type.Optional(Type.String({ description: "frontend|backend|infra|tests|docs|config or custom area" })),
        priority: Type.Optional(Type.String({ description: "low|medium|high|critical" })),
      }),
      async execute(_toolCallId, params) {
        const {
          type,
          summary,
          details = "",
          suggestedAction = "",
          category = "best_practice",
          area = "config",
          priority = "medium",
        } = params as {
          type: "learning" | "error";
          summary: string;
          details?: string;
          suggestedAction?: string;
          category?: string;
          area?: string;
          priority?: string;
        };
        try {
          const workspaceDir = resolveWorkspaceDir(toolCtx, context.workspaceDir);
          const runtimeContext = resolveToolContext(context, toolCtx);
          const agentId = runtimeContext.agentId;
          const denied = rejectIfGovernorAgentDisabled(context, agentId);
          if (denied) return denied;
          const scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
          let scope = context.scopeManager.getDefaultScope(agentId);
          if (!context.scopeManager.isAccessible(scope, agentId)) {
            scope = "global";
          }

          const { id: entryId, memoryId, auditPath } = await appendSelfImprovementEntry({
            baseDir: workspaceDir,
            type,
            summary,
            details,
            suggestedAction,
            category,
            area,
            priority,
            source: "memory-lancedb-pro/self_improvement_log",
            lance: {
              store: context.store,
              embedder: context.embedder,
              scope,
              scopeFilter,
              agentId,
            },
          });

          return {
            content: [
              {
                type: "text",
                text:
                  `Logged ${type} rule ${entryId} → LanceDB memory ${memoryId}. Audit line: ${SI_IMPLEMENTATION_AUDIT_FILE}`,
              },
            ],
            details: { action: "logged", type, id: entryId, memoryId, auditPath },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Failed to log self-improvement entry: ${error instanceof Error ? error.message : String(error)}` }],
            details: { error: "self_improvement_log_failed", message: String(error) },
          };
        }
      },
    }),
    { name: "self_improvement_log" }
  );
}

export function registerSelfImprovementExtractSkillTool(api: OpenClawPluginApi, context: ToolContext) {
  api.registerTool(
    (toolCtx) => ({
      name: "self_improvement_extract_skill",
      label: "Extract Skill From Learning",
      description:
        "Create a new skill scaffold from a self-improvement rule (LanceDB first). Falls back to legacy .learnings markdown if missing.",
      parameters: Type.Object({
        learningId: Type.String({ description: "Learning ID like LRN-YYYYMMDD-001 or ERR-..." }),
        skillName: Type.String({ description: "Skill folder name, lowercase with hyphens" }),
        sourceFile: Type.Optional(stringEnum(["LEARNINGS.md", "ERRORS.md"])),
        outputDir: Type.Optional(Type.String({ description: "Relative output dir under workspace (default: skills)" })),
      }),
      async execute(_toolCallId, params) {
        const { learningId, skillName, sourceFile = "LEARNINGS.md", outputDir = "skills" } = params as {
          learningId: string;
          skillName: string;
          sourceFile?: "LEARNINGS.md" | "ERRORS.md";
          outputDir?: string;
        };
        try {
          if (!/^(LRN|ERR)-\d{8}-\d{3}$/.test(learningId)) {
            return {
              content: [{ type: "text", text: "Invalid learningId format. Use LRN-YYYYMMDD-001 / ERR-..." }],
              details: { error: "invalid_learning_id" },
            };
          }
          if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillName)) {
            return {
              content: [{ type: "text", text: "Invalid skillName. Use lowercase letters, numbers, and hyphens only." }],
              details: { error: "invalid_skill_name" },
            };
          }

          const workspaceDir = resolveWorkspaceDir(toolCtx, context.workspaceDir);
          await ensureSelfImprovementLearningFiles(workspaceDir);
          const runtimeContext = resolveToolContext(context, toolCtx);
          const agentId = runtimeContext.agentId;
          const deniedEx = rejectIfGovernorAgentDisabled(context, agentId);
          if (deniedEx) return deniedEx;
          const scopeFilter = resolveScopeFilter(context.scopeManager, agentId);

          const safeOutputDir = outputDir
            .replace(/\\/g, "/")
            .split("/")
            .filter((segment) => segment && segment !== "." && segment !== "..")
            .join("/");
          const relSkillBase = `${safeOutputDir || "skills"}/${skillName}`;

          let summary = "Summarize the source learning here.";
          let sourceLabel = `lancedb:${learningId}`;

          const lEntry = await findSelfImprovementRuleByHumanId(
            context.store,
            scopeFilter,
            learningId,
          );

          if (lEntry) {
            summary = summarizeSiRuleText(lEntry);
            await context.store.patchMetadata(
              lEntry.id,
              {
                si_implementation_status: "promoted_to_skill",
                si_skill_path: relSkillBase,
              },
              scopeFilter,
            );
            await appendSelfImprovementAuditLine(workspaceDir, {
              event: "PROMOTED_SKILL",
              humanId: learningId,
              memoryId: lEntry.id,
              kind: learningId.startsWith("ERR") ? "error" : "learning",
              siStatus: "promoted_to_skill",
              summary,
            });
          } else {
            const learningsPath = join(workspaceDir, ".learnings", sourceFile);
            const learningBody = await readFile(learningsPath, "utf-8");
            const escapedLearningId = escapeRegExp(learningId.trim());
            const entryRegex = new RegExp(`## \\[${escapedLearningId}\\][\\s\\S]*?(?=\\n## \\[|$)`, "m");
            const match = learningBody.match(entryRegex);
            if (!match) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Learning entry ${learningId} not found in LanceDB or .learnings/${sourceFile}`,
                  },
                ],
                details: { error: "learning_not_found", learningId, sourceFile },
              };
            }
            const summaryMatch = match[0].match(/### Summary\n([\s\S]*?)\n###/m);
            summary = (summaryMatch?.[1] ?? summary).trim();
            sourceLabel = `.learnings/${sourceFile}`;
            const promotedMarker = `**Status**: promoted_to_skill`;
            const skillPathMarker = `- Skill-Path: ${relSkillBase}`;
            let updatedEntry = match[0];
            updatedEntry = updatedEntry.includes("**Status**:")
              ? updatedEntry.replace(/\*\*Status\*\*:\s*.+/m, promotedMarker)
              : `${updatedEntry.trimEnd()}\n${promotedMarker}\n`;
            if (!updatedEntry.includes("Skill-Path:")) {
              updatedEntry = `${updatedEntry.trimEnd()}\n${skillPathMarker}\n`;
            }
            const updatedLearningBody = learningBody.replace(match[0], updatedEntry);
            await writeFile(learningsPath, updatedLearningBody, "utf-8");
          }

          const skillDir = join(workspaceDir, safeOutputDir || "skills", skillName);
          await mkdir(skillDir, { recursive: true });
          const skillPath = join(skillDir, "SKILL.md");
          const skillTitle = skillName
            .split("-")
            .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
            .join(" ");
          const skillContent = [
            "---",
            `name: ${skillName}`,
            `description: "Extracted from learning ${learningId}. Replace with a concise description."`,
            "---",
            "",
            `# ${skillTitle}`,
            "",
            "## Why",
            summary,
            "",
            "## When To Use",
            "- [TODO] Define trigger conditions",
            "",
            "## Steps",
            "1. [TODO] Add repeatable workflow steps",
            "2. [TODO] Add verification steps",
            "",
            "## Source Learning",
            `- Learning ID: ${learningId}`,
            `- Source: ${sourceLabel}`,
            "",
          ].join("\n");
          await writeFile(skillPath, skillContent, "utf-8");

          return {
            content: [
              {
                type: "text",
                text: `Extracted skill scaffold to ${relSkillBase}/SKILL.md and updated ${learningId} (${sourceLabel}).`,
              },
            ],
            details: {
              action: "skill_extracted",
              learningId,
              sourceFile: sourceLabel,
              skillPath: `${relSkillBase}/SKILL.md`,
            },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Failed to extract skill: ${error instanceof Error ? error.message : String(error)}` }],
            details: { error: "self_improvement_extract_skill_failed", message: String(error) },
          };
        }
      },
    }),
    { name: "self_improvement_extract_skill" }
  );
}

export function registerSelfImprovementReviewTool(api: OpenClawPluginApi, context: ToolContext) {
  api.registerTool(
    (toolCtx) => ({
      name: "self_improvement_review",
      label: "Self-Improvement Review",
      description:
        "Summarize self-improvement rules from LanceDB (opencl_si_rule). Mentions .learnings/SI_IMPLEMENTATION_AUDIT.md for human audit trail only.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const workspaceDir = resolveWorkspaceDir(toolCtx, context.workspaceDir);
          await ensureSelfImprovementLearningFiles(workspaceDir);
          const runtimeContext = resolveToolContext(context, toolCtx);
          const agentId = runtimeContext.agentId;
          const deniedRv = rejectIfGovernorAgentDisabled(context, agentId);
          if (deniedRv) return deniedRv;
          const scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
          const rules = await listSelfImprovementRules(context.store, scopeFilter, 5000);

          const stats = {
            total: rules.length,
            pending: 0,
            implemented: 0,
            wont_fix: 0,
            promoted: 0,
            high: 0,
          };

          for (const e of rules) {
            const m = parseSmartMetadata(e.metadata, e);
            const st = String(m.si_implementation_status || "pending").toLowerCase();
            if (st === "pending" || st === "in_progress") stats.pending++;
            else if (st === "implemented" || st === "resolved") stats.implemented++;
            else if (st === "wont_fix") stats.wont_fix++;
            else if (st === "promoted_to_skill" || st === "promoted") stats.promoted++;
            const pr = String(m.si_priority || "").toLowerCase();
            if (pr === "high" || pr === "critical") stats.high++;
          }

          let auditLines = 0;
          try {
            const audit = await readFile(
              join(workspaceDir, ".learnings", SI_IMPLEMENTATION_AUDIT_FILE),
              "utf-8",
            );
            auditLines = (audit.match(/\d{4}-\d{2}-\d{2}T/g) || []).length;
          } catch {
            auditLines = 0;
          }

          const text = [
            "Self-Improvement (LanceDB `opencl_si_rule`):",
            `- Total rules: ${stats.total}`,
            `- Pending / in progress: ${stats.pending}`,
            `- Implemented / resolved: ${stats.implemented}`,
            `- Won't fix: ${stats.wont_fix}`,
            `- Promoted to skill: ${stats.promoted}`,
            `- High/Critical priority: ${stats.high}`,
            "",
            `Human audit log (append-only): .learnings/${SI_IMPLEMENTATION_AUDIT_FILE} (~${auditLines} timestamped lines)`,
            "",
            "Use memory_recall / memory_list for details; mark progress with memory_update (metadata si_implementation_status).",
          ].join("\n");

          return {
            content: [{ type: "text", text }],
            details: { action: "review", stats, auditLineCount: auditLines },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Failed to review self-improvement backlog: ${error instanceof Error ? error.message : String(error)}` }],
            details: { error: "self_improvement_review_failed", message: String(error) },
          };
        }
      },
    }),
    { name: "self_improvement_review" }
  );
}

// ============================================================================
// Core Tools (Backward Compatible)
// ============================================================================

export function registerMemoryRecallTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
      name: "memory_recall",
      label: "Memory Recall",
      description:
        "Search through long-term memories using hybrid retrieval (vector + keyword search). Use when you need context about user preferences, past decisions, or previously discussed topics.",
      parameters: Type.Object({
        query: Type.String({
          description: "Search query for finding relevant memories",
        }),
        limit: Type.Optional(
          Type.Number({
            description: "Max results to return (default: 3, max: 20; summary mode soft max: 6)",
          }),
        ),
        includeFullText: Type.Optional(
          Type.Boolean({
            description: "Return full memory text when true (default: false returns summary previews)",
          }),
        ),
        maxCharsPerItem: Type.Optional(
          Type.Number({
            description: "Maximum characters per returned memory in summary mode (default: 180)",
          }),
        ),
        scope: Type.Optional(
          Type.String({
            description: "Specific memory scope to search in (optional)",
          }),
        ),
        category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
      }),
      async execute(_toolCallId, params) {
        const {
          query,
          limit = 3,
          includeFullText = false,
          maxCharsPerItem = 180,
          scope,
          category,
        } = params as {
          query: string;
          limit?: number;
          includeFullText?: boolean;
          maxCharsPerItem?: number;
          scope?: string;
          category?: string;
        };

        try {
          const safeLimit = includeFullText
            ? clampInt(limit, 1, 20)
            : clampInt(limit, 1, 6);
          const safeCharsPerItem = clampInt(maxCharsPerItem, 60, 1000);
          const agentId = runtimeContext.agentId;
          const deniedRecall = rejectIfGovernorAgentDisabled(context, agentId);
          if (deniedRecall) return deniedRecall;

          // Determine accessible scopes
          let scopeFilter = resolveScopeFilter(runtimeContext.scopeManager, agentId);
          if (scope) {
            if (runtimeContext.scopeManager.isAccessible(scope, agentId)) {
              scopeFilter = [scope];
            } else {
              return {
                content: [
                  { type: "text", text: `Access denied to scope: ${scope}` },
                ],
                details: {
                  error: "scope_access_denied",
                  requestedScope: scope,
                },
              };
            }
          }

          let results = filterUserMdExclusiveRecallResults(await retrieveWithRetry(runtimeContext.retriever, {
            query,
            limit: safeLimit,
            scopeFilter,
            category,
            source: "manual",
          }), runtimeContext.workspaceBoundary);

          // For exact-looking keys (UUID-ish / token-like), prefer literal matches
          // to avoid unrelated semantic neighbors masking "not found" states.
          if (isLikelyExactRecallQuery(query)) {
            results = results.filter((r) => matchesExactRecallQuery(r.entry, query));
          }

          // Generic literal fallback: vector-only retrieval can miss freshly
          // stored exact text when embeddings are noisy or the query is a long
          // mixed-language sentence. Manual recall should still be able to find
          // entries by exact/substring text or metadata without requiring users
          // to know the memory id.
          results = await mergeLiteralRecallFallback({
            store: runtimeContext.store,
            query,
            results,
            limit: safeLimit,
            scopeFilter,
            category,
            workspaceBoundary: runtimeContext.workspaceBoundary,
          });

          // Similar-memory guard: if the query contains concrete anchors
          // (codename, owner, ticket, timezone, version, etc.), exact anchor
          // hits must outrank broad semantic neighbors. This prevents queries
          // like "blue-raven owner" from returning "silver-fox owner" first
          // merely because both memories are semantically close.
          const queryAnchors = extractComparableAnchors(query);
          if (queryAnchors.length > 0) {
            const anchorRanked = results
              .map((result) => resultWithLiteralAnalysis(result, query))
              .sort(compareLiteralAwareResults);
            const strong = anchorRanked.filter((result) =>
              result._literal &&
              result._literal.score > 0 &&
              isStrongLiteralKind(result._literal.kind),
            );
            if (strong.length > 0) {
              const weak = anchorRanked.filter((result) => !strong.some((s) => s.entry.id === result.entry.id));
              results = [...strong, ...weak].slice(0, safeLimit).map(stripLiteralAnalysis);
            } else {
              results = anchorRanked.slice(0, safeLimit).map(stripLiteralAnalysis);
            }
          }

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0, query, scopes: scopeFilter },
            };
          }

          const ambiguity = findAmbiguousSimilarRecall(query, results);
          if (ambiguity) {
            const candidateSummaries = ambiguity.candidates.map((result, index) => {
              const meta = parseSmartMetadata(result.entry.metadata, result.entry);
              const anchors = extractComparableAnchors(
                `${result.entry.text}\n${meta.l0_abstract}\n${metadataComparableAnchors(meta).join(" ")}`,
              ).slice(0, 8);
              return `${index + 1}. [${result.entry.id}] ${truncateText(normalizeInlineText(meta.l0_abstract || result.entry.text), 140)}${anchors.length ? ` (区分点: ${anchors.join(", ")})` : ""}`;
            }).join("\n");
            return {
              content: [
                {
                  type: "text",
                  text:
                    "Found multiple similar memories; please add a distinguishing detail (for example owner, project/codename, time window, ticket, or exact preference) to avoid mixing them.\n\n" +
                    candidateSummaries,
                },
              ],
              details: {
                error: "ambiguous_similar_memories",
                count: ambiguity.candidates.length,
                query,
                queryAnchors: ambiguity.queryAnchors,
                memories: sanitizeMemoryForSerialization(ambiguity.candidates),
                scopes: scopeFilter,
              },
            };
          }

          const now = Date.now();
          await Promise.allSettled(
            results.map((result) => {
              const meta = parseSmartMetadata(result.entry.metadata, result.entry);
              return runtimeContext.store.patchMetadata(
                result.entry.id,
                {
                  access_count: meta.access_count + 1,
                  last_accessed_at: now,
                  last_confirmed_use_at: now,
                  bad_recall_count: 0,
                  suppressed_until_turn: 0,
                },
                scopeFilter,
              );
            }),
          );

          const text = results
            .map((r, i) => {
              const categoryTag = getDisplayCategoryTag(r.entry);
              const metadata = parseSmartMetadata(r.entry.metadata, r.entry);
              const base = includeFullText
                ? (metadata.l2_content || metadata.l1_overview || r.entry.text)
                : (metadata.l0_abstract || r.entry.text);
              const inline = normalizeInlineText(base);
              const rendered = includeFullText
                ? inline
                : truncateText(inline, safeCharsPerItem);
              return `${i + 1}. [${r.entry.id}] [${categoryTag}] ${rendered}`;
            })
            .join("\n");

          const serializedMemories = sanitizeMemoryForSerialization(results);
          if (includeFullText) {
            for (let i = 0; i < results.length; i++) {
              const metadata = parseSmartMetadata(results[i].entry.metadata, results[i].entry);
              (serializedMemories[i] as Record<string, unknown>).fullText =
                metadata.l2_content || metadata.l1_overview || results[i].entry.text;
            }
          }

          return {
            content: [
              {
                type: "text",
                text: `Found ${results.length} memories:\n\n${text}`,
              },
            ],
            details: {
              count: results.length,
              memories: serializedMemories,
              query,
              scopes: scopeFilter,
              retrievalMode: runtimeContext.retriever.getConfig().mode,
            },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Memory recall failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { error: "recall_failed", message: String(error) },
          };
        }
      },
    };
    },
    { name: "memory_recall" },
  );
}

export function registerMemoryStoreTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
      name: "memory_store",
      label: "Memory Store",
      description:
        "Save important information in long-term memory. Use for preferences, facts, decisions, and other notable information.",
      parameters: Type.Object({
        text: Type.String({ description: "Information to remember" }),
        importance: Type.Optional(
          Type.Number({ description: "Importance score 0-1 (default: 0.7)" }),
        ),
        category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
        scope: Type.Optional(
          Type.String({
            description: "Memory scope (optional, defaults to agent scope)",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const {
          text,
          importance = 0.7,
          category = "other",
          scope,
        } = params as {
          text: string;
          importance?: number;
          category?: string;
          scope?: string;
        };

        try {
          const agentId = runtimeContext.agentId;
          const deniedStore = rejectIfGovernorAgentDisabled(context, agentId);
          if (deniedStore) return deniedStore;
          // Determine target scope
          let targetScope = scope;
          if (!targetScope) {
            if (isSystemBypassId(agentId)) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Reserved bypass agent IDs must provide an explicit scope for memory_store writes.",
                  },
                ],
                details: {
                  error: "explicit_scope_required",
                  agentId,
                },
              };
            }
            targetScope = runtimeContext.scopeManager.getDefaultScope(agentId);
          }

          // Validate scope access
          if (!runtimeContext.scopeManager.isAccessible(targetScope, agentId)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Access denied to scope: ${targetScope}`,
                },
              ],
              details: {
                error: "scope_access_denied",
                requestedScope: targetScope,
              },
            };
          }

          // Reject noise before wasting an embedding API call
          if (isNoise(text)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Skipped: text detected as noise (greeting, boilerplate, or meta-question)`,
                },
              ],
              details: { action: "noise_filtered", text: text.slice(0, 60) },
            };
          }

          if (
            isUserMdExclusiveMemory(
              { text },
              runtimeContext.workspaceBoundary,
            )
          ) {
            return {
              content: [
                {
                  type: "text",
                  text: "Skipped: this fact belongs in USER.md, not plugin memory.",
                },
              ],
              details: {
                action: "skipped_by_workspace_boundary",
                boundary: "user_md_exclusive",
              },
            };
          }

          const safeImportance = clamp01(importance, 0.7);
          const vector = await runtimeContext.embedder.embedPassage(text);

          // Check for duplicates using raw vector similarity (bypasses importance/recency weighting)
          // Fail-open by design: dedup must never block a legitimate memory write.
          // excludeInactive: superseded historical records must not block new writes.
          let existing: Awaited<ReturnType<MemoryStore["vectorSearch"]>> = [];
          try {
            existing = await runtimeContext.store.vectorSearch(vector, 1, 0.1, [
              targetScope,
            ], { excludeInactive: true });
          } catch (err) {
            console.warn(
              `memory-lancedb-pro: duplicate pre-check failed, continue store: ${String(err)}`,
            );
          }

          if (existing.length > 0 && existing[0].score > 0.98) {
            return {
              content: [
                {
                  type: "text",
                  text: `Similar memory already exists: "${existing[0].entry.text}"`,
                },
              ],
              details: {
                action: "duplicate",
                existingId: existing[0].entry.id,
                existingText: existing[0].entry.text,
                existingScope: existing[0].entry.scope,
                similarity: existing[0].score,
              },
            };
          }

          const entry = await runtimeContext.store.store({
            text,
            vector,
            importance: safeImportance,
            category: category as any,
            scope: targetScope,
            metadata: stringifySmartMetadata(
              buildSmartMetadata(
                {
                  text,
                  category: category as any,
                  importance: safeImportance,
                },
                {
                  l0_abstract: text,
                  l1_overview: `- ${text}`,
                  l2_content: text,
                  recall_anchors: buildRecallAnchors(text, category as string),
                  source: "manual",
                  state: "confirmed",
                  memory_layer: deriveManualMemoryLayer(category as string),
                  last_confirmed_use_at: Date.now(),
                  bad_recall_count: 0,
                  suppressed_until_turn: 0,
                },
              ),
            ),
          });

          // Dual-write to Markdown mirror if enabled
          if (context.mdMirror) {
            await context.mdMirror(
              { text, category: category as string, scope: targetScope, timestamp: entry.timestamp },
              { source: "memory_store", agentId },
            );
          }

          return {
            content: [
              {
                type: "text",
                text: `Stored: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}" in scope '${targetScope}'`,
              },
            ],
            details: {
              action: "created",
              id: entry.id,
              scope: entry.scope,
              category: entry.category,
              importance: entry.importance,
            },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Memory storage failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { error: "store_failed", message: String(error) },
          };
        }
      },
    };
    },
    { name: "memory_store" },
  );
}

export function registerMemoryForgetTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_forget",
      label: "Memory Forget",
      description:
        "Delete specific memories. Supports both search-based and direct ID-based deletion.",
      parameters: Type.Object({
        query: Type.Optional(
          Type.String({ description: "Search query to find memory to delete" }),
        ),
        memoryId: Type.Optional(
          Type.String({ description: "Specific memory ID to delete" }),
        ),
        scope: Type.Optional(
          Type.String({
            description: "Scope to search/delete from (optional)",
          }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
        const { query, memoryId, scope } = params as {
          query?: string;
          memoryId?: string;
          scope?: string;
        };

        try {
          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx);
          const deniedForget = rejectIfGovernorAgentDisabled(context, agentId);
          if (deniedForget) return deniedForget;
          // Determine accessible scopes
          let scopeFilter = resolveScopeFilter(runtimeContext.scopeManager, agentId);
          if (scope) {
            if (runtimeContext.scopeManager.isAccessible(scope, agentId)) {
              scopeFilter = [scope];
            } else {
              return {
                content: [
                  { type: "text", text: `Access denied to scope: ${scope}` },
                ],
                details: {
                  error: "scope_access_denied",
                  requestedScope: scope,
                },
              };
            }
          }

          if (memoryId) {
            const deleted = await context.store.delete(memoryId, scopeFilter);
            if (deleted) {
              return {
                content: [
                  { type: "text", text: `Memory ${memoryId} forgotten.` },
                ],
                details: { action: "deleted", id: memoryId },
              };
            } else {
              return {
                content: [
                  {
                    type: "text",
                    text: `Memory ${memoryId} not found or access denied.`,
                  },
                ],
                details: { error: "not_found", id: memoryId },
              };
            }
          }

          if (query) {
            const results = await retrieveWithRetry(context.retriever, {
              query,
              limit: 5,
              scopeFilter,
            });

            if (results.length === 0) {
              return {
                content: [
                  { type: "text", text: "No matching memories found." },
                ],
                details: { found: 0, query },
              };
            }

            if (results.length === 1 && results[0].score > 0.9) {
              const deleted = await context.store.delete(
                results[0].entry.id,
                scopeFilter,
              );
              if (deleted) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Forgotten: "${results[0].entry.text}"`,
                    },
                  ],
                  details: { action: "deleted", id: results[0].entry.id },
                };
              }
            }

            const list = results
              .map(
                (r) =>
                  `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}${r.entry.text.length > 60 ? "..." : ""}`,
              )
              .join("\n");

            return {
              content: [
                {
                  type: "text",
                  text: `Found ${results.length} candidates. Specify memoryId to delete:\n${list}`,
                },
              ],
              details: {
                action: "candidates",
                candidates: sanitizeMemoryForSerialization(results),
              },
            };
          }

          return {
            content: [
              {
                type: "text",
                text: "Provide either 'query' to search for memories or 'memoryId' to delete specific memory.",
              },
            ],
            details: { error: "missing_param" },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Memory deletion failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { error: "delete_failed", message: String(error) },
          };
        }
      },
    };
    },
    { name: "memory_forget" },
  );
}

// ============================================================================
// Update Tool
// ============================================================================

export function registerMemoryUpdateTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_update",
      label: "Memory Update",
      description:
        "Update an existing memory. For preferences/entities, changing text creates a new version (supersede) to preserve history. Metadata-only changes (importance, category) update in-place.",
      parameters: Type.Object({
        memoryId: Type.String({
          description:
            "ID of the memory to update (full UUID or 8+ char prefix)",
        }),
        text: Type.Optional(
          Type.String({
            description: "New text content (triggers re-embedding)",
          }),
        ),
        importance: Type.Optional(
          Type.Number({ description: "New importance score 0-1" }),
        ),
        category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
        const { memoryId, text, importance, category } = params as {
          memoryId: string;
          text?: string;
          importance?: number;
          category?: string;
        };

        try {
          if (!text && importance === undefined && !category) {
            return {
              content: [
                {
                  type: "text",
                  text: "Nothing to update. Provide at least one of: text, importance, category.",
                },
              ],
              details: { error: "no_updates" },
            };
          }

          // Determine accessible scopes
          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx);
          const deniedUpd = rejectIfGovernorAgentDisabled(context, agentId);
          if (deniedUpd) return deniedUpd;
          const scopeFilter = resolveScopeFilter(runtimeContext.scopeManager, agentId);

          // Resolve memoryId: if it doesn't look like a UUID, try search
          let resolvedId = memoryId;
          const uuidLike = /^[0-9a-f]{8}(-[0-9a-f]{4}){0,4}/i.test(memoryId);
          if (!uuidLike) {
            // Treat as search query
            const results = await retrieveWithRetry(context.retriever, {
              query: memoryId,
              limit: 3,
              scopeFilter,
            });
            if (results.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `No memory found matching "${memoryId}".`,
                  },
                ],
                details: { error: "not_found", query: memoryId },
              };
            }
            if (results.length === 1 || results[0].score > 0.85) {
              resolvedId = results[0].entry.id;
            } else {
              const list = results
                .map(
                  (r) =>
                    `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}${r.entry.text.length > 60 ? "..." : ""}`,
                )
                .join("\n");
              return {
                content: [
                  {
                    type: "text",
                    text: `Multiple matches. Specify memoryId:\n${list}`,
                  },
                ],
                details: {
                  action: "candidates",
                  candidates: sanitizeMemoryForSerialization(results),
                },
              };
            }
          }

          // If text changed, re-embed; reject noise
          let newVector: number[] | undefined;
          if (text) {
            if (isNoise(text)) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Skipped: updated text detected as noise",
                  },
                ],
                details: { action: "noise_filtered" },
              };
            }
            newVector = await context.embedder.embedPassage(text);
          }

          // --- Temporal supersede guard ---
          // For temporal-versioned categories (preferences/entities), changing
          // text must go through supersede to preserve the history chain.
          if (text && newVector) {
            const existing = await context.store.getById(resolvedId, scopeFilter);
            if (existing) {
              const meta = parseSmartMetadata(existing.metadata, existing);
              if (TEMPORAL_VERSIONED_CATEGORIES.has(meta.memory_category)) {
                const now = Date.now();
                const factKey =
                  meta.fact_key ?? deriveFactKey(meta.memory_category, text);

                // Create new superseding record
                const newMeta = buildSmartMetadata(
                  { text, category: existing.category },
                  {
                    l0_abstract: text,
                    l1_overview: meta.l1_overview,
                    l2_content: text,
                    memory_category: meta.memory_category,
                    tier: meta.tier,
                    access_count: 0,
                    confidence: importance !== undefined ? clamp01(importance, 0.7) : meta.confidence,
                    valid_from: now,
                    fact_key: factKey,
                    supersedes: resolvedId,
                    relations: appendRelation([], {
                      type: "supersedes",
                      targetId: resolvedId,
                    }),
                  },
                );

                const newEntry = await context.store.store({
                  text,
                  vector: newVector,
                  category: category ? (category as any) : existing.category,
                  scope: existing.scope,
                  importance:
                    importance !== undefined
                      ? clamp01(importance, 0.7)
                      : existing.importance,
                  metadata: stringifySmartMetadata(newMeta),
                });

                // Invalidate old record (metadata-only patch — safe)
                try {
                  const invalidatedMeta = buildSmartMetadata(existing, {
                    fact_key: factKey,
                    invalidated_at: now,
                    superseded_by: newEntry.id,
                    relations: appendRelation(meta.relations, {
                      type: "superseded_by",
                      targetId: newEntry.id,
                    }),
                  });
                  await context.store.update(
                    resolvedId,
                    { metadata: stringifySmartMetadata(invalidatedMeta) },
                    scopeFilter,
                  );
                } catch (patchErr) {
                  // New record is already the source of truth; log but don't fail
                  console.warn(
                    `memory-pro: failed to patch superseded record ${resolvedId.slice(0, 8)}: ${patchErr}`,
                  );
                }

                return {
                  content: [
                    {
                      type: "text",
                      text: `Superseded memory ${resolvedId.slice(0, 8)}... → new version ${newEntry.id.slice(0, 8)}...: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`,
                    },
                  ],
                  details: {
                    action: "superseded",
                    oldId: resolvedId,
                    newId: newEntry.id,
                    category: meta.memory_category,
                  },
                };
              }
            }
          }
          // --- End temporal supersede guard ---

          const existingForPatch = await context.store.getById(resolvedId, scopeFilter);
          if (!existingForPatch) {
            return {
              content: [
                {
                  type: "text",
                  text: `Memory ${resolvedId.slice(0, 8)}... not found or access denied.`,
                },
              ],
              details: { error: "not_found", id: resolvedId },
            };
          }

          const updates: Record<string, any> = {};
          if (text) updates.text = text;
          if (newVector) updates.vector = newVector;
          if (importance !== undefined)
            updates.importance = clamp01(importance, 0.7);
          if (category) updates.category = category;

          // Keep smart metadata in sync with editable fields so recall rendering
          // and lexical retrieval reflect the latest text/category/importance.
          if (text || importance !== undefined || category) {
            const metadataPatch: Record<string, unknown> = {};
            if (text) {
              metadataPatch.l0_abstract = text;
              metadataPatch.l1_overview = `- ${text}`;
              metadataPatch.l2_content = text;
            }
            if (importance !== undefined) {
              metadataPatch.confidence = clamp01(importance, 0.7);
            }
            if (category) {
              metadataPatch.memory_category = category;
              metadataPatch.memory_layer = deriveManualMemoryLayer(category);
            }
            const mergedMeta = buildSmartMetadata(existingForPatch, metadataPatch);
            updates.metadata = stringifySmartMetadata(mergedMeta);
          }

          const updated = await context.store.update(
            resolvedId,
            updates,
            scopeFilter,
          );

          if (!updated) {
            return {
              content: [
                {
                  type: "text",
                  text: `Memory ${resolvedId.slice(0, 8)}... not found or access denied.`,
                },
              ],
              details: { error: "not_found", id: resolvedId },
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `Updated memory ${updated.id.slice(0, 8)}...: "${updated.text.slice(0, 80)}${updated.text.length > 80 ? "..." : ""}"`,
              },
            ],
            details: {
              action: "updated",
              id: updated.id,
              scope: updated.scope,
              category: updated.category,
              importance: updated.importance,
              fieldsUpdated: Object.keys(updates),
            },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Memory update failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { error: "update_failed", message: String(error) },
          };
        }
      },
    };
    },
    { name: "memory_update" },
  );
}

// ============================================================================
// Management Tools (Optional)
// ============================================================================

export function registerMemoryStatsTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_stats",
      label: "Memory Statistics",
      description: "Get statistics about memory usage, scopes, and categories.",
      parameters: Type.Object({
        scope: Type.Optional(
          Type.String({
            description: "Specific scope to get stats for (optional)",
          }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
        const { scope } = params as { scope?: string };

        try {
          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx);
          const deniedSt = rejectIfGovernorAgentDisabled(context, agentId);
          if (deniedSt) return deniedSt;
          // Determine accessible scopes
          let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
          if (scope) {
            if (context.scopeManager.isAccessible(scope, agentId)) {
              scopeFilter = [scope];
            } else {
              return {
                content: [
                  { type: "text", text: `Access denied to scope: ${scope}` },
                ],
                details: {
                  error: "scope_access_denied",
                  requestedScope: scope,
                },
              };
            }
          }

          const stats = await context.store.stats(scopeFilter);
          const scopeManagerStats = context.scopeManager.getStats();
          const retrievalConfig = context.retriever.getConfig();

          const textLines = [
            `Memory Statistics:`,
            `\u2022 Total memories: ${stats.totalCount}`,
            `\u2022 Available scopes: ${scopeManagerStats.totalScopes}`,
            `\u2022 Retrieval mode: ${retrievalConfig.mode}`,
            `\u2022 FTS support: ${context.store.hasFtsSupport ? "Yes" : "No"}`,
            ``,
            `Memories by scope:`,
            ...Object.entries(stats.scopeCounts).map(
              ([s, count]) => `  \u2022 ${s}: ${count}`,
            ),
            ``,
            `Memories by category:`,
            ...Object.entries(stats.categoryCounts).map(
              ([c, count]) => `  \u2022 ${c}: ${count}`,
            ),
          ];

          // Include retrieval quality metrics if stats collector is available
          const statsCollector = context.retriever.getStatsCollector();
          let retrievalStats = undefined;
          if (statsCollector && statsCollector.count > 0) {
            retrievalStats = statsCollector.getStats();
            textLines.push(
              ``,
              `Retrieval Quality (last ${retrievalStats.totalQueries} queries):`,
              `  \u2022 Zero-result queries: ${retrievalStats.zeroResultQueries}`,
              `  \u2022 Avg latency: ${retrievalStats.avgLatencyMs}ms`,
              `  \u2022 P95 latency: ${retrievalStats.p95LatencyMs}ms`,
              `  \u2022 Avg result count: ${retrievalStats.avgResultCount}`,
              `  \u2022 Rerank used: ${retrievalStats.rerankUsed}`,
              `  \u2022 Noise filtered: ${retrievalStats.noiseFiltered}`,
            );
            if (retrievalStats.topDropStages.length > 0) {
              textLines.push(`  Top drop stages:`);
              for (const ds of retrievalStats.topDropStages) {
                textLines.push(`    \u2022 ${ds.name}: ${ds.totalDropped} dropped`);
              }
            }
          }

          const text = textLines.join("\n");

          return {
            content: [{ type: "text", text }],
            details: {
              stats,
              scopeManagerStats,
              retrievalConfig: {
                ...retrievalConfig,
                rerankApiKey: retrievalConfig.rerankApiKey ? "***" : undefined,
              },
              hasFtsSupport: context.store.hasFtsSupport,
              retrievalStats,
            },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to get memory stats: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { error: "stats_failed", message: String(error) },
          };
        }
      },
    };
    },
    { name: "memory_stats" },
  );
}

export function registerMemoryDebugTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const agentId = resolveAgentId((toolCtx as any)?.agentId, context.agentId) ?? "main";
      return {
        name: "memory_debug",
        label: "Memory Debug",
        description:
          "Debug memory retrieval: search with full pipeline trace showing per-stage drop info, score ranges, and timing.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query to debug" }),
          limit: Type.Optional(
            Type.Number({ description: "Max results to return (default: 5, max: 20)" }),
          ),
          scope: Type.Optional(
            Type.String({ description: "Specific memory scope to search in (optional)" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { query, limit = 5, scope } = params as {
            query: string; limit?: number; scope?: string;
          };
          try {
            const deniedDbg = rejectIfGovernorAgentDisabled(context, agentId);
            if (deniedDbg) return deniedDbg;
            const safeLimit = clampInt(limit, 1, 20);
            let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
            if (scope) {
              if (context.scopeManager.isAccessible(scope, agentId)) {
                scopeFilter = [scope];
              } else {
                return {
                  content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                  details: { error: "scope_access_denied", requestedScope: scope },
                };
              }
            }

            const { results, trace } = await context.retriever.retrieveWithTrace({
              query, limit: safeLimit, scopeFilter, source: "manual",
            });

            const traceLines: string[] = [
              `Retrieval Debug Trace:`,
              `  Mode: ${trace.mode}`,
              `  Total: ${trace.totalMs}ms`,
              `  Stages:`,
            ];
            for (const stage of trace.stages) {
              const dropped = Math.max(0, stage.inputCount - stage.outputCount);
              const scoreStr = stage.scoreRange
                ? ` scores=[${stage.scoreRange[0].toFixed(3)}, ${stage.scoreRange[1].toFixed(3)}]`
                : "";
              // For search stages (input=0), show "found N" instead of "dropped -N"
              const dropStr = stage.inputCount === 0
                ? `found ${stage.outputCount}`
                : `${stage.inputCount} -> ${stage.outputCount} (-${dropped})`;
              traceLines.push(
                `    ${stage.name}: ${dropStr} ${stage.durationMs}ms${scoreStr}`,
              );
              if (stage.droppedIds.length > 0 && stage.droppedIds.length <= 3) {
                traceLines.push(`      dropped: ${stage.droppedIds.join(", ")}`);
              } else if (stage.droppedIds.length > 3) {
                traceLines.push(
                  `      dropped: ${stage.droppedIds.slice(0, 3).join(", ")} (+${stage.droppedIds.length - 3} more)`,
                );
              }
            }

            if (results.length === 0) {
              traceLines.push(``, `No results survived the pipeline.`);
              return {
                content: [{ type: "text", text: traceLines.join("\n") }],
                details: { count: 0, query, trace },
              };
            }

            const resultLines = results.map((r, i) => {
              const sources: string[] = [];
              if (r.sources.vector) sources.push("vector");
              if (r.sources.bm25) sources.push("BM25");
              if (r.sources.reranked) sources.push("reranked");
              const categoryTag = getDisplayCategoryTag(r.entry);
              return `${i + 1}. [${r.entry.id}] [${categoryTag}] ${r.entry.text.slice(0, 120)}${r.entry.text.length > 120 ? "..." : ""} (${(r.score * 100).toFixed(1)}%${sources.length > 0 ? `, ${sources.join("+")}` : ""})`;
            });

            const text = [...traceLines, ``, `Results (${results.length}):`, ...resultLines].join("\n");
            return {
              content: [{ type: "text", text }],
              details: {
                count: results.length,
                memories: sanitizeMemoryForSerialization(results),
                query,
                trace,
              },
            };
          } catch (error) {
            return {
              content: [{
                type: "text",
                text: `Memory debug failed: ${error instanceof Error ? error.message : String(error)}`,
              }],
              details: { error: "debug_failed", message: String(error) },
            };
          }
        },
      };
    },
    { name: "memory_debug" },
  );
}

export function registerMemoryListTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_list",
      label: "Memory List",
      description:
        "List recent memories with optional filtering by scope and category.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Number({
            description: "Max memories to list (default: 10, max: 50)",
          }),
        ),
        scope: Type.Optional(
          Type.String({ description: "Filter by specific scope (optional)" }),
        ),
        category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
        offset: Type.Optional(
          Type.Number({
            description: "Number of memories to skip (default: 0)",
          }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
        const {
          limit = 10,
          scope,
          category,
          offset = 0,
        } = params as {
          limit?: number;
          scope?: string;
          category?: string;
          offset?: number;
        };

        try {
          const safeLimit = clampInt(limit, 1, 50);
          const safeOffset = clampInt(offset, 0, 1000);
          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx);

          // Determine accessible scopes
          let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
          if (scope) {
            if (context.scopeManager.isAccessible(scope, agentId)) {
              scopeFilter = [scope];
            } else {
              return {
                content: [
                  { type: "text", text: `Access denied to scope: ${scope}` },
                ],
                details: {
                  error: "scope_access_denied",
                  requestedScope: scope,
                },
              };
            }
          }

          const entries = await context.store.list(
            scopeFilter,
            category,
            safeLimit,
            safeOffset,
          );

          if (entries.length === 0) {
            return {
              content: [{ type: "text", text: "No memories found." }],
              details: {
                count: 0,
                filters: {
                  scope,
                  category,
                  limit: safeLimit,
                  offset: safeOffset,
                },
              },
            };
          }

          const text = entries
            .map((entry, i) => {
              const date = new Date(entry.timestamp)
                .toISOString()
                .split("T")[0];
              const categoryTag = getDisplayCategoryTag(entry);
              return `${safeOffset + i + 1}. [${entry.id}] [${categoryTag}] ${entry.text.slice(0, 100)}${entry.text.length > 100 ? "..." : ""} (${date})`;
            })
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text: `Recent memories (showing ${entries.length}):\n\n${text}`,
              },
            ],
            details: {
              count: entries.length,
              memories: entries.map((e) => ({
                id: e.id,
                text: e.text,
                category: getDisplayCategoryTag(e),
                rawCategory: e.category,
                scope: e.scope,
                importance: e.importance,
                timestamp: e.timestamp,
              })),
              filters: {
                scope,
                category,
                limit: safeLimit,
                offset: safeOffset,
              },
            },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to list memories: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { error: "list_failed", message: String(error) },
          };
        }
      },
    };
    },
    { name: "memory_list" },
  );
}

export function registerMemoryPromoteTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_promote",
        label: "Memory Promote",
        description:
          "Promote a memory into confirmed/durable governance state (tiering, audits, and other lifecycle tooling).",
        parameters: Type.Object({
          memoryId: Type.Optional(
            Type.String({ description: "Memory id (UUID/prefix). Optional when query is provided." }),
          ),
          query: Type.Optional(
            Type.String({ description: "Search query to locate a memory when memoryId is omitted." }),
          ),
          scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
          state: Type.Optional(Type.Union([
            Type.Literal("pending"),
            Type.Literal("confirmed"),
            Type.Literal("archived"),
          ])),
          layer: Type.Optional(Type.Union([
            Type.Literal("durable"),
            Type.Literal("working"),
            Type.Literal("reflection"),
            Type.Literal("archive"),
          ])),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
          const {
            memoryId,
            query,
            scope,
            state = "confirmed",
            layer = "durable",
          } = params as {
            memoryId?: string;
            query?: string;
            scope?: string;
            state?: "pending" | "confirmed" | "archived";
            layer?: "durable" | "working" | "reflection" | "archive";
          };

          if (!memoryId && !query) {
            return {
              content: [{ type: "text", text: "Provide memoryId or query." }],
              details: { error: "missing_selector" },
            };
          }

          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx);
          const deniedPr = rejectIfGovernorAgentDisabled(context, agentId);
          if (deniedPr) return deniedPr;
          let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
          if (scope) {
            if (!context.scopeManager.isAccessible(scope, agentId)) {
              return {
                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                details: { error: "scope_access_denied", requestedScope: scope },
              };
            }
            scopeFilter = [scope];
          }

          const resolved = await resolveMemoryId(
            runtimeContext,
            memoryId ?? query ?? "",
            scopeFilter,
          );
          if (isResolveMemoryIdFailure(resolved)) {
            return {
              content: [{ type: "text", text: resolved.message }],
              details: resolved.details ?? { error: "resolve_failed" },
            };
          }

          const before = await runtimeContext.store.getById(resolved.id, scopeFilter);
          if (!before) {
            return {
              content: [{ type: "text", text: `Memory ${resolved.id.slice(0, 8)} not found.` }],
              details: { error: "not_found", id: resolved.id },
            };
          }

          const now = Date.now();
          const updated = await runtimeContext.store.patchMetadata(
            resolved.id,
            {
              source: "manual",
              state,
              memory_layer: layer,
              last_confirmed_use_at: state === "confirmed" ? now : undefined,
              bad_recall_count: 0,
              suppressed_until_turn: 0,
            },
            scopeFilter,
          );
          if (!updated) {
            return {
              content: [{ type: "text", text: `Failed to promote memory ${resolved.id.slice(0, 8)}.` }],
              details: { error: "promote_failed", id: resolved.id },
            };
          }

          return {
            content: [{
              type: "text",
              text: `Promoted memory ${resolved.id.slice(0, 8)} to state=${state}, layer=${layer}.`,
            }],
            details: {
              action: "promoted",
              id: resolved.id,
              state,
              layer,
            },
          };
        },
      };
    },
    { name: "memory_promote" },
  );
}

export function registerMemoryArchiveTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_archive",
        label: "Memory Archive",
        description:
          "Archive a memory while preserving history. Strong retrieval hits may still be auto-injected; use explicit suppression workflows if a row must stay out of context.",
        parameters: Type.Object({
          memoryId: Type.Optional(Type.String({ description: "Memory id (UUID/prefix)." })),
          query: Type.Optional(Type.String({ description: "Search query when memoryId is omitted." })),
          scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
          reason: Type.Optional(Type.String({ description: "Archive reason for audit trail." })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
          const { memoryId, query, scope, reason = "manual_archive" } = params as {
            memoryId?: string;
            query?: string;
            scope?: string;
            reason?: string;
          };
          if (!memoryId && !query) {
            return {
              content: [{ type: "text", text: "Provide memoryId or query." }],
              details: { error: "missing_selector" },
            };
          }

          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx);
          const deniedAr = rejectIfGovernorAgentDisabled(context, agentId);
          if (deniedAr) return deniedAr;
          let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
          if (scope) {
            if (!context.scopeManager.isAccessible(scope, agentId)) {
              return {
                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                details: { error: "scope_access_denied", requestedScope: scope },
              };
            }
            scopeFilter = [scope];
          }

          const resolved = await resolveMemoryId(
            runtimeContext,
            memoryId ?? query ?? "",
            scopeFilter,
          );
          if (isResolveMemoryIdFailure(resolved)) {
            return {
              content: [{ type: "text", text: resolved.message }],
              details: resolved.details ?? { error: "resolve_failed" },
            };
          }

          const patch = {
            state: "archived" as const,
            memory_layer: "archive" as const,
            archive_reason: reason,
            archived_at: Date.now(),
          };
          const updated = await runtimeContext.store.patchMetadata(resolved.id, patch, scopeFilter);
          if (!updated) {
            return {
              content: [{ type: "text", text: `Failed to archive memory ${resolved.id.slice(0, 8)}.` }],
              details: { error: "archive_failed", id: resolved.id },
            };
          }

          return {
            content: [{ type: "text", text: `Archived memory ${resolved.id.slice(0, 8)}.` }],
            details: { action: "archived", id: resolved.id, reason },
          };
        },
      };
    },
    { name: "memory_archive" },
  );
}

export function registerMemoryDedupeTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_dedupe",
        label: "Memory dedupe",
        description:
          "Archive duplicate memories (same category + normalized abstract) while keeping one canonical entry. " +
          "Distinct from memory_compact, which merges semantically similar memories via embeddings.",
        parameters: Type.Object({
          scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
          dryRun: Type.Optional(Type.Boolean({ description: "Preview compaction only (default true)." })),
          limit: Type.Optional(Type.Number({ description: "Max entries to scan (default 200)." })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
          const { scope, dryRun = true, limit = 200 } = params as {
            scope?: string;
            dryRun?: boolean;
            limit?: number;
          };

          const safeLimit = clampInt(limit, 20, 1000);
          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx);
          const deniedDe = rejectIfGovernorAgentDisabled(context, agentId);
          if (deniedDe) return deniedDe;
          let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
          if (scope) {
            if (!context.scopeManager.isAccessible(scope, agentId)) {
              return {
                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                details: { error: "scope_access_denied", requestedScope: scope },
              };
            }
            scopeFilter = [scope];
          }

          const entries = await runtimeContext.store.list(scopeFilter, undefined, safeLimit, 0);
          const canonicalByKey = new Map<string, typeof entries[number]>();
          const duplicates: Array<{ duplicateId: string; canonicalId: string; key: string }> = [];

          for (const entry of entries) {
            const meta = parseSmartMetadata(entry.metadata, entry);
            if (meta.state === "archived") continue;
            const key = `${meta.memory_category}:${normalizeInlineText(meta.l0_abstract).toLowerCase()}`;
            const existing = canonicalByKey.get(key);
            if (!existing) {
              canonicalByKey.set(key, entry);
              continue;
            }
            const keep =
              existing.timestamp >= entry.timestamp ? existing : entry;
            const drop =
              keep.id === existing.id ? entry : existing;
            canonicalByKey.set(key, keep);
            duplicates.push({ duplicateId: drop.id, canonicalId: keep.id, key });
          }

          let archivedCount = 0;
          if (!dryRun) {
            for (const item of duplicates) {
              await runtimeContext.store.patchMetadata(
                item.duplicateId,
                {
                  state: "archived",
                  memory_layer: "archive",
                  canonical_id: item.canonicalId,
                  archive_reason: "compact_duplicate",
                  archived_at: Date.now(),
                },
                scopeFilter,
              );
              archivedCount++;
            }
          }

          return {
            content: [{
              type: "text",
              text: dryRun
                ? `Compaction preview: ${duplicates.length} duplicate(s) detected across ${entries.length} entries.`
                : `Compaction complete: archived ${archivedCount} duplicate memory record(s).`,
            }],
            details: {
              action: dryRun ? "compact_preview" : "compact_applied",
              scanned: entries.length,
              duplicates: duplicates.length,
              archived: archivedCount,
              sample: duplicates.slice(0, 20),
            },
          };
        },
      };
    },
    { name: "memory_dedupe" },
  );
}

export function registerMemoryExplainRankTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_explain_rank",
        label: "Memory Explain Rank",
        description:
          "Run recall and explain why each memory was ranked, including governance metadata (state/layer/source/suppression).",
        parameters: Type.Object({
          query: Type.String({ description: "Query used for ranking analysis." }),
          limit: Type.Optional(Type.Number({ description: "How many items to explain (default 5)." })),
          scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
          const { query, limit = 5, scope } = params as {
            query: string;
            limit?: number;
            scope?: string;
          };

          const safeLimit = clampInt(limit, 1, 20);
          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx);
          const deniedExR = rejectIfGovernorAgentDisabled(context, agentId);
          if (deniedExR) return deniedExR;
          let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
          if (scope) {
            if (!context.scopeManager.isAccessible(scope, agentId)) {
              return {
                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                details: { error: "scope_access_denied", requestedScope: scope },
              };
            }
            scopeFilter = [scope];
          }

          const results = await retrieveWithRetry(runtimeContext.retriever, {
            query,
            limit: safeLimit,
            scopeFilter,
          });
          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { action: "empty", query, scopeFilter },
            };
          }

          const lines = results.map((r, idx) => {
            const meta = parseSmartMetadata(r.entry.metadata, r.entry);
            const sourceBreakdown = [];
            if (r.sources.vector) sourceBreakdown.push(`vec=${r.sources.vector.score.toFixed(3)}`);
            if (r.sources.bm25) sourceBreakdown.push(`bm25=${r.sources.bm25.score.toFixed(3)}`);
            if (r.sources.reranked) sourceBreakdown.push(`rerank=${r.sources.reranked.score.toFixed(3)}`);
            return [
              `${idx + 1}. [${r.entry.id}] score=${r.score.toFixed(3)} ${sourceBreakdown.join(" ")}`.trim(),
              `   state=${meta.state} layer=${meta.memory_layer} source=${meta.source} tier=${meta.tier}`,
              `   access=${meta.access_count} injected=${meta.injected_count} badRecall=${meta.bad_recall_count} suppressedUntilTurn=${meta.suppressed_until_turn}`,
              `   text=${truncateText(normalizeInlineText(meta.l0_abstract || r.entry.text), 180)}`,
            ].join("\n");
          });

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: {
              action: "explain_rank",
              query,
              count: results.length,
              results: sanitizeMemoryForSerialization(results),
            },
          };
        },
      };
    },
    { name: "memory_explain_rank" },
  );
}

// ============================================================================
// Tool Registration Helper
// ============================================================================

export function registerAllMemoryTools(
  api: OpenClawPluginApi,
  context: ToolContext,
  options: {
    enableManagementTools?: boolean;
    enableSelfImprovementTools?: boolean;
  } = {},
) {
  // Core tools (always enabled)
  registerMemoryRecallTool(api, context);
  registerMemoryStoreTool(api, context);
  registerMemoryForgetTool(api, context);
  registerMemoryUpdateTool(api, context);

  // Management tools (optional)
  if (options.enableManagementTools) {
    registerMemoryStatsTool(api, context);
    registerMemoryDebugTool(api, context);
    registerMemoryListTool(api, context);
    registerMemoryPromoteTool(api, context);
    registerMemoryArchiveTool(api, context);
    registerMemoryDedupeTool(api, context);
    registerMemoryExplainRankTool(api, context);
  }
  if (options.enableSelfImprovementTools !== false) {
    registerSelfImprovementLogTool(api, context);
    if (options.enableManagementTools) {
      registerSelfImprovementExtractSkillTool(api, context);
      registerSelfImprovementReviewTool(api, context);
    }
  }
}
