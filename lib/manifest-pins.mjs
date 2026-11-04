// Source pins outside YAML (realm @nick/craft, node #435): a flake.lock's github, gitlab and git inputs at their
// locked commit (nixpkgs skipped: a package set, not a system the code relies on), and a Terraform module's
// `source = "git::<url>?ref=<rev>"`. Each names its repository, so the candidate's repo is not guessed. Pure.
import { escapeRe } from './manifest-lines.mjs'

/** @typedef {import('./manifest-images.mjs').RawCandidate} RawCandidate */

const REV = '"([0-9a-f]{40})"'

/** @param {unknown} v @returns {Record<string, unknown>} */
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : {})
/** @param {unknown} v */
const text = v => (typeof v === 'string' ? v : '')

/**
 * One locked input: its repository and the pattern that reads its commit — the lockfile's keys stand sorted, so
 * `owner`, `repo`, `rev` (github, gitlab) and `rev`, `revCount`?, `type`, `url` (git) are adjacent.
 * @param {Record<string, unknown>} locked @returns {{ repo: string, versionMatch: string } | null}
 */
function lockedInput(locked) {
  const [type, owner, repo, url] = [text(locked['type']), text(locked['owner']), text(locked['repo']), text(locked['url'])]
  if ((type === 'github' || type === 'gitlab') && owner && repo) {
    const host = type === 'github' ? 'github.com' : text(locked['host']) || 'gitlab.com'
    return { repo: `https://${host}/${owner}/${repo}`, versionMatch: `"owner":\\s*"${escapeRe(owner)}",\\s*"repo":\\s*"${escapeRe(repo)}",\\s*"rev":\\s*${REV}` }
  }
  if (type === 'git' && url) {
    return { repo: url.startsWith('https://') ? url : '', versionMatch: `"rev":\\s*${REV},(?:\\s*"revCount":\\s*\\d+,)?\\s*"type":\\s*"git",\\s*"url":\\s*"${escapeRe(url)}"` }
  }
  return null
}

/** The raw candidates of a flake.lock; none when it is not JSON. @param {string} source @returns {RawCandidate[]} */
export function flakeCandidates(source) {
  /** @type {unknown} */
  let lock
  try { lock = JSON.parse(source) } catch { return [] }
  return Object.entries(obj(obj(lock)['nodes'])).flatMap(([name, node]) => {
    const locked = obj(obj(node)['locked'])
    const rev = text(locked['rev'])
    const input = lockedInput(locked)
    if (name === 'root' || /^nixpkgs/i.test(name) || text(locked['repo']) === 'nixpkgs' || !/^[0-9a-f]{40}$/.test(rev) || !input) return []
    return [{ system: name, repo: input.repo, repoGuessed: false, version: rev, versionMatch: input.versionMatch }]
  })
}

const TF_SOURCE = /^[ \t]*source[ \t]*=[ \t]*"git::([^"?\s]+)\?((?:[^"\s]*&)?ref=)([^"&\s]+)[^"\s]*"/

/** A module's git URL without its `//subdir`. @param {string} url */
function tfBase(url) {
  const scheme = url.indexOf('://')
  const sub = url.indexOf('//', scheme >= 0 ? scheme + 3 : 0)
  return sub >= 0 ? url.slice(0, sub) : url
}

/** The raw candidates of a Terraform file: each git-sourced module pinned by `ref`. @param {string[]} lines @returns {RawCandidate[]} */
export function terraformCandidates(lines) {
  return lines.flatMap(line => {
    const m = TF_SOURCE.exec(line)
    if (!m) return []
    const [url, query, version] = [String(m[1]), String(m[2]), String(m[3])]
    const base = tfBase(url)
    const repo = base.startsWith('https://') ? base : ''
    const system = base.replace(/\/+$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '') ?? ''
    return [{ system, repo, repoGuessed: false, version, versionMatch: `source[ \\t]*=[ \\t]*"git::${escapeRe(url)}\\?${escapeRe(query)}([^"&\\s]+)` }]
  })
}
