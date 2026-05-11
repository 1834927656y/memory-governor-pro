/**
 * Gate / re-rank auto-recall candidates so injected memories align with the user's current utterance.
 */

import type { RetrievalResult } from "../retriever.js";
import { parseSmartMetadata } from "../smart-metadata.js";

function looksLikeQuestion(text: string): boolean {
  const s = String(text || "").trim();
  if (!s) return false;
  const stripped = s
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/^sender\s*\(untrusted metadata\):/i, "")
    .trim();
  if (/[?？]/.test(s)) return true;
  // Common Chinese question/request patterns (avoid storing/recalling them as durable facts)
  if (/^(请|麻烦|能否|可以|帮我)/.test(stripped) && /(复述|说明|解释|告诉我|是什么|多少|怎么|为何|为什么)/.test(stripped)) {
    return true;
  }
  // Imperative question-like prompts that often appear without punctuation.
  if (/(请复述|请说明|请解释|请列出|请告诉我|先回复|给我一个|列出当前|说明当前)/.test(stripped)) {
    return true;
  }
  return false;
}

function isRulesOrCodewordQuery(q: string): boolean {
  const s = String(q || "").toLowerCase();
  return /(长期规则|规则|規則|原則|项目代号|項目代號|代号|代號|复述|復述|gmt\+\d+|utc\+\d+)/i.test(s);
}

type TopicAxis = "ai-application" | "ai-development" | "ai-technology";

function detectTopicAxes(text: string): Set<TopicAxis> {
  const s = String(text || "").toLowerCase();
  const out = new Set<TopicAxis>();
  if (/(ai应用|ai應用|应用场景|應用場景|落地|业务化|商業化|use case|application)/i.test(s)) {
    out.add("ai-application");
  }
  if (/(ai发展|ai發展|趋势|趨勢|演进|演進|里程碑|milestone|evolution|roadmap)/i.test(s)) {
    out.add("ai-development");
  }
  if (/(ai技术|ai技術|架构|架構|模型|推理|训练|訓練|蒸馏|蒸餾|量化|quant|rag|agent)/i.test(s)) {
    out.add("ai-technology");
  }
  return out;
}

function axisMatchBonus(queryAxes: Set<TopicAxis>, hayAxes: Set<TopicAxis>): number {
  if (queryAxes.size === 0) return 0;
  let hit = 0;
  for (const x of queryAxes) if (hayAxes.has(x)) hit++;
  if (hit === 0) return -0.18;
  if (hit === queryAxes.size) return 0.2;
  return 0.08;
}

function hasTimeHint(query: string): boolean {
  return /(上次|之前|以前|那次|昨天|上周|上个月|去年|last time|previously|earlier|yesterday|last week|last month)/i.test(
    String(query || ""),
  );
}

function isCurrentStateRulesQuery(query: string): boolean {
  return /(当前|现在|仍生效|生效|有效|latest|current|active)/i.test(String(query || ""));
}

function normalizeRuleText(text: string): string {
  return normalizeSemanticText(String(text || ""));
}

function inferRuleFreshnessScore(text: string, slot?: string): number {
  const s = normalizeRuleText(text);
  let score = 0;
  if (!s) return score;
  if (/(当前|现行|生效|有效|已更新|更新后|改为|升级|替换|取代|仅保留新值|latest|current)/i.test(s)) score += 1.2;
  if (/(历史|旧规则|旧记忆|过期|已失效|obsolete|deprecated|legacy)/i.test(s)) score -= 0.8;

  if (slot === "rule:project-codeword") {
    if (/(无项目代号|不存在.*项目代号|不再使用.*项目代号|取消.*项目代号|代号.*失效)/i.test(s)) score += 2.2;
    if (/(当前项目代号|项目代号[:：]|代号[:：])/i.test(s) && !/(无项目代号|不再使用|取消|失效)/i.test(s)) score += 0.4;
  }

  if (slot === "rule:time-format") {
    if (/(utc\+\d+)/i.test(s)) score += 1.0;
    if (/(gmt\+\d+)/i.test(s) && !/(改为|更新|升级|取代)/i.test(s)) score -= 0.5;
  }
  return score;
}

function inferRuleSlotPolarity(text: string, slot?: string): number {
  const s = normalizeRuleText(text);
  if (!s) return 0;
  if (slot === "rule:project-codeword") {
    // Positive polarity => "no active codeword"/cancelled constraints (new-state intent).
    if (/(无项目代号|不存在.*项目代号|不再使用.*项目代号|取消.*项目代号|代号.*失效|不应再包含.*项目代号)/i.test(s)) {
      return 2;
    }
    // Negative polarity => still has a codeword.
    if (/(当前项目代号|项目代号[:：]|代号[:：]|项目标识[:：])/i.test(s)) return -1;
  }
  if (slot === "rule:time-format") {
    if (/(utc\+\d+)/i.test(s)) return 1;
    if (/(gmt\+\d+)/i.test(s)) return -1;
  }
  return 0;
}

