import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson, ensureDir } from "./fsx.js";
import type { Config } from "../types.js";
import {
  assertValidDateKey,
  cleanupRollbackArtifactsOnDisk,
  clearRotationDayRecord,
  hasRotationDayRecord,
  purgeGovernorMemoriesForDate,
  readRotationDayRecord,
  restoreSessionsFromArchive,
  type RollbackDiskCleanupResult,
} from "./audit-rollback.js";
import {
  firstInstallBootstrapStatePath,
  readFirstInstallMarker,
} from "./first-install-marker.js";
import { createLogger } from "./logger.js";

function appendAudit(stateDir: string, event: string, data: Record<string, unknown>): void {
  try {
    createLogger(stateDir, `rollback-first-install-${Date.now()}`).info(event, data);
  } catch {
    /* ignore */
  }
}

function parseDatesCsv(raw: string | undefined): string[] | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function readGovernorEnabledAgentIds(openclawConfigPath: string): string[] {
  const cfg = readJson<Record<string, unknown>>(openclawConfigPath, {});
  const plugins = cfg.plugins as Record<string, unknown> | undefined;
  const entries = plugins?.entries as Record<string, unknown> | undefined;
  if (!entries || typeof entries !== "object") return [];
  for (const key of ["memory-lancedb-pro", "memory-governor-pro"]) {
    const entry = entries[key] as Record<string, unknown> | undefined;
    const plugConfig = entry?.config as Record<string, unknown> | undefined;
    const gov = plugConfig?.governor as Record<string, unknown> | undefined;
    const list = gov?.enabledAgents;
    if (Array.isArray(list) && list.length > 0) {
      const ids = list
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim());
      return [...new Set(ids)].sort();
    }
  }
  return [];
}

export interface RollbackFirstInstallOpts {
  dryRun: boolean;
  datesOverride?: string[];
  restoreMergeTargets: boolean;
  deleteSnapshotsAfterPurge: boolean;
  resetMarker: boolean;
  deleteArchivesAfterRollback: boolean;
  deletePreRefineAfterRollback: boolean;
}

export interface RollbackFirstInstallPerDateStep {
  dateKey: string;
  restore?: unknown;
  purge?: unknown;
  diskCleanup?: RollbackDiskCleanupResult;
  clearRotation?: unknown;
  snapshotDeleted?: boolean;
  skippedRestore?: string;
  skippedPurge?: string;
  error?: string;
}

export interface RollbackFirstInstallResult {
  agentId: string;
  dryRun: boolean;
  dateKeysAsc: string[];
  dateKeysRollbackOrder: string[];
  steps: RollbackFirstInstallPerDateStep[];
  markerReset?: boolean;
  warnings: string[];
}

function refinedSnapshotPath(stateDir: string, dateKey: string): string {
  return path.join(stateDir, "snapshots", `${dateKey}.json`);
}

