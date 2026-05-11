/**
 * Stable cache key for the latest raw user message across hooks.
 * Previously message_received used channelId → conversationId → default while
 * before_prompt_build used channelId → sessionId — a mismatch dropped the real
 * user text and broke collaboration / self-improvement gating (full prompt fallback).
 */
export function resolveLastRawUserMessageCacheKey(
  ctx: { channelId?: string; conversationId?: string; sessionId?: string } | null | undefined,
): string {
  const channelId = typeof ctx?.channelId === "string" ? ctx.channelId.trim() : "";
  const conversationId = typeof ctx?.conversationId === "string" ? ctx.conversationId.trim() : "";
  const sessionId = typeof ctx?.sessionId === "string" ? ctx.sessionId.trim() : "";
  return channelId || conversationId || sessionId || "default";
}