function isCurrentEffectiveCollaborationRule(text: string, slot?: string): boolean {
  const s = normalizeRuleText(text);
  if (!s) return false;
  const hasCurrentSignal = /(当前|现行|生效|有效|已更新|更新后|改为|升级|取代|仅保留新值|latest|current|active)/i.test(s);
  const isStale = /(历史|旧规则|旧记忆|过期|已失效|obsolete|legacy)/i.test(s);
  if (isStale) return false;

  if (slot === "rule:project-codeword") {
    // Keep explicit "removed/none/inactive" states for current-state asks.
    return /(无.*代号|不存在.*代号|不再使用.*代号|取消.*代号|代号.*失效|不应再包含.*代号|no\s+codeword|codeword.*inactive)/i.test(s);
  }
  if (slot === "rule:time-format") {
    // Prefer upgraded/current timezone states and suppress stale legacy templates.
    if (/(utc\+\d+|gmt\+\d+|timezone)/i.test(s) && (hasCurrentSignal || /(升级|改为|更新|取代)/i.test(s))) return true;
    return false;
  }
  if (slot === "rule:language" || slot === "rule:plan-format" || slot === "rule:general") {
    if (slot === "rule:general") {
      // For "current effective rules" asks, generic "协作约定" rows without current/update cues
      // are often stale historical snapshots (e.g. old timezone/plan/codeword templates).
      return hasCurrentSignal || /(当前长期协作约定|更新|确认|已由|改为|升级|取代|仅保留新值)/i.test(s);
    }
    // Language/plan slots also require current/update signals to avoid replaying old snapshots.
    return hasCurrentSignal || /(当前长期协作约定|更新|确认|已由|改为|升级|取代|仅保留新值)/i.test(s);
  }
  return hasCurrentSignal;
}

function inferCurrentStateConflictPenalty(text: string, slot?: string): number {
  const s = normalizeRuleText(text);
  if (!s) return 0;
  let p = 0;
  const hasCurrentSignal = /(当前|现行|生效|有效|已更新|更新后|改为|升级|取代|仅保留新值|latest|current|active)/i.test(s);
  if (slot === "rule:project-codeword") {
    // "has codeword" conflicts with current-effective recall intent.
    if (/(当前项目代号|项目代号[:：]|代号[:：]|项目标识[:：])/i.test(s) && !/(取消|失效|不存在|无.*代号)/i.test(s)) p -= 1.6;
  }
  if (slot === "rule:time-format") {
    // Legacy GMT templates are likely stale when no explicit upgrade/current signal exists.
    if (/(gmt\+\d+)/i.test(s) && !/(升级|改为|更新|取代|当前|生效|有效|latest|current)/i.test(s)) p -= 1.2;
  }
  // Generic stale-snapshot penalty for current-state asks:
  // dated/established rows without any current/update cue are likely historical.
  if (/\b20\d{2}-\d{2}-\d{2}\b/.test(s) && !hasCurrentSignal) p -= 0.9;
  if (/(确立|established)/i.test(s) && !hasCurrentSignal) p -= 0.8;
  // Session summary stubs should not outrank structured collaboration rules.
  if (/session summary|会话摘要/i.test(s)) p -= 0.8;
  return p;
}

function inferEffectiveEventAt(meta: ReturnType<typeof parseSmartMetadata>): number | undefined {
  const candidates: number[] = [];
  const eventAt = (meta as Record<string, unknown>).event_at;
  if (typeof eventAt === "number" && Number.isFinite(eventAt)) candidates.push(eventAt);
  if (typeof eventAt === "string") {
    const d = Date.parse(eventAt);
    if (Number.isFinite(d)) candidates.push(d);
  }
  const validFrom = Number(meta.valid_from);
  if (Number.isFinite(validFrom) && validFrom > 0) candidates.push(validFrom);
  const lastAccessedAt = Number(meta.last_accessed_at);
  if (Number.isFinite(lastAccessedAt) && lastAccessedAt > 0) candidates.push(lastAccessedAt);
  const lastInjectedAt = Number((meta as Record<string, unknown>).last_injected_at);
  if (Number.isFinite(lastInjectedAt) && lastInjectedAt > 0) candidates.push(lastInjectedAt);
  return candidates.length ? Math.max(...candidates) : undefined;
}

function extractQuotedAnchors(text: string): string[] {
  const s = String(text || "");
  const out: string[] = [];
  const re = /["“”'「」『』](.{2,120}?)["“”'「」『』]/g;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(s))) {
    const v = normalizeSemanticText(m[1] || "");
    if (v.length >= 2) out.push(v);
  }
  return [...new Set(out)];
}

type IntentLabel = "latest_state" | "historical_segment" | "topic_summary" | "fact_lookup";

const INTENT_PROTOTYPES: Record<IntentLabel, string[]> = {
  latest_state: [
    "当前生效版本 最新状态 现行约束 现在有效内容",
    "what is the current active latest version",
  ],
  historical_segment: [
    "指定某一段 原文 原话 当时那段 具体那句 历史片段",
    "quote exact previous segment from history",
  ],
  topic_summary: [
    "总结该主题 主线脉络 概览归纳 核心观点",
    "summarize this topic key points overview",
  ],
  fact_lookup: [
    "某个具体事实 参数 值 是多少",
    "lookup exact fact value for a field",
  ],
};

