// The Send Feedback action opens GitHub's issue form in a new window with the
// app/version/platform context prefilled into the form's `context` field
// (.github/ISSUE_TEMPLATE/feedback.yml). Nothing is submitted automatically:
// the user reviews the draft issue before filing it.
export function adeaFeedbackUrl(version: string | undefined, platform: 'desktop' | 'web') {
  const params = new URLSearchParams({
    template: 'feedback.yml',
    context: `App: Adea\nVersion: ${version || 'unavailable'}\nPlatform: ${platform}`,
  })
  return `https://github.com/adea-ai/adea/issues/new?${params.toString()}`
}
