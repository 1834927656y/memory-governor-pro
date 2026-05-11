import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryStore } from "./store.js";
import { readBundledSelfImprovementAsset } from "./self-improvement/bundled-resolve.js";
import {
  nextSiHumanId,
  storeSelfImprovementRuleInLance,
  type SiKind,
} from "./self-improvement/lance-rules.js";

/** Audit log only — rules are in LanceDB (`opencl_si_rule`). */
export const SI_IMPLEMENTATION_AUDIT_FILE = "SI_IMPLEMENTATION_AUDIT.md";

export const DEFAULT_LEARNINGS_TEMPLATE = `# LEARNINGS.md (reference only)

**Source of truth:** self-improvement **learning** rules are stored in **LanceDB** (\`opencl_si_rule\`, \`si_kind=learning\`).

Use the \`self_improvement_log\` tool or \`memory_recall\` / \`memory_list\` with scope. This file is not updated by the plugin.

**Implementation audit:** see \`${SI_IMPLEMENTATION_AUDIT_FILE}\`.
`;

export const DEFAULT_ERRORS_TEMPLATE = `# ERRORS.md (reference only)

**Source of truth:** self-improvement **error** rules are stored in **LanceDB** (\`opencl_si_rule\`, \`si_kind=error\`).

Use \`self_improvement_log\` or memory tools. This file is not updated by the plugin.

**Implementation audit:** see \`${SI_IMPLEMENTATION_AUDIT_FILE}\`.
`;

export const DEFAULT_FEATURE_REQUESTS_TEMPLATE = `# FEATURE_REQUESTS.md (reference only)

Track capability gaps in **LanceDB** via \`self_improvement_log\` (type learning, category \`feature_request\`) or dedicated memory workflow.

**Implementation audit:** see \`${SI_IMPLEMENTATION_AUDIT_FILE}\`.
`;

export const DEFAULT_SI_AUDIT_TEMPLATE = `# Self-improvement — implementation audit

**Canonical rules:** LanceDB (\`opencl_si_rule\`).

Append-only lines: \`ISO-8601 | EVENT | human_id | memory_id | kind | si_status | summary\`

---
`;

async function resolveInitialTemplate(
  assetName: string,
  fallback: string,
): Promise<string> {
  const fromBundled = await readBundledSelfImprovementAsset(assetName);
  const t = fromBundled?.trim();
  return t && t.length > 0 ? t : fallback.trim();
}

export async function ensureSelfImprovementLearningFiles(baseDir: string): Promise<void> {
  const learningsDir = join(baseDir, ".learnings");
  await mkdir(learningsDir, { recursive: true });

  const ensureFile = async (filePath: string, content: string) => {
    try {
      const existing = await readFile(filePath, "utf-8");
      if (existing.trim().length > 0) return;
    } catch {
      // write default below
    }
    await writeFile(filePath, `${content.trim()}\n`, "utf-8");
  };

  await ensureFile(
    join(learningsDir, "LEARNINGS.md"),
    await resolveInitialTemplate("LEARNINGS.md", DEFAULT_LEARNINGS_TEMPLATE),
  );
  await ensureFile(
    join(learningsDir, "ERRORS.md"),
    await resolveInitialTemplate("ERRORS.md", DEFAULT_ERRORS_TEMPLATE),
  );
  await ensureFile(
    join(learningsDir, "FEATURE_REQUESTS.md"),
    await resolveInitialTemplate("FEATURE_REQUESTS.md", DEFAULT_FEATURE_REQUESTS_TEMPLATE),
  );
  await ensureFile(
    join(learningsDir, SI_IMPLEMENTATION_AUDIT_FILE),
    (await readBundledSelfImprovementAsset("SI_IMPLEMENTATION_AUDIT.md"))?.trim() ||
      DEFAULT_SI_AUDIT_TEMPLATE,
  );
}

export interface SelfImprovementLanceWriteContext {
  store: MemoryStore;
  embedder: { embedPassage: (text: string) => Promise<number[]> };
  scope: string;
  scopeFilter: string[] | undefined;
  agentId: string;
}

export interface AppendSelfImprovementEntryParams {
  baseDir: string;
  type: SiKind;
  summary: string;
  details?: string;
  suggestedAction?: string;
  category?: string;
  area?: string;
  priority?: string;
  status?: string;
  source?: string;
  lance: SelfImprovementLanceWriteContext;
}

function clipAuditSummary(s: string, max = 120): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export async function appendSelfImprovementAuditLine(
  baseDir: string,
  parts: {
    event: "CREATE" | "IMPLEMENTED" | "PROMOTED_SKILL" | "WONT_FIX";
    humanId: string;
    memoryId: string;
    kind: SiKind;
    siStatus: string;
    summary: string;
  },
): Promise<void> {
  await ensureSelfImprovementLearningFiles(baseDir);
  const p = join(baseDir, ".learnings", SI_IMPLEMENTATION_AUDIT_FILE);
  const line = [
    new Date().toISOString(),
    parts.event,
    parts.humanId,
    parts.memoryId,
    parts.kind,
    parts.siStatus,
    clipAuditSummary(parts.summary),
  ].join(" | ");
  await appendFile(p, `${line}\n`, "utf-8");
}

export async function appendSelfImprovementEntry(params: AppendSelfImprovementEntryParams): Promise<{
  id: string;
  memoryId: string;
  auditPath: string;
}> {
  const {
    baseDir,
    type,
    summary,
    details = "",
    suggestedAction = "",
    category = "best_practice",
    area = "config",
    priority = "medium",
    status = "pending",
    source = "memory-lancedb-pro/self_improvement_log",
    lance,
  } = params;

  await ensureSelfImprovementLearningFiles(baseDir);
  const humanId = await nextSiHumanId(lance.store, lance.scopeFilter, type);
  const { memoryId } = await storeSelfImprovementRuleInLance({
    store: lance.store,
    embedder: lance.embedder,
    scope: lance.scope,
    scopeFilter: lance.scopeFilter,
    agentId: lance.agentId,
    kind: type,
    humanId,
    summary,
    details,
    suggestedAction,
    category,
    area,
    priority,
    status,
    source,
  });

  const auditPath = join(baseDir, ".learnings", SI_IMPLEMENTATION_AUDIT_FILE);
  await appendSelfImprovementAuditLine(baseDir, {
    event: "CREATE",
    humanId,
    memoryId,
    kind: type,
    siStatus: status,
    summary,
  });

  return { id: humanId, memoryId, auditPath };
}