function inferQueryIntentBySemantics(query: string): {
  label: IntentLabel;
  confidence: number;
  margin: number;
  scores: Record<IntentLabel, number>;
} {
  const qTok = semanticTokenSet(query);
  const scores = {
    latest_state: 0,
    historical_segment: 0,
    topic_summary: 0,
    fact_lookup: 0,
  } as Record<IntentLabel, number>;
  for (const label of Object.keys(INTENT_PROTOTYPES) as IntentLabel[]) {
    let best = 0;
    for (const p of INTENT_PROTOTYPES[label]) {
      const s = semanticOverlap(qTok, semanticTokenSet(p));
      if (s > best) best = s;
    }
    scores[label] = best;
  }
  const ranked = (Object.entries(scores) as Array<[IntentLabel, number]>).sort((a, b) => b[1] - a[1]);
  const top = ranked[0] || (["fact_lookup", 0] as [IntentLabel, number]);
  const second = ranked[1] || (["fact_lookup", 0] as [IntentLabel, number]);
  return {
    label: top[0],
    confidence: top[1],
    margin: top[1] - second[1],
    scores,
  };
}

function anchorCoverage(anchors: string[], haystack: string): number {
  if (!anchors.length) return 0;
  const h = normalizeSemanticText(haystack);
  let hit = 0;
  for (const a of anchors) if (a && h.includes(a)) hit++;
  return hit / Math.max(1, anchors.length);
}

function inferRuleSlot(haystack: string): string | undefined {
  const s = String(haystack || "").toLowerCase();
  if (!s) return undefined;
  if (/(项目代号|項目代號|代号|代號|codeword|project code)/i.test(s)) return "rule:project-codeword";
  if (/(时间格式|時區|timezone|utc\+?\d+|gmt\+?\d+)/i.test(s)) return "rule:time-format";
  if (/(默认中文|始终中文|語言|language)/i.test(s)) return "rule:language";
  if (/(目标-步骤-风险|目標-步驟-風險|计划输出|計劃輸出|plan format)/i.test(s)) return "rule:plan-format";
  if (/(长期规则|長期規則|协作约定|協作約定|rules?)/i.test(s)) return "rule:general";
  return undefined;
}

type RuleDomain = "collaboration" | "system-runtime" | "unknown";

function inferRuleDomain(text: string): RuleDomain {
  const s = normalizeRuleText(text);
  if (!s) return "unknown";
  if (
    /(系统级|开发者|工具|cron|no_reply|heartbeat_ok|工作区|skills?|openclaw 更新|配置写入|优先级|runtime|sandbox|gateway)/i.test(
      s,
    )
  ) {
    return "system-runtime";
  }
  if (
    /(长期协作|协作约定|中文回复|utc\+\d+|gmt\+\d+|目标-步骤-风险|项目代号|任务标签|不再使用任何项目代号|代号.*失效|计划输出)/i.test(
      s,
    )
  ) {
    return "collaboration";
  }
  return "unknown";
}

function inferQueryRuleSlot(query: string): string | undefined {
  const s = String(query || "").toLowerCase();
  if (!s) return undefined;
  if (/(项目代号|項目代號|代号|代號|codeword|project code)/i.test(s)) return "rule:project-codeword";
  if (/(时间格式|時區|timezone|utc\+?\d+|gmt\+?\d+)/i.test(s)) return "rule:time-format";
  if (/(默认中文|始终中文|語言|language)/i.test(s)) return "rule:language";
  if (/(目标-步骤-风险|目標-步驟-風險|计划输出|計劃輸出|plan format)/i.test(s)) return "rule:plan-format";
  if (/(长期规则|長期規則|协作约定|協作約定|rules?)/i.test(s)) return "rule:general";
  return undefined;
}

function normalizeSemanticText(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/^sender\s*\(untrusted metadata\):/i, "")
    .replace(/[“”"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function semanticTokenSet(text: string): Set<string> {
  const t = normalizeSemanticText(text);
  const out = new Set<string>();
  for (const w of t.split(/[\s,.;:!?，。；：！？()\[\]{}<>/\\|+=-]+/g)) {
    const x = w.trim();
    if (x.length >= 2) out.add(x);
  }
  const han = t.match(/[\u4e00-\u9fff]{2,}/g);
  if (han) {
    for (const block of han) {
      for (let i = 0; i < block.length - 1; i++) out.add(block.slice(i, i + 2));
    }
  }
  return out;
}

function semanticOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return hit / Math.max(1, Math.min(a.size, b.size));
}

function inferSemanticBackbone(text: string): string | undefined {
  let s = normalizeSemanticText(text);
  if (!s) return undefined;
  s = s
    .replace(/\b(?:utc|gmt)\s*\+?\d+\b/gi, "<tz>")
    .replace(/\b\d{4}[-/年]\d{1,2}[-/月]\d{1,2}\b/g, "<date>")
    .replace(/"(.*?)"/g, '"<value>"')
    .replace(/“(.*?)”/g, "“<value>”")
    .replace(/'(.*?)'/g, "'<value>'");
  if (/(长期协作约定|协作约定|长期规则|规则清单)/i.test(s)) return "rule-backbone:agreement";
  return s.slice(0, 180);
}

