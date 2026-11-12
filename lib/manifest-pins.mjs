// Source pins outside YAML (realm @nick/craft, node #435): a Terraform module's `source = "git::<url>?ref=<rev>"`.
// It names its repository, so the candidate's repo is not guessed. A flake.lock's inputs are not read: build
// tooling, not a system the code talks to at run time. Pure.
import { escapeRe } from './manifest-lines.mjs'

/** @typedef {import('./manifest-images.mjs').RawCandidate} RawCandidate */

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
    const system =
      base
        .replace(/\/+$/, '')
        .split(/[/:]/)
        .pop()
        ?.replace(/\.git$/, '') ?? ''
    return [{ system, repo, repoGuessed: false, version, versionMatch: `source[ \\t]*=[ \\t]*"git::${escapeRe(url)}\\?${escapeRe(query)}([^"&\\s]+)` }]
  })
}
