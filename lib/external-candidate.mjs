// A candidate for a memory record of kind `external` (realm @nick/craft, node #434): what the discovery CLI derives
// from a deployment manifest (node #435) and only a human's confirmation turns into a record (node #436; the engine
// never writes memory, #206). The checks a candidate must pass wherever it is read — the CLI's own output and the
// review engine's reading of what its prep agent relayed — whether a record already covers it, and the report line.
// Pure: the engine bundles it.
import { SYSTEM_NAME, refFault, repoUrlParts, versionPattern } from './external-source-spec.mjs'
import { hasControlChar } from './prior-decision-record.mjs'

/**
 * @typedef {{ system: string, repo: string, repoGuessed: boolean, versionFrom: string, versionMatch: string, version: string, scope: string, note?: string }} Candidate
 * @typedef {{ system: string, repo: string, versionFrom: string, version?: string }} RecordLike
 */

// How many candidates one report names; the rest are counted.
export const CANDIDATES_SHOWN = 16
const SCOPE = /^[A-Za-z0-9._@+/ -]{1,300}$/
const NOTE_MAX = 200

/** A repo-relative path of plain characters, no `..` segment. @param {string} p */
const relPath = p => SCOPE.test(p) && !p.startsWith('/') && !p.split('/').includes('..')
/** @param {unknown} v */
const txt = v => (typeof v === 'string' ? v : '')

/** A repository URL a candidate may carry: https and one the sources CLI would clone. @param {string} repo */
export const usableRepo = repo => repo.startsWith('https://') && !('error' in repoUrlParts(repo))

/** The fields of a candidate as text, from whatever `x` is. @param {unknown} x */
function fieldsOf(x) {
  const r = /** @type {Record<string, unknown>} */ (x && typeof x === 'object' && !Array.isArray(x) ? x : {})
  return { system: txt(r['system']), repo: txt(r['repo']), repoGuessed: r['repoGuessed'] === true, versionFrom: txt(r['versionFrom']), versionMatch: txt(r['versionMatch']), version: txt(r['version']), scope: txt(r['scope']), note: txt(r['note']) }
}

/** Whether versionFrom and scope are repo-relative, versionFrom among `files` when given. @param {Candidate} c @param {string[]} [files] */
const soundPaths = (c, files) => relPath(c.versionFrom) && relPath(c.scope) && (!files || files.includes(c.versionFrom))
/** Whether the pattern compiles with one capture group and holds no backtick, and the version is a safe revision. @param {Candidate} c */
const soundPattern = c => !c.versionMatch.includes('`') && !('error' in versionPattern(c.versionMatch)) && !refFault(c.version)

/**
 * The candidate in `x`, or null when any field fails: no field holds a control character (a newline would forge
 * report lines, wherever the line prints it), a system name, a repo that is empty or usable, a versionFrom
 * among `files` (when given), a versionMatch that compiles with one capture group and holds no backtick, a version
 * that is a safe revision, a scope of plain repo-relative path characters.
 * @param {unknown} x @param {string[]} [files] @returns {Candidate | null}
 */
export function checkCandidate(x, files) {
  const { note: rawNote, ...c } = fieldsOf(x)
  const note = rawNote.replace(/`/g, ' ').slice(0, NOTE_MAX)
  const ok = ![rawNote, ...Object.values(c)].some(v => typeof v === 'string' && hasControlChar(v)) && SYSTEM_NAME.test(c.system) && (!c.repo || usableRepo(c.repo)) && soundPaths(c, files) && soundPattern(c)
  return ok ? { ...c, repoGuessed: c.repoGuessed && !!c.repo, ...(note ? { note } : {}) } : null
}

/** A repository's identity: host and path, lower-cased; '' when it is no URL. @param {string} url */
function repoKey(url) {
  const p = repoUrlParts(url)
  return 'error' in p ? '' : `${p.host}/${p.path}`.toLowerCase()
}

/** Whether two repository URLs (https, ssh or scp form, with or without `.git`) name the same repository. @param {string} a @param {string} b */
export function sameRepo(a, b) {
  const key = repoKey(a)
  return !!key && key === repoKey(b)
}

/**
 * Whether a record already covers the candidate: the same repository, or the same system and either the same
 * versionFrom or a version the human stated (realm @nick/craft, node #440). @param {Candidate} c @param {RecordLike[]} records
 */
export function coveredBy(c, records) {
  const key = c.repo ? repoKey(c.repo) : ''
  return records.some(r => (key && repoKey(txt(r.repo)) === key) || ((txt(r.versionFrom) === c.versionFrom || !!txt(r.version)) && txt(r.system).toLowerCase() === c.system.toLowerCase()))
}

/**
 * The candidates in a relayed list that pass the checks, lie in `files` and no record covers; one per system and
 * versionFrom, in order.
 * @param {unknown} list @param {string[] | undefined} files @param {RecordLike[]} records @returns {Candidate[]}
 */
export function readCandidates(list, files, records) {
  /** @type {Candidate[]} */
  const out = []
  for (const x of Array.isArray(list) ? list : []) {
    const c = checkCandidate(x, files)
    if (c && !coveredBy(c, records) && !out.some(o => o.system === c.system && o.versionFrom === c.versionFrom)) out.push(c)
  }
  return out
}

/** The report's line for a candidate: every field a record-external needs, ready to confirm. @param {Candidate} c */
export function candidateLine(c) {
  const repo = c.repo ? `repo ${c.repo}${c.repoGuessed ? ' (guessed)' : ''}` : 'repo unknown'
  return `- candidate: ${c.system} — ${repo} · versionFrom \`${c.versionFrom}\` · versionMatch \`${c.versionMatch}\` · scope \`${c.scope}\` · reads ${c.version}${c.note ? ` (${c.note})` : ''} — record it with craft:memory record-external, or confirm with craft:memory discover-externals`
}
