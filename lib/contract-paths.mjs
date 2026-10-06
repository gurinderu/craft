// Which changed paths are a CERTAIN public-contract signal: a surface another version of the code, a
// deployment or a client reads, calls or deploys against, so the review gate forces the `compat`
// lens on (and `negative-space` with it) even where the scout said the diff has no wire form. Path
// only, by design: the gate sees the changed-file list and not the diff text, so a change is judged
// by WHERE it is, never by what it says. Pasted into workflows/review.js by the craft-inline gate.
import { pathSegments } from './path-segments.mjs'

// Directories whose files are test inputs, not the contract they imitate: a CRD or a migration under
// `tests/` or `fixtures/` is what a test feeds itself. A segment match, case-insensitive, at any depth.
export const NON_CONTRACT_DIRS = new Set(['test', 'tests', '__tests__', 'testdata', 'fixtures', '__fixtures__', '__snapshots__'])

// Prose is never the contract, wherever it sits. Judged by extension, NOT by a `docs/` directory:
// generated API specs commonly live there (`docs/swagger.yaml`), and those are the contract.
export const PROSE_EXT = /\.(md|mdx|markdown|rst|adoc|txt)$/i

// A directory that holds Helm charts: `charts/`, `chart/` or `helm/`. A `values*.yaml` counts only at the
// repo root (a single-chart repository) or under one — elsewhere it is far more often some other tool's.
/** @param {string} d @returns {boolean} */
export function isChartDir(d) {
  return /^(charts?|helm)$/i.test(d)
}

// The contract classes, each a predicate over the path's directory segments and its basename, named
// so a test can pin each one (skills/compatibility/catalogue.md, C5–C12). `package.json` is NOT a
// class: its public names (`bin`, `exports`) change in a minority of its edits — dependency bumps are
// the common case — and a path cannot tell the two apart, so the scout's reading stands there.
/** @type {{ name: string, test: (p: { dirs: string[], base: string }) => boolean }[]} */
export const CONTRACT_PATH_CLASSES = [
  { name: 'contracts-crate', test: p => p.dirs.some((s, i) => s === 'crates' && /^(contracts|.*-contracts)$/.test(p.dirs[i + 1] ?? '')) },
  { name: 'crd-dir', test: p => p.dirs.includes('crds') },
  { name: 'crd-manifest', test: p => /\.(ya?ml|json)$/i.test(p.base) && p.base.split(/[._-]/).some(t => /^(crds?|customresourcedefinitions?)$/i.test(t)) },
  { name: 'helm-chart', test: p => /^Chart\.ya?ml$/.test(p.base) },
  { name: 'helm-values', test: p => /^values([._-].*)?\.ya?ml$/i.test(p.base) && (p.dirs.length === 0 || p.dirs.some(isChartDir)) },
  { name: 'helm-template', test: p => /\.(ya?ml|tpl)$/i.test(p.base) && p.dirs.some((s, i) => s === 'templates' && p.dirs.slice(0, i).some(isChartDir)) },
  { name: 'openapi', test: p => /(openapi|swagger)/i.test(p.base) && /\.(ya?ml|json)$/i.test(p.base) },
  { name: 'proto', test: p => /\.proto$/i.test(p.base) },
  { name: 'graphql', test: p => /\.(graphqls?|gql)$/i.test(p.base) },
  { name: 'avro', test: p => /\.(avsc|avdl|avpr)$/i.test(p.base) },
  { name: 'json-schema', test: p => /(^|\.)schema\.json$/i.test(p.base) || /\.jsonschema$/i.test(p.base) },
  { name: 'db-migration', test: p => p.dirs.some(s => /^(migrations?|migrate|alembic)$/i.test(s)) },
  { name: 'plugin-manifest', test: p => p.dirs[p.dirs.length - 1] === '.claude-plugin' && /\.json$/i.test(p.base) },
]

// The contract class a changed path belongs to, or '' when it is none — prose and test inputs first.
/** @param {unknown} f @returns {string} */
export function contractPathClass(f) {
  const segs = pathSegments(f || '')
  const base = segs[segs.length - 1] ?? ''
  const dirs = segs.slice(0, -1)
  if (!base || PROSE_EXT.test(base) || dirs.some(s => NON_CONTRACT_DIRS.has(s.toLowerCase()))) return ''
  return CONTRACT_PATH_CLASSES.find(c => c.test({ dirs, base }))?.name ?? ''
}

// A changed file on a contract path is a CERTAIN cross-boundary signal the scout can miss. The gate
// reads this to FORCE the two surfaces it implies ON — never off, so it can only ever ADD a lens back.
/** @param {unknown} f @returns {boolean} */
export function isContractOrSchemaPath(f) {
  return contractPathClass(f) !== ''
}