export async function rollbackFirstInstallBackfill(
  config: Config,
  opts: RollbackFirstInstallOpts,
): Promise<RollbackFirstInstallResult> {
  ensureDir(config.stateDir);
  const markerPath = firstInstallBootstrapStatePath(config.stateDir);
  const marker = readFirstInstallMarker(config.stateDir);

  let dateKeysAsc =
    opts.datesOverride && opts.datesOverride.length > 0
      ? [...opts.datesOverride]
      : marker.rotatedDateKeysAsc;

  if (!dateKeysAsc?.length) {
    throw new Error(
      `缺少回滚日期列表：${markerPath} 中无 rotatedDateKeysAsc（旧版首装未记录）。请使用 --dates YYYY-MM-DD,... 显式指定要逆序回滚的日历日。`,
    );
  }

  for (const dk of dateKeysAsc) assertValidDateKey(dk.trim());
  dateKeysAsc = [...new Set(dateKeysAsc.map((d) => d.trim()))].sort();
  const dateKeysRollbackOrder = [...dateKeysAsc].reverse();

  const warnings: string[] = [];
  if (!marker.done && (!opts.datesOverride || opts.datesOverride.length === 0)) {
    warnings.push(
      "首装标记 done 不为 true；若仍需回滚，请确认 --dates 范围正确（仍建议先 audit-inspect 核对）。",
    );
  }

  const steps: RollbackFirstInstallPerDateStep[] = [];

  for (const dateKey of dateKeysRollbackOrder) {
    const step: RollbackFirstInstallPerDateStep = { dateKey };
    try {
      const hasRotation = hasRotationDayRecord(config.stateDir, dateKey);
      const rec = readRotationDayRecord(config.stateDir, dateKey);
      const snapPath = refinedSnapshotPath(config.stateDir, dateKey);
      const hasSnapshot = fs.existsSync(snapPath);

      if (hasRotation) {
        step.restore = restoreSessionsFromArchive(config, dateKey, {
          dryRun: opts.dryRun,
          backupCurrent: true,
          restoreMergeTargetsFromPreSnapshot: opts.restoreMergeTargets,
        });
      } else {
        step.skippedRestore = "rotation-state 中无该日记录";
        warnings.push(`${dateKey}: 无 rotation 台账，跳过从归档恢复会话。`);
      }

      if (hasSnapshot) {
        try {
          step.purge = await purgeGovernorMemoriesForDate(config, dateKey, opts.dryRun);
        } catch (e) {
          step.error = `purge: ${String(e)}`;
          steps.push(step);
          continue;
        }
      } else {
        step.skippedPurge = "缺少精炼快照，无法按 id 删除治理向量";
        warnings.push(`${dateKey}: 无 snapshots/${dateKey}.json，跳过向量库 purge。`);
      }

      const shouldCleanArchives =
        opts.deleteArchivesAfterRollback && Boolean(rec?.changes?.length) && hasRotation;
      const shouldCleanPre =
        opts.deletePreRefineAfterRollback &&
        typeof rec?.preRefineSnapshotDir === "string" &&
        rec.preRefineSnapshotDir.trim().length > 0;
      if (shouldCleanArchives || shouldCleanPre) {
        step.diskCleanup = cleanupRollbackArtifactsOnDisk(config, dateKey, rec, {
          dryRun: opts.dryRun,
          deleteArchiveCopies: shouldCleanArchives,
          deletePreRefineForDateKey: shouldCleanPre,
        });
        for (const w of step.diskCleanup.warnings) warnings.push(`${dateKey}: ${w}`);
      }

      if (hasRotation) {
        step.clearRotation = clearRotationDayRecord(config, dateKey, opts.dryRun);
      }

      if (!opts.dryRun && opts.deleteSnapshotsAfterPurge && fs.existsSync(snapPath)) {
        fs.unlinkSync(snapPath);
        step.snapshotDeleted = true;
      }

      if (!opts.dryRun) {
        appendAudit(config.stateDir, "rollback.first_install.date", { dateKey });
      }
    } catch (e) {
      step.error = String(e);
    }
    steps.push(step);
  }

  let markerReset: boolean | undefined;
  if (!opts.dryRun && opts.resetMarker && fs.existsSync(markerPath)) {
    writeJson(markerPath, {
      done: false,
      at: new Date().toISOString(),
      note: "reset_by_rollback_first_install",
      rotatedDateKeysAsc: [],
    });
    markerReset = true;
    appendAudit(config.stateDir, "rollback.first_install.marker_reset", {});
  }

  return {
    agentId: config.agentId,
    dryRun: opts.dryRun,
    dateKeysAsc,
    dateKeysRollbackOrder,
    steps,
    markerReset,
    warnings,
  };
}

export function resolveRollbackDatesFromOpts(datesCsv: string | undefined): string[] | undefined {
  const parsed = parseDatesCsv(datesCsv);
  if (!parsed?.length) return undefined;
  return parsed;
}