function inferGenericSemanticBackbone(text: string): string | undefined {
  let s = normalizeSemanticText(text);
  if (!s) return undefined;
  // Normalize volatile value spans while keeping the subject/topic prefix.
  s = s
    .replace(/\b(?:utc|gmt)\s*\+?\d+\b/gi, "<tz>")
    .replace(/\b\d{4}[-/年]\d{1,2}[-/月]\d{1,2}(?:[日号]?\s*\d{1,2}:\d{1,2})?\b/g, "<time>")
    .replace(/\b\d{1,4}(?:\.\d+)?\b/g, "<num>")
    .replace(/"(.*?)"/g, '"<value>"')
    .replace(/“(.*?)”/g, "“<value>”")
    .replace(/'(.*?)'/g, "'<value>'");
  const m =
    s.match(/^(.{2,120}?)(?:[：:]|是|为|改为|变为|更新为|设为|切换为|->|=>)\s*(.+)$/) ||
    s.match(/^(.{2,120}?)(?:保持|采用|使用)\s+(.+)$/);
  if (m?.[1]) {
    return `topic:${m[1].trim()}`;
  }
  return s.slice(0, 180);
}

function ruleSlotCoverageScore(text: string): number {
  const s = normalizeSemanticText(text);
  let c = 0;
  if (/(默认中文|始终中文|中文回复|language)/i.test(s)) c++;
  if (/(?:utc|gmt)\s*\+?\d+|时间写|时间格式|timezone/i.test(s)) c++;
  if (/(目标-行动-风险|目标-步骤-风险|计划输出|输出结构|plan format)/i.test(s)) c++;
  if (/(项目代号|任务标签|codeword|tag)/i.test(s)) c++;
  return c;
}

