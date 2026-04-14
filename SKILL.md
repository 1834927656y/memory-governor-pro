---
name: memory-governor-pro
description: TypeScript memory-governance skill with memory-lancedb-pro and bundled self-improvement (same repo).
---

# memory-governor-pro

This skill implements:

1. Daily 24:00 job for current agent only.
2. Threshold flush jobs at 50/70/85 context usage.
3. Same-day multi-session aggregation.
4. Direct LanceDB writes (no `memory/YYYY-MM-DD.md` persistence).
5. Strict session rotation:
   - delete only if a whole file belongs to date D
   - otherwise rewrite and remove only D messages.
6. Bootstrap backfill for historical sessions, with deletion allowed.
7. Self-improvement **rules** in the **main** MemoryStore (`opencl_si_rule`); workspace markdown only for `SI_IMPLEMENTATION_AUDIT.md` trail.
8. TOON-first injection block generation (JSON fallback).
9. Governance with agent-only-day exclusion from hit/degrade/retire calculations.
10. Default layout: OpenClaw plugin + governor CLI + bundled self-improvement in one tree; optional `upstream/memory-lancedb-pro` for forked layouts.
   - Self-improvement skill path: `bundled/self-improvement` (see `INTEGRATION.md` there)
11. Layered injection (runtime):
   - self-improvement: most permissive keyword-triggered recall
   - memory-lancedb-pro: existing recall behavior
   - governance: strict recall with low quota
12. Post-task rotation:
   - every `agent_end` can trigger rotate for current day
   - session directory normalized to a single active `*.jsonl` (unrefined content only)

## Important Safety Rules

- Single injector only: memory-lancedb autoRecall.
- This skill never performs per-turn direct injection.
- Session deletion runs only after successful ingestion and audit writes.
- Audit / rollback CLI: `audit-inspect`, `audit-restore-sessions`, `audit-clear-rotation`, `audit-purge-memories`; `rollback-first-install-backfill`（按首装 `rotatedDateKeysAsc` 逆序一键回滚，旧版无记录时用 `--dates`）；可选 `preRefineSessionSnapshot` 以便恢复合并目标。
- Recommended governor config overrides:
  - `rotateOnAgentEnd=true`
  - `rotateOnAgentEndCooldownMs=120000`
  - `runtimeVectorOnlyRecall=true`
  - `injectionLayerBudget={ selfImprovement:0.2, memory:0.5, governance:0.3 }`

## Install / Remove (gateway runtime)

- Install/init (relative path, cross-env):
  - `node scripts/manage-plugin-install.mjs install --agents main`
- Uninstall (remove load path + clear enabledAgents):
  - `node scripts/manage-plugin-install.mjs uninstall`
- Uninstall + disable plugin entry:
  - `node scripts/manage-plugin-install.mjs uninstall --disable`

Notes:
- Plugin load path is `skills/memory-governor-pro` (no absolute path).
- Agent enable list is stored in `openclaw.json` at:
  - `plugins.entries.memory-lancedb-pro.config.governor.enabledAgents`

