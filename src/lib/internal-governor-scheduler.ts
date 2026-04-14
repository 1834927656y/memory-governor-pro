import path from "node:path";
import fs from "node:fs";
import lockfile from "proper-lockfile";
import type { Config, InternalSchedulerConfig } from "../types.js";
import { resolveRuntimeConfig } from "./runtime-config.js";
import { todayYmdInTimeZone } from "./daily-rotate.js";
import { createLogger } from "./logger.js";
import { ensureDir, readJson, writeJson } from "./fsx.js";
import { governorPruneStaleActivity } from "./governor-session-activity.js";
import { maybePruneArchiveByRetention } from "./archive-ttl.js";
import { firstInstallBootstrapStatePath } from "./first-install-marker.js";
import { runGovernorFullStrip } from "./governor-full-strip.js";

export interface InternalGovernorSchedulerState {
  lastTickIso?: string;
}

const DEFAULT_ISC: Required<
  Pick<
    InternalSchedulerConfig,
    | "runAtLocalTime"
    | "tickIntervalMs"
    | "jitterMaxMs"
    | "quietMsAfterSessionWrite"
    | "postTurnQuietMs"
    | "maxDeferMs"
    | "catchUpOutsideRunWindow"
    | "catchUpOnStartup"
    | "catchUpMaxDays"
    | "downtimeRecoveryMaxDays"
    | "lockStaleMs"
    | "runGovernanceAfterSuccess"
    | "openclawCleanup"
    | "openclawBin"
    | "firstInstallBackfillEnabled"
    | "firstInstallBackfillMaxDays"
  >
> = {
  runAtLocalTime: "00:05",
  tickIntervalMs: 60_000,
  jitterMaxMs: 90_000,
  quietMsAfterSessionWrite: 180_000,
  postTurnQuietMs: 120_000,
  maxDeferMs: 7_200_000,
  catchUpOutsideRunWindow: true,
  catchUpOnStartup: true,
  catchUpMaxDays: 7,
  downtimeRecoveryMaxDays: 365,
  lockStaleMs: 300_000,
  runGovernanceAfterSuccess: false,
  openclawCleanup: false,
  openclawBin: "openclaw",
  firstInstallBackfillEnabled: true,
  firstInstallBackfillMaxDays: 365,
};

function mergeIsc(raw?: InternalSchedulerConfig): typeof DEFAULT_ISC & InternalSchedulerConfig {
  return { ...DEFAULT_ISC, ...(raw || {}) };
}

function schedulerStatePath(stateDir: string): string {
  return path.join(stateDir, "internal-scheduler-state.json");
}

/**
 * 与 openclaw.json 中 governor.enabledAgents 对齐的去重、排序列表。
 * 若为空数组：不应对任何 agent 执行首装（与「名单即启用管家精炼的分身集合」一致）。
 */
export function normalizeFirstInstallGovernorAgentIds(
  governorEnabledAgents: string[] | undefined,
  _rawConfig: Config,
  _skillRoot: string,
): string[] {
  const trimmed = (governorEnabledAgents ?? [])
    .map((id) => (typeof id === "string" ? id.trim() : ""))
    .filter(Boolean);
  const unique = [...new Set(trimmed)];
  return unique.sort();
}

/**
 * 网关内管家心跳：仅负责首次安装全量剥皮与归档 TTL；已无「按日夜轮转」日终精炼。
 */
