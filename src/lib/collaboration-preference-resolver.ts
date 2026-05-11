/**
 * Resolve current collaboration preferences from many historical memory rows.
 *
 * Important design constraint: this module is read-only. It never deletes,
 * archives, patches, or rewrites stored memories. It only interprets candidate
 * rows at injection time, groups them by semantic slots, and renders the latest
 * active state for each slot.
 */

export type CollaborationPreferenceSlot =
  | "language"
  | "time-format"
  | "plan-format"
  | "project-codeword"
  | "task-label"
  | "source-disclosure";

export interface CollaborationPreferenceCandidate {
  id?: string;
  text: string;
  timestamp?: number;
  validFrom?: number;
  eventAt?: number | string;
}

export interface CollaborationPreferenceState {
  slot: CollaborationPreferenceSlot;
  active: boolean;
  fact: string;
  value?: string;
  effectiveAt: number;
  confidence: number;
  sourceId?: string;
  evidence: string;
  sourceOrder?: number;
  /**
   * Optional list ordinal from a source snapshot clause, e.g. `4）...`.
   * Used only at resolution time so later "forget item 4" statements can
   * invalidate whichever semantic slot item 4 actually contained instead of
   * hard-coding that "4" always means a project codeword rule.
   */
  ordinal?: number;
  targetOrdinal?: number;
  ordinalRemoval?: boolean;
}

export interface ResolvedCollaborationPreferences {
  facts: string[];
  active: CollaborationPreferenceState[];
  inactive: CollaborationPreferenceState[];
  slots: Partial<Record<CollaborationPreferenceSlot, CollaborationPreferenceState>>;
}

const SLOT_ORDER: CollaborationPreferenceSlot[] = [
  "language",
  "time-format",
  "plan-format",
  "source-disclosure",
  "project-codeword",
  "task-label",
];

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

function candidateEffectiveAt(candidate: CollaborationPreferenceCandidate, fallbackOrder: number): number {
  // Deliberately exclude last_accessed_at / last_injected_at style signals:
  // access recency is not factual recency.
  const candidates = [
    parseTimestamp(candidate.eventAt),
    parseTimestamp(candidate.validFrom),
    parseTimestamp(candidate.timestamp),
  ].filter((x): x is number => typeof x === "number");
  if (candidates.length > 0) return Math.max(...candidates);
  return fallbackOrder;
}

function normalizeText(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function compactEvidence(value: string): string {
  return normalizeText(value).slice(0, 240);
}

function parseChineseInteger(value: string): number | undefined {
  const s = value.trim();
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return Number(s);
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    兩: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  if (s in digits) return digits[s];
  const tenMatch = s.match(/^十([一二两兩三四五六七八九])?$/);
  if (tenMatch) return 10 + (tenMatch[1] ? digits[tenMatch[1]] : 0);
  const compound = s.match(/^([一二两兩三四五六七八九])十([一二两兩三四五六七八九])?$/);
  if (compound) return (digits[compound[1]] || 0) * 10 + (compound[2] ? digits[compound[2]] : 0);
  return undefined;
}

function parseLeadingOrdinal(text: string): number | undefined {
  const s = normalizeText(text);
  const circled: Record<string, number> = { "①": 1, "②": 2, "③": 3, "④": 4, "⑤": 5, "⑥": 6, "⑦": 7, "⑧": 8, "⑨": 9 };
  const circledMatch = s.match(/^([①②③④⑤⑥⑦⑧⑨])\s*[）).、]?/);
  if (circledMatch?.[1]) return circled[circledMatch[1]];
  const match = s.match(/^([0-9]{1,2}|[一二两兩三四五六七八九十]{1,3}|[①②③④⑤⑥⑦⑧⑨])\s*[）).、]/);
  if (match?.[1]) return circled[match[1]] ?? parseChineseInteger(match[1]);
  const prefixed = s.match(/^第\s*([0-9]{1,2}|[一二两兩三四五六七八九十]{1,3}|[①②③④⑤⑥⑦⑧⑨])\s*(?:条|條|项|項|个|個|则|則|点|點|款|条规则|項規則|rule)\s*[：:、.)）-]?/i);
  if (prefixed?.[1]) return circled[prefixed[1]] ?? parseChineseInteger(prefixed[1]);
  const english = s.match(/^(?:rule|item|preference)\s*#?\s*([0-9]{1,2})\s*[：:、.)）-]?/i);
  if (english?.[1]) return parseChineseInteger(english[1]);
  return undefined;
}

