import { expect, test } from 'bun:test'
import { agentProfileActionNotice } from '../../src/agent-profile-notice'

test('profile failures give fixed remediation without provider content', () => {
  for (const [code, expected] of [
    ['AGENT_PROFILE_CONFLICT', 'review the current version'],
    ['AGENT_PROFILE_REVOKED', 'published, compatible'],
    ['AGENT_PROFILE_DEPRECATED', 'published, compatible'],
    ['AGENT_PROFILE_SUPERSEDED', 'published, compatible'],
    ['AGENT_PROFILE_DRAFT', 'published, compatible'],
    ['PROFILE_VERSION_NOT_FOUND', 'published, compatible'],
    ['PROFILE_APPROVAL_MISSING', 'published, compatible'],
    ['AGENT_PROFILE_MISSING', 'published, compatible'],
    ['PROFILE_APPROVAL_REJECTED', 'published, compatible'],
    ['CONTROL_PLANE_UNAVAILABLE', 'unavailable'],
  ]) {
    const notice = agentProfileActionNotice({ code, message: 'private-provider-canary' })
    expect(notice).toContain(expected!)
    expect(notice).not.toContain('private-provider-canary')
  }
  expect(agentProfileActionNotice({ code: 'AGENT_PROFILE___proto__' })).not.toContain('__proto__')
  expect(agentProfileActionNotice({ status: 422 })).toContain('compatible')
  expect(agentProfileActionNotice({ status: 403 })).toContain('permitted')
})

test('a superseded Agent revision asks the editor to refresh without repeating server text', () => {
  const notice = agentProfileActionNotice({
    code: 'AGENT_REVISION_CONFLICT',
    message: 'private-provider-canary',
  })
  expect(notice).toContain('Agent changed')
  expect(notice).toContain('refresh')
  expect(notice).not.toContain('private-provider-canary')
})
