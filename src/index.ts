#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { ensureDir, readJson, toDateKey } from "./lib/fsx";
import { createLogger } from "./lib/logger";
import { rotateDay } from "./lib/nightly";
import { applyGovernance } from "./lib/governance";
import { assertSingleInjector, buildInjectionPack, recordFlushEvent, shouldFlush } from "./lib/flushAndInject";
import { ensureSelfImprovingFiles, listVendoredCapabilities } from "./lib/vendor";
import { resolveRuntimeConfig } from "./lib/runtime-config.js";
import { todayYmdInTimeZone } from "./lib/daily-rotate.js";
import { maybePruneArchiveByRetention } from "./lib/archive-ttl.js";
import { runDailyRotatePipeline, runOpenclawSessionsCleanup } from "./lib/daily-rotate.js";
import { governorIsSessionStemBusy } from "./lib/governor-session-activity.js";
import {
  assertValidDateKey,
  clearRotationDayRecord,
  inspectRotationDay,
  purgeGovernorMemoriesForDate,
  purgeRefineArtifactDirsForDates,
  restoreSessionsFromArchive,
} from "./lib/audit-rollback.js";
import {
  readGovernorEnabledAgentIds,
  resolveRollbackDatesFromOpts,
  rollbackFirstInstallBackfill,
} from "./lib/rollback-first-install.js";
import { rollbackAllRefined } from "./lib/rollback-all-refined.js";
import type { Config } from "./types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillRoot = path.resolve(__dirname, "..");
const configPath = path.join(skillRoot, "config.json");
const rawConfig = readJson<Config | null>(configPath, null);
if (!rawConfig) throw new Error(`未找到配置文件: ${configPath}`);

const config = resolveRuntimeConfig(rawConfig, { skillRoot });
ensureDir(config.stateDir);

const program = new Command();
const mkLogger = (k: string) => createLogger(config.stateDir, `${k}-${Date.now()}`);

program.name("memory-governor-pro").description("TS memory governance pipeline with vendored upstream projects");

program
  .command("daily-rotate")
  .description(
    "每日精炼：默认处理配置时区内「昨天」的会话日，并补跑未登记的历史日；可多 agent；归档后从 jsonl 移除该日消息并可删空文件",
  )
  .option("--date <YYYY-MM-DD>", "只处理指定日历日（必须早于今天）")
  .option("--agent <id>", "仅处理该 agent（与 --all-agents 互斥）")
  .option("--all-agents", "对 openclaw.json 中列出的全部 agent 各执行一遍", false)
  .option("--skip-catch-up", "不补跑仍含历史消息但 rotation-state 未登记的日期", false)
  .option("--catch-up-max-days <n>", "补跑时最多处理多少个待定日历日", "90")
  .option("--skip-delete", "仅精炼+归档+重写文件，不删除整份 jsonl（同 nightly --skipDelete）", false)
  .option(
    "--disallow-delete",
    "禁止在「仅含该日」时 unlink jsonl（不传入 allowDelete）",
    false,
  )
  .option(
    "--openclaw-cleanup",
    "若有成功 rotate，则执行 openclaw sessions cleanup --all-agents --enforce 同步会话索引",
    false,
  )
  .option("--openclaw-bin <path>", "openclaw 命令", "openclaw")
  .option("--force", "忽略 rotation-state，重复处理同一日历日（排错/补写入用）", false)
  .option(
    "--respect-session-activity",
    "会话忙或 jsonl 近期写入时推迟该日（与网关内调度相同门闸；独立脚本运行时 busy 仅 mtime 有效）",
    false,
  )
  .option("--force-ignore-quiet", "与 --respect-session-activity 同时使用时跳过推迟门闸", false)
  .action(async (opts) => {
    const isc = rawConfig.internalScheduler;
    const batch = await runDailyRotatePipeline(
      {
        rawConfig,
        singleAgentId: opts.agent as string | undefined,
        allAgents: Boolean(opts.allAgents),
        explicitDateKey: opts.date as string | undefined,
        catchUp: !opts.skipCatchUp,
        catchUpMaxDays: Number(opts.catchUpMaxDays) || 90,
        skipDelete: Boolean(opts.skipDelete),
        allowDelete: !opts.disallowDelete,
        openclawCleanup: Boolean(opts.openclawCleanup),
        openclawBin: (opts.openclawBin as string) || "openclaw",
        force: Boolean(opts.force),
        skillRoot,
        rotateSafety:
          opts.respectSessionActivity === true
            ? {
                quietMsAfterSessionWrite: isc?.quietMsAfterSessionWrite ?? 180_000,
                isSessionStemBusy: governorIsSessionStemBusy,
              }
            : undefined,
        forceIgnoreRotateSafety: opts.forceIgnoreQuiet === true,
      },
      (agentCfg, jobKey) => createLogger(agentCfg.stateDir, jobKey),
    );
    console.log(JSON.stringify({ ok: true, batch }, null, 2));
  });

