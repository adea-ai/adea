/** A settled Solid resource may still hold a page from the previous audience. */
export function settledConversationPage<T extends { conversationAudienceEpoch?: number }>(
  query: { readonly isSuccess: boolean; readonly data: T | undefined },
  audienceEpoch: number
): T | undefined {
  const page = query.isSuccess ? query.data : undefined
  return page?.conversationAudienceEpoch === audienceEpoch ? page : undefined
}
