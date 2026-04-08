#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function listJsonl(root) {
  try {
    return fs.readdirSync(root).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
}

function main() {
  const home = process.env.OPENCLAW_HOME
    ? path.resolve(process.env.OPENCLAW_HOME)
    : path.resolve(path.join(process.env.USERPROFILE || process.env.HOME || ".", ".openclaw"));

  const openclawConfigPath = path.join(home, "openclaw.json");
  const cfg = readJsonSafe(openclawConfigPath, {});
  const pluginCfg =
    cfg?.plugins?.entries?.["memory-lancedb-pro"]?.config ||
    {};

  const report = {
    openclawConfigPath,
    checks: [],
    warnings: [],
  };

  const budgets = pluginCfg?.governor?.injectionLayerBudget;
  if (
    budgets &&
    typeof budgets.selfImprovement === "number" &&
    typeof budgets.memory === "number" &&
    typeof budgets.governance === "number"
  ) {
    report.checks.push("injectionLayerBudget exists");
  } else {
    report.warnings.push("injectionLayerBudget missing in plugins.entries.memory-lancedb-pro.config.governor");
  }

  const enabledAgents = Array.isArray(pluginCfg?.governor?.enabledAgents)
    ? pluginCfg.governor.enabledAgents.filter((x) => typeof x === "string")
    : ["main"];

  for (const agentId of enabledAgents) {
    const sessionsRoot = path.join(home, "agents", agentId, "sessions");
    const files = listJsonl(sessionsRoot);
    if (files.length === 1) {
      report.checks.push(`[${agentId}] single active jsonl: ${files[0]}`);
    } else {
      report.warnings.push(`[${agentId}] expected 1 active jsonl, got ${files.length}`);
    }
    const sessionsJson = path.join(sessionsRoot, "sessions.json");
    const store = readJsonSafe(sessionsJson, {});
    const pointed = new Set(
      Object.values(store || {})
        .map((v) => (v && typeof v === "object" ? v.sessionFile : undefined))
        .filter((x) => typeof x === "string"),
    );
    if (pointed.size <= 1) {
      report.checks.push(`[${agentId}] sessions.json unified sessionFile pointer`);
    } else {
      report.warnings.push(`[${agentId}] sessions.json has ${pointed.size} distinct sessionFile pointers`);
    }
  }

  console.log(JSON.stringify(report, null, 2));
}

main();