export function startInternalGovernorScheduler(params: {
  skillRoot: string;
  rawConfig: Config;
  governorEnabledAgents?: string[];
  log: (msg: string) => void;
  warn: (msg: string) => void;
}): () => Promise<void> {
  const { skillRoot, rawConfig, log, warn } = params;
  const governorTargetAgentIds = normalizeFirstInstallGovernorAgentIds(
    params.governorEnabledAgents ?? [],
    rawConfig,
    skillRoot,
  );
  let loggedEmptyGovernorTargets = false;

  if (process.env.MEMORY_GOVERNOR_DISABLE_INTERNAL_SCHEDULER === "1") {
    log("memory-governor-pro: 内部调度已跳过（MEMORY_GOVERNOR_DISABLE_INTERNAL_SCHEDULER=1）");
    return async () => {};
  }

  if (!rawConfig.internalScheduler || rawConfig.internalScheduler.enabled === false) {
    log("memory-governor-pro: 内部调度未启用（config.internalScheduler.enabled !== true）");
    return async () => {};
  }

  let stopRequested = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  let firstInstallBackfillTried = false;

  const tick = async (): Promise<void> => {
    if (stopRequested) return;

    const resolved = resolveRuntimeConfig(rawConfig, { skillRoot });
    const isc = mergeIsc(resolved.internalScheduler);
    const tz = resolved.timezone || "UTC";
    const todayYmd = todayYmdInTimeZone(tz);

    ensureDir(resolved.stateDir);
    ensureDir(path.join(resolved.stateDir, ".locks"));
    governorPruneStaleActivity();

    if (!firstInstallBackfillTried && isc.firstInstallBackfillEnabled) {
      firstInstallBackfillTried = true;

      const runFirstInstallForAgent = async (backfillAgentId: string): Promise<void> => {
        const agentResolved = resolveRuntimeConfig(rawConfig, {
          skillRoot,
          envAgentId: backfillAgentId,
        });
        ensureDir(agentResolved.stateDir);
        ensureDir(path.join(agentResolved.stateDir, ".locks"));
        const markerPath = firstInstallBootstrapStatePath(agentResolved.stateDir);
        const marker = readJson<{
          done?: boolean;
          at?: string;
          note?: string;
        }>(markerPath, {});
        if (marker.done) {
          log(
            `memory-governor-pro: 首次安装回填已执行过（agent=${agentResolved.agentId}, at=${marker.at || "unknown"}）`,
          );
          return;
        }
        const firstLock = path.join(
          agentResolved.stateDir,
          ".locks",
          "governor-first-install-backfill",
        );
        ensureDir(path.dirname(firstLock));
        if (!fs.existsSync(firstLock)) {
          fs.writeFileSync(firstLock, `${process.pid}\n`, "utf8");
        }
        let releaseFirst: (() => Promise<void>) | undefined;
        try {
          releaseFirst = await lockfile.lock(firstLock, {
            stale: isc.lockStaleMs,
            retries: { retries: 0 },
          });
        } catch {
          // other process is bootstrapping this agent
        }
        if (!releaseFirst) {
          return;
        }
        try {
          log(`memory-governor-pro: 首次安装全量剥皮开始（agent=${agentResolved.agentId}）`);
          const glog = createLogger(agentResolved.stateDir, `first-install-${Date.now()}`);
          const stripRs = await runGovernorFullStrip({
            config: agentResolved,
            logger: glog,
            reason: "first_install",
            openclawCleanup: isc.openclawCleanup === true,
            openclawBin: isc.openclawBin,
          });
          if (stripRs.ok) {
            writeJson(markerPath, {
              done: true,
              at: new Date().toISOString(),
              note: `governor_full_strip runId=${stripRs.runId} memoryRows=${stripRs.memoryRows}`,
              rotatedDateKeysAsc: [...stripRs.ingestedDateKeys].sort(),
            });
            log(
              `memory-governor-pro: 首次安装全量剥皮完成（agent=${agentResolved.agentId}, memoryRows=${stripRs.memoryRows}, keeper=${stripRs.keeperPath}）`,
            );
          } else {
            writeJson(markerPath, {
              done: false,
              at: new Date().toISOString(),
              note: stripRs.error || "governor_full_strip_failed",
            });
            warn(
              `memory-governor-pro: 首次安装全量剥皮失败（agent=${agentResolved.agentId}）: ${stripRs.error || "unknown"}`,
            );
          }
        } catch (e) {
          warn(`memory-governor-pro: 首次安装回填失败: ${String(e)}`);
        } finally {
          try {
            await releaseFirst();
          } catch {
            /* ignore */
          }
        }
      };

      await Promise.all(governorTargetAgentIds.map((id) => runFirstInstallForAgent(id)));
    }

    if (governorTargetAgentIds.length === 0) {
      if (!loggedEmptyGovernorTargets) {
        log(
          "memory-governor-pro: governor.enabledAgents 为空，跳过管家维护（请在 openclaw.json 的插件配置中填写该名单）",
        );
        loggedEmptyGovernorTargets = true;
      }
      return;
    }

    for (const agentId of governorTargetAgentIds) {
      const agentResolved = resolveRuntimeConfig(rawConfig, {
        skillRoot,
        envAgentId: agentId,
      });
      const stPath = schedulerStatePath(agentResolved.stateDir);
      try {
        const pr = maybePruneArchiveByRetention(agentResolved, todayYmd, {});
        if (pr.ran && pr.result && pr.result.deletedDirs.length > 0) {
          log(
            `memory-governor-pro: 归档 TTL（agent=${agentResolved.agentId}）已清理 ${pr.result.deletedDirs.length} 个日期目录（早于 ${pr.result.deleteBeforeYmd}）`,
          );
        }
      } catch (e) {
        warn(
          `memory-governor-pro: 归档 TTL 清理失败（agent=${agentResolved.agentId}）: ${String(e)}`,
        );
      }
      const persisted = readJson<InternalGovernorSchedulerState>(stPath, {});
      persisted.lastTickIso = new Date().toISOString();
      writeJson(stPath, persisted);
    }
  };

  interval = setInterval(() => {
    void tick().catch((e) => warn(`memory-governor-pro: tick 异常: ${String(e)}`));
  }, mergeIsc(rawConfig.internalScheduler).tickIntervalMs);

  void tick().catch((e) => warn(`memory-governor-pro: 首 tick 异常: ${String(e)}`));

  log("memory-governor-pro: 内部管家调度已启动（首装全量剥皮 + 归档 TTL；无日终按日轮转）");

  return async () => {
    stopRequested = true;
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    log("memory-governor-pro: 内部管家调度已停止");
  };
}
