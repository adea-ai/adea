/* Display formatting for the source control app: relative times, short
 * SHAs, counts, and durations. Pure; `now` is injected for tests. */

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
}

export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds} seconds ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return new Date(then).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function duration(startedAt: string | undefined, completedAt: string | undefined): string {
  if (!startedAt || !completedAt) return ''
  const ms = Date.parse(completedAt) - Date.parse(startedAt)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes} min ${String(rest).padStart(2, '0')} s`
}

export function changeCounts(
  additions: number,
  deletions: number
): Readonly<{ add: string; del: string }> {
  return {
    add: `+${additions.toLocaleString('en-US')}`,
    del: `−${deletions.toLocaleString('en-US')}`,
  }
}

/** Initial for a monogram avatar; logins never render as images here. */
export function initial(login: string | undefined): string {
  return (
    (login ?? '?')
      .replace(/\[bot\]$/, '')
      .charAt(0)
      .toUpperCase() || '?'
  )
}

export function displayLogin(login: string): string {
  return login.replace(/\[bot\]$/, '')
}
