// Which files of the consumer's repository may be deployment manifests naming an external system (realm
// @nick/craft, node #435): by the file's name alone, so the review engine picks the ones its diff touched in code
// (the Workflow sandbox reads no file and spawns no process, #134) and the discovery CLI knows what to parse. A
// library's lockfile (Cargo.lock, go.sum, package-lock.json) is not one: a dependency's source is found the
// lockfile's way (lib/dependency-source.mjs). Nor is a flake.lock: its inputs are build tooling the code does not
// talk to at run time (realm @nick/craft, node #435). Pure: no Node API, the engine bundles it.

/** @typedef {'chart' | 'values' | 'kustomization' | 'compose' | 'terraform' | 'k8s'} ManifestKind */

// How many touched manifests one review hands the discovery CLI; the rest are named as not read.
export const MANIFESTS_MAX = 24

/** @type {Array<[RegExp, ManifestKind]>} */
const BY_NAME = [
  [/^Chart\.yaml$/, 'chart'],
  [/^values[\w.-]*\.ya?ml$/, 'values'],
  [/^(?:kustomization\.ya?ml|Kustomization)$/, 'kustomization'],
  [/^(?:docker-)?compose[\w.-]*\.ya?ml$/, 'compose'],
  [/\.tf$/, 'terraform'],
]

/**
 * The kind of manifest `file` (repo-relative, `/`-separated) may be, '' when none. Any other YAML file may be a
 * plain Kubernetes manifest (the CLI reads its content to tell) — unless it sits under a dot directory (CI and
 * tool configuration), under a chart's `templates/` (no literal version there), or is a lockfile.
 * @param {string} file @returns {ManifestKind | ''}
 */
export function manifestKind(file) {
  const segs = file.split('/')
  const name = segs[segs.length - 1] ?? ''
  const named = BY_NAME.find(([re]) => re.test(name))
  if (named) return named[1]
  if (!/\.ya?ml$/.test(name) || /lock/i.test(name)) return ''
  return segs.some(s => s.startsWith('.') || s === 'templates') ? '' : 'k8s'
}

/** The changed files that may be manifests, at most MANIFESTS_MAX, and how many past it were dropped. @param {string[]} files */
export function touchedManifests(files) {
  const all = [...new Set(files.filter(f => typeof f === 'string' && manifestKind(f)))]
  return { manifests: all.slice(0, MANIFESTS_MAX), dropped: Math.max(0, all.length - MANIFESTS_MAX) }
}

/** The directory of a repo-relative file, `.` at the root: a candidate's suggested scope. @param {string} file */
export const fileDir = file => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.')
