// The deployed revision of an external system (realm @nick/craft, nodes #431, #440): the `version` the human stated,
// else the one `versionMatch` reads from the consumer's `versionFrom` file inside the repository, checked to the safe
// revision charset. Read by `craft init --propose` for the memory's `external` records (lib/craft-externals-memory.mjs);
// the craft binary reads and fetches a reviewer profile's integration points itself (cli/crates/craft-review/src/sources.rs).
import { readRepoFile } from './repo-file.mjs'
import { readRef, refFault, versionPattern } from './external-source-spec.mjs'

const VERSION_FILE_MAX = 4 * 1024 * 1024

/**
 * The revision a system's entry names: the `version` the human stated (node #440), else the one `versionMatch` reads
 * from `versionFrom`; throws when that file cannot be read. @param {string} repoReal @param {Record<string, string>} e
 * @returns {{ ref: string } | { error: string }}
 */
export function revisionOf(repoReal, e) {
  return 'version' in e ? statedRef(e['version']) : readVersion(repoReal, e)
}

/** A revision the human stated (node #440), checked like one read from a file. @param {string} ref @returns {{ ref: string } | { error: string }} */
function statedRef(ref) {
  const why = refFault(ref)
  return why ? { error: `version: ${why}` } : { ref }
}

/** The revision `versionMatch` reads from `versionFrom`. @param {string} repoReal @param {Record<string, string>} e @returns {{ ref: string } | { error: string }} */
function readVersion(repoReal, e) {
  const pattern = versionPattern(String(e['versionMatch']))
  if ('error' in pattern) return pattern
  return readRef(pattern.re, readRepoFile(repoReal, String(e['versionFrom']), { max: VERSION_FILE_MAX, label: 'versionFrom' }))
}
