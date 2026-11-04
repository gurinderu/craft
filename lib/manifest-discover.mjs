// The candidates one deployment manifest gives (realm @nick/craft, node #435): the parser its name calls for, and
// each raw candidate kept only when its pattern, run on the file's own text, reads back exactly the version it was
// built from — a pattern that would read another line, or none, is dropped, not shown. Pure.
import { readRef, versionPattern } from './external-source-spec.mjs'
import { checkCandidate, usableRepo } from './external-candidate.mjs'
import { fileDir, manifestKind } from './manifest-paths.mjs'
import { imageLines, kustomizeImages, repositoryTagBlocks } from './manifest-images.mjs'
import { chartCandidates } from './manifest-chart.mjs'
import { terraformCandidates } from './manifest-pins.mjs'

/**
 * @typedef {import('./external-candidate.mjs').Candidate} Candidate
 * @typedef {import('./manifest-images.mjs').RawCandidate} RawCandidate
 */

// A plain Kubernetes manifest: a top-level apiVersion and kind.
const K8S = /^apiVersion:/m
const K8S_KIND = /^kind:/m

/** The raw candidates of `text` read as the manifest `file`'s name says. @param {string} file @param {string} text @returns {RawCandidate[]} */
function rawCandidates(file, text) {
  const lines = text.split('\n')
  switch (manifestKind(file)) {
    case 'chart': return chartCandidates(lines)
    case 'values': return [...imageLines(lines), ...repositoryTagBlocks(lines)]
    case 'kustomization': return kustomizeImages(lines)
    case 'compose': return imageLines(lines)
    case 'terraform': return terraformCandidates(lines)
    case 'k8s': return K8S.test(text) && K8S_KIND.test(text) ? imageLines(lines) : []
    default: return []
  }
}

/** Whether the raw candidate's pattern reads its own version from `text`. @param {RawCandidate} raw @param {string} text */
function readsBack(raw, text) {
  const p = versionPattern(raw.versionMatch)
  if ('error' in p) return false
  const got = readRef(p.re, text)
  return 'ref' in got && got.ref === raw.version
}

/**
 * The checked candidates of one manifest: versionFrom the file, scope its directory; one per system.
 * @param {string} file  repo-relative @param {string} text @returns {Candidate[]}
 */
export function candidatesIn(file, text) {
  /** @type {Candidate[]} */
  const out = []
  for (const raw of rawCandidates(file, text)) {
    if (!readsBack(raw, text)) continue
    const repo = usableRepo(raw.repo) ? raw.repo : ''
    const c = checkCandidate({ ...raw, repo, repoGuessed: raw.repoGuessed && !!repo, versionFrom: file, scope: fileDir(file) })
    if (c && !out.some(o => o.system === c.system)) out.push(c)
  }
  return out
}
