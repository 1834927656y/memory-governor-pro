import { toToonBlock } from "./toon.js";

export type InjectionLayer = "self-improvement" | "memory-lancedb-pro" | "governance";

export type LayerBudgetConfig = {
  selfImprovement: number;
  memory: number;
  governance: number;
};

export type LayeredPart = {
  source: string;
  layer: InjectionLayer;
  text: string;
  priority?: number;
};

export function resolveLayerBudgetConfig(raw: unknown): LayerBudgetConfig {
  const r = (raw && typeof raw === "object") ? (raw as Record<string, unknown>) : {};
  const si = typeof r.selfImprovement === "number" ? r.selfImprovement : 0.2;
  const mm = typeof r.memory === "number" ? r.memory : 0.5;
  const gv = typeof r.governance === "number" ? r.governance : 0.3;
  const sum = Math.max(0.0001, si + mm + gv);
  return {
    selfImprovement: si / sum,
    memory: mm / sum,
    governance: gv / sum,
  };
}

function trimToChars(text: string, maxChars: number): string {
  if (!text || maxChars <= 0) return "";
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

export function enforceLayerBudgets(
  parts: LayeredPart[],
  totalChars: number,
  budgets: LayerBudgetConfig,
): LayeredPart[] {
  const cap = Math.max(600, totalChars);
  const byLayer: Record<InjectionLayer, LayeredPart[]> = {
    "self-improvement": [],
    "memory-lancedb-pro": [],
    "governance": [],
  };
  for (const p of parts) {
    byLayer[p.layer].push(p);
  }
  for (const layer of Object.keys(byLayer) as InjectionLayer[]) {
    byLayer[layer].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  const layerCap: Record<InjectionLayer, number> = {
    "self-improvement": Math.floor(cap * budgets.selfImprovement),
    "memory-lancedb-pro": Math.floor(cap * budgets.memory),
    "governance": Math.floor(cap * budgets.governance),
  };

  const out: LayeredPart[] = [];
  for (const layer of ["self-improvement", "memory-lancedb-pro", "governance"] as InjectionLayer[]) {
    let used = 0;
    for (const p of byLayer[layer]) {
      const remain = layerCap[layer] - used;
      if (remain <= 0) break;
      const text = trimToChars(p.text, remain);
      if (!text.trim()) continue;
      out.push({ ...p, text });
      used += text.length;
    }
  }
  return out;
}

export function formatGovernanceRows(rows: Array<Record<string, unknown>>, maxSummaryChars = 220): string {
  if (!rows.length) return "";
  const shortRows = rows.map((r) => ({
    type: typeof r.type === "string" ? r.type : "fact",
    summary: String(r.summary || r.text || "").slice(0, maxSummaryChars),
    date: typeof r.date === "string" ? r.date : "",
    tags: Array.isArray(r.tags) ? (r.tags as string[]).filter((x) => typeof x === "string") : [],
  }));
  return toToonBlock(shortRows);
}

export function selectSiKeywordRules(
  queryText: string,
  rules: Array<{ id: string; text: string; summary: string; tags: string[]; priority?: number }>,
  maxItems = 3,
): Array<{ id: string; text: string; summary: string; tags: string[]; priority?: number }> {
  const q = String(queryText || "").toLowerCase();
  if (!q.trim()) return [];
  const triggers = ["语音", "voice", "tts"];
  const tokens = new Set(
    q.split(/[\s,.;:!?，。；：！？()\[\]{}<>"'`/\\|+-]+/g).map((x) => x.trim()).filter((x) => x.length >= 2),
  );
  for (const t of triggers) tokens.add(t.toLowerCase());

  return rules
    .map((r) => {
      const hay = `${r.summary}\n${r.text}\n${(r.tags || []).join(" ")}`.toLowerCase();
      let score = 0;
      for (const tk of tokens) {
        if (!tk) continue;
        if (q.includes(tk) && hay.includes(tk)) score += 2;
      }
      if (q.includes("语音") && (hay.includes("语音") || hay.includes("tts") || hay.includes("voice"))) {
        score += 5;
      }
      return { r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems)
    .map((x) => x.r);
}
