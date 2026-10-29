// enrich-cost by a Workflow run id: every record the run filed gets the cost of its own slice of the
// run's agents (realm @nick/craft, nodes #393, #115, #389). The engine sandbox cannot see its run id,
// so the launcher, which reads `wf_…` off the Workflow completion, runs this after the run has ended.
// A run that resumed files a second record; summing the whole directory into each, or enriching the
// first while the run still grew, gave a cost no field said was partial. Counting is transcript-cost's
// one rule (#98, #357) — this module only decides which transcripts belong to which record.
// SLICED BY ENGINE FIRST, then by time within one engine: rust-audit and the rust-review/nix-review
// entries run a nested engine in the same run, whose agents interleave with the outer engine's, so a
// cut by time alone gives one engine's agents to the other's record.
import { runTranscripts, measureCost } from './transcript-cost.mjs'
import { findRunDir } from './workflow-run-dir.mjs'
import { readAgent } from './run-agents.mjs'

/** @typedef {import('./run-agents.mjs').RunAgent} RunAgent */
/** @typedef {{ engine: string, instance: string, agents: number }} Absorbed */
/** @typedef {{ record: string, transcripts: string[], tail: number, end: number, absorbed?: Absorbed[] }} Slice */

/**
 * One engine's records in filing order, each with the transcripts of its slice: the agents that started
 * after the previous record's log-run agent, up to and including its own. Agents that started after
 * the last log-run (a dead tail) go to the last record and are counted in its `tail`.
 * @param {{ name: string, start: number, record: string }[]} agents @param {string} [engine]  named in a refusal
 * @returns {Slice[]}
 */
export function sliceAgents(agents, engine = 'this run') {
  const ordered = [...agents].sort((a, b) => a.start - b.start || a.name.localeCompare(b.name))
  // A record filed twice (the engine's retry: `already filed`) ends its slice at the later filing.
  /** @type {Map<string, number>} */
  const boundary = new Map()
  for (const a of ordered) if (a.record) boundary.set(a.record, a.start)
  const bounds = [...boundary].sort((a, b) => a[1] - b[1])
  if (!bounds.length) throw new Error(`no log-run agent of ${engine} reported a filed record`)
  /** @type {Slice[]} */
  const slices = bounds.map(([record, end]) => ({ record, transcripts: [], tail: 0, end }))
  const last = /** @type {Slice} */ (slices[slices.length - 1])
  for (const a of ordered) {
    const i = bounds.findIndex(([, end]) => a.start <= end)
    const slice = i < 0 ? last : /** @type {Slice} */ (slices[i])
    if (i < 0) slice.tail++
    slice.transcripts.push(a.name)
  }
  return slices
}

/**
 * The run's agents grouped by the engine instance they ran under ('' for the top-level engine). A nested
 * instance that filed no record (its logger died) ran on the top-level engine's behalf: its agents join
 * that group, a warning says so, and `absorbed` names each such agent's engine for the cost to show.
 * @param {RunAgent[]} agents @param {string[]} warnings
 * @returns {{ groups: Map<string, RunAgent[]>, absorbed: Map<string, RunAgent> }}
 */
function byEngine(agents, warnings) {
  /** @type {Map<string, RunAgent[]>} */
  const groups = new Map()
  /** @type {Map<string, RunAgent>} */
  const absorbed = new Map()
  for (const a of agents) groups.set(a.instance, [...(groups.get(a.instance) ?? []), a])
  for (const [instance, list] of groups) {
    if (!instance || list.some(a => a.record)) continue
    groups.delete(instance)
    groups.set('', [...(groups.get('') ?? []), ...list])
    for (const a of list) absorbed.set(a.name, a)
    warnings.push(`craft-log-run WARNING: ${list.length} agent(s) of "${instance}" filed no record — counted under the top-level engine`)
  }
  return { groups, absorbed }
}

// The nested engines whose agents a slice took in, one entry per instance; undefined when none.
/** @param {Slice} slice @param {Map<string, RunAgent>} absorbed @returns {Absorbed[] | undefined} */
function absorbedIn(slice, absorbed) {
  /** @type {Map<string, Absorbed>} */
  const by = new Map()
  for (const name of slice.transcripts) {
    const a = absorbed.get(name)
    if (!a) continue
    const seen = by.get(a.instance) ?? { engine: a.engine, instance: a.instance, agents: 0 }
    seen.agents++
    by.set(a.instance, seen)
  }
  return by.size ? [...by.values()] : undefined
}

// A nested engine's record must be that engine's, and no record may be filed from two engines.
/** @param {string} file @param {string} instance @param {RunAgent[]} list @param {(file: string) => unknown} recordName @param {Slice[]} earlier */
function checkRecord(file, instance, list, recordName, earlier) {
  const engine = list.find(a => a.engine)?.engine ?? ''
  const name = recordName(file)
  if (instance && name !== engine) throw new Error(`record ${file} is "${String(name)}", but its logger ran under "${instance}" — not matched, refusing the run`)
  if (earlier.some(o => o.record === file)) throw new Error(`record ${file} was filed from two engines of this run — refusing the run`)
}

/**
 * Every record of the run with its slice, in filing order. Refuses, naming the record, when a nested
 * engine's record is not that engine's (its `name`), or one record was filed from two engines.
 * @param {RunAgent[]} agents @param {(file: string) => unknown} recordName @param {string[]} warnings
 * @returns {Slice[]}
 */
export function sliceByEngine(agents, recordName, warnings) {
  /** @type {Slice[]} */
  const slices = []
  const { groups, absorbed } = byEngine(agents, warnings)
  for (const [instance, list] of groups) {
    const mine = sliceAgents(list, instance ? `"${instance}"` : 'the top-level engine')
    for (const s of mine) {
      checkRecord(s.record, instance, list, recordName, slices)
      const took = absorbedIn(s, absorbed)
      if (took) s.absorbed = took
    }
    slices.push(...mine)
  }
  return slices.sort((a, b) => a.end - b.end)
}

/**
 * Every record the run filed, each with its slice's cost. Measures and reads every record before any
 * write, so a refusal leaves all of them as they were.
 * @param {{ runId: string, claudeHome: string, warnings: string[],
 *   readRecord: (file: string) => Record<string, unknown>, writeRecord: (file: string, record: Record<string, unknown>) => void }} opts
 */
export function enrichRunCost({ runId, claudeHome, warnings, readRecord, writeRecord }) {
  const runDir = findRunDir(runId, claudeHome)
  const transcripts = runTranscripts(runDir)
  if (!transcripts.length) throw new Error(`no agent-*.jsonl transcripts under ${runDir}`)
  /** @type {Map<string, Record<string, unknown>>} */
  const records = new Map()
  const read = (/** @type {string} */ file) => records.get(file) ?? records.set(file, readRecord(file)).get(file) ?? {}
  const slices = sliceByEngine(transcripts.map(name => readAgent(runDir, name)), file => read(file)['name'], warnings)
  const costs = slices.map((s, i) => {
    const cost = measureCost(runDir, s.transcripts, warnings, runId)
    cost.slice = { index: i + 1, of: slices.length, ...(s.tail ? { tail: s.tail } : {}) }
    if (s.absorbed) cost.absorbed = s.absorbed
    return { file: s.record, cost, record: read(s.record) }
  })
  // Replaced, never appended: a re-run re-slices and re-sums.
  for (const { file, cost, record } of costs) writeRecord(file, { ...record, cost })
  return { runDir, costs }
}
