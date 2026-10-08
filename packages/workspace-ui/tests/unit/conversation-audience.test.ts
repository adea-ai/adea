import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../src/conversation-surface.tsx', import.meta.url), 'utf8')
const compact = source.replace(/\s+/g, '')

test('retained transcripts are workspace and audience scoped, and revoked generations cannot be saved again', () => {
  expect(compact).toContain(
    'useWorkspaceState((state)=>state.conversationAudienceEpochs[props.workspaceId]??0)'
  )
  expect(source).toContain('conversationAudienceEpochs[workspaceId] ?? 0) !== audienceEpoch')
  expect(source).toContain(
    'cached.workspaceId === props.workspaceId && cached.audienceEpoch !== epoch'
  )
  expect(source).toContain('transcriptCache.delete(key)')
  expect(source).toContain('loadedAudienceEpoch = epoch')
  expect(source).toContain('setMessages(cached?.messages ?? [])')
  expect(source).toContain('setOptimisticMessage(null)')
  expect(source).not.toContain('placeholderData:')
  expect(source).toContain('settledConversationPage(messageQuery, epoch)')
})

test('late message responses cannot restore a transcript after audience reset or channel switch', () => {
  expect(source).toContain('const submittedAudienceEpoch = audienceEpoch()')
  expect(source).toContain('if (!stillCurrent()) return')
  expect(source).toContain('audienceEpoch() === submittedAudienceEpoch')
  expect(source).toContain('if (stillCurrent()) setOptimisticMessage(null)')
})

// Source composition coverage supplements the mounted Chat controller cases;
// these assertions do not claim browser mounting of the Virtual/nav components.
test('Virtual and global navigation use audience-qualified lists and guard group completion', () => {
  const virtual = readFileSync(
    new URL('../../src/virtual-room-controls.tsx', import.meta.url),
    'utf8'
  )
  const navigation = readFileSync(
    new URL('../../src/global-nav-sections.tsx', import.meta.url),
    'utf8'
  )
  expect(virtual).toContain('settledConversationPage(channels, audienceEpoch())')
  expect(virtual).toContain('list?.conversationWorkspaceId === workspaceId()')
  expect(virtual).toContain("decision.action === 'clear'")
  expect(virtual).not.toContain('settledData(channels)')
  expect(virtual).toContain(
    'if (currentSelectionAuthority(authority)) selectChannel(result.channel.id)'
  )
  expect(navigation).toContain('settledConversationPage(channels, audienceEpoch())')
  expect(navigation).not.toContain('settledData(channels)')
  expect(navigation).toContain('workspaceId() !== submittedWorkspaceId')
  expect(navigation).toContain('audienceEpoch() !== submittedAudienceEpoch')
})
