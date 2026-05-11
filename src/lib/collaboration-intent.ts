/**
 * Collaboration-rule vs applied-deliverable intents for recall / injection gating.
 * Keep in sync with injection-semantic-gate expectations where relevant.
 */

function isCollaborationRulesQueryText(text: string): boolean {
  const s = String(text || "");
  const hasRuleNoun =
    /(规则|規則|原则|原則|协作|協作|约定|約定|约束|約束|偏好|默认|默認|长期|長期|后续|後續|以后|以後|要求|限制|格式|风格|語言|语言|时区|時區|timezone|输出|輸出|方案|计划|計劃|排期|口径|口徑|代号|代號|标签|標籤|preference|rule|policy|constraint|default|format|plan|schedule)/i.test(s);
  const hasQueryVerb =
    /(复述|列出|说明|解释|确认|查看|清单|列表|当前|现在|现行|仍生效|生效|有效|最新|目前|怎么|如何|该怎么|默认|默認|沿用|算数|算數|还算|提醒|别再用|不要再用|不再用|旧.*别|舊.*別|latest|current|active|what|how|list|show|applies|in force)/i.test(s);
  return hasRuleNoun && hasQueryVerb;
}

export function isAppliedCollaborationPreferenceIntentText(text: string): boolean {
  const s = String(text || "");
  const hasAppliedWorkNoun =
    /(方案|计划|計劃|排期|安排|日程|时间安排|時間安排|日期|时间|時間|关键动作|關鍵動作|风险|風險|步骤|步驟|行动|行動|推进|推進|推进表|推進表|跟进|跟進|节奏|節奏|进度|進度|里程碑|路线图|路線圖|复盘|復盤|清单|清單|表格|模板|框架|卡点|卡住|阻塞|障碍|障礙|输出|輸出|口径|口徑|任务名|任務名|任务标识|任務標識|任务标签|任務標籤|项目代号|項目代號|标签|標籤|代号|代號|plan|schedule|roadmap|timeline|milestone|blocker|blockers|follow-?up|checklist|readiness|launch|rollout|onboarding|runbook|playbook|brief|proposal|report|summary|matrix)/i.test(s);
  // Include polite English + Chinese request cues; avoid bare tokens like "plan" matching "the plan is …".
  const hasRequestCue =
    /(帮我|帮忙|请|麻烦|给我|给.{1,24}(写|列|做|排|起草|草拟|擬|拟|整理|规划|規劃|设计|設計)|做一个|做一份|做个|写一|写个|起草|草拟|擬|拟|生成|整理|安排|排一个|排一份|列出|列一|规划|規劃|设计|設計|出一版|给一版|来一份|来个|整一份|我需要|我要|想要|还需要|还需|需要(?:一份|一个|一张|一版|张表)|write|make|draft|create|prepare|build|produce|assemble|put together|map out|(?:plan|outline)\s+(?:for|the|a|an|my|our|this|that|some)|design\s+(?:for|the|a|an|my|our)|develop\s+(?:for|the|a|an|my|our)|list\s+(?:the|my|our|a|an|all|out)|\bgive\s+me\b|\bcould\s+you\b|\bcan\s+you\b|\bwould\s+you\b|\b(?:i|we)\s+need\b|\bneed\s+(?:a|an|the|some)\b|\b(?:i|we)\s+want\b|\bwant\s+(?:a|an|the|some)\b)/i.test(s);
  return hasAppliedWorkNoun && hasRequestCue;
}

export function isCollaborationPreferenceIntentText(text: string): boolean {
  return isCollaborationRulesQueryText(text) || isAppliedCollaborationPreferenceIntentText(text);
}

/**
 * Collaboration preference recall is intentionally read-only: for these turns
 * we may synthesize active preferences from historical rows, but must not patch
 * those rows' access/injection metadata because that would make stale,
 * frequently-injected memories look newer than later semantic cancellations.
 */
export function shouldPatchRecallMetadataForQuery(text: string): boolean {
  return !isCollaborationPreferenceIntentText(text);
}
