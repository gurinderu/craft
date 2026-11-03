// What the external sources' prep gives the run's text (realm @nick/craft, node #430): the block the lenses that
// read them get, the verifiers' block, and the report section — what was prepared, what was not, and the systems a
// finding leaned on that memory does not record (the engine itself never writes memory, #206).
import { str } from './external-source-prep.mjs'

/**
 * @typedef {import('./external-source-spec.mjs').ExternalRecord} ExternalRecord
 * @typedef {import('./external-source-prep.mjs').Prepared} Prepared
 * @typedef {import('./external-source-prep.mjs').PrepState} PrepState
 */

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
 * The report section: what was prepared, what was not (a warning: reviewed without that context), and the
 * systems findings leaned on that memory has no record of; '' when none of it applies.
 * @param {PrepState} state @param {ExternalRecord[]} records @param {Array<Record<string, unknown>>} findings
 */
export function externalSourcesSection(state, records, findings) {
  const known = new Set(records.map(r => r.system.toLowerCase()))
  const named = [...new Set(findings.map(f => str(f['externalSystem'])).filter(Boolean))]
  const unrecorded = named.filter(s => !known.has(s.toLowerCase()))
  const lines = [
    ...state.prepared.map(p => `- ${p.system} @ ${p.ref}: \`${p.dir}\``),
    ...(state.unreachable ? [`- ⚠️ the source cache was unreachable (${state.unreachable}) — ${records.map(r => r.system).join(', ')} reviewed without external context`] : []),
    ...(state.skipped ? [`- ⚠️ ${records.map(r => r.system).join(', ')} reviewed without external context — ${state.skipped}`] : []),
    ...state.failed.map(f => `- ⚠️ ${f.system}: ${f.error} — reviewed without external context`),
    ...unrecorded.map(s => `- not recorded: ${s} — record it with craft:memory record-external`),
  ]
  return lines.length ? `\n\n## External sources\n${lines.join('\n')}\n` : ''
}
