const feedbackIssueUrl = 'https://github.com/adea-ai/adea/issues/new'

/** Prefill only non-sensitive app context; users add feedback and diagnostics themselves. */
export function createFeedbackUrl(input: {
  platform: 'desktop' | 'web'
  version?: string
}): string {
  const context = [`Adea ${input.platform}`, input.version ? `version ${input.version}` : undefined]
    .filter(Boolean)
    .join(' · ')
  const params = new URLSearchParams({ template: 'feedback.yml', context })
  return `${feedbackIssueUrl}?${params.toString()}`
}
