/** Retains a retry key for the current local submission; it grants no execution authority. */
export function createComposerSubmissionIdentity(createKey: () => string) {
  let signature: string | undefined
  let key: string | undefined
  return {
    key(input: {
      channelId: string
      bodyText: string
      artifactIds: readonly string[]
      mentions: readonly unknown[]
      submissionContext?: string
    }) {
      const next = JSON.stringify(input)
      if (next !== signature) {
        signature = next
        key = createKey()
      }
      return key!
    },
    reset() {
      signature = undefined
      key = undefined
    },
  }
}
