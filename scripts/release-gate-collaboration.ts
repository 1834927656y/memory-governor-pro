/**
 * Release gate: pure collaboration/cache-key behavior (no LanceDB / OpenClaw).
 * Run: node --import jiti/register scripts/release-gate-collaboration.ts
 */
import assert from "node:assert/strict";
import { resolveLastRawUserMessageCacheKey } from "../src/lib/user-message-cache-key.js";
import {
  isCollaborationPreferenceIntentText,
  isAppliedCollaborationPreferenceIntentText,
  shouldPatchRecallMetadataForQuery,
} from "../src/lib/collaboration-intent.js";
import {
  formatResolvedCollaborationPreferencesBlock,
  resolveCollaborationPreferences,
} from "../src/lib/collaboration-preference-resolver.js";

function ok(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}`);
    throw e;
  }
}

ok("cacheKey prefers channel over conversation/session", () => {
  assert.equal(
    resolveLastRawUserMessageCacheKey({ channelId: "ch", conversationId: "co", sessionId: "se" }),
    "ch",
  );
});

ok("cacheKey uses conversationId when channel absent (historical SI/recall mismatch)", () => {
  assert.equal(resolveLastRawUserMessageCacheKey({ conversationId: "thread-9", sessionId: "sess-7" }), "thread-9");
});

ok("cacheKey falls back to sessionId", () => {
  assert.equal(resolveLastRawUserMessageCacheKey({ sessionId: "sess-7" }), "sess-7");
});

ok("applied intent: explicit create + launch checklist", () => {
  assert.ok(
    isAppliedCollaborationPreferenceIntentText(
      "Please create a launch readiness checklist for a regional distributor rollout next week.",
    ),
  );
});

ok("applied intent: need a checklist (weak verb)", () => {
  assert.ok(
    isAppliedCollaborationPreferenceIntentText(
      "We need a rollout checklist with owners and timing for APAC.",
    ),
  );
});

ok("applied intent: Chinese 需要一份推进表", () => {
  assert.ok(isAppliedCollaborationPreferenceIntentText("需要一份下周渠道推进表，含风险和卡点。"));
});

ok("collaboration preference: rule query still detected", () => {
  assert.ok(isCollaborationPreferenceIntentText("当前的协作输出格式规则是什么？"));
});

ok("collaboration preference recall remains read-only for stored memory metadata", () => {
  assert.equal(shouldPatchRecallMetadataForQuery("当前仍生效的协作规则清单是什么？"), false);
  assert.equal(shouldPatchRecallMetadataForQuery("需要一份下周渠道推进表，含风险和卡点。"), false);
  assert.equal(shouldPatchRecallMetadataForQuery("请总结上次关于数据库索引的讨论。"), true);
});

ok("applied intent: plan the rollout (verb phrase)", () => {
  assert.ok(isAppliedCollaborationPreferenceIntentText("Please plan the APAC rollout timeline."));
});

ok("not applied: descriptive sentence without request cue", () => {
  assert.ok(!isAppliedCollaborationPreferenceIntentText("The roadmap highlights three milestones for Q3."));
});

ok("resolver: later fourth-rule forgetting removes project-codeword slot without deleting memories", () => {
  const resolved = resolveCollaborationPreferences([
    {
      id: "old-snapshot",
      timestamp: Date.parse("2026-04-29T00:00:00.000Z"),
      text:
        "当前长期协作约定（2026-04-29更新）：1）始终中文回复；2）所有时间写 UTC+9；" +
        "3）计划输出用“目标-步骤-风险”三段；4）取消所有项目代号/任务标签相关约束，后续回答不应再包含或使用任何项目代号；若旧记忆提到项目代号，一律视为已失效。",
    },
    {
      id: "forget-fourth",
      timestamp: Date.parse("2026-05-09T08:00:00.000Z"),
      text: "请遗忘第四条规则，后续不要再把第四条作为仍生效的协作偏好。",
    },
  ]);

  assert.deepEqual(resolved.facts, [
    "始终中文回复",
    "所有时间写 UTC+9",
    "计划输出用「目标-步骤-风险」三段",
  ]);
  assert.equal(resolved.slots["project-codeword"]?.active, false);
  assert.equal(resolved.slots["task-label"]?.active, false);
  assert.ok(!formatResolvedCollaborationPreferencesBlock(resolved).includes("项目代号"));
});

ok("resolver: later cancellation beats older repeated project codeword snapshot", () => {
  const resolved = resolveCollaborationPreferences([
    {
      id: "old-a",
      timestamp: Date.parse("2026-04-28T00:00:00.000Z"),
      text: "当前项目代号：青鸟计划-Alpha；所有时间写 GMT+8。",
    },
    {
      id: "old-b-reinforced",
      timestamp: Date.parse("2026-04-28T00:01:00.000Z"),
      text: "协作规则：项目代号：青鸟计划-Alpha。",
    },
    {
      id: "new-state",
      timestamp: Date.parse("2026-04-29T00:00:00.000Z"),
      text: "当前长期协作偏好已更新：所有时间写 UTC+9；取消所有项目代号/任务标签相关约束，若旧记忆提到项目代号，一律视为已失效。",
    },
  ]);

  const block = formatResolvedCollaborationPreferencesBlock(resolved);
  assert.ok(block.includes("所有时间写 UTC+9"));
  assert.ok(block.includes("不使用项目代号/任务标签"));
  assert.ok(!block.includes("青鸟计划-Alpha"));
  assert.ok(!block.includes("GMT+8"));
});

ok("resolver: explicit codeword is parsed, then later fourth-rule forgetting suppresses it", () => {
  const resolved = resolveCollaborationPreferences([
    {
      id: "old-codeword",
      timestamp: Date.parse("2026-04-28T00:00:00.000Z"),
      text: "当前项目代号：青鸟计划-Alpha。",
    },
    {
      id: "forget-fourth",
      timestamp: Date.parse("2026-05-09T08:00:00.000Z"),
      text: "请遗忘第四条规则，后续不要再把第四条作为仍生效的协作偏好。",
    },
  ]);

  const block = formatResolvedCollaborationPreferencesBlock(resolved);
  assert.equal(resolved.facts.length, 0);
  assert.equal(resolved.slots["project-codeword"]?.active, false);
  assert.ok(block.includes("当前没有可输出的生效协作偏好"));
  assert.ok(!block.includes("青鸟计划-Alpha"));
});

console.log("\nrelease-gate-collaboration: all checks passed");
