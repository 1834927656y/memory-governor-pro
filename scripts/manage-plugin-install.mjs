#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PLUGIN_ID = "memory-lancedb-pro";
const SKILL_RELATIVE_PATH = "skills/memory-governor-pro";

function resolveOpenclawHome() {
  return path.resolve(process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw"));
}

function resolveConfigPath(openclawHome, cliPath) {
  if (cliPath?.trim()) return path.resolve(cliPath.trim());
  if (process.env.OPENCLAW_CONFIG_PATH?.trim()) return path.resolve(process.env.OPENCLAW_CONFIG_PATH.trim());
  return path.join(openclawHome, "openclaw.json");
}

function parseArgs(argv) {
  const out = {
    mode: "install",
    config: "",
    agents: [],
    disable: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "install" || a === "uninstall") out.mode = a;
    else if (a === "--config") out.config = argv[++i] || "";
    else if (a === "--agents") out.agents = (argv[++i] || "").split(",").map((x) => x.trim()).filter(Boolean);
    else if (a === "--disable") out.disable = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        [
          "Usage:",
          "  node scripts/manage-plugin-install.mjs install --agents main,xunc1",
          "  node scripts/manage-plugin-install.mjs uninstall [--disable]",
          "",
          "Options:",
          "  --agents <a,b,c>   Set governor.enabledAgents",
          "  --disable          On uninstall also set plugins.entries.memory-lancedb-pro.enabled=false",
          "  --config <path>    Override openclaw.json path",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return out;
}

function uniq(arr) {
  return [...new Set(arr)];
}

function ensureArray(v) {
  return Array.isArray(v) ? v : [];
}

function normalizePathString(p) {
  return path.normalize(p || "");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const openclawHome = resolveOpenclawHome();
  const configPath = resolveConfigPath(openclawHome, args.config);
  const skillAbsolutePath = path.resolve(openclawHome, SKILL_RELATIVE_PATH);
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));

  cfg.plugins = cfg.plugins || {};
  cfg.plugins.load = cfg.plugins.load || {};
  cfg.plugins.entries = cfg.plugins.entries || {};
  cfg.plugins.entries[PLUGIN_ID] = cfg.plugins.entries[PLUGIN_ID] || {};
  cfg.plugins.entries[PLUGIN_ID].config = cfg.plugins.entries[PLUGIN_ID].config || {};

  const beforePaths = ensureArray(cfg.plugins.load.paths);
  const normalizedSkillAbsolute = normalizePathString(skillAbsolutePath);
  const normalizedSkillRelative = normalizePathString(SKILL_RELATIVE_PATH);
  const nextPaths =
    args.mode === "install"
      ? uniq([
        ...beforePaths.filter((x) => normalizePathString(x) !== normalizedSkillRelative),
        skillAbsolutePath,
      ])
      : beforePaths.filter((x) => {
        const n = normalizePathString(x);
        return n !== normalizedSkillRelative && n !== normalizedSkillAbsolute;
      });
  cfg.plugins.load.paths = nextPaths;

  const pluginEntry = cfg.plugins.entries[PLUGIN_ID];
  if (args.mode === "install") {
    if (!fs.existsSync(skillAbsolutePath)) {
      throw new Error(
        `Plugin path not found: ${skillAbsolutePath}\n` +
          `Expected skill directory under OPENCLAW_HOME. ` +
          `Set OPENCLAW_HOME correctly or place the skill at ${SKILL_RELATIVE_PATH}.`,
      );
    }
    pluginEntry.enabled = true;
    if (args.agents.length > 0) {
      pluginEntry.config.governor = pluginEntry.config.governor || {};
      pluginEntry.config.governor.enabledAgents = uniq(args.agents);
    }
  } else {
    if (pluginEntry?.config?.governor && typeof pluginEntry.config.governor === "object") {
      delete pluginEntry.config.governor.enabledAgents;
    }
    if (args.disable) pluginEntry.enabled = false;
  }

  fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: args.mode,
        configPath,
        pluginId: PLUGIN_ID,
        skillPath: skillAbsolutePath,
        paths: cfg.plugins.load.paths,
        enabled: cfg.plugins.entries[PLUGIN_ID]?.enabled,
        enabledAgents: cfg.plugins.entries[PLUGIN_ID]?.config?.governor?.enabledAgents || [],
      },
      null,
      2,
    ),
  );
}

main();