function parseOrdinalReference(text: string): number | undefined {
  const s = normalizeText(text);
  const patterns = [
    /第\s*([0-9]{1,2}|[一二两兩三四五六七八九十]{1,3}|[①②③④⑤⑥⑦⑧⑨])\s*(?:条|條|项|項|个|個|则|則|点|點|款|条规则|項規則|rule)/i,
    /(?:编号|序号|第)\s*#?\s*([0-9]{1,2})/i,
    /\brule\s*#?\s*([0-9]{1,2})\b/i,
    /\b([0-9]{1,2})(?:st|nd|rd|th)\s+(?:rule|item|preference)\b/i,
  ];
  for (const pattern of patterns) {
    const match = s.match(pattern);
    if (match?.[1]) return parseLeadingOrdinal(match[1] + "）");
  }
  const circled = s.match(/([①②③④⑤⑥⑦⑧⑨])/);
  if (circled?.[1]) return parseLeadingOrdinal(circled[1] + "）");
  return undefined;
}

function splitPreferenceClauses(text: string): string[] {
  const normalized = String(text || "")
    .replace(/\r/g, "\n")
    // Turn numbered list markers into clause boundaries. This handles compact
    // snapshots like: "1）中文;2）UTC+9;3）目标-步骤-风险;4）..."
    .replace(/([：:;；。.!?！？]\s*|^|\s)([1-9]|[一二三四五六七八九十]|①|②|③|④|⑤|⑥|⑦|⑧|⑨)[）).、]/g, "\n$2）")
    .replace(/([：:;；。.!?！？]\s*|^|\s)([①②③④⑤⑥⑦⑧⑨])\s*/g, "\n$2")
    // Also handle natural-language list markers such as "第一条：..." or
    // "Rule 4: ..." without assuming any fixed ordinal-to-slot meaning.
    .replace(/([：:;；。.!?！？]\s*|^|\s)(第\s*([0-9]{1,2}|[一二三四五六七八九十]|①|②|③|④|⑤|⑥|⑦|⑧|⑨)\s*(?:条|條|项|項|个|個|则|則|点|點|款)\s*[：:、.)）-]?)/g, "\n$2")
    .replace(/([：:;；。.!?！？]\s*|^|\s)((?:Rule|Item|Preference)\s*#?\s*[0-9]{1,2}\s*[：:、.)）-]?)/gi, "\n$2")
    .replace(/[;；]\s*/g, "\n");
  return normalized
    .split(/\n+/g)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);
}

function hasForgetOrRemovalCue(text: string): boolean {
  return /(遗忘|忘记|忘掉|删掉|删除|移除|去掉|撤销|取消|不再记|不再把|不再将|作废|废弃|forget|remove|drop|delete|discard|revoke)/i.test(
    text,
  );
}

function hasCurrentCue(text: string): boolean {
  return /(当前|现行|仍生效|生效|有效|最新|目前|现在|已更新|更新后|改为|升级|取代|确认|后续|以后|一律|始终|默认|默認|latest|current|active|in force|going forward|from now on)/i.test(
    text,
  );
}

function normalizeTimezone(value: string): string {
  const m = value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/\s+/g, "")
    .match(/\b(UTC|GMT)([+-])0?(\d{1,2})(?::?(\d{2}))?\b/);
  if (!m) return value.toUpperCase().replace(/\s+/g, "");
  const minutes = m[4] && m[4] !== "00" ? `:${m[4]}` : "";
  return `${m[1]}${m[2]}${Number(m[3])}${minutes}`;
}

function pickTimezone(text: string): string | undefined {
  const matches = [...text.matchAll(/\b(?:UTC|GMT)\s*[+-]\s*\d{1,2}(?::?\d{2})?\b/gi)].map((m) =>
    normalizeTimezone(m[0]),
  );
  if (matches.length === 0) return undefined;
  // In replacement statements ("GMT+8 改为 UTC+9"), the new value is normally
  // the last timezone mention.
  if (/(改为|更新为|升级为|切换为|替换为|取代|->|=>|to)/i.test(text)) {
    return matches[matches.length - 1];
  }
  return matches[0];
}

