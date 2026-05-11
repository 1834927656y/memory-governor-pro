/**
 * Per-stream injection tuning: character budgets (via governor.injectionLayerBudget),
 * semantic gates, and governance strict-retrieval limits.
 * Config lives under `governor.injectionStreams` in openclaw.json.
 */

export type MemoryRecallInjectionStreamConfig = {
  /** When false, skip lexical/score gating (legacy behavior). Default true. */
  semanticGateEnabled?: boolean;
  /**
   * Minimum fraction of query alignment tokens found in memory text (0–1).
   * Short queries (&lt;4 chars) skip this gate.
   */
  minLexicalCoverage?: number;
  /** If set, memories with retriever score ≥ this pass even when lexical is low. */
  minRetrieverScore?: number;
  /** Re-rank blend: (1-w)*normScore + w*lexicalCoverage */
  lexicalRankWeight?: number;
  /**
   * If semantic gating removes every candidate, fall back to top-N by retriever score only (0 = no fallback).
   */
  fallbackTopNWhenAllFiltered?: number;
};

export type GovernanceInjectionStreamConfig = {
  strictTopK?: number;
  /** Passed to queryMemoriesStrict token-overlap filter */
  minQueryTokenOverlap?: number;
};

export type SelfImprovementInjectionStreamConfig = {
  /** Hard cap on reminder blob before XML wrap (saves layer budget for memory). */
  reminderMaxChars?: number;
};

export type InjectionStreamsConfig = {
  selfImprovement?: SelfImprovementInjectionStreamConfig;
  memoryRecall?: MemoryRecallInjectionStreamConfig;
  governance?: GovernanceInjectionStreamConfig;
};

export type ResolvedInjectionStreams = {
  selfImprovement: { reminderMaxChars: number };
  memoryRecall: {
    semanticGateEnabled: boolean;
    minLexicalCoverage: number;
    minRetrieverScore?: number;
    lexicalRankWeight: number;
    fallbackTopNWhenAllFiltered: number;
  };
  governance: Required<GovernanceInjectionStreamConfig>;
};

const DEFAULT_MEMORY: ResolvedInjectionStreams["memoryRecall"] = {
  semanticGateEnabled: true,
  minLexicalCoverage: 0.07,
  lexicalRankWeight: 0.45,
  fallbackTopNWhenAllFiltered: 1,
};

const DEFAULT_GOV: ResolvedInjectionStreams["governance"] = {
  strictTopK: 2,
  minQueryTokenOverlap: 2,
};

const DEFAULT_SI: ResolvedInjectionStreams["selfImprovement"] = {
  reminderMaxChars: 720,
};

export function resolveInjectionStreams(
  governor: Record<string, unknown> | undefined,
): ResolvedInjectionStreams {
  const raw = governor?.injectionStreams;
  const m =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).memoryRecall
      : undefined;
  const g =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).governance
      : undefined;
  const s =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).selfImprovement
      : undefined;

  const memObj = m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
  const govObj = g && typeof g === "object" && !Array.isArray(g) ? (g as Record<string, unknown>) : {};
  const siObj = s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : {};

  const minR = memObj.minRetrieverScore;
  const minRetrieverScore =
    typeof minR === "number" && Number.isFinite(minR) ? Math.max(0, Math.min(1, minR)) : undefined;
  return {
    selfImprovement: {
      reminderMaxChars:
        typeof siObj.reminderMaxChars === "number" && Number.isFinite(siObj.reminderMaxChars)
          ? Math.max(120, Math.min(4000, Math.floor(siObj.reminderMaxChars)))
          : DEFAULT_SI.reminderMaxChars,
    },
    memoryRecall: {
      semanticGateEnabled: memObj.semanticGateEnabled !== false,
      minLexicalCoverage:
        typeof memObj.minLexicalCoverage === "number" && Number.isFinite(memObj.minLexicalCoverage)
          ? Math.min(0.95, Math.max(0, memObj.minLexicalCoverage))
          : DEFAULT_MEMORY.minLexicalCoverage,
      ...(minRetrieverScore !== undefined ? { minRetrieverScore } : {}),
      lexicalRankWeight:
        typeof memObj.lexicalRankWeight === "number" && Number.isFinite(memObj.lexicalRankWeight)
          ? Math.min(0.95, Math.max(0.05, memObj.lexicalRankWeight))
          : DEFAULT_MEMORY.lexicalRankWeight,
      fallbackTopNWhenAllFiltered:
        typeof memObj.fallbackTopNWhenAllFiltered === "number" && Number.isFinite(memObj.fallbackTopNWhenAllFiltered)
          ? Math.max(0, Math.min(5, Math.floor(memObj.fallbackTopNWhenAllFiltered)))
          : DEFAULT_MEMORY.fallbackTopNWhenAllFiltered,
    },
    governance: {
      strictTopK:
        typeof govObj.strictTopK === "number" && Number.isFinite(govObj.strictTopK)
          ? Math.max(1, Math.min(12, Math.floor(govObj.strictTopK)))
          : DEFAULT_GOV.strictTopK,
      minQueryTokenOverlap:
        typeof govObj.minQueryTokenOverlap === "number" && Number.isFinite(govObj.minQueryTokenOverlap)
          ? Math.max(1, Math.min(20, Math.floor(govObj.minQueryTokenOverlap)))
          : DEFAULT_GOV.minQueryTokenOverlap,
    },
  };
}
