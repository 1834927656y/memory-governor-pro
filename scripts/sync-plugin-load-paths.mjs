#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function expandHome(input) {
  if (!input) return input;
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolveOpenclawHome() {
  return path.resolve(process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw"));
}

function resolveConfigPath(openclawHome) {
  const fromEnv = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (fromEnv) return path.resolve(expandHome(fromEnv));
  return path.join(openclawHome, "openclaw.json");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function usage() {
  console.log(
    [
      "Usage: node scripts/sync-plugin-load-paths.mjs [options]",
      "",
      "Options:",
      "  --write                 Write changes to openclaw.json",
      "  --config <path>         Override config path (default: OPENCLAW_CONFIG_PATH or OPENCLAW_HOME/openclaw.json)",
      "  --plugin-id <id>        Plugin id (default: from openclaw.plugin.json)",
      "  --verbose               Print candidate workspaces and path checks",
      "  -h, --help              Show help",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    write: false,
    configPath: "",
    pluginId: "",
    verbose: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") args.write = true;
    else if (a === "--verbose") args.verbose = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a === "--config") args.configPath = argv[++i] || "";
    else if (a === "--plugin-id") args.pluginId = argv[++i] || "";
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function uniq(arr) {
  return [...new Set(arr)];
}

function resolvePluginId(skillRoot, argPluginId) {
  if (argPluginId?.trim()) return argPluginId.trim();
  const manifestPath = path.join(skillRoot, "openclaw.plugin.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`openclaw.plugin.json not found at ${manifestPath}`);
  }
  const manifest = readJson(manifestPath);
  const id = typeof manifest.id === "string" ? manifest.id.trim() : "";
  if (!id) throw new Error("Invalid plugin id in openclaw.plugin.json");
  return id;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const skillRoot = path.resolve(path.join(import.meta.dirname, ".."));
  const skillName = path.basename(skillRoot);
  const openclawHome = resolveOpenclawHome();
  const configPath = args.configPath
    ? path.resolve(expandHome(args.configPath))
    : resolveConfigPath(openclawHome);

  if (!fs.existsSync(configPath)) {
    throw new Error(`openclaw.json not found: ${configPath}`);
  }

  const cfg = readJson(configPath);
  const pluginId = resolvePluginId(skillRoot, args.pluginId);

  const defaultWorkspaceRaw = cfg?.agents?.defaults?.workspace;
  const defaultWorkspace = path.resolve(
    expandHome(typeof defaultWorkspaceRaw === "string" && defaultWorkspaceRaw.trim()
      ? defaultWorkspaceRaw
      : path.join(openclawHome, "workspace")),
  );
  const listedAgents = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];

  const candidateWorkspaces = uniq(
    listedAgents.map((agent) => {
      const raw = typeof agent?.workspace === "string" && agent.workspace.trim()
        ? agent.workspace
        : defaultWorkspace;
      return path.resolve(expandHome(raw));
    }),
  );

  // Always include this running skill root, so single-agent setups work even
  // when agents.list is incomplete.
  const resolvedPaths = [];
  for (const ws of candidateWorkspaces) {
    const p = path.resolve(ws, "skills", skillName);
    const exists = fs.existsSync(p);
    if (args.verbose) {
      console.log(`[check] ${p} -> ${exists ? "exists" : "missing"}`);
    }
    if (exists) resolvedPaths.push(p);
  }
  if (fs.existsSync(skillRoot)) resolvedPaths.push(skillRoot);

  const paths = uniq(resolvedPaths).sort((a, b) => a.localeCompare(b));
  const beforePaths = Array.isArray(cfg?.plugins?.load?.paths) ? cfg.plugins.load.paths : [];

  if (!cfg.plugins) cfg.plugins = {};
  if (!cfg.plugins.load) cfg.plugins.load = {};
  cfg.plugins.load.paths = paths;

  const changed = JSON.stringify(beforePaths) !== JSON.stringify(paths);
  const summary = {
    pluginId,
    configPath,
    skillName,
    openclawHome,
    changed,
    write: args.write,
    beforePaths,
    paths,
  };

  if (!args.write) {
    console.log(JSON.stringify(summary, null, 2));
    console.log("Dry-run only. Re-run with --write to persist.");
    return;
  }

  fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

try {
  main();
} catch (err) {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
}