function pickProjectCodeword(text: string): string | undefined {
  const normalized = normalizeText(text);
  const match =
    normalized.match(/(?:当前|現行|current)?\s*(?:项目代号|項目代號|项目代码|項目代碼|代号|代號|codeword|project code)\s*(?:为|為|是|:|：|=)?\s*([^\s,，。；;、]{2,80})/i);
  const raw = match?.[1]?.trim();
  if (!raw) return undefined;
  if (/^(无|無|没有|沒有|不存在|不使用|不再使用|取消|已取消|失效|已失效|none|no)$/i.test(raw)) {
    return undefined;
  }
  if (/(相关|相關|偏好|规则|規則|约束|約束|取消|失效|废弃|作废)/i.test(raw)) {
    return undefined;
  }
  return raw.replace(/[。.!?！？]+$/g, "");
}

function pickTaskLabel(text: string): string | undefined {
  const normalized = normalizeText(text);
  const match =
    normalized.match(/(?:当前|現行|current)?\s*(?:任务标签|任務標籤|任务标识|任務標識|标签|標籤|task tag|task label)\s*(?:为|為|是|:|：|=)?\s*([^\s,，。；;、]{2,80})/i);
  const raw = match?.[1]?.trim();
  if (!raw) return undefined;
  if (/^(无|無|没有|沒有|不存在|不使用|不再使用|取消|已取消|失效|已失效|none|no)$/i.test(raw)) {
    return undefined;
  }
  if (/(相关|相關|偏好|规则|規則|约束|約束|取消|失效|废弃|作废)/i.test(raw)) {
    return undefined;
  }
  return raw.replace(/[。.!?！？]+$/g, "");
}

function addState(
  out: CollaborationPreferenceState[],
  state: Omit<CollaborationPreferenceState, "evidence"> & { evidence?: string },
): void {
  out.push({
    ...state,
    evidence: compactEvidence(state.evidence || state.fact),
  });
}

