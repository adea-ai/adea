/*
 * The Finish your review popover's copy. Each verdict's description says
 * what that verdict does to this pull request right now — the approval it
 * completes, whose fix a change request waits on — and a status line says
 * where the viewer's own review stands. Pure.
 */
import { displayLogin, plural } from './format'
import {
  approvalCount,
  approvalsMet,
  changesRequested,
  reviewFacet,
  viewerIsAuthor,
  viewerIsRequested,
} from './status'
import type { PullRequestView } from './types'

export type ReviewCopy = Readonly<{
  status: string
  comment: string
  approve: string
  requestChanges: string
}>

const sameLogin = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()

export function reviewCopy(pr: PullRequestView, viewer: string | undefined): ReviewCopy {
  const own = viewerIsAuthor(pr, viewer)
  const mine = viewer
    ? pr.reviews.find((review) => sameLogin(review.actor.login, viewer))
    : undefined
  const onHead = mine?.commitSha === undefined || mine.commitSha === pr.headSha
  const author = pr.session
    ? 'the agent session'
    : pr.author
      ? displayLogin(pr.author.login)
      : 'the author'

  let status: string
  if (own) status = 'This is your pull request; you can comment on it.'
  else if (mine?.state === 'approved')
    status = onHead
      ? 'You approved these changes.'
      : 'You approved an earlier commit; the branch has moved since.'
  else if (mine?.state === 'changes_requested')
    status = onHead
      ? 'You requested changes on these changes.'
      : 'You requested changes on an earlier commit; the branch has moved since.'
  else if (viewerIsRequested(pr, viewer)) status = 'Your review is requested.'
  else if (changesRequested(pr)) status = 'A reviewer requested changes.'
  else status = `${reviewFacet(pr).label}.`

  const approvals = approvalCount(pr)
  const required = pr.requiredApprovals
  const viewerCounted = mine?.state === 'approved'
  let approve: string
  if (own) approve = 'You cannot approve your own pull request.'
  else if (viewerCounted && onHead) approve = 'Approve again; your approval already counts.'
  else if (pr.reviewDecision === 'approved' || (required === undefined && approvalsMet(pr)))
    approve = 'Adds your approval; the required approvals are already in.'
  else if (required !== undefined && required > 0) {
    const next = approvals + (viewerCounted ? 0 : 1)
    approve =
      next < required
        ? `This counts as approval ${next} of ${required}.`
        : required === 1
          ? 'This is the one required approval.'
          : `This completes the ${plural(required, 'required approval')}.`
  } else approve = 'Approve these changes.'

  return {
    status,
    comment:
      mine?.state === 'approved' && onHead
        ? 'Send feedback; your approval stands.'
        : 'Send feedback without approving.',
    approve,
    requestChanges: own
      ? 'You cannot request changes on your own pull request.'
      : `Blocks merging until ${author} pushes a fix.`,
  }
}
