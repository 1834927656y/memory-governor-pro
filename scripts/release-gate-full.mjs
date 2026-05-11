#!/usr/bin/env node
/**
 * Full pre-release gate (no LanceDB / live gateway required):
 * 1) Pure collaboration + cache-key assertions
 * 2) Full-strip smoke test against a temporary OpenClaw home
 * 3) Layered-injection config + session layout verification
 *
 * Override config path: set RELEASE_GATE_OPENCLAW_CONFIG to absolute path of openclaw.json.
 * By default this script uses a temporary fixture config so the release gate remains
 * deterministic in clean checkouts/CI and is not polluted by a developer's live sessions.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");
const requestedConfigPath = process.env.RELEASE_GATE_OPENCLAW_CONFIG;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function createFixtureOpenclawConfig() {
  const home = mkdtempSync(path.join(os.tmpdir(), "mgp-release-gate-openclaw-"));
  const agentId = "main";
  const sessionsRoot = path.join(home, "agents", agentId, "sessions");
  mkdirSync(sessionsRoot, { recursive: true });

  const sessionFile = path.join(sessionsRoot, "release-gate-session.jsonl");
  writeFileSync(sessionFile, "", "utf8");
  writeFileSync(
    path.join(sessionsRoot, "sessions.json"),
    JSON.stringify(
      {
        "agent:main:release-gate": {
          sessionId: "release-gate-session",
          sessionFile,
          updatedAt: Date.now(),
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const configPath = path.join(home, "openclaw.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        agents: {
          defaults: { workspace: path.join(home, "workspace") },
          list: [{ id: agentId }],
        },
        plugins: {
          entries: {
            "memory-lancedb-pro": {
              enabled: true,
              config: {
                embedding: {
                  provider: "openai-compatible",
                  apiKey: "release-gate-test-key",
                  model: "mock-embedding-model",
                  baseURL: "http://127.0.0.1:9/v1",
                  dimensions: 32,
                },
                dbPath: path.join(home, "lancedb"),
                autoCapture: false,
                autoRecall: false,
                smartExtraction: false,
                sessionStrategy: "none",
                governor: {
                  enabledAgents: [agentId],
                  runtimeVectorOnlyRecall: true,
                  injectionLayerBudget: {
                    selfImprovement: 0.2,
                    memory: 0.5,
                    governance: 0.3,
                  },
                },
              },
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return { configPath, home };
}

function runPackAudit() {
  const npmCache = process.env.RELEASE_GATE_NPM_CACHE || path.join(os.tmpdir(), "memory-governor-pro-npm-cache");
  mkdirSync(npmCache, { recursive: true });
  const auditDir = mkdtempSync(path.join(os.tmpdir(), "memory-governor-pro-pack-audit-"));
  const stdoutPath = path.join(auditDir, "npm-pack.json");
  const stderrPath = path.join(auditDir, "npm-pack.stderr");
  try {
    // In some managed Codex/OMX shells, stdout piped from nested node/npm
    // children is suppressed even when the child succeeds. Redirect npm's JSON
    // output to a temp file and read it back so this gate remains deterministic
    // in CI, local shells, and sandboxed agent runs.
    execSync(
      `npm --cache ${shellQuote(npmCache)} pack --dry-run --json > ${shellQuote(stdoutPath)} 2> ${shellQuote(stderrPath)}`,
      {
        cwd: pluginRoot,
        stdio: ["ignore", "ignore", "ignore"],
        shell: true,
      },
    );
  } catch (err) {
    const stdout = existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8").trim() : "";
    const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8").trim() : "";
    throw new Error(
      `release-gate-full: npm pack audit failed (status=${(err)?.status ?? "unknown"}).\n` +
        `stdout: ${stdout.slice(0, 2_000) || "(empty)"}\n` +
        `stderr: ${stderr.slice(0, 2_000) || "(empty)"}`,
    );
  }
  const raw = existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : "";
  if (!raw.trim()) {
    const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8").trim() : "";
    throw new Error(
      `release-gate-full: npm pack audit produced empty JSON output; stderr=${stderr.slice(0, 2_000) || "(empty)"}`,
    );
  }
  const jsonStart = raw.indexOf("[");
  const parsed = JSON.parse((jsonStart >= 0 ? raw.slice(jsonStart) : raw).trim());
  const files = (parsed?.[0]?.files || []).map((file) => String(file.path || ""));
  const forbidden = [
    /^\.omx(?:\/|$)/,
    /^state(?:\/|$)/,
    /^\.git(?:\/|$)/,
    /^node_modules(?:\/|$)/,
    /^\.env(?:\.|\/|$)/,
    /(?:^|\/)npm-debug\.log$/,
    /(?:^|\/).+\.log$/,
  ];
  const leaked = files.filter((file) => forbidden.some((pattern) => pattern.test(file)));
  if (leaked.length > 0) {
    throw new Error(`release-gate-full: forbidden files would be packed: ${leaked.join(", ")}`);
  }
  rmSync(auditDir, { recursive: true, force: true });
  console.log(`release-gate-full: pack audit ok (${files.length} files).`);
}

let configPath = requestedConfigPath;
let fixture;

console.log(`release-gate-full: pluginRoot=${pluginRoot}`);
console.log(
  requestedConfigPath
    ? `release-gate-full: requested openclaw.json=${requestedConfigPath}`
    : "release-gate-full: RELEASE_GATE_OPENCLAW_CONFIG not set; using isolated fixture openclaw.json",
);

if (!configPath || !existsSync(configPath)) {
  fixture = createFixtureOpenclawConfig();
  configPath = fixture.configPath;
  console.log(
    `release-gate-full: requested config missing; using temporary fixture openclaw.json=${configPath}`,
  );
}

execSync("npm run governor:release-gate-collaboration", {
  cwd: pluginRoot,
  stdio: "inherit",
  shell: true,
});

execSync("npm run governor:test-full-strip", {
  cwd: pluginRoot,
  stdio: "inherit",
  shell: true,
});

execSync(`node scripts/verify-layered-injection.mjs --strict --config ${shellQuote(configPath)}`, {
  cwd: pluginRoot,
  stdio: "inherit",
  shell: true,
});

runPackAudit();

console.log("\nrelease-gate-full: completed.");
