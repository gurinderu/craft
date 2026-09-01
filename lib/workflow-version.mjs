// Which workflows must carry a `const CRAFT_VERSION = '…'` stamp, and whether they do.
//
// The set is DERIVED, never listed: a workflow needs a stamp exactly when it files its own run
// record, and it files one by calling `logRun(...)` (the inlined persister every record-filing
// workflow pastes in). A hardcoded list would reproduce the very defect this guards — a new
// record-filing workflow would simply be absent from it and thus silently exempt.
//
// The pins (`rust-review.js`, `nix-review.js`) delegate to `review.js` and file nothing, so they
// call no logRun and are legitimately skipped; a version const there would be dead code.
//
// A missing stamp is a FAILURE, not a skip: silence must never be readable as a pass.

const CALLS_LOG_RUN = /(^|[^\w.])logRun\s*\(/m
const VERSION_STAMP = /^const CRAFT_VERSION = '([^']*)'/m

export function filesRunRecord(src) {
  return CALLS_LOG_RUN.test(src)
}

export function versionStamp(src) {
  const m = src.match(VERSION_STAMP)
  return m ? m[1] : null
}

// files: [{ name, src }]. Returns { failures: string[], oks: string[], skipped: string[] }.
export function checkVersionStamps(files, manifestVersion) {
  const failures = []
  const oks = []
  const skipped = []
  for (const { name, src } of files) {
    const stamp = versionStamp(src)
    if (!filesRunRecord(src)) {
      if (stamp === null) { skipped.push(name); continue }
      // Stamped but files no record: still hold it to the manifest rather than ignoring it.
    }
    if (stamp === null) {
      failures.push(`${name} :: files a run record but carries no CRAFT_VERSION stamp (expected \`const CRAFT_VERSION = '${manifestVersion}' // x-release-please-version\`)`)
    } else if (stamp !== manifestVersion) {
      failures.push(`${name} :: CRAFT_VERSION '${stamp}' != plugin.json version '${manifestVersion}'`)
    } else {
      oks.push(`${name} CRAFT_VERSION ${stamp} matches the manifest`)
    }
  }
  return { failures, oks, skipped }
}