function tokenizeAlignment(text: string): Set<string> {
  const t = String(text || "").toLowerCase();
  const out = new Set<string>();
  for (const w of t.split(/[\s,.;:!?，。；：！？()\[\]{}<>"'`/\\|+-]+/g)) {
    const x = w.trim();
    if (x.length >= 2) out.add(x);
    if (x.length === 1 && /[\u4e00-\u9fff]/.test(x)) out.add(x);
  }
  const han = t.match(/[\u4e00-\u9fff]+/g);
  if (han) {
    for (const block of han) {
      for (let i = 0; i < block.length - 1; i++) {
        out.add(block.slice(i, i + 2));
      }
    }
  }
  return out;
}

/** Fraction of query tokens (or Han bigrams) that appear in haystack (substring or token match). */
export function lexicalCoverage(query: string, haystack: string): number {
  const q = tokenizeAlignment(query);
  if (q.size === 0) return 1;
  const hLower = haystack.toLowerCase();
  const hTok = tokenizeAlignment(haystack);
  let hit = 0;
  for (const tok of q) {
    if (tok.length <= 3 && hLower.includes(tok)) hit++;
    else if (hTok.has(tok)) hit++;
  }
  return hit / q.size;
}

function retrievalNumericScore(r: RetrievalResult): number {
  const rr = r.sources?.reranked?.score;
  if (typeof rr === "number" && Number.isFinite(rr)) return rr;
  const fs = r.sources?.fused?.score;
  if (typeof fs === "number" && Number.isFinite(fs)) return fs;
  const vs = r.sources?.vector?.score;
  if (typeof vs === "number" && Number.isFinite(vs)) return vs;
  return 0;
}

function haystackForRecallEntry(r: RetrievalResult): string {
  const meta = parseSmartMetadata(r.entry.metadata, r.entry);
  return `${meta.l0_abstract}\n${meta.l1_overview}\n${meta.l2_content}\n${r.entry.text || ""}`;
}

export type MemorySemanticGateOptions = {
  semanticGateEnabled: boolean;
  minLexicalCoverage: number;
  minRetrieverScore?: number;
  lexicalRankWeight: number;
  fallbackTopNWhenAllFiltered: number;
};

/**
 * Drop memories that are neither lexically aligned with the user line nor above a retriever floor;
 * then re-rank by blended lexical + score so “对话语义” drives ordering.
 */
export function gateAndRankRecallForInjection(
  alignmentQuery: string,
  results: RetrievalResult[],
  opts: MemorySemanticGateOptions,
): RetrievalResult[] {
  if (!opts.semanticGateEnabled || results.length === 0) return results;

  const q = alignmentQuery.trim();
  const shortQuery = q.length < 4;
  const rulesQuery = isRulesOrCodewordQuery(q);
  const queryAxes = detectTopicAxes(q);
  const queryHasTimeHint = hasTimeHint(q);
  const intent = inferQueryIntentBySemantics(q);
  const segmentTarget = intent.label === "historical_segment" && intent.confidence >= 0.28 && intent.margin >= 0.04;
  const latestTarget = intent.label === "latest_state" && intent.confidence >= 0.24;
  const quotedAnchors = extractQuotedAnchors(q);
  const queryRuleSlot = inferQueryRuleSlot(q);
  const currentStateRulesQuery = rulesQuery && isCurrentStateRulesQuery(q);
  let decisionMode = "default";
  let decisionSlot = "";

  const scored = results.map((r) => {
    const hay = haystackForRecallEntry(r);
    const lex = lexicalCoverage(q, hay);
    const sc = retrievalNumericScore(r);
    const meta = parseSmartMetadata(r.entry.metadata, r.entry);
    const l0 = String(meta.l0_abstract || r.entry.text || "").trim();
    const isSessionSummary =
      String(meta.source || "").toLowerCase() === "session-summary" ||
      String(meta.type || "").toLowerCase() === "session-summary";
    const questionLike = looksLikeQuestion(l0) || looksLikeQuestion(String(r.entry.text || ""));
    const selfEcho =
      (l0.length > 0 && l0 === q) ||
      // Query-like memories may be wrapped with metadata prefixes; treat
      // "contains the full current query" as self-echo for rule recalls.
      (rulesQuery && q.length >= 8 && hay.includes(q));
    const hasRuleSignals = /(长期规则|规则|規則|原則|项目代号|項目代號|代号|代號|utc\+?\d+|gmt\+?\d+)/i.test(hay);
    const hayAxes = detectTopicAxes(hay);
    const topicBonus = axisMatchBonus(queryAxes, hayAxes);
    const eventAt = inferEffectiveEventAt(meta);
    // For time-anchored queries, prefer memories that carry a real timestamp.
    const timeBonus = queryHasTimeHint ? (Number.isFinite(eventAt) ? 0.06 : -0.04) : 0;
    const ruleSlot = inferRuleSlot(hay);
    const semanticId = String(meta.fact_key || meta.canonical_id || "").trim().toLowerCase();
    const abstractText = String(meta.l0_abstract || r.entry.text || "").trim();
    const ruleDomain = rulesQuery ? inferRuleDomain(`${abstractText}\n${hay}`) : "unknown";
    const freshnessScore = rulesQuery ? inferRuleFreshnessScore(`${abstractText}\n${hay}`, ruleSlot) : 0;
    const slotPolarity = rulesQuery ? inferRuleSlotPolarity(`${abstractText}\n${hay}`, ruleSlot) : 0;
    const currentStatePenalty = currentStateRulesQuery ? inferCurrentStateConflictPenalty(`${abstractText}\n${hay}`, ruleSlot) : 0;
    const semanticTokens = semanticTokenSet(abstractText || hay);
    const semanticBackbone = inferSemanticBackbone(abstractText || hay);
    const genericBackbone = inferGenericSemanticBackbone(abstractText || hay);
    const anchorHit = anchorCoverage(quotedAnchors, `${abstractText}\n${hay}`);
    const slotCoverage = ruleSlotCoverageScore(abstractText || hay);
    const memoryCategory = String(meta.memory_category || "").trim().toLowerCase();
    return {
      r,
      lex,
      sc,
      isSessionSummary,
      questionLike,
      selfEcho,
      hasRuleSignals,
      topicBonus,
      timeBonus,
      eventAt,
      ruleSlot,
      ruleDomain,
      semanticId,
      semanticTokens,
      abstractText,
      semanticBackbone,
      genericBackbone,
      anchorHit,
      slotCoverage,
      memoryCategory,
      freshnessScore,
      slotPolarity,
      currentStatePenalty,
    };
  });

  const minLex = opts.minLexicalCoverage;
  const minSc = opts.minRetrieverScore;

  const filtered = scored.filter(({ lex, sc, questionLike, selfEcho, isSessionSummary, hasRuleSignals, topicBonus, anchorHit }) => {
    // Hard drop: do not inject memories that are clearly user questions or self-echo of the current query.
    if (questionLike || selfEcho) return false;
    // When user is asking for "rules / codeword", avoid injecting session summaries unless they also contain rule signals.
    if (rulesQuery && isSessionSummary && !hasRuleSignals) return false;
    // Strong topic mismatch should be dropped for disambiguation-sensitive queries.
    if (queryAxes.size > 0 && topicBonus <= -0.15) return false;
    // "指定某段内容" 优先锚点命中，避免被“最新版本”误吸附。
    if (segmentTarget && quotedAnchors.length > 0 && anchorHit <= 0) return false;
    if (shortQuery) return true;
    if (minSc !== undefined && Number.isFinite(minSc) && sc >= minSc) return true;
    return lex >= minLex;
  });

  let chosen = filtered;
  if (chosen.length === 0 && opts.fallbackTopNWhenAllFiltered > 0) {
    // Fallback: prefer aligned rule-bearing memories for rule queries, otherwise by score.
    scored.sort((a, b) => {
      if (rulesQuery) {
        if (a.hasRuleSignals !== b.hasRuleSignals) return a.hasRuleSignals ? -1 : 1;
        if (a.isSessionSummary !== b.isSessionSummary) return a.isSessionSummary ? 1 : -1;
      }
      return b.sc - a.sc;
    });
    chosen = scored.slice(0, opts.fallbackTopNWhenAllFiltered);
  }

  // For "current effective rules" asks, prioritize candidates that explicitly
  // express current/effective states before any slot consolidation.
  if (currentStateRulesQuery && chosen.length > 1) {
    const currentEffective = chosen.filter((x) =>
      isCurrentEffectiveCollaborationRule(`${x.abstractText}\n${haystackForRecallEntry(x.r)}`, x.ruleSlot)
    );
    if (currentEffective.length > 0) {
      chosen = currentEffective;
    }
  }

  // For rule/codeword recall, first perform global semantic consolidation:
  // 1) if query explicitly points to a slot (e.g. "项目代号"), only keep that slot;
  // 2) otherwise pick the dominant slot by aggregate semantic/retrieval strength.
  if (rulesQuery && chosen.length > 1) {
    const slotItems = chosen.filter((x) => !!x.ruleSlot);
    if (slotItems.length > 0) {
      if (queryRuleSlot) {
        const exact = chosen.filter((x) => x.ruleSlot === queryRuleSlot);
        if (exact.length > 0) {
          // Exact-slot queries should not bring in other rule-bearing rows
          // (e.g. old codeword in a generic summary), which causes slot mixing.
          // Keep only exact slot + neutral passthrough without rule signals.
          chosen = [...exact, ...chosen.filter((x) => !x.ruleSlot && !x.hasRuleSignals)];
          decisionMode = "rule-slot-exact";
          decisionSlot = queryRuleSlot;
        }
      } else {
        const maxS = Math.max(1e-9, ...chosen.map((x) => x.sc));
        const slotScore = new Map<string, number>();
        for (const item of slotItems) {
          const key = item.ruleSlot as string;
          const v =
            (item.sc / maxS) +
            item.lex +
            (item.hasRuleSignals ? 0.2 : 0) +
            (item.isSessionSummary ? -0.2 : 0) +
            item.topicBonus +
            item.timeBonus;
          slotScore.set(key, (slotScore.get(key) || 0) + v);
        }
        const dominant = [...slotScore.entries()]
          .sort((a, b) => {
            if (b[1] !== a[1]) return b[1] - a[1];
            // deterministic tie-break to keep replayability.
            return a[0].localeCompare(b[0]);
          })[0]?.[0];
        if (dominant) {
          chosen = [...chosen.filter((x) => x.ruleSlot === dominant), ...chosen.filter((x) => !x.ruleSlot)];
          decisionMode = "rule-slot-dominant";
          decisionSlot = dominant;
        }
      }
    }
  }

  // Generic semantic de-conflict (not keyword-specific):
  // 1) Prefer latest entry for the same semantic identity (fact_key/canonical_id);
  // 2) For rows without explicit identity, collapse near-duplicate semantic clusters by recency.
  if (chosen.length > 1) {
    const bySemanticId = new Map<string, (typeof chosen)[number]>();
    const residual: (typeof chosen) = [];
    for (const item of chosen) {
      if (!item.semanticId) {
        residual.push(item);
        continue;
      }
      const prev = bySemanticId.get(item.semanticId);
      if (!prev) {
        bySemanticId.set(item.semanticId, item);
        continue;
      }
      const currTs = Number.isFinite(item.eventAt) ? (item.eventAt as number) : -1;
      const prevTs = Number.isFinite(prev.eventAt) ? (prev.eventAt as number) : -1;
      if (currTs >= prevTs) bySemanticId.set(item.semanticId, item);
    }
    const collapsed: (typeof chosen) = [...bySemanticId.values()];
    const clustered = new Map<number, (typeof chosen)[number]>();
    for (const item of residual) {
      let matchedCluster = -1;
      for (const [idx, rep] of clustered.entries()) {
        const sim = semanticOverlap(item.semanticTokens, rep.semanticTokens);
        // Strong semantic near-duplicate (same statement with wording variations).
        if (sim >= 0.72) {
          matchedCluster = idx;
          break;
        }
      }
      if (matchedCluster < 0) {
        clustered.set(clustered.size, item);
      } else {
        const prev = clustered.get(matchedCluster)!;
        const currTs = Number.isFinite(item.eventAt) ? (item.eventAt as number) : -1;
        const prevTs = Number.isFinite(prev.eventAt) ? (prev.eventAt as number) : -1;
        if (currTs >= prevTs) clustered.set(matchedCluster, item);
      }
    }
    chosen = [...collapsed, ...clustered.values()];

    // Second-pass semantic collapse across different semanticId values.
    // Use generic semantic backbones for all memory types, then fallback to
    // high-overlap clustering within the same memory category.
    if (chosen.length > 1) {
      const mergedByBackbone = new Map<string, (typeof chosen)[number]>();
      const pending: (typeof chosen)[number][] = [];
      for (const item of chosen) {
        const key = item.genericBackbone || item.semanticBackbone || "";
        if (!key) {
          pending.push(item);
          continue;
        }
        const prev = mergedByBackbone.get(key);
        if (!prev) {
          mergedByBackbone.set(key, item);
          continue;
        }
        const currTs = Number.isFinite(item.eventAt) ? (item.eventAt as number) : -1;
        const prevTs = Number.isFinite(prev.eventAt) ? (prev.eventAt as number) : -1;
        if (segmentTarget) {
          if (item.anchorHit !== prev.anchorHit) {
            if (item.anchorHit > prev.anchorHit) mergedByBackbone.set(key, item);
            continue;
          }
        } else if (currTs !== prevTs) {
          if (currTs > prevTs) mergedByBackbone.set(key, item);
          continue;
        }
        const currScore = item.lex + item.sc + item.timeBonus + item.topicBonus;
        const prevScore = prev.lex + prev.sc + prev.timeBonus + prev.topicBonus;
        if (currScore >= prevScore) mergedByBackbone.set(key, item);
      }
      const mergedClusters: (typeof chosen)[number][] = [];
      for (const item of [...mergedByBackbone.values(), ...pending]) {
        let hitIdx = -1;
        for (let i = 0; i < mergedClusters.length; i++) {
          const rep = mergedClusters[i]!;
          const sim = semanticOverlap(item.semanticTokens, rep.semanticTokens);
          const categoryCompatible =
            !!item.memoryCategory &&
            !!rep.memoryCategory &&
            item.memoryCategory === rep.memoryCategory;
          const slotCompatible = !!item.ruleSlot && !!rep.ruleSlot && item.ruleSlot === rep.ruleSlot;
          if ((slotCompatible && sim >= 0.66) || (categoryCompatible && sim >= 0.78)) {
            hitIdx = i;
            break;
          }
        }
        if (hitIdx < 0) {
          mergedClusters.push(item);
          continue;
        }
        const prev = mergedClusters[hitIdx]!;
        const currTs = Number.isFinite(item.eventAt) ? (item.eventAt as number) : -1;
        const prevTs = Number.isFinite(prev.eventAt) ? (prev.eventAt as number) : -1;
        if (segmentTarget) {
          if (item.anchorHit > prev.anchorHit || (item.anchorHit === prev.anchorHit && item.lex + item.sc >= prev.lex + prev.sc)) {
            mergedClusters[hitIdx] = item;
          }
        } else if (currTs >= prevTs) {
          mergedClusters[hitIdx] = item;
        }
      }
      chosen = mergedClusters;
    }
  }

  if (rulesQuery && chosen.length > 1) {
    const byBackbone = new Map<string, (typeof chosen)[number]>();
    const passthrough: (typeof chosen) = [];
    for (const item of chosen) {
      const key = item.semanticBackbone || item.semanticId || "";
      if (!key || !item.hasRuleSignals) {
        passthrough.push(item);
        continue;
      }
      const prev = byBackbone.get(key);
      if (!prev) {
        byBackbone.set(key, item);
        continue;
      }
      const currTs = Number.isFinite(item.eventAt) ? (item.eventAt as number) : -1;
      const prevTs = Number.isFinite(prev.eventAt) ? (prev.eventAt as number) : -1;
      if (currTs !== prevTs) {
        if (currTs > prevTs) byBackbone.set(key, item);
        continue;
      }
      if (item.slotCoverage !== prev.slotCoverage) {
        if (item.slotCoverage > prev.slotCoverage) byBackbone.set(key, item);
        continue;
      }
      const currScore = item.lex + item.sc;
      const prevScore = prev.lex + prev.sc;
      if (currScore >= prevScore) byBackbone.set(key, item);
    }
    chosen = [...byBackbone.values(), ...passthrough];
  }

  // Then collapse conflicting memories inside the selected semantic slice by slot recency.
  if (rulesQuery && chosen.length > 1) {
    const bySlot = new Map<string, (typeof chosen)[number]>();
    const passthrough: (typeof chosen) = [];
    for (const item of chosen) {
      const slot = item.ruleSlot;
      if (!slot) {
        passthrough.push(item);
        continue;
      }
      const prev = bySlot.get(slot);
      if (!prev) {
        bySlot.set(slot, item);
        continue;
      }
      const currTs = Number.isFinite(item.eventAt) ? (item.eventAt as number) : -1;
      const prevTs = Number.isFinite(prev.eventAt) ? (prev.eventAt as number) : -1;
      if (currTs > prevTs) {
        bySlot.set(slot, item);
        continue;
      }
      // For "current/effective rules" queries, resolve slot conflicts by polarity first.
      // Example: "no codeword" must beat "has codeword"; UTC should beat stale GMT.
      if (currentStateRulesQuery && item.slotPolarity !== prev.slotPolarity) {
        if (item.slotPolarity > prev.slotPolarity) {
          bySlot.set(slot, item);
        }
        continue;
      }
      if (currTs === prevTs && item.freshnessScore > prev.freshnessScore) {
        bySlot.set(slot, item);
      }
    }
    chosen = [...bySlot.values(), ...passthrough];
  }

  // Current-state rule queries should suppress stale rule lines in favor of latest/active statements.
  if (currentStateRulesQuery && chosen.length > 1) {
    const stalePenalty = /(历史|旧规则|旧记忆|过期|已失效|obsolete|legacy)/i;
    chosen = chosen.filter((item) => {
      const s = `${item.abstractText}\n${haystackForRecallEntry(item.r)}`;
      if (stalePenalty.test(s) && item.freshnessScore < 0.6) return false;
      return true;
    });
  }

  if (currentStateRulesQuery && chosen.length > 1) {
    // Final hard de-conflict on key rule slots.
    const hasCodewordCancel = chosen.some((x) => x.ruleSlot === "rule:project-codeword" && x.slotPolarity > 0);
    if (hasCodewordCancel) {
      chosen = chosen.filter((x) => !(x.ruleSlot === "rule:project-codeword" && x.slotPolarity < 0));
    }
    const hasUtc = chosen.some((x) => x.ruleSlot === "rule:time-format" && x.slotPolarity > 0);
    if (hasUtc) {
      chosen = chosen.filter((x) => !(x.ruleSlot === "rule:time-format" && x.slotPolarity < 0));
    }
  }

  if (currentStateRulesQuery && chosen.length > 1) {
    // Hard whitelist for current-effective collaboration rules.
    // This blocks stale templates like "GMT+8 + 青鸟计划-Alpha" from dominating.
    const scoped = chosen.filter((x) => {
      const text = `${x.abstractText}\n${haystackForRecallEntry(x.r)}`;
      if (x.ruleDomain === "system-runtime") return false;
      if (x.ruleSlot === "rule:time-format" && /(timezone|utc\+\d+|gmt\+\d+)/i.test(text) && !/(当前|生效|有效|更新|升级|改为|取代|latest|current)/i.test(text)) {
        return false;
      }
      if (x.ruleSlot === "rule:project-codeword" && x.slotPolarity < 0) return false;
      return isCurrentEffectiveCollaborationRule(text, x.ruleSlot);
    });
    if (scoped.length > 0) {
      chosen = scoped;
      decisionMode = "current-effective-collab-whitelist";
    }
  }

  // For collaboration-rule recalls, system/runtime policy memories should not dominate.
  if (currentStateRulesQuery && chosen.length > 1) {
    const hasCollaboration = chosen.some((x) => x.ruleDomain === "collaboration");
    if (hasCollaboration) {
      chosen = chosen.filter((x) => x.ruleDomain !== "system-runtime");
      decisionMode = "collaboration-domain-preferred";
    }
  }

  const maxS = Math.max(1e-9, ...chosen.map((x) => x.sc));
  const w = opts.lexicalRankWeight;
  chosen.sort((a, b) => {
    const bonusA =
      (rulesQuery && a.hasRuleSignals ? 0.15 : 0) +
      (rulesQuery && a.isSessionSummary ? -0.25 : 0) +
      (rulesQuery ? a.freshnessScore * 0.08 : 0) +
      (currentStateRulesQuery ? a.currentStatePenalty : 0) +
      ((rulesQuery || latestTarget) && !segmentTarget && Number.isFinite(a.eventAt) ? 0.03 : 0) +
      (segmentTarget ? a.anchorHit * 0.45 : 0) +
      a.topicBonus +
      a.timeBonus;
    const bonusB =
      (rulesQuery && b.hasRuleSignals ? 0.15 : 0) +
      (rulesQuery && b.isSessionSummary ? -0.25 : 0) +
      (rulesQuery ? b.freshnessScore * 0.08 : 0) +
      (currentStateRulesQuery ? b.currentStatePenalty : 0) +
      ((rulesQuery || latestTarget) && !segmentTarget && Number.isFinite(b.eventAt) ? 0.03 : 0) +
      (segmentTarget ? b.anchorHit * 0.45 : 0) +
      b.topicBonus +
      b.timeBonus;
    const ca = (1 - w) * (a.sc / maxS) + w * a.lex + bonusA;
    const cb = (1 - w) * (b.sc / maxS) + w * b.lex + bonusB;
    return cb - ca;
  });
  for (const x of chosen) {
    (x.r as any).__semanticMatch = {
      lexicalCoverage: x.lex,
      retrievalScore: x.sc,
      topicBonus: x.topicBonus,
      timeBonus: x.timeBonus,
      rulesQuery,
      intentLabel: intent.label,
      intentConfidence: intent.confidence,
      intentMargin: intent.margin,
      intentScores: intent.scores,
      segmentTarget,
      latestTarget,
      anchorHit: x.anchorHit,
      ruleSlot: x.ruleSlot || "",
      semanticId: x.semanticId || "",
      semanticBackbone: x.semanticBackbone || "",
      genericBackbone: x.genericBackbone || "",
      memoryCategory: x.memoryCategory || "",
      slotCoverage: x.slotCoverage || 0,
      freshnessScore: x.freshnessScore || 0,
      slotPolarity: x.slotPolarity || 0,
      currentStatePenalty: x.currentStatePenalty || 0,
      ruleDomain: x.ruleDomain || "unknown",
      gateDecisionMode: decisionMode,
      gateDecisionSlot: decisionSlot,
    };
  }
  return chosen.map((x) => x.r);
}
