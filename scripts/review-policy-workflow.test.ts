import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const workflow = Bun.YAML.parse(
  readFileSync(join(root, '.github/workflows/review-policy.yml'), 'utf8')
) as Record<string, any>
// YAML 1.1 reads the unquoted key `on` as the boolean true.
const triggers = (workflow.on ?? workflow[String(true)]) as Record<string, { types: string[] }>

/** The concurrency group a run of `event` on PR 7 lands in. */
const groupOf = (event: string) =>
  String(workflow.concurrency.group)
    .replaceAll('${{ github.event_name }}', event)
    .replaceAll('${{ github.event.pull_request.number }}', '7')

describe('review policy workflow', () => {
  test('pull_request_target and pull_request_review runs do not share a cancellation group', () => {
    // Both events evaluate the same required `Review Policy / Gate` context. With one shared group, a review
    // event cancelled an in-flight `pull_request_target` run (and the reverse), which left the required context
    // cancelled instead of evaluated.
    expect(groupOf('pull_request_target')).not.toBe(groupOf('pull_request_review'))
  })

  test('superseded runs of the same event on the same pull request still cancel each other', () => {
    expect(workflow.concurrency['cancel-in-progress']).toBe(true)
    expect(String(workflow.concurrency.group)).toContain('${{ github.event.pull_request.number }}')
    expect(String(workflow.concurrency.group)).toContain('${{ github.event_name }}')
  })

  test('the policy evaluation, triggers, permissions and required context are unchanged', () => {
    expect(triggers.pull_request_target!.types).toEqual(['ready_for_review', 'synchronize'])
    expect(triggers.pull_request_review!.types).toEqual(['submitted', 'dismissed'])
    expect(workflow.permissions).toEqual({ 'pull-requests': 'read' })
    expect(workflow.jobs.gate.name).toBe('Review Policy / Gate')
    expect(workflow.jobs.gate['runs-on']).toBe('ubuntu-latest')
    expect(workflow.jobs.gate['timeout-minutes']).toBe(5)
    expect(Object.keys(workflow.jobs)).toEqual(['gate'])
  })
})
