/**
 * 烟测：runGovernorFullStrip 在无有效 message 行的 jsonl 时不调用嵌入，
 * 仍能归档、腾空、收敛 sessions.json。
 *
 * 运行：npm run governor:test-full-strip
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { readJson } from "../src/lib/fsx.js";
import { resolveRuntimeConfig } from "../src/lib/runtime-config.js";
import { runGovernorFullStrip } from "../src/lib/governor-full-strip.js";
import { createLogger } from "../src/lib/logger.js";
import type { Config } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, "..");

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mgp-governor-strip-"));
  const base = readJson<Config | null>(path.join(skillRoot, "config.json"), null);
  if (!base) {
    console.error("FAIL: config.json not found at skill root");
    process.exit(1);
  }

  const openclawJson = path.join(tmp, "openclaw.json");
  fs.writeFileSync(
    openclawJson,
    JSON.stringify({ plugins: { entries: { "memory-lancedb-pro": { enabled: true } } } }),
    "utf8",
  );

  const raw: Config = {
    ...base,
    sessionsRoot: path.join(tmp, "sessions"),
    stateDir: path.join(tmp, "state"),
    archiveRoot: path.join(tmp, "archive"),
    openclawConfigPath: openclawJson,
    workspaceRoot: path.join(tmp, "workspace"),
    selfImprovingRoot: path.join(tmp, "workspace"),
    lancedb: {
      ...base.lancedb,
      dbPath: path.join(tmp, "governor-lancedb"),
    },
  };

  fs.mkdirSync(path.join(tmp, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "workspace"), { recursive: true });

  const sid = "11111111-1111-1111-1111-111111111111";
  const staleJsonl = path.join(tmp, "sessions", `${sid}.jsonl`);
  fs.writeFileSync(staleJsonl, "\n", "utf8");

  fs.writeFileSync(
    path.join(tmp, "sessions", "sessions.json"),
    JSON.stringify(
      {
        k1: {
          sessionFile: staleJsonl,
          sessionId: sid,
          updatedAt: Date.now(),
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const config = resolveRuntimeConfig(raw, { skillRoot, envAgentId: "main" });
  const logger = createLogger(config.stateDir, "smoke-test");
  const rs = await runGovernorFullStrip({
    config,
    logger,
    reason: "threshold_flush",
    openclawCleanup: false,
  });

  if (!rs.ok) {
    console.error("FAIL: runGovernorFullStrip", rs);
    process.exit(1);
  }

  const jsonlFiles = fs
    .readdirSync(config.sessionsRoot)
    .filter((f) => f.endsWith(".jsonl") && !f.includes(".rewrite."));
  if (jsonlFiles.length !== 1) {
    console.error("FAIL: expected exactly 1 active jsonl, got:", jsonlFiles);
    process.exit(1);
  }

  const govFull = path.join(config.archiveRoot, "governor-full");
  if (!fs.existsSync(govFull)) {
    console.error("FAIL: missing archive/governor-full");
    process.exit(1);
  }
  const runs = fs.readdirSync(govFull);
  if (runs.length < 1) {
    console.error("FAIL: expected at least one run dir under governor-full");
    process.exit(1);
  }

  const store = readJson<Record<string, Record<string, unknown>>>(
    path.join(config.sessionsRoot, "sessions.json"),
    {},
  );
  const canonical = path.resolve(config.sessionsRoot, jsonlFiles[0]!);
  let allPointToKeeper = true;
  for (const entry of Object.values(store)) {
    const sf = entry?.sessionFile;
    if (typeof sf !== "string") continue;
    const resolved = path.isAbsolute(sf)
      ? path.resolve(sf)
      : path.resolve(config.sessionsRoot, sf);
    if (resolved !== canonical) allPointToKeeper = false;
  }
  const auditPath = path.join(config.stateDir, "audit.jsonl");
  if (!fs.existsSync(auditPath)) {
    console.error("FAIL: audit.jsonl missing");
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        status: "ok",
        tmpDir: tmp,
        keeper: jsonlFiles[0],
        archiveRun: runs[0],
        memoryRows: rs.memoryRows,
        sessionsJsonUpdated: rs.sessionsJsonUpdated,
        allEntriesPointToKeeper: allPointToKeeper,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
