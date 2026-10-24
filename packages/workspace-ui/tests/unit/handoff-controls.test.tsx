// Distinct lead-stop and job-cancel controls (#1173). A job is cancelled only
// from its own control, only while an authenticated observation binds it, and
// never through the lead or session stop handlers. The model decides
// availability (see packages/dev-view/tests/chat-handoff-observation.test.ts);
// this file proves what the rendered surface does with that decision.
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

const { render } = await import('solid-js/web')
const { DirectSessionHandoffControls } = await import('@adea-ai/dev-view/chat')
const { deriveDirectSessionHandoff } = await import('@adea-ai/dev-view/chat/model')

type Input = Parameters<typeof deriveDirectSessionHandoff>[0]

const SCOPE = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const INTENT = '00000000-0000-4000-8000-0000000000a1'
const ATTEMPT = 'attempt_11111111111111111111111111111111'
const TASK = '00000000-0000-4000-8000-0000000000f1'

const observation = {
  source: 'runtime_authenticated' as const,
  sessionId: 'session-1',
  taskId: TASK,
  generation: 3,
  intentId: INTENT,
  attemptId: ATTEMPT,
}

function input(overrides: Partial<Input> = {}): Input {
  return {
    session: {
      id: 'session-1',
      scope: SCOPE,
      projectId: 'project-1',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      lifecycle: 'active',
      archived: false,
      projection: 'structured',
      generation: 3,
      version: 7,
      activeHarnessRunId: 'run-1',
    },
    mode: 'coordination_handoff',
    leadTurn: {
      intentId: INTENT,
      agentId: '00000000-0000-4000-8000-0000000000b2',
      dispatchId: 'dispatch_22222222222222222222222222222222',
      attemptId: ATTEMPT,
      state: 'running',
      canCancel: true,
      handoffTarget: { runtimeSessionId: 'session-1', taskId: TASK, observedGeneration: 3 },
      executionRuntimeSessionId: 'session-1',
      targetObservation: observation,
    },
    leadAgent: {
      id: '00000000-0000-4000-8000-0000000000b2',
      isWorkspaceLead: true,
      lifecycleState: 'active',
    },
    leadMismatch: false,
    connected: true,
    generationCurrent: true,
    scopeAuthorized: true,
    hasUnsentDraft: false,
    awaitingApproval: false,
    childJobs: [
      {
        jobId: 'job-1',
        label: 'Index the repository',
        state: 'running',
        descendantCount: 2,
        observation,
      },
    ],
    jobCancelWired: true,
    ...overrides,
  } as Input
}

const disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  document.body.innerHTML = ''
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function mount(
  overrides: Partial<Input>,
  handlers: Partial<Parameters<typeof DirectSessionHandoffControls>[0]>
) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const view = deriveDirectSessionHandoff(input(overrides))
  disposers.push(
    render(() => <DirectSessionHandoffControls view={view} {...handlers} />, container)
  )
  return container
}

function button(container: HTMLElement, name: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find(
      (candidate) => candidate.getAttribute('aria-label') === name || candidate.textContent === name
    ) ?? null
  )
}

describe('job cancel on the rendered controls', () => {
  test('cancels the job that was clicked and nothing else', () => {
    const cancelled: string[] = []
    const stopped: string[] = []
    const container = mount(
      {},
      {
        onJobCancel: (jobId: string) => void cancelled.push(jobId),
        onLeadStop: () => void stopped.push('lead'),
        onSessionStop: () => void stopped.push('session'),
      }
    )
    const cancel = button(container, 'Cancel job: Index the repository')
    expect(cancel).not.toBeNull()
    expect(cancel?.disabled).toBe(false)
    cancel?.click()
    expect(cancelled).toEqual(['job-1'])
    expect(stopped).toEqual([])
  })

  test('stopping the lead never cancels a job', () => {
    const cancelled: string[] = []
    let leadStops = 0
    const container = mount(
      {},
      {
        onJobCancel: (jobId: string) => void cancelled.push(jobId),
        onLeadStop: () => void (leadStops += 1),
      }
    )
    button(container, 'Stop lead')?.click()
    expect(leadStops).toBe(1)
    expect(cancelled).toEqual([])
  })

  test('a job the model does not authorize cannot be cancelled', () => {
    for (const overrides of [
      { jobCancelWired: false },
      { connected: false },
      { childJobs: [{ ...input().childJobs![0]!, state: 'cancel_pending' as const }] },
    ]) {
      const cancelled: string[] = []
      const container = mount(overrides, {
        onJobCancel: (jobId: string) => void cancelled.push(jobId),
      })
      const cancel = button(container, 'Cancel job: Index the repository')
      expect(cancel === null || cancel.disabled).toBe(true)
      cancel?.click()
      expect(cancelled).toEqual([])
    }
  })

  test('without a handler no job control is offered as available', () => {
    const container = mount({}, {})
    const cancel = button(container, 'Cancel job: Index the repository')
    expect(cancel === null || cancel.disabled).toBe(true)
  })
})