function parseClauseStates(
  clause: string,
  candidate: CollaborationPreferenceCandidate,
  effectiveAt: number,
): CollaborationPreferenceState[] {
  const s = normalizeText(clause);
  const lower = s.toLowerCase();
  const states: CollaborationPreferenceState[] = [];
  const sourceId = candidate.id;
  const currentBoost = hasCurrentCue(s) ? 0.08 : 0;
  const ordinal = parseLeadingOrdinal(s);
  const referencedOrdinal = parseOrdinalReference(s);

  const ordinalRuleRemoval =
    referencedOrdinal !== undefined &&
    (
      hasForgetOrRemovalCue(s) ||
      /(不再生效|失效|作废|废弃|别再按|不要再按|不算数|不算數|不用遵守|ignore|disable|invalidate|no longer applies)/i.test(s)
    );

  const codewordOrTagRemoval =
    hasForgetOrRemovalCue(s) &&
    /(项目代号|项目代码|代号|任务标签|任务标识|标签|codeword|project code|task tag|label)/i.test(s) &&
    /(规则|约束|約束|偏好|条款|要求|不再生效|失效|作废|废弃|第\s*\d+|第[一二两兩三四五六七八九十]+|rule)/i.test(s);

  const strongNoCodeword =
    /(不应再包含|不应.*使用|不要再使用|不要使用|不得使用|禁止使用|不再使用任何|不使用任何|不使用|不再包含|无项目代号|不存在.*项目代号|项目代号.*失效|代号.*失效|no\s+codeword)/i.test(
      s,
    );

  if (codewordOrTagRemoval && !strongNoCodeword) {
    addState(states, {
      slot: "project-codeword",
      active: false,
      fact: "项目代号相关偏好已取消",
      effectiveAt,
      confidence: 0.95 + currentBoost,
      sourceId,
      evidence: s,
      ordinal,
    });
    addState(states, {
      slot: "task-label",
      active: false,
      fact: "任务标签相关偏好已取消",
      effectiveAt,
      confidence: 0.95 + currentBoost,
      sourceId,
      evidence: s,
      ordinal,
    });
  } else if (strongNoCodeword || /(若旧.*(项目代号|代号).*失效|不应再包含.*项目代号|不再使用.*任务标签)/i.test(s)) {
    const mentionsTaskTag = /(任务标签|任务标识|标签|task tag|label)/i.test(s);
    addState(states, {
      slot: "project-codeword",
      active: true,
      fact: mentionsTaskTag ? "不使用项目代号/任务标签" : "不使用项目代号",
      value: mentionsTaskTag ? "none-project-codeword-or-task-label" : "none-project-codeword",
      effectiveAt,
      confidence: 0.86 + currentBoost,
      sourceId,
      evidence: s,
      ordinal,
    });
    if (mentionsTaskTag) {
      addState(states, {
        slot: "task-label",
        active: true,
        fact: "不使用项目代号/任务标签",
        value: "none-project-codeword-or-task-label",
        effectiveAt,
        confidence: 0.86 + currentBoost,
        sourceId,
        evidence: s,
        ordinal,
      });
    }
  } else if (!hasForgetOrRemovalCue(s)) {
    const codeword = pickProjectCodeword(s);
    if (codeword) {
      addState(states, {
        slot: "project-codeword",
        active: true,
        fact: `项目代号：${codeword}`,
        value: codeword,
        effectiveAt,
        confidence: 0.74 + currentBoost,
        sourceId,
        evidence: s,
        ordinal,
      });
    }
    const taskLabel = pickTaskLabel(s);
    if (taskLabel) {
      addState(states, {
        slot: "task-label",
        active: true,
        fact: `任务标签：${taskLabel}`,
        value: taskLabel,
        effectiveAt,
        confidence: 0.72 + currentBoost,
        sourceId,
        evidence: s,
        ordinal,
      });
    }
  }

  const languageRemoval =
    hasForgetOrRemovalCue(s) && /(中文|语言|語言|回复语言|回答语言|language|chinese)/i.test(s);
  if (languageRemoval && !/(始终|一律|默认|默認|用中文|中文回复|reply in chinese)/i.test(s)) {
    addState(states, {
      slot: "language",
      active: false,
      fact: "回复语言偏好已取消",
      effectiveAt,
      confidence: 0.78 + currentBoost,
      sourceId,
      evidence: s,
      ordinal,
    });
  } else if (/(始终|一律|默认|默認|请用|用|回复|回答|reply in)\s*(中文|chinese)|中文回复|中文回答|用中文回复|reply in chinese/i.test(s)) {
    addState(states, {
      slot: "language",
      active: true,
      fact: "始终中文回复",
      value: "zh",
      effectiveAt,
      confidence: 0.82 + currentBoost,
      sourceId,
      evidence: s,
      ordinal,
    });
  }

  const timezone = pickTimezone(s);
  const timezoneRemoval = hasForgetOrRemovalCue(s) && /(时间|时区|時區|timezone|utc|gmt)/i.test(s);
  if (timezoneRemoval && !timezone) {
    addState(states, {
      slot: "time-format",
      active: false,
      fact: "时间格式偏好已取消",
      effectiveAt,
      confidence: 0.78 + currentBoost,
      sourceId,
      evidence: s,
      ordinal,
    });
  } else if (timezone && /(时间|日期|时区|時區|timezone|utc|gmt|所有时间|全部时间|写)/i.test(s)) {
    addState(states, {
      slot: "time-format",
      active: true,
      fact: `所有时间写 ${timezone}`,
      value: timezone,
      effectiveAt,
      confidence: 0.84 + currentBoost,
      sourceId,
      evidence: s,
      ordinal,
    });
  }

  const planRemoval =
    hasForgetOrRemovalCue(s) &&
    /(目标-步骤-风险|目标\s*[-→>]\s*步骤\s*[-→>]\s*风险|三段|计划输出|输出结构|plan format)/i.test(s);
  if (planRemoval && !/(使用|采用|固定为|保持|必须|一律|默认|默認)/i.test(s)) {
    addState(states, {
      slot: "plan-format",
      active: false,
      fact: "计划输出结构偏好已取消",
      effectiveAt,
      confidence: 0.78 + currentBoost,
      sourceId,
      evidence: s,
      ordinal,
    });
  } else if (/(目标\s*[-→>]\s*步骤\s*[-→>]\s*风险|目標\s*[-→>]\s*步驟\s*[-→>]\s*風險|目标-步骤-风险|目標-步驟-風險)/i.test(s)) {
    addState(states, {
      slot: "plan-format",
      active: true,
      fact: "计划输出用「目标-步骤-风险」三段",
      value: "目标-步骤-风险",
      effectiveAt,
      confidence: 0.84 + currentBoost,
      sourceId,
      evidence: s,
      ordinal,
    });
  }

  const sourceDisclosureRemoval =
    hasForgetOrRemovalCue(s) &&
    /(不提及|不要提及|无需提及|不需要提及|来源说明|提示来源|注入上下文|系统消息|source disclosure|mention(?:ing)? source|injected context|system message)/i.test(s);
  if (sourceDisclosureRemoval && !/(不提及|不要提及|不说|do not mention|don't mention)/i.test(lower)) {
    addState(states, {
      slot: "source-disclosure",
      active: false,
      fact: "来源说明偏好已取消",
      effectiveAt,
      confidence: 0.72 + currentBoost,
      sourceId,
      evidence: s,
      ordinal,
    });
  } else if (
    /(不提及|不要提及|不说|无需提及|不需要提及|do not mention|don't mention).{0,60}(记忆|記憶|注入上下文|提示|系统消息|来源|memory|injected context|prompt|system message|source)/i.test(
      s,
    )
  ) {
    addState(states, {
      slot: "source-disclosure",
      active: true,
      fact: "不提及记忆、注入上下文或提示来源，自然表达",
      value: "no-source-disclosure",
      effectiveAt,
      confidence: 0.78 + currentBoost,
      sourceId,
      evidence: s,
      ordinal,
    });
  }

  if (ordinalRuleRemoval && states.length === 0) {
    addState(states, {
      slot: "project-codeword",
      active: false,
      fact: "__ordinal_removal__",
      effectiveAt,
      confidence: 0.62 + currentBoost,
      sourceId,
      evidence: s,
      ordinal: referencedOrdinal,
      targetOrdinal: referencedOrdinal,
      ordinalRemoval: true,
    });
  }

  return states;
}

function parseCandidateStates(
  candidate: CollaborationPreferenceCandidate,
  index: number,
): CollaborationPreferenceState[] {
  const effectiveAt = candidateEffectiveAt(candidate, index + 1);
  const clauses = splitPreferenceClauses(candidate.text);
  const states = clauses.flatMap((clause) => parseClauseStates(clause, candidate, effectiveAt));
  for (const state of states) state.sourceOrder = index;

  // Some short English preference rows do not split into useful clauses.
  if (states.length === 0 && candidate.text.trim()) {
    const fallbackStates = parseClauseStates(candidate.text, candidate, effectiveAt);
    for (const state of fallbackStates) state.sourceOrder = index;
    return fallbackStates;
  }
  return states;
}

function compareState(a: CollaborationPreferenceState, b: CollaborationPreferenceState): number {
  if (a.effectiveAt !== b.effectiveAt) return b.effectiveAt - a.effectiveAt;
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  return a.evidence.localeCompare(b.evidence);
}

function slotOrder(slot: CollaborationPreferenceSlot): number {
  const idx = SLOT_ORDER.indexOf(slot);
  return idx >= 0 ? idx : SLOT_ORDER.length;
}

function inactiveFactForSlot(slot: CollaborationPreferenceSlot): string {
  switch (slot) {
    case "language":
      return "回复语言偏好已取消";
    case "time-format":
      return "时间格式偏好已取消";
    case "plan-format":
      return "计划输出结构偏好已取消";
    case "source-disclosure":
      return "来源说明偏好已取消";
    case "project-codeword":
      return "项目代号相关偏好已取消";
    case "task-label":
      return "任务标签相关偏好已取消";
  }
}

function expandOrdinalRemovals(states: CollaborationPreferenceState[]): CollaborationPreferenceState[] {
  const expanded: CollaborationPreferenceState[] = [];
  for (const state of states) {
    if (!state.ordinalRemoval) {
      expanded.push(state);
      continue;
    }
    const targetOrdinal = state.targetOrdinal ?? state.ordinal;
    if (!targetOrdinal) continue;
    const priorTargetStates = states.filter((candidate) =>
      !candidate.ordinalRemoval &&
      candidate.ordinal === targetOrdinal &&
      candidate.effectiveAt < state.effectiveAt,
    );
    if (priorTargetStates.length === 0) continue;
    const latestEffectiveAt = Math.max(...priorTargetStates.map((candidate) => candidate.effectiveAt));
    const latestAtSameTime = priorTargetStates.filter((candidate) => candidate.effectiveAt === latestEffectiveAt);
    const latestSourceOrder = Math.max(...latestAtSameTime.map((candidate) => candidate.sourceOrder ?? -1));
    const targetStates = latestAtSameTime.filter((candidate) => (candidate.sourceOrder ?? -1) === latestSourceOrder);
    const targetSlots = [...new Set(targetStates.map((candidate) => candidate.slot))];
    for (const slot of targetSlots) {
      expanded.push({
        ...state,
        slot,
        active: false,
        fact: inactiveFactForSlot(slot),
        value: undefined,
        ordinal: targetOrdinal,
        targetOrdinal,
        ordinalRemoval: false,
      });
    }
  }
  return expanded;
}

function combinedProjectCodewordFact(slots: Partial<Record<CollaborationPreferenceSlot, CollaborationPreferenceState>>): string | null {
  const codeword = slots["project-codeword"];
  const label = slots["task-label"];
  if (!codeword?.active && !label?.active) return null;
  if (codeword?.active && label?.active) return "不使用项目代号/任务标签";
  if (codeword?.active) return codeword.fact || "不使用项目代号";
  return label?.fact || "不使用任务标签";
}

export function resolveCollaborationPreferences(
  candidates: CollaborationPreferenceCandidate[],
): ResolvedCollaborationPreferences {
  const allStates = expandOrdinalRemovals(
    candidates.flatMap((candidate, index) => parseCandidateStates(candidate, index)),
  );
  const bySlot = new Map<CollaborationPreferenceSlot, CollaborationPreferenceState[]>();
  for (const state of allStates) {
    const rows = bySlot.get(state.slot) || [];
    rows.push(state);
    bySlot.set(state.slot, rows);
  }

  const slots: Partial<Record<CollaborationPreferenceSlot, CollaborationPreferenceState>> = {};
  for (const [slot, states] of bySlot) {
    const winner = [...states].sort(compareState)[0];
    if (winner) slots[slot] = winner;
  }

  const facts: string[] = [];
  const emitted = new Set<string>();
  for (const slot of SLOT_ORDER) {
    if (slot === "project-codeword" || slot === "task-label") continue;
    const state = slots[slot];
    if (!state?.active) continue;
    const fact = state.fact.trim();
    if (!fact || emitted.has(fact)) continue;
    facts.push(fact);
    emitted.add(fact);
  }
  const projectFact = combinedProjectCodewordFact(slots);
  if (projectFact && !emitted.has(projectFact)) facts.push(projectFact);

  const active = Object.values(slots)
    .filter((x): x is CollaborationPreferenceState => Boolean(x) && x.active)
    .sort((a, b) => slotOrder(a.slot) - slotOrder(b.slot));
  const inactive = Object.values(slots)
    .filter((x): x is CollaborationPreferenceState => Boolean(x) && !x.active)
    .sort((a, b) => slotOrder(a.slot) - slotOrder(b.slot));

  return { facts, active, inactive, slots };
}

export function formatResolvedCollaborationPreferencesBlock(
  resolved: ResolvedCollaborationPreferences,
): string {
  const facts = resolved.facts.length > 0
    ? resolved.facts.map((fact) => `- ${fact}`).join("\n")
    : "- 当前没有可输出的生效协作偏好";
  return [
    "<memory-governor-output-preferences>",
    "[CONTROLLED SUMMARY — current collaboration preferences synthesized by semantic slot resolution.]",
    "Current explicit collaboration preferences:",
    facts,
    "- Apply only the active preferences above when answering current-preference/rule questions.",
    "- If asked which rules are active, answer from the active preference list only.",
    "- Apply them naturally; do not describe this wrapper.",
    "</memory-governor-output-preferences>",
    "",
  ].join("\n");
}
