const releaseTypes = new Set(['feat', 'fix', 'perf', 'revert'])

export function parseCommitLog(log) {
  return log
    .split('\u001e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash = '', subject = '', ...body] = record.split('\u001f')
      return { hash, subject, body: body.join('\u001f').trim() }
    })
}

function isReleasableCommit(commit) {
  const conventional = commit.subject.match(/^([a-z]+)(?:\([^)]+\))?(!)?:\s+.+/)
  return (
    (conventional && (releaseTypes.has(conventional[1]) || conventional[2] === '!')) ||
    /(^|\n)BREAKING[ -]CHANGE:\s+\S/i.test(commit.body) ||
    /(^|\n)Release-As:\s+\d+\.\d+\.\d+\s*$/im.test(commit.body)
  )
}

export function createReleasePlan({ branch, commits, head, latestTag, remoteHead, status }) {
  if (branch !== 'main') throw new Error('Manual releases must run from main.')
  if (status.trim()) throw new Error('Manual releases require a clean worktree.')
  if (head !== remoteHead) throw new Error('Local main must exactly match origin/main.')
  if (!/^v\d+\.\d+\.\d+$/.test(latestTag)) {
    throw new Error(`Latest GitHub release is not an exact semantic version tag: ${latestTag}`)
  }

  const releasableCommits = commits.filter(isReleasableCommit)
  return releasableCommits.length === 0
    ? { action: 'noop', latestTag, releasableCommits }
    : { action: 'release', latestTag, releasableCommits }
}