program.command("nightly").option("--date <YYYY-MM-DD>").option("--skipDelete").option("--allowDelete").action(async (opts) => {
  const logger = mkLogger("nightly");
  const dateKey = opts.date || toDateKey(new Date());
  const rs = await rotateDay(config, logger, dateKey, { skipDelete: Boolean(opts.skipDelete), allowDelete: Boolean(opts.allowDelete) });
  console.log(JSON.stringify(rs, null, 2));
});

program.command("bootstrap").option("--days <n>", "90").option("--allowDelete").action(async (opts) => {
  const logger = mkLogger("bootstrap");
  const days = Number(opts.days);
  for (let i = days; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 3600 * 1000);
    await rotateDay(config, logger, toDateKey(d), { allowDelete: Boolean(opts.allowDelete && config.rotation.allowBootstrapDelete) });
  }
  console.log(JSON.stringify({ ok: true, days }, null, 2));
});

program.command("flush").requiredOption("--percent <n>").option("--query <text>", "近期决策与硬约束").action(async (opts) => {
  const logger = mkLogger("flush");
  assertSingleInjector(readJson<any>(config.openclawConfigPath, {}), logger);
  const singleThresholdPercent =
    config.contextFlush?.singleThresholdPercent ??
    Math.max(...(config.scheduler?.thresholds || [85]));
  const preemptMarginPercent = config.contextFlush?.preemptMarginPercent ?? 0;
  if (!shouldFlush(Number(opts.percent), singleThresholdPercent, preemptMarginPercent)) return;
  recordFlushEvent(config.stateDir, Number(opts.percent), "threshold");
  const rs = await buildInjectionPack(
    config,
    (opts.query as string) || config.contextFlush?.query || "近期决策与硬约束",
    logger,
  );
  console.log(JSON.stringify(rs, null, 2));
});

program.command("governance").option("--date <YYYY-MM-DD>").action(async (opts) => {
  const logger = mkLogger("governance");
  const rs = applyGovernance(config.stateDir, opts.date || toDateKey(new Date()), config.governance, logger);
  console.log(JSON.stringify(rs, null, 2));
});

program.command("vendor:status").action(() => {
  console.log(JSON.stringify(listVendoredCapabilities(skillRoot), null, 2));
});

program.command("vendor:init-self-improving").action(() => {
  const dir = ensureSelfImprovingFiles(config.workspaceRoot, skillRoot);
  console.log(JSON.stringify({ ok: true, learningsDir: dir }, null, 2));
});

program.command("build-pack").requiredOption("--query <text>").action(async (opts) => {
  const logger = mkLogger("pack");
  const rs = await buildInjectionPack(config, opts.query, logger);
  console.log(rs.payload);
});

function configForAgent(agentFlag: string | undefined): Config {
  const id = typeof agentFlag === "string" && agentFlag.trim() ? agentFlag.trim() : undefined;
  return resolveRuntimeConfig(rawConfig, { envAgentId: id, skillRoot });
}

program
  .command("audit-inspect")
  .description("只读核对：某日轮转台账、归档副本是否存在、精炼快照、调度锚点")
  .requiredOption("--date <YYYY-MM-DD>", "日历日")
  .option("--agent <id>", "智能体 id（默认按环境/配置解析）")
  .action(async (opts) => {
    const dateKey = String(opts.date).trim();
    assertValidDateKey(dateKey);
    const cfg = configForAgent(opts.agent as string | undefined);
    ensureDir(cfg.stateDir);
    const out = inspectRotationDay(cfg, dateKey);
    console.log(JSON.stringify(out, null, 2));
  });

