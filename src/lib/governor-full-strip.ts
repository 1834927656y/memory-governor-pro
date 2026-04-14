/**
 * Governor 全量剥皮：与会话日历日终轮转解耦。
 * - 将全部会话转录按日历桶精炼并写入记忆库；
 * - 将当前全部 jsonl 复制到 archiveRoot/governor-full/<runId>/；
 * - 删除现有转录，仅保留一个新的空 jsonl；
 * - 将 sessions.json 全部条目收敛到该文件；
 * - 不写 state/snapshots/*.json，仅追加 audit.jsonl。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "../types.js";
import type { Logger } from "./logger.js";
import { aggregateByDate, listSessionFiles, stableMemoryId } from "./jsonlSessions.js";
import { refineBucket } from "./refiner.js";
import { collectSelfImprovingRecords } from "./selfImprovingIngest.js";
import { upsertMemories } from "./lancedbStore.js";
import { upsertGovernanceStateFromRefined } from "./governance.js";
import { ensureDir } from "./fsx.js";
import { syncOpenClawSessionsJsonAfterRotation } from "./sessions-json-sync.js";
import { runOpenclawSessionsCleanup } from "./daily-rotate.js";

export type GovernorFullStripReason = "first_install" | "threshold_flush";

export type GovernorFullStripResult = {
  ok: boolean;
  error?: string;
  runId: string;
  archivedDir: string;
  keeperPath: string;
  ingestedDateKeys: string[];
  memoryRows: number;
  sessionsJsonUpdated: number;
};

function detectAgentOnlyDay(bucket: { messages: Array<{ role?: string }> }): boolean {
  return !bucket.messages.some((m) => m.role === "user");
}

function appendGovernorAudit(stateDir: string, record: Record<string, unknown>): void {
  const p = path.join(stateDir, "audit.jsonl");
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8");
}

/**
 * @param openclawCleanup — 为 true 时在收尾对 openclaw home 执行 sessions cleanup（首装可在配置中打开）。
 */
export async function runGovernorFullStrip(params: {
  config: Config;
  logger: Logger;
  reason: GovernorFullStripReason;
  openclawCleanup?: boolean;
  openclawBin?: string;
}): Promise<GovernorFullStripResult> {
  const { config, logger, reason } = params;
  const runId = new Date().toISOString().replace(/:/g, "-");
  const openclawCleanup = params.openclawCleanup === true;
  const openclawBin = params.openclawBin || "openclaw";

  let archivedDir = "";

  try {
    ensureDir(config.archiveRoot);
    ensureDir(config.sessionsRoot);
    ensureDir(config.stateDir);

    const files = listSessionFiles(config.sessionsRoot);
    if (files.length === 0) {
      const keeperPath = path.join(config.sessionsRoot, `${randomUUID()}.jsonl`);
      fs.writeFileSync(keeperPath, "", "utf8");
      const syncRs = syncOpenClawSessionsJsonAfterRotation({
        sessionsRoot: config.sessionsRoot,
        changes: [],
        normalize: { keeperPath, mergedFrom: [], created: true },
        forceCanonicalSessionFile: path.resolve(keeperPath),
      });
      appendGovernorAudit(config.stateDir, {
        kind: "governor_full_strip",
        reason,
        runId,
        emptySessions: true,
        keeperPath,
        sessionsJsonUpdated: syncRs.updated,
      });
      logger.info("governor.full_strip.empty_sessions", { reason, keeperPath });
      return {
        ok: true,
        runId,
        archivedDir: "",
        keeperPath,
        ingestedDateKeys: [],
        memoryRows: 0,
        sessionsJsonUpdated: syncRs.updated,
      };
    }

    const buckets = await aggregateByDate(config.sessionsRoot);
    const sorted = [...buckets].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    const selfRows = collectSelfImprovingRecords(config.selfImprovingRoot);
    let memoryRows = 0;
    const ingestedDateKeys: string[] = [];

    for (const bucket of sorted) {
      const refined = refineBucket(bucket as any, selfRows).map((r: any, i: number) => ({
        ...r,
        id: stableMemoryId([config.agentId, r.date, r.type, String(i), r.summary]),
        agentId: config.agentId,
        createdAt: new Date().toISOString(),
        sessionIds: bucket.sourceSessionIds,
        agentOnlyDay: detectAgentOnlyDay(bucket as any),
      }));
      if (refined.length === 0) continue;
      const upsertRs = await upsertMemories(config.lancedb, refined);
      upsertGovernanceStateFromRefined(config.stateDir, refined);
      memoryRows += refined.length;
      ingestedDateKeys.push(bucket.dateKey);
      logger.info("governor.full_strip.bucket_ingested", {
        dateKey: bucket.dateKey,
        count: refined.length,
        mode: upsertRs.mode,
      });
    }

    archivedDir = path.join(config.archiveRoot, "governor-full", runId);
    ensureDir(archivedDir);
    for (const filePath of files) {
      const dest = path.join(archivedDir, path.basename(filePath));
      fs.copyFileSync(filePath, dest);
    }

    const mergedFrom = [...files];
    for (const filePath of files) {
      try {
        fs.unlinkSync(filePath);
      } catch (e) {
        logger.warn("governor.full_strip.unlink_failed", { filePath, err: String(e) });
      }
    }

    const keeperPath = path.join(config.sessionsRoot, `${randomUUID()}.jsonl`);
    fs.writeFileSync(keeperPath, "", "utf8");

    const syncRs = syncOpenClawSessionsJsonAfterRotation({
      sessionsRoot: config.sessionsRoot,
      changes: [],
      normalize: { keeperPath, mergedFrom, created: true },
      forceCanonicalSessionFile: path.resolve(keeperPath),
    });

    if (openclawCleanup) {
      const cfgHome = path.dirname(config.openclawConfigPath);
      const cr = runOpenclawSessionsCleanup(openclawBin, cfgHome);
      if (!cr.ok) {
        logger.warn("governor.full_strip.openclaw_cleanup_failed", {
          stderr: cr.stderr.slice(0, 500),
        });
      }
    }

    appendGovernorAudit(config.stateDir, {
      kind: "governor_full_strip",
      reason,
      runId,
      archivedDir,
      keeperPath,
      ingestedDateKeys,
      memoryRows,
      sourceFiles: mergedFrom.map((p) => path.basename(p)),
      sessionsJsonUpdated: syncRs.updated,
    });

    logger.info("governor.full_strip.done", {
      reason,
      runId,
      memoryRows,
      keeperPath,
      sessionsJsonUpdated: syncRs.updated,
    });

    return {
      ok: true,
      runId,
      archivedDir,
      keeperPath,
      ingestedDateKeys,
      memoryRows,
      sessionsJsonUpdated: syncRs.updated,
    };
  } catch (e) {
    const err = String(e);
    logger.warn("governor.full_strip.failed", { reason, err });
    appendGovernorAudit(config.stateDir, {
      kind: "governor_full_strip",
      reason,
      runId,
      ok: false,
      error: err,
      archivedDir,
      keeperPath: "",
    });
    return {
      ok: false,
      error: err,
      runId,
      archivedDir,
      keeperPath: "",
      ingestedDateKeys: [],
      memoryRows: 0,
      sessionsJsonUpdated: 0,
    };
  }
}
