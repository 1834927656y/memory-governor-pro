import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJson } from "./fsx.js";
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
import { createLogger } from "./logger.js";

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function refinedSnapshotPath(stateDir: string, dateKey: string): string {
  return path.join(stateDir, "snapshots", `${dateKey}.json`);
}

function rotationStatePath(stateDir: string): string {
  return path.join(stateDir, "rotation-state.json");
}

function appendAudit(stateDir: string, event: string, data: Record<string, unknown>): void {
  try {
    createLogger(stateDir, `rollback-all-refined-${Date.now()}`).info(event, data);
  } catch {
    /* ignore */
  }
}

/**
 * 所有「需要参与回滚」的日历日：rotation-state 已登记日 ∪ snapshots 下存在 JSON 的日，升序去重。
 */
export function collectAllRefinedDateKeys(stateDir: string): string[] {
  const fromRotation = new Set<string>();
  const st = readJson<{ rotatedDays?: Record<string, unknown> }>(
    rotationStatePath(stateDir),
    { rotatedDays: {} },
  );
  for (const k of Object.keys(st.rotatedDays || {})) {
    const t = k.trim();
    if (DATE_KEY_RE.test(t)) fromRotation.add(t);
  }

  const snapDir = path.join(stateDir, "snapshots");
  if (fs.existsSync(snapDir)) {
    for (const name of fs.readdirSync(snapDir)) {
      if (!name.endsWith(".json")) continue;
      const base = name.slice(0, -5);
      const t = base.trim();
      if (DATE_KEY_RE.test(t)) fromRotation.add(t);
    }
  }

  return [...fromRotation].sort();
}

export interface RollbackAllRefinedOpts {
  dryRun: boolean;
  /** 为 false 时不从归档恢复会话（仅清向量 / 台账 / 快照） */
  restoreSessions: boolean;
  restoreMergeTargets: boolean;
  deleteSnapshotsAfterPurge: boolean;
  /** 删除 rotation 台账中记载的 archive 副本（及空目录）；默认 true */
  deleteArchivesAfterRollback: boolean;
  /** 删除 state/pre-refine-snapshots/<dateKey>/ 整目录；默认 true */
  deletePreRefineAfterRollback: boolean;
}

export interface RollbackAllRefinedStep {
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

export interface RollbackAllRefinedResult {
  agentId: string;
  dryRun: boolean;
  dateKeysAsc: string[];
  dateKeysRollbackOrder: string[];
  steps: RollbackAllRefinedStep[];
  warnings: string[];
}

/**
 * 将当前 agent 下已精炼内容整体回滚到「未精炼」近似状态：
 * 按日（新→旧）恢复归档会话、按 snapshots 删向量、清除 rotation 台账、可选删当日精炼快照。
 * 仅 ingest、无 rotation 台账的日期仍会 purge 向量并删快照。
 */
export async function rollbackAllRefined(
  config: Config,
  opts: RollbackAllRefinedOpts,
): Promise<RollbackAllRefinedResult> {
  ensureDir(config.stateDir);
  const dateKeysAsc = collectAllRefinedDateKeys(config.stateDir);
  if (dateKeysAsc.length === 0) {
    return {
      agentId: config.agentId,
      dryRun: opts.dryRun,
      dateKeysAsc: [],
      dateKeysRollbackOrder: [],
      steps: [],
      warnings: ["rotation-state 与 snapshots 均未发现可回滚的日历日。"],
    };
  }

  const dateKeysRollbackOrder = [...dateKeysAsc].reverse();
  const warnings: string[] = [];
  const steps: RollbackAllRefinedStep[] = [];

  for (const dateKey of dateKeysRollbackOrder) {
    assertValidDateKey(dateKey);
    const step: RollbackAllRefinedStep = { dateKey };
    try {
      const hasRotation = hasRotationDayRecord(config.stateDir, dateKey);
      const rec = readRotationDayRecord(config.stateDir, dateKey);
      const snapPath = refinedSnapshotPath(config.stateDir, dateKey);
      const hasSnapshot = fs.existsSync(snapPath);

      if (opts.restoreSessions && hasRotation && rec?.changes?.length) {
        step.restore = restoreSessionsFromArchive(config, dateKey, {
          dryRun: opts.dryRun,
          backupCurrent: true,
          restoreMergeTargetsFromPreSnapshot: opts.restoreMergeTargets,
        });
      } else if (opts.restoreSessions && hasRotation && !rec?.changes?.length) {
        step.skippedRestore = "台账无 changes，跳过归档恢复";
        warnings.push(`${dateKey}: rotation 记录存在但 changes 为空，未做归档恢复。`);
      } else if (opts.restoreSessions && !hasRotation) {
        step.skippedRestore = "无 rotation 台账（可能仅为 ingest-only），跳过归档恢复";
      } else if (!opts.restoreSessions) {
        step.skippedRestore = "--skip-restore";
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
        step.skippedPurge = "缺少 snapshots/<日>.json，无法按 id 删除向量";
        warnings.push(`${dateKey}: 无精炼快照，跳过向量 purge。`);
      }

      const shouldCleanArchives =
        opts.deleteArchivesAfterRollback &&
        Boolean(rec?.changes?.length) &&
        !(opts.restoreSessions === false);
      /** 仅删台账记载的 preRefineSnapshotDir，不扫 pre-refine-snapshots/<日>/ 整树 */
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
        appendAudit(config.stateDir, "rollback.all_refined.date", { dateKey });
      }
    } catch (e) {
      step.error = String(e);
    }
    steps.push(step);
  }

  return {
    agentId: config.agentId,
    dryRun: opts.dryRun,
    dateKeysAsc,
    dateKeysRollbackOrder,
    steps,
    warnings,
  };
}