program
  .command("audit-restore-sessions")
  .description("从归档副本按台账恢复会话 jsonl（可 dry-run；可选恢复「合并目标」会话文件）")
  .requiredOption("--date <YYYY-MM-DD>", "日历日")
  .option("--agent <id>", "智能体 id")
  .option("--dry-run", "只打印将执行的操作", false)
  .option("--skip-backup", "恢复前不备份当前文件", false)
  .option(
    "--restore-merge-targets",
    "若台账含「合并到最新会话」且存在改写前快照，则用快照中的文件覆盖 targetSessionFile",
    false,
  )
  .action(async (opts) => {
    const dateKey = String(opts.date).trim();
    const cfg = configForAgent(opts.agent as string | undefined);
    ensureDir(cfg.stateDir);
    const rs = restoreSessionsFromArchive(cfg, dateKey, {
      dryRun: Boolean(opts.dryRun),
      backupCurrent: !opts.skipBackup,
      restoreMergeTargetsFromPreSnapshot: opts.restoreMergeTargets === true,
    });
    console.log(JSON.stringify(rs, null, 2));
  });

program
  .command("audit-clear-rotation")
  .description("从 rotation-state 移除某日记录（便于恢复会话后按需重跑精炼；不删向量库）")
  .requiredOption("--date <YYYY-MM-DD>", "日历日")
  .option("--agent <id>", "智能体 id")
  .option("--dry-run", "只检查是否存在记录", false)
  .action(async (opts) => {
    const dateKey = String(opts.date).trim();
    const cfg = configForAgent(opts.agent as string | undefined);
    ensureDir(cfg.stateDir);
    const rs = clearRotationDayRecord(cfg, dateKey, Boolean(opts.dryRun));
    console.log(JSON.stringify(rs, null, 2));
  });

program
  .command("audit-purge-memories")
  .description("按 snapshots/<日>.json 中的精炼 id 从治理向量库删除，并 pruning governance-state（先 audit-inspect 核对）")
  .requiredOption("--date <YYYY-MM-DD>", "日历日")
  .option("--agent <id>", "智能体 id")
  .option("--dry-run", "只列出将删除的 id", false)
  .action(async (opts) => {
    const dateKey = String(opts.date).trim();
    const cfg = configForAgent(opts.agent as string | undefined);
    ensureDir(cfg.stateDir);
    const rs = await purgeGovernorMemoriesForDate(cfg, dateKey, Boolean(opts.dryRun));
    console.log(JSON.stringify(rs, null, 2));
  });

