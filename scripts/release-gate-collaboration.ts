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

const forgetFourthParaphrases = [
  "请遗忘第四条规则，后续不要再把第四条作为仍生效的协作偏好。",
  "编号 4 的协作偏好作废，以后别再按它执行。",
  "第四项以后不算数，当前规则里不要包含它。",
  "Rule 4 no longer applies; drop that preference going forward.",
  "旧清单里的第4条请取消，不要再沿用。",
];

ok("resolver: varied ordinal forgetting removes the semantic slot at that ordinal", () => {
  for (const forgetText of forgetFourthParaphrases) {
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
        text: forgetText,
      },
    ]);

    assert.deepEqual(resolved.facts, [
      "始终中文回复",
      "所有时间写 UTC+9",
      "计划输出用「目标-步骤-风险」三段",
    ], forgetText);
    assert.equal(resolved.slots["project-codeword"]?.active, false, forgetText);
    assert.equal(resolved.slots["task-label"]?.active, false, forgetText);
    assert.ok(!formatResolvedCollaborationPreferencesBlock(resolved).includes("项目代号"), forgetText);
  }
});

ok("resolver: ordinal forgetting is semantic, not hard-coded to project-codeword", () => {
  const resolved = resolveCollaborationPreferences([
    {
      id: "old-snapshot",
      timestamp: Date.parse("2026-04-29T00:00:00.000Z"),
      text:
        "当前长期协作约定：1）始终中文回复；2）所有时间写 UTC+9；" +
        "3）计划输出用“目标-步骤-风险”三段；4）不提及记忆、注入上下文或提示来源，自然表达。",
    },
    {
      id: "forget-fourth",
      timestamp: Date.parse("2026-05-09T08:00:00.000Z"),
      text: "第四项以后不算数，当前规则里不要包含它。",
    },
  ]);

  assert.deepEqual(resolved.facts, [
    "始终中文回复",
    "所有时间写 UTC+9",
    "计划输出用「目标-步骤-风险」三段",
  ]);
  assert.equal(resolved.slots["source-disclosure"]?.active, false);
  assert.equal(resolved.slots["project-codeword"], undefined);
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

ok("resolver: explicit codeword is parsed, then later direct codeword cancellation suppresses it", () => {
  const resolved = resolveCollaborationPreferences([
    {
      id: "old-codeword",
      timestamp: Date.parse("2026-04-28T00:00:00.000Z"),
      text: "当前项目代号：青鸟计划-Alpha。",
    },
    {
      id: "cancel-codeword",
      timestamp: Date.parse("2026-05-09T08:00:00.000Z"),
      text: "旧项目代号那条约束作废，之后不要再使用任何项目代号。",
    },
  ]);

  const block = formatResolvedCollaborationPreferencesBlock(resolved);
  assert.deepEqual(resolved.facts, ["不使用项目代号"]);
  assert.equal(resolved.slots["project-codeword"]?.active, true);
  assert.ok(!block.includes("青鸟计划-Alpha"));
});

ok("resolver: randomized ordinal dialogue variants do not assume a fixed fourth-rule meaning", () => {
  const oldCodewords = ["青鸟计划-Alpha", "blue-raven-42", "云杉-77", "amber-river-9"];
  const ordinalRefs = [
    (n: number) => `第${n}条规则以后不算数。`,
    (n: number) => `编号 ${n} 的协作偏好作废，以后别再按它执行。`,
    (n: number) => `Rule ${n} no longer applies; drop that preference going forward.`,
    (n: number) => `旧清单里的第${n}项请取消，不要再沿用。`,
  ];
  const snapshots = [
    (code: string) => ({
      codewordOrdinal: 2,
      text: `当前长期协作约定：1）始终中文回复；2）项目代号：${code}；3）所有时间写 UTC+9。`,
      expectedFacts: ["始终中文回复", "所有时间写 UTC+9"],
    }),
    (code: string) => ({
      codewordOrdinal: 3,
      text: `当前长期协作约定：1）始终中文回复；2）所有时间写 UTC+9；3）项目代号：${code}；4）计划输出用“目标-步骤-风险”三段。`,
      expectedFacts: ["始终中文回复", "所有时间写 UTC+9", "计划输出用「目标-步骤-风险」三段"],
    }),
    (code: string) => ({
      codewordOrdinal: 4,
      text: `当前长期协作约定：1）始终中文回复；2）所有时间写 UTC+9；3）计划输出用“目标-步骤-风险”三段；4）项目代号：${code}。`,
      expectedFacts: ["始终中文回复", "所有时间写 UTC+9", "计划输出用「目标-步骤-风险」三段"],
    }),
  ];

  let caseIndex = 0;
  for (const code of oldCodewords) {
    for (const makeSnapshot of snapshots) {
      for (const makeForget of ordinalRefs) {
        const snapshot = makeSnapshot(code);
        const resolved = resolveCollaborationPreferences([
          { id: `old-${caseIndex}`, timestamp: Date.parse("2026-04-28T00:00:00.000Z"), text: snapshot.text },
          {
            id: `forget-${caseIndex}`,
            timestamp: Date.parse("2026-05-09T08:00:00.000Z") + caseIndex,
            text: makeForget(snapshot.codewordOrdinal),
          },
        ]);
        assert.deepEqual(resolved.facts, snapshot.expectedFacts, `${snapshot.text} :: ${makeForget(snapshot.codewordOrdinal)}`);
        assert.equal(resolved.slots["project-codeword"]?.active, false);
        assert.ok(!formatResolvedCollaborationPreferencesBlock(resolved).includes(code));
        caseIndex++;
      }
    }
  }
});

ok("resolver: ordinal forgetting targets the latest snapshot ordinal, not every historical same number", () => {
  const resolved = resolveCollaborationPreferences([
    {
      id: "older",
      timestamp: Date.parse("2026-04-28T00:00:00.000Z"),
      text: "当前长期协作约定：1）始终中文回复；2）项目代号：older-blue；3）所有时间写 UTC+9。",
    },
    {
      id: "newer",
      timestamp: Date.parse("2026-04-29T00:00:00.000Z"),
      text: "当前长期协作约定：1）始终中文回复；2）所有时间写 UTC+9；3）项目代号：newer-green。",
    },
    {
      id: "forget-second",
      timestamp: Date.parse("2026-05-09T08:00:00.000Z"),
      text: "旧清单里的第2项请取消，不要再沿用。",
    },
  ]);

  const block = formatResolvedCollaborationPreferencesBlock(resolved);
  assert.deepEqual(resolved.facts, ["始终中文回复", "项目代号：newer-green"]);
  assert.equal(resolved.slots["time-format"]?.active, false);
  assert.equal(resolved.slots["project-codeword"]?.active, true);
  assert.ok(!block.includes("所有时间写 UTC+9"));
  assert.ok(block.includes("newer-green"));
  assert.ok(!block.includes("older-blue"));
});

ok("resolver: random dialogue variants include non-parenthesized ordinals", () => {
  const resolved = resolveCollaborationPreferences([
    {
      id: "snapshot",
      timestamp: Date.parse("2026-04-29T00:00:00.000Z"),
      text: "当前长期协作偏好：第一条：始终中文回复。第二条：所有时间写 UTC+9。Rule 3: project code: raven-71. ④ 计划输出用“目标-步骤-风险”三段。",
    },
    {
      id: "forget-rule-3",
      timestamp: Date.parse("2026-05-09T08:00:00.000Z"),
      text: "3rd rule no longer applies; drop that preference going forward.",
    },
  ]);

  const block = formatResolvedCollaborationPreferencesBlock(resolved);
  assert.deepEqual(resolved.facts, [
    "始终中文回复",
    "所有时间写 UTC+9",
    "计划输出用「目标-步骤-风险」三段",
  ]);
  assert.equal(resolved.slots["project-codeword"]?.active, false);
  assert.ok(!block.includes("raven-71"));
});

console.log("\nrelease-gate-collaboration: all checks passed");
