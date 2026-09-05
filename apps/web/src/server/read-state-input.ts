export function parseReadStateInput(
  value: unknown,
  options: Readonly<{ requireChannelId?: boolean }> = {}
): Readonly<{
  action: "read" | "unread";
  channelId?: string;
  lastReadSequence?: number;
}> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const keys = new Set([
    "action",
    "lastReadSequence",
    ...(options.requireChannelId ? ["channelId"] : []),
  ]);
  if (
    Object.keys(input).some((key) => !keys.has(key)) ||
    !["read", "unread"].includes(String(input.action)) ||
    (input.lastReadSequence !== undefined &&
      (!Number.isSafeInteger(input.lastReadSequence) || Number(input.lastReadSequence) < 0)) ||
    (options.requireChannelId &&
      (typeof input.channelId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          input.channelId
        )))
  )
    return null;
  return {
    action: input.action as "read" | "unread",
    ...(typeof input.channelId === "string" ? { channelId: input.channelId } : {}),
    ...(typeof input.lastReadSequence === "number"
      ? { lastReadSequence: input.lastReadSequence }
      : {}),
  };
}
