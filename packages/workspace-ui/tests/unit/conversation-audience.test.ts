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
