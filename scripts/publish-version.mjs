// Release Please publishes stable x.y.z versions; fail closed on other formats.
function parseStableVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)
  if (!match) {
    throw new Error(`expected a stable three-part version, received ${version}`)
  }
  return match.slice(1).map(BigInt)
}

function compareStableVersions(left, right) {
  const leftParts = parseStableVersion(left)
  const rightParts = parseStableVersion(right)
  for (let index = 0; index < leftParts.length; index++) {
    if (leftParts[index] < rightParts[index]) return -1
    if (leftParts[index] > rightParts[index]) return 1
  }
  return 0
}

/** Return false for an already-published exact version; refuse non-forward releases. */
export function shouldPublishVersion(version, exactVersion, latestVersion) {
  if (exactVersion === version) return false
  if (exactVersion !== null && exactVersion !== undefined) {
    throw new Error(`registry returned unexpected exact version ${exactVersion} for ${version}`)
  }
  if (latestVersion) {
    const comparison = compareStableVersions(version, latestVersion)
    if (comparison <= 0) {
      const relation = comparison === 0 ? 'matches' : 'is below'
      throw new Error(
        `refusing to publish ${version} because it ${relation} latest ${latestVersion}`
      )
    }
  } else {
    parseStableVersion(version)
  }
  return true
}
