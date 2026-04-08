import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import type { Config, InternalSchedulerConfig } from "../types.js";
import { resolveRuntimeConfig } from "./runtime-config.js";
import {
  listPendingRotationDateKeys,
  runDailyRotatePipeline,
  runOpenclawSessionsCleanup,
  todayYmdInTimeZone,
  yesterdayYmdInTimeZone,
} from "./daily-rotate.js";
import { createLogger } from "./logger.js";
import { applyGovernance } from "./governance.js";
import { ensureDir, readJson, writeJson } from "./fsx.js";
import {
  governorIsSessionStemBusy,
  governorPruneStaleActivity,
} from "./governor-session-activity.js";
import { maybePruneArchiveByRetention } from "./archive-ttl.js";

export interface InternalGovernorSchedulerState {
  /** 已成功完成批跑后的锚点：至少应追到「配置时区下的昨夜」 */
  lastAnchorDateKey?: string;
  firstDeferIso?: string | null;
  lastTickIso?: string;
  /**
   * 与当前网关进程内 `governorSchedulerSessionId` 一致时，表示本 agent 已参与过本轮「调度会话」的启动补跑判定；
   * 网关重启后 session 变化，可与其它 agent 独立地再次获得 catchUpOnStartup 行为。
   */
  lastGovernorSchedulerSessionId?: string;
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

function parseRunAtLocalMinutes(runAt: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(runAt.trim());
  if (!m) throw new Error(`internalScheduler.runAtLocalTime 无效: ${runAt}（须 HH:mm）`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    throw new Error(`internalScheduler.runAtLocalTime 越界: ${runAt}`);
  }
  return hh * 60 + mm;
}

function localWallMinutesInTimeZone(timeZone: string, d = new Date()): number {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomUInt(max: number): number {
  if (max <= 0) return 0;
  return Math.floor(Math.random() * (max + 1));
}

/**
 * 与 openclaw.json 中 governor.enabledAgents 对齐的去重、排序列表。
 * 若为空数组：不应对任何 agent 执行首装/日终精炼（与「名单即启用管家精炼的分身集合」一致）。
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

function schedulerStatePath(stateDir: string): string {
  return path.join(stateDir, "internal-scheduler-state.json");
}

function firstInstallBootstrapStatePath(stateDir: string): string {
  return path.join(stateDir, "first-install-bootstrap.json");
}

function isDeferredResult(r: unknown): boolean {
  if (!r || typeof r !== "object") return false;
  return (r as { status?: string }).status === "deferred";
}

function batchHasDeferred(batch: Awaited<ReturnType<typeof runDailyRotatePipeline>>): boolean {
  for (const b of batch) {
    for (const r of b.results) {
      if (isDeferredResult(r)) return true;
    }
  }
  return false;
}

function batchHasSuccessfulRotate(batch: Awaited<ReturnType<typeof runDailyRotatePipeline>>): boolean {
  for (const b of batch) {
    for (const r of b.results) {
      if (r && typeof r === "object" && "status" in r) {
        const s = (r as { status?: string }).status;
        if (s === "ok" || s === "ok_no_delete") return true;
      }
    }
  }
  return false;
}

function daysDiffExclusive(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split("-").map(Number);
  const [ty, tm, td] = toYmd.split("-").map(Number);
  const a = Date.UTC(fy, fm - 1, fd, 12, 0, 0);
  const b = Date.UTC(ty, tm - 1, td, 12, 0, 0);
  const d = Math.floor((b - a) / 86_400_000);
  return Math.max(0, d);
}

/**
 * 网关进程内启动日终治理心跳；每个安装了本 skill 的 agent 由各自进程副本注册（安装路径决定 agentId）。
 */
export function startInternalGovernorScheduler(params: {
  skillRoot: string;
  rawConfig: Config;
  /** 与 openclaw.json governor.enabledAgents 一致；空数组则不跑首装/日终精炼 */
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
  /** 本插件调度器在网关进程内的生命周期标识（重启后变，用于按 agent 区分「首帧启动补跑」） */
  const governorSchedulerSessionId = randomUUID();

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
    const intendedYesterday = yesterdayYmdInTimeZone(tz);
    const runAtMinutes = parseRunAtLocalMinutes(isc.runAtLocalTime);
    const nowMinutes = localWallMinutesInTimeZone(tz);
    const inMainWindow = nowMinutes >= runAtMinutes;

    ensureDir(resolved.stateDir);
    ensureDir(path.join(resolved.stateDir, ".locks"));
    governorPruneStaleActivity();

    let openclawCleanupPending = false;

    if (!firstInstallBackfillTried && isc.firstInstallBackfillEnabled) {
      firstInstallBackfillTried = true;

      const runFirstInstallForAgent = async (backfillAgentId: string): Promise<boolean> => {
        let anySuccessfulRotate = false;
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
          return false;
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
          return false;
        }
        try {
          log(
            `memory-governor-pro: 首次安装回填开始（agent=${agentResolved.agentId}, maxDays=${isc.firstInstallBackfillMaxDays}）`,
          );
          const firstBatch = await runDailyRotatePipeline(
            {
              rawConfig,
              singleAgentId: agentResolved.agentId,
              allAgents: false,
              explicitDateKey: undefined,
              catchUp: true,
              catchUpMaxDays:
                isc.firstInstallBackfillMaxDays > 0
                  ? isc.firstInstallBackfillMaxDays
                  : Number.MAX_SAFE_INTEGER,
              skipDelete: false,
              allowDelete: true,
              openclawCleanup: isc.openclawCleanup === true,
              skipOpenclawCleanup: true,
              openclawBin: isc.openclawBin,
              force: false,
              skillRoot,
              rotateSafety: undefined,
              forceIgnoreRotateSafety: true,
            },
            (agentCfg, jobKey) => createLogger(agentCfg.stateDir, `${jobKey}-first-install`),
          );
          if (batchHasSuccessfulRotate(firstBatch)) {
            anySuccessfulRotate = true;
          }
          const hasDeferred = batchHasDeferred(firstBatch);
          if (!hasDeferred) {
            const processed = firstBatch.flatMap((b) => b.results).length;
            writeJson(markerPath, {
              done: true,
              at: new Date().toISOString(),
              note: `processed=${processed}`,
            });
            log(
              `memory-governor-pro: 首次安装回填完成（agent=${agentResolved.agentId}, processed=${processed}）`,
            );
          } else {
            writeJson(markerPath, {
              done: false,
              at: new Date().toISOString(),
              note: "deferred_found_will_retry_next_startup",
            });
            warn(
              `memory-governor-pro: 首次安装回填出现 deferred，已记录待重试（agent=${agentResolved.agentId}）`,
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
        return anySuccessfulRotate;
      };

      const firstInstallHits = await Promise.all(
        governorTargetAgentIds.map((id) => runFirstInstallForAgent(id)),
      );
      openclawCleanupPending = firstInstallHits.some(Boolean);
    }

    const cfgHome = path.dirname(
      resolveRuntimeConfig(rawConfig, { skillRoot }).openclawConfigPath,
    );

    if (governorTargetAgentIds.length === 0) {
      if (!loggedEmptyGovernorTargets) {
        log(
          "memory-governor-pro: governor.enabledAgents 为空，跳过内部日终精炼（请在 openclaw.json 的插件配置中填写该名单）",
        );
        loggedEmptyGovernorTargets = true;
      }
      if (openclawCleanupPending && isc.openclawCleanup === true) {
        const cr = runOpenclawSessionsCleanup(isc.openclawBin, cfgHome);
        if (!cr.ok) {
          warn(`memory-governor-pro: openclaw sessions cleanup 失败: ${cr.stderr.slice(0, 800)}`);
        }
      }
      return;
    }

    /**
     * 多 agent 在同一 tick 内**串行**跑精炼（一个接一个），避免同时改盘、抢锁；
     * 是否「最优」视负载而定：并行可缩短 wall time，但需要更强的隔离与限流。
     */
    for (const dailyAgentId of governorTargetAgentIds) {
      const agentResolved = resolveRuntimeConfig(rawConfig, {
        skillRoot,
        envAgentId: dailyAgentId,
      });
      ensureDir(agentResolved.stateDir);
      ensureDir(path.join(agentResolved.stateDir, ".locks"));

      const stPath = schedulerStatePath(agentResolved.stateDir);

      try {
        let persisted = readJson<InternalGovernorSchedulerState>(stPath, {});
        const startupEligible =
          isc.catchUpOnStartup !== false &&
          persisted.lastGovernorSchedulerSessionId !== governorSchedulerSessionId;

        persisted.lastTickIso = new Date().toISOString();
        writeJson(stPath, persisted);

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

        const anchorGapDays = persisted.lastAnchorDateKey
          ? daysDiffExclusive(persisted.lastAnchorDateKey, intendedYesterday)
          : 0;
        const recoveryCap =
          isc.downtimeRecoveryMaxDays > 0
            ? isc.downtimeRecoveryMaxDays
            : Number.MAX_SAFE_INTEGER;
        const dynamicCatchUpMaxDays = Math.max(
          isc.catchUpMaxDays,
          Math.min(anchorGapDays, recoveryCap),
        );

        let pending: string[] = [];
        try {
          pending = await listPendingRotationDateKeys(
            agentResolved,
            todayYmd,
            dynamicCatchUpMaxDays,
          );
        } catch (e) {
          warn(
            `memory-governor-pro: 列出待补跑日期失败（agent=${agentResolved.agentId}）: ${String(e)}`,
          );
          continue;
        }

        const needCatchUp = pending.length > 0;
        const anchorBehind =
          !persisted.lastAnchorDateKey ||
          persisted.lastAnchorDateKey < intendedYesterday;

        const fullyCaughtUp =
          !needCatchUp &&
          Boolean(persisted.lastAnchorDateKey) &&
          persisted.lastAnchorDateKey! >= intendedYesterday;

        if (fullyCaughtUp && !persisted.firstDeferIso) {
          continue;
        }

        const allowCatchUpOutside = isc.catchUpOutsideRunWindow !== false;

        const startupPulse = startupEligible && (needCatchUp || anchorBehind);
        if (startupPulse) {
          log(
            `memory-governor-pro: 启动补跑/校准 agent=${agentResolved.agentId} anchor=${persisted.lastAnchorDateKey ?? "(无)"} intendedYesterday=${intendedYesterday} pending=${pending.length} dynamicCatchUpMaxDays=${dynamicCatchUpMaxDays}`,
          );
        }

        const shouldRunNow =
          startupPulse ||
          (allowCatchUpOutside && needCatchUp) ||
          (inMainWindow && (needCatchUp || anchorBehind));

        if (!shouldRunNow) {
          continue;
        }

        let forceIgnore =
          isc.maxDeferMs > 0 &&
          Boolean(persisted.firstDeferIso) &&
          Date.now() - new Date(persisted.firstDeferIso as string).getTime() >= isc.maxDeferMs;
        if (forceIgnore) {
          warn(
            `memory-governor-pro: 推迟已超过 maxDeferMs（agent=${agentResolved.agentId}）${isc.maxDeferMs}ms，本轮强制忽略会话静默门闸`,
          );
        }

        const lockFile = path.join(agentResolved.stateDir, ".locks", "governor-internal-daily");
        ensureDir(path.dirname(lockFile));
        if (!fs.existsSync(lockFile)) {
          fs.writeFileSync(lockFile, `${process.pid}\n`, "utf8");
        }

        let release: (() => Promise<void>) | undefined;
        try {
          release = await lockfile.lock(lockFile, {
            stale: isc.lockStaleMs,
            retries: { retries: 0 },
          });
        } catch {
          continue;
        }

        try {
          await sleep(randomUInt(isc.jitterMaxMs));

          const rotateSafety =
            forceIgnore
              ? undefined
              : {
                  quietMsAfterSessionWrite: isc.quietMsAfterSessionWrite,
                  isSessionStemBusy: governorIsSessionStemBusy,
                };

          persisted = readJson<InternalGovernorSchedulerState>(stPath, persisted);
          const batch = await runDailyRotatePipeline(
            {
              rawConfig,
              singleAgentId: agentResolved.agentId,
              allAgents: false,
              explicitDateKey: undefined,
              catchUp: true,
              catchUpMaxDays: dynamicCatchUpMaxDays,
              skipDelete: false,
              allowDelete: true,
              openclawCleanup: isc.openclawCleanup === true,
              skipOpenclawCleanup: true,
              openclawBin: isc.openclawBin,
              force: false,
              skillRoot,
              rotateSafety,
              forceIgnoreRotateSafety: forceIgnore,
            },
            (agentCfg, jobKey) => createLogger(agentCfg.stateDir, jobKey),
          );

          const deferred = batchHasDeferred(batch);
          if (deferred) {
            persisted = readJson<InternalGovernorSchedulerState>(stPath, persisted);
            if (!persisted.firstDeferIso) {
              persisted.firstDeferIso = new Date().toISOString();
              writeJson(stPath, persisted);
            }
            warn(
              `memory-governor-pro: 本轮 deferred（agent=${agentResolved.agentId}）会话忙或近期写入，本 tick 继续其它 agent`,
            );
            continue;
          }

          persisted = readJson<InternalGovernorSchedulerState>(stPath, persisted);
          persisted.firstDeferIso = null;
          const maxDateInBatch = batch.flatMap((b) => b.dateKeys).sort().pop();
          if (maxDateInBatch && maxDateInBatch >= intendedYesterday) {
            persisted.lastAnchorDateKey = maxDateInBatch;
          } else if (batchHasSuccessfulRotate(batch) || !needCatchUp) {
            persisted.lastAnchorDateKey = intendedYesterday;
          }
          writeJson(stPath, persisted);

          if (batchHasSuccessfulRotate(batch)) {
            openclawCleanupPending = true;
          }

          log(
            `memory-governor-pro: 内部调度 batch 完成 agent=${agentResolved.agentId} anchor=${persisted.lastAnchorDateKey}`,
          );

          if (isc.runGovernanceAfterSuccess) {
            const glog = createLogger(agentResolved.stateDir, `internal-gov-${Date.now()}`);
            try {
              applyGovernance(agentResolved.stateDir, todayYmd, agentResolved.governance, glog);
            } catch (e) {
              warn(
                `memory-governor-pro: applyGovernance 失败（agent=${agentResolved.agentId}）: ${String(e)}`,
              );
            }
          }
        } catch (e) {
          warn(
            `memory-governor-pro: 内部调度执行失败（agent=${agentResolved.agentId}）: ${String(e)}`,
          );
        } finally {
          if (release) {
            try {
              await release();
            } catch {
              /* ignore */
            }
          }
        }
      } finally {
        const cur = readJson<InternalGovernorSchedulerState>(stPath, {});
        cur.lastGovernorSchedulerSessionId = governorSchedulerSessionId;
        writeJson(stPath, cur);
      }
    }

    if (openclawCleanupPending && isc.openclawCleanup === true) {
      const cr = runOpenclawSessionsCleanup(isc.openclawBin, cfgHome);
      if (!cr.ok) {
        warn(`memory-governor-pro: openclaw sessions cleanup 失败: ${cr.stderr.slice(0, 800)}`);
      }
    }
  };

  interval = setInterval(() => {
    void tick().catch((e) => warn(`memory-governor-pro: tick 异常: ${String(e)}`));
  }, mergeIsc(rawConfig.internalScheduler).tickIntervalMs);

  void tick().catch((e) => warn(`memory-governor-pro: 首 tick 异常: ${String(e)}`));

  log("memory-governor-pro: 内部日终调度已启动（随 OpenClaw 网关进程）");

  return async () => {
    stopRequested = true;
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    log("memory-governor-pro: 内部日终调度已停止");
  };
}
