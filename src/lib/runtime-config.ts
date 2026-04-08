import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { expandHome } from "./fsx.js";
import type { Config } from "../types.js";

interface OpenClawAgentsConfig {
  agents?: {
    defaults?: {
      workspace?: string;
    };
    list?: Array<{
      id?: string;
      workspace?: string;
    }>;
  };
}

export interface ResolveRuntimeOptions {
  envAgentId?: string;
  skillRoot?: string;
}

export function resolvePathTemplate(
  input: string,
  ctx: { openclawHome: string; agentId: string; skillRoot?: string },
): string {
  const replaced = input
    .replaceAll("{OPENCLAW_HOME}", ctx.openclawHome)
    .replaceAll("{AGENT_ID}", ctx.agentId)
    .replaceAll("{SKILL_ROOT}", ctx.skillRoot ? path.resolve(ctx.skillRoot) : "");
  const expanded = expandHome(replaced);
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.normalize(path.join(ctx.openclawHome, expanded));
}

function resolveOpenClawHome(): string {
  return path.normalize(
    process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw"),
  );
}

function resolveOpenClawConfigPath(openclawHome: string): string {
  const fromEnv = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (fromEnv) return path.normalize(expandHome(fromEnv));
  return path.join(openclawHome, "openclaw.json");
}

function detectInstalledAgentFromSkillRoot(
  openclawHome: string,
  skillRoot: string | undefined,
): { agentId: string; workspaceRoot: string } | undefined {
  if (!skillRoot || !skillRoot.trim()) return undefined;
  const normalizedSkillRoot = path.resolve(skillRoot);
  const cfgPath = resolveOpenClawConfigPath(openclawHome);
  if (!fs.existsSync(cfgPath)) return undefined;

  let cfg: OpenClawAgentsConfig;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as OpenClawAgentsConfig;
  } catch {
    return undefined;
  }

  const defaultWorkspace = cfg.agents?.defaults?.workspace
    ? path.normalize(expandHome(cfg.agents.defaults.workspace))
    : path.join(openclawHome, "workspace");
  const list = Array.isArray(cfg.agents?.list) ? cfg.agents!.list! : [];

  for (const agent of list) {
    const id = typeof agent?.id === "string" ? agent.id.trim() : "";
    if (!id) continue;
    const workspaceRoot =
      typeof agent?.workspace === "string" && agent.workspace.trim()
        ? path.normalize(expandHome(agent.workspace))
        : defaultWorkspace;
    const expectedSkillRoot = path.resolve(
      workspaceRoot,
      "skills",
      path.basename(normalizedSkillRoot),
    );
    if (normalizedSkillRoot === expectedSkillRoot) {
      return { agentId: id, workspaceRoot };
    }
  }

  return undefined;
}

export function resolveRuntimeConfig(cfg: Config, options: ResolveRuntimeOptions = {}): Config {
  const openclawHome: string = resolveOpenClawHome();
  const installDetected = detectInstalledAgentFromSkillRoot(openclawHome, options.skillRoot);
  /**
   * Agent 解析优先级（与业务约定一致）：
   * 1. 调用方显式传入 envAgentId（如 daily-rotate 循环或 `--agent`）
   * 2. 安装路径识别（同一副本内最高优先级，压过 OPENCLAW_AGENT_ID / config 默认）
   * 3. OPENCLAW_AGENT_ID
   * 4. config.json 中的 agentId
   * 5. main
   */
  const explicitAgentId = options.envAgentId?.trim() || "";
  const agentId =
    explicitAgentId ||
    installDetected?.agentId ||
    process.env.OPENCLAW_AGENT_ID?.trim() ||
    cfg.agentId ||
    "main";
  const ctx = { openclawHome, agentId, skillRoot: options.skillRoot };

  /** 仅在「未显式指定 agent」且能识别安装位点时，直接用识别到的工作区；否则按模板 + 最终 agentId 展开 */
  const useInstallWorkspace = !explicitAgentId && Boolean(installDetected);

  const resolvedWorkspaceRoot =
    useInstallWorkspace && installDetected
      ? installDetected.workspaceRoot
      : resolvePathTemplate(cfg.workspaceRoot, ctx);
  const resolvedSelfImprovingRoot = cfg.selfImprovingRoot.includes("{AGENT_ID}")
    ? resolvePathTemplate(cfg.selfImprovingRoot, ctx)
    : useInstallWorkspace && installDetected
      ? installDetected.workspaceRoot
      : resolvePathTemplate(cfg.selfImprovingRoot, ctx);

  return {
    ...cfg,
    agentId,
    workspaceRoot: resolvedWorkspaceRoot,
    sessionsRoot: resolvePathTemplate(cfg.sessionsRoot, ctx),
    openclawConfigPath: resolvePathTemplate(cfg.openclawConfigPath, ctx),
    stateDir: resolvePathTemplate(cfg.stateDir, ctx),
    archiveRoot: resolvePathTemplate(cfg.archiveRoot, ctx),
    selfImprovingRoot: resolvedSelfImprovingRoot,
    lancedb: {
      ...cfg.lancedb,
      dbPath: resolvePathTemplate(cfg.lancedb.dbPath, ctx),
    },
  };
}