program
  .command("rollback-first-install-backfill")
  .description(
    "回滚「首次安装自动回填」：按首装记录的日历日逆序恢复归档会话、清理当日治理向量与 rotation 台账，并默认重置 first-install-bootstrap.json 以便可再次首装回填",
  )
  .option("--agent <id>", "单个智能体 id（与 --all-governor-agents 互斥）")
  .option(
    "--all-governor-agents",
    "对 openclaw.json 插件配置里 governor.enabledAgents 中的全部 agent 各执行一遍",
    false,
  )
  .option(
    "--dates <csv>",
    "逗号或空白分隔的 YYYY-MM-DD 列表，覆盖标记文件中的 rotatedDateKeysAsc（旧版首装无记录时必填）",
  )
  .option("--dry-run", "仅演示 restore/purge/clear/delete 步骤，不改盘", false)
  .option("--skip-restore-merge-targets", "不向 audit-restore 传入「合并目标」恢复快照", false)
  .option("--keep-snapshots", "purge 后仍保留 snapshots/<日>.json", false)
  .option("--keep-archives", "回滚成功后仍保留 agents/.../sessions/archive 下当日副本", false)
  .option(
    "--keep-pre-refine-snapshots",
    "仍保留台账中的 preRefineSnapshotDir（单次精炼目录；默认仅删该目录）",
    false,
  )
  .option("--no-reset-marker", "成功后不回写首装标记（默认会重置 done=false 以便再次首装）", false)
  .option(
    "--no-openclaw-cleanup",
    "跳过末尾 openclaw sessions cleanup --all-agents --enforce（默认执行，用于同步 sessions.json 索引）",
    false,
  )
  .option("--openclaw-bin <path>", "openclaw 可执行文件", "openclaw")
  .action(async (opts) => {
    const datesOverride = resolveRollbackDatesFromOpts(
      typeof opts.dates === "string" ? opts.dates : undefined,
    );
    const baseResolved = resolveRuntimeConfig(rawConfig, { skillRoot });
    let agentIds: string[];
    if (opts.allGovernorAgents === true) {
      agentIds = readGovernorEnabledAgentIds(baseResolved.openclawConfigPath);
      if (agentIds.length === 0) {
        console.error(
          JSON.stringify(
            {
              ok: false,
              error:
                "未在 openclaw.json 的 memory-lancedb-pro / memory-governor-pro 插件 config.governor.enabledAgents 中找到任何 agent",
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
        return;
      }
    } else {
      const id =
        typeof opts.agent === "string" && opts.agent.trim() ? opts.agent.trim() : undefined;
      agentIds = [id || baseResolved.agentId];
    }

    const results: unknown[] = [];
    for (const agentId of agentIds) {
      const cfg = configForAgent(agentId);
      ensureDir(cfg.stateDir);
      const rs = await rollbackFirstInstallBackfill(cfg, {
        dryRun: Boolean(opts.dryRun),
        datesOverride,
        restoreMergeTargets: opts.skipRestoreMergeTargets !== true,
        deleteSnapshotsAfterPurge: opts.keepSnapshots !== true,
        resetMarker: opts.noResetMarker !== true,
        deleteArchivesAfterRollback: opts.keepArchives !== true,
        deletePreRefineAfterRollback: opts.keepPreRefineSnapshots !== true,
      });
      results.push(rs);
    }

    let openclawCleanup: { ok: boolean; stderr: string } | undefined;
    if (opts.openclawCleanup !== false && !opts.dryRun) {
      const home = path.dirname(baseResolved.openclawConfigPath);
      const cr = runOpenclawSessionsCleanup(
        (opts.openclawBin as string) || "openclaw",
        home,
      );
      openclawCleanup = { ok: cr.ok, stderr: cr.stderr.slice(0, 4000) };
    }

    console.log(
      JSON.stringify(
        { ok: true, agentCount: agentIds.length, results, openclawCleanup },
        null,
        2,
      ),
    );
  });

program
  .command("rollback-all-refined")
  .description(
    "回滚当前 agent 全部已精炼状态：按日历日自新向旧恢复会话、purge 向量、清台账、删除参与回滚的 snapshots/<日>.json；磁盘收尾仅删台账 changes 中的归档文件与 preRefineSnapshotDir（非整日录；无台账的 ingest-only 日不删 pre-refine）",
  )
  .option("--agent <id>", "智能体 id（与 --all-governor-agents 互斥）")
  .option(
    "--all-governor-agents",
    "对 openclaw.json 里 governor.enabledAgents 中的全部 agent 各执行一遍",
    false,
  )
  .option("--dry-run", "只演示步骤，不改盘", false)
  .option("--skip-restore", "不从归档恢复会话 jsonl（仅清向量与台账/快照）", false)
  .option(
    "--skip-restore-merge-targets",
    "恢复会话时不使用 pre-refine 快照还原「合并目标」文件",
    false,
  )
  .option("--keep-snapshots", "purge 后保留 snapshots/<日>.json", false)
  .option("--keep-archives", "仍保留从台账恢复时所用的 archive 下副本（默认删）", false)
  .option(
    "--keep-pre-refine-snapshots",
    "仍保留台账中的 preRefineSnapshotDir（单次精炼目录；默认删该目录而非整日-folder）",
    false,
  )
  .option(
    "--no-openclaw-cleanup",
    "跳过末尾 openclaw sessions cleanup --all-agents --enforce",
    false,
  )
  .option("--openclaw-bin <path>", "openclaw 可执行文件", "openclaw")
  .action(async (opts) => {
    const baseResolved = resolveRuntimeConfig(rawConfig, { skillRoot });
    let agentIds: string[];
    if (opts.allGovernorAgents === true) {
      agentIds = readGovernorEnabledAgentIds(baseResolved.openclawConfigPath);
      if (agentIds.length === 0) {
        console.error(
          JSON.stringify(
            {
              ok: false,
              error:
                "未在 governor.enabledAgents 中找到任何 agent（与 rollback-first-install-backfill 相同要求）",
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
        return;
      }
    } else {
      const id =
        typeof opts.agent === "string" && opts.agent.trim() ? opts.agent.trim() : undefined;
      agentIds = [id || baseResolved.agentId];
    }

    const results: unknown[] = [];
    for (const agentId of agentIds) {
      const cfg = configForAgent(agentId);
      ensureDir(cfg.stateDir);
      const rs = await rollbackAllRefined(cfg, {
        dryRun: Boolean(opts.dryRun),
        restoreSessions: opts.skipRestore !== true,
        restoreMergeTargets: opts.skipRestoreMergeTargets !== true,
        deleteSnapshotsAfterPurge: opts.keepSnapshots !== true,
        deleteArchivesAfterRollback: opts.keepArchives !== true,
        deletePreRefineAfterRollback: opts.keepPreRefineSnapshots !== true,
      });
      results.push(rs);
    }

    let openclawCleanup: { ok: boolean; stderr: string } | undefined;
    if (opts.openclawCleanup !== false && !opts.dryRun) {
      const home = path.dirname(baseResolved.openclawConfigPath);
      const cr = runOpenclawSessionsCleanup(
        (opts.openclawBin as string) || "openclaw",
        home,
      );
      openclawCleanup = { ok: cr.ok, stderr: cr.stderr.slice(0, 4000) };
    }

    console.log(
      JSON.stringify({ ok: true, agentCount: agentIds.length, results, openclawCleanup }, null, 2),
    );
  });

program
  .command("purge-refine-artifact-dirs")
  .description(
    "无台账时按日历日整目录删除 archive/<日> 与 pre-refine-snapshots/<日>（默认拒绝执行，须 --force 确认）",
  )
  .requiredOption("--dates <csv>", "逗号或空白分隔的 YYYY-MM-DD")
  .option("--agent <id>", "智能体 id")
  .option("--dry-run", "只列出将删除的目录", false)
  .option(
    "--force",
    "确认整目录删除（与带 rotation 的回滚选择性删文件不同；误删风险自负）",
    false,
  )
  .action(async (opts) => {
    const rawDates = String(opts.dates || "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const cfg = configForAgent(opts.agent as string | undefined);
    ensureDir(cfg.stateDir);
    const rs = purgeRefineArtifactDirsForDates(cfg, rawDates, {
      dryRun: Boolean(opts.dryRun),
      forceWholeDateDirs: opts.force === true,
    });
    console.log(JSON.stringify({ ok: !rs.skipped, agentId: cfg.agentId, ...rs }, null, 2));
    if (rs.skipped) process.exitCode = 1;
  });

program
  .command("archive-prune")
  .description(
    "按 archiveRetentionDays 删除归档根下过期日期子目录（YYYY-MM-DD）；未配置或 0 则跳过；默认以配置时区「今天」计算",
  )
  .option("--agent <id>", "智能体 id")
  .option("--dry-run", "只列出将删除的目录", false)
  .option("--force", "忽略「每日只跑一次」标记（可配合手工多次试跑）", false)
  .action(async (opts) => {
    const cfg = configForAgent(opts.agent as string | undefined);
    ensureDir(cfg.stateDir);
    const todayYmd = todayYmdInTimeZone(cfg.timezone || "UTC");
    const rs = maybePruneArchiveByRetention(cfg, todayYmd, {
      dryRun: Boolean(opts.dryRun),
      force: Boolean(opts.force),
    });
    console.log(JSON.stringify({ todayYmd, ...rs }, null, 2));
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});

