// What the external sources' prep gives the run's text (realm @nick/craft, node #430): the block the lenses that
// read them get, the verifiers' block, and the report section — what was prepared, what was not, the systems a
// finding leaned on that memory does not record, and the candidates the touched deployment manifests name (node
// #434, ready for the human to confirm, #436; the engine itself never writes memory, #206).
import { str } from './external-source-prep.mjs'
import { CANDIDATES_SHOWN, candidateLine } from './external-candidate.mjs'
import { MANIFESTS_MAX } from './manifest-paths.mjs'

/**
 * @typedef {import('./external-source-spec.mjs').ExternalRecord} ExternalRecord
 * @typedef {import('./external-source-prep.mjs').Prepared} Prepared
 * @typedef {import('./external-source-prep.mjs').PrepState} PrepState
 * @typedef {import('./external-source-prep.mjs').DiscoveryState & { manifests: string[], dropped: number }} Discovery
 */

// The lines a launcher keeps from a nested run's section once it adopted that run's prep: what is the nested run's
// own — the systems its findings named that memory lacks, and its discovery (the launcher left those files to it).
export const NESTED_OWN_LINE = /^- (?:not recorded: |candidate: |… \d+ more candidate|⚠️ deployment manifest)/

/** The lenses' block; '' when nothing was prepared. @param {Prepared[]} prepared */
export function lensSourcesBlock(prepared) {
  if (!prepared.length) return ''
  return `EXTERNAL SOURCES (read-only — the source of a system this code relies on, at the version the consumer deploys; read it with your own Read, Grep and Glob tools inside that directory, never modify it):
${prepared.map(p => `- ${p.system} @ ${p.ref}: ${p.dir}`).join('\n')}
A claim about how one of these systems behaves must cite \`<dir>/<path>:<line>\` under its directory above in \`whereChecked\`, and the finding names the system in \`externalSystem\`. For a system not listed here, a claim about how it behaves stands only on that system's source at the deployed version, opened by you; otherwise it is an open question, not a finding.`
}

/** The verifiers' block; '' when nothing was prepared. @param {Prepared[]} prepared */
export function verifySourcesBlock(prepared) {
  if (!prepared.length) return ''
  return `EXTERNAL SOURCES (read-only, the deployed version of each system): ${prepared.map(p => `${p.system} @ ${p.ref} at ${p.dir}`).join('; ')}. A \`whereChecked\` under one of these directories is that system's own source: open it there to judge the premise.\n`
}

/**
 * The report section: what was prepared, what was not (a warning: reviewed without that context), the systems
 * findings leaned on that memory has no record of, and the discovery's candidates (or why it read no manifest);
 * '' when none of it applies.
 * @param {PrepState} state @param {ExternalRecord[]} records @param {Array<Record<string, unknown>>} findings @param {Discovery} [found]
 */
export function externalSourcesSection(state, records, findings, found) {
  const known = new Set(records.map(r => r.system.toLowerCase()))
  const named = [...new Set(findings.map(f => str(f['externalSystem'])).filter(Boolean))]
  const unrecorded = named.filter(s => !known.has(s.toLowerCase()))
  const lines = [
    ...state.prepared.map(p => `- ${p.system} @ ${p.ref}${stated(records, p.system) ? ' (recorded version, not read from a file)' : ''}: \`${p.dir}\``),
    ...(state.unreachable ? [`- ⚠️ the source cache was unreachable (${state.unreachable}) — ${records.map(r => r.system).join(', ')} reviewed without external context`] : []),
    ...(state.skipped ? [`- ⚠️ ${records.map(r => r.system).join(', ')} reviewed without external context — ${state.skipped}`] : []),
    ...state.failed.map(f => `- ⚠️ ${f.system}: ${f.error} — reviewed without external context`),
    ...unrecorded.map(s => `- not recorded: ${s} — record it with craft:memory record-external`),
    ...(found ? discoveryLines(found) : []),
  ]
  return lines.length ? `\n\n## External sources\n${lines.join('\n')}\n` : ''
}

/** Whether the system's record carries a version the human stated, which goes stale silently (realm @nick/craft, node #440). @param {ExternalRecord[]} records @param {string} system */
const stated = (records, system) => !!records.find(r => r.system === system)?.version

/** The discovery's lines: each candidate, those past the bound counted, and why manifests went unread. @param {Discovery} found */
function discoveryLines(found) {
  const files = found.manifests.join(', ')
  const why = found.skipped || (found.ran ? found.error : '')
  return [
    ...found.candidates.slice(0, CANDIDATES_SHOWN).map(candidateLine),
    ...(found.candidates.length > CANDIDATES_SHOWN ? [`- … ${found.candidates.length - CANDIDATES_SHOWN} more candidate(s) — list them with craft:memory discover-externals`] : []),
    ...(why ? [`- ⚠️ deployment manifest(s) ${files} not read for external systems — ${why}`] : []),
    ...(found.ran && found.dropped ? [`- ⚠️ deployment manifest(s): ${found.dropped} more touched past the bound of ${MANIFESTS_MAX}, not read — run craft:memory discover-externals`] : []),
  ]
}
