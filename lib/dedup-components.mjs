// The cross-lens dedup's groups as one graph (realm @nick/craft, node #405): the deterministic
// same-spot groups and the model's same-defect groups are edges over the pool's indices, and each
// connected component merges into one finding. "First wins" used to drop a whole model group that
// shared one finding with a same-spot pair — on a measured run a nine-lens "grant counted twice"
// group and a nine-lens "lowered max_attempts strands rows" group stayed split, so neither the
// verifier nor the multi-lens agreement (lib/lens-agreement.mjs) ever saw them as one defect.

/** The largest component chaining model groups may build before it falls back to first-wins. */
export const COMPONENT_MAX = 40

/**
 * Adds one dedup pass's component sizes to the run's tally: the largest, how many exceeded twelve
 * (the old cap, under which the measured clusters fell back) and how many fell back now.
 * @param {{ largest: number, overTwelve: number, fellBack: number }} tally  mutated
 * @param {number[]} sizes @param {number} fellBack
 */
export function noteComponents(tally, sizes, fellBack) {
  tally.largest = Math.max(tally.largest, ...sizes)
  tally.overTwelve += sizes.filter(s => s > 12).length
  tally.fellBack += fellBack
}

/** @param {number[]} parent @param {number} i @returns {number} */
function find(parent, i) {
  let r = i
  while (parent[r] !== r) r = /** @type {number} */ (parent[r])
  while (parent[i] !== r) { const next = /** @type {number} */ (parent[i]); parent[i] = r; i = next }
  return r
}

/**
 * The groups of `groups` (in order) that overlap no earlier one: the old first-wins rule, kept for a
 * component the union may not merge whole.
 * @param {number[][]} groups @returns {number[][]}
 */
export function firstWins(groups) {
  /** @type {Set<number>} */
  const taken = new Set()
  const out = []
  for (const g of groups) {
    if (g.some(i => taken.has(i))) continue
    for (const i of g) taken.add(i)
    out.push(g)
  }
  return out
}

/**
 * The connected components of the edges `detGroups` then `modelGroups` lay over `n` indices, each a
 * merge group (singletons left out). A component the union may not merge whole — over COMPONENT_MAX,
 * or `holdsDistinct` over its members (two gate findings the tool tells apart, realm @nick/craft,
 * node #238) — falls back to first-wins over its own groups, the same-spot ones first, so a pair is
 * never split; it is listed in `fellBack`.
 * @param {number} n
 * @param {number[][]} detGroups
 * @param {number[][]} modelGroups
 * @param {(members: number[]) => boolean} holdsDistinct
 * @returns {{ groups: number[][], fellBack: number[][], sizes: number[] }}
 */
export function mergeComponents(n, detGroups, modelGroups, holdsDistinct) {
  const all = detGroups.concat(modelGroups)
  const parent = Array.from({ length: n }, (_u, i) => i)
  for (const g of all) for (const i of g.slice(1)) parent[find(parent, i)] = find(parent, /** @type {number} */ (g[0]))
  /** @type {Map<number, number[]>} */
  const comps = new Map()
  for (let i = 0; i < n; i++) {
    const r = find(parent, i)
    const c = comps.get(r)
    if (c) c.push(i)
    else comps.set(r, [i])
  }
  /** @type {number[][]} */
  const groups = []
  /** @type {number[][]} */
  const fellBack = []
  /** @type {number[]} */
  const sizes = []
  for (const [root, members] of comps) {
    if (members.length < 2) continue
    sizes.push(members.length)
    const own = all.filter(g => find(parent, /** @type {number} */ (g[0])) === root)
    if (members.length <= COMPONENT_MAX && !holdsDistinct(members)) { groups.push(members); continue }
    fellBack.push(members)
    groups.push(...firstWins(own))
  }
  return { groups, fellBack, sizes }
}
