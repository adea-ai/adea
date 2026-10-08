import { describe, expect, test } from 'bun:test'

import {
  groupCreationRejectionReasons,
  groupGrantStates,
  groupPublicationHoldReasons,
  groupSharingScopes,
  isGroupSharingScope,
} from '../src/group-participation'
import { groupSharingScopes as groupSharingScopesFromIndex } from '../src/index'

describe('group participation type contracts', () => {
  test('enumerates every grant state', () => {
    expect(groupGrantStates).toEqual(['effective', 'expired', 'not_yet_issued', 'revoked'])
  })

  test('enumerates both sharing scopes as independently grantable', () => {
    expect(groupSharingScopes).toEqual(['earlier_history', 'earlier_summary'])
  })

  test('enumerates every creation rejection reason', () => {
    expect(groupCreationRejectionReasons).toEqual([
      'audience_empty',
      'audience_requires_human',
      'duplicate_participant',
      'grant_absent',
      'grant_expired',
      'grant_id_missing',
      'grant_mismatched_group',
      'grant_mismatched_participant',
      'grant_not_yet_issued',
      'grant_revision_invalid',
      'grant_revoked',
      'group_id_missing',
      'group_workspace_missing',
      'participant_cross_tenant',
      'participant_unqualified',
    ])
  })

  test('enumerates every publication hold reason', () => {
    expect(groupPublicationHoldReasons).toEqual([
      'publication_authority_mismatch',
      'publication_binding_mismatch',
      'publication_participation_revoked',
      'publication_participation_stale',
      'publication_unauthorized_at_completion',
    ])
  })

  test('guards sharing scopes', () => {
    expect(isGroupSharingScope('earlier_history')).toBeTrue()
    expect(isGroupSharingScope('earlier_summary')).toBeTrue()
    expect(isGroupSharingScope('all_history')).toBeFalse()
    expect(isGroupSharingScope(undefined)).toBeFalse()
  })

  test('re-exports the module from the package index', () => {
    expect(groupSharingScopesFromIndex).toEqual(groupSharingScopes)
  })
})
