// When a craft agent type (craft:rust-reviewer, craft:rust-security-scanner, …) is not registered in the
// session — typically the craft plugin is not enabled in that project — an engine runs the work on the
// generic subagent instead. That keeps the review or audit going, but without the agent's rubric, and an
// operator who sees only a failed probe or a log line reads a weaker run as a normal one. These helpers
// are the ONE way both engines (review, rust-audit) recognise that case and say it in the report
// (realm @nick/craft #113, #116). Pasted into the engines through `craft-inline` fences; pure.

// Only an error about the AGENT TYPE counts: a missing model, a file or tool not found inside the agent,
// or an HTTP 404 also say "not found", and an "install the plugin" line for those would send the
// operator to the wrong fix. Observed from the session's Agent tool for an unregistered type:
// "Agent type 'craft:rust-reviewer' not found. Available agents: …" (realm @nick/craft #152); what the
// workflow sandbox's agent() throws for it is not yet observed, so a "not found" this does not match
// still falls back softly in both engines rather than killing the work.
/** @param {unknown} msg @param {string} [agent] */
export function isAgentTypeMissing(msg, agent) {
  const m = String(msg ?? '')
  return /not found/i.test(m) && (/agent type/i.test(m) || (!!agent && m.includes(agent)))
}

// The report section. `missing`: [{ agent, what, error }] — an agent type the engine learned is not
// registered, and what ran without it ("every rust lens", "the audit dimensions that use it").
// `emptied`: [{ agent, count, what, error? }] — dispatches the generic subagent answered after the agent
// came back EMPTY (an unregistered agent on some runtimes, or a transient failure) or, with `error`,
// threw a "not found" isAgentTypeMissing does not recognise (the sandbox's wording for an unregistered
// type is not yet observed, #152) — said softly, without the install line, the error quoted. Empty string
// when there is nothing to say.
/**
 * @param {{ agent: string, what: string, error?: string }[]} missing
 * @param {{ agent: string, count: number, what: string, error?: string }[]} emptied
 * @returns {string}
 */
export function agentUnavailableSection(missing, emptied) {
  const hard = Array.isArray(missing) ? missing : []
  const soft = (Array.isArray(emptied) ? emptied : []).filter(x => x && x.count > 0)
  if (!hard.length && !soft.length) return ''
  // One bullet is one line: the harness's error carries newlines ("…not found.\nAvailable agents: …"), and
  // readAgentUnavailableSection stops at the first line that is not a bullet, dropping every later entry.
  /** @param {unknown} e */
  const quote = e => String(e).replace(/\s+/g, ' ').trim().slice(0, 160)
  const lines = [
    ...hard.map(x => `- \`${x.agent}\` is not registered in this session, so ${x.what} went to the generic subagent, without that agent's rubric — this run is weaker than a normal one, not broken.${x.error ? ` (${quote(x.error)})` : ''}`),
    ...soft.map(x => x.error
      ? `- \`${x.agent}\` failed with "${quote(x.error)}" on ${x.count} ${x.what}, which were re-run on the generic subagent, without its rubric (an unregistered agent in wording this engine does not recognise, or a missing model or tool).`
      : `- \`${x.agent}\` returned nothing for ${x.count} ${x.what}, which were re-run on the generic subagent, without its rubric (an unregistered agent on some runtimes, or a transient failure).`),
  ]
  const fix = hard.length ? 'Enable the plugin in this project (`/plugin install craft@craft`, project or local scope) and re-run to use it.\n' : ''
  return `## ⚠️ Reviewer agent unavailable\n${lines.join('\n')}\n${fix}\n`
}

// The fact's ONE shape on a run record, whichever engine files it (realm @nick/craft #151):
// `agentUnavailable` — the agent types the engine learned are not registered, each once, sorted;
// `agentFallbacks` — per agent type, the dispatches the generic subagent answered in its place.
// Keyed by agent type in both engines: a profile id names the review engine's own grouping, which
// an audit dimension does not have.
/**
 * @param {Iterable<string>} missing
 * @param {{ agent: string, count: number }[]} fallbacks
 * @returns {{ agentUnavailable: string[], agentFallbacks: Record<string, number> }}
 */
export function agentUnavailableRecord(missing, fallbacks) {
  /** @type {Record<string, number>} */
  const agentFallbacks = {}
  for (const x of fallbacks) if (x.count > 0) agentFallbacks[x.agent] = (agentFallbacks[x.agent] || 0) + x.count
  return { agentUnavailable: [...new Set(missing)].sort(), agentFallbacks }
}

// The section above, read back out of a report. An engine that nests a review receives only the
// nested report, so this is how it learns what the nested run fell back on (realm @nick/craft #153).
// It is the inverse of agentUnavailableSection and lives beside it, so the wording and its reader
// change in one place. A bullet it cannot read fails toward "unavailable": it is returned as missing,
// the bullet itself as the error, rather than dropped.
/**
 * @param {unknown} report
 * @returns {{ missing: { agent: string, error: string }[], emptied: { agent: string, count: number, error?: string }[] }}
 */
export function readAgentUnavailableSection(report) {
  /** @type {{ agent: string, error: string }[]} */
  const missing = []
  /** @type {{ agent: string, count: number, error?: string }[]} */
  const emptied = []
  const text = String(report ?? '')
  const head = text.indexOf('## ⚠️ Reviewer agent unavailable\n')
  if (head < 0) return { missing, emptied }
  for (const line of text.slice(head).split('\n').slice(1)) {
    if (!line.startsWith('- ')) break
    const got = readAgentUnavailableLine(line)
    if ('count' in got) emptied.push(got)
    else missing.push(got)
  }
  return { missing, emptied }
}

// One bullet of the section: a soft fallback carries `count`, an unregistered agent does not. A bullet
// in wording this does not know is an unregistered agent, the bullet itself (bounded) as the error.
/** @param {string} line @returns {{ agent: string, error: string } | { agent: string, count: number, error?: string }} */
export function readAgentUnavailableLine(line) {
  const hard = /^- `([^`]+)` is not registered in this session, .*? not broken\.(?: \((.*)\))?$/.exec(line)
  if (hard) return { agent: String(hard[1]), error: hard[2] || '' }
  const threw = /^- `([^`]+)` failed with "(.*)" on (\d+) /.exec(line)
  if (threw) return { agent: String(threw[1]), count: Number(threw[3]), error: threw[2] || '' }
  const empty = /^- `([^`]+)` returned nothing for (\d+) /.exec(line)
  if (empty) return { agent: String(empty[1]), count: Number(empty[2]) }
  return { agent: /`([^`]+)`/.exec(line)?.[1] || 'a craft agent', error: line.slice(2, 162) }
}

// The fact read off a stored record of either engine and any age: the shape agentUnavailableRecord
// writes (rust-audit wrote it from the start), or the review engine's earlier fields, keyed by profile
// id — `reviewerAgentUnavailable[]` and `reviewerAgentFallbacks{}` — whose agent was `craft:<id>-reviewer`.
/** @param {unknown} rec @returns {{ agentUnavailable: string[], agentFallbacks: Record<string, number> }} */
export function readAgentUnavailable(rec) {
  const r = /** @type {Record<string, unknown>} */ (rec && typeof rec === 'object' ? rec : {})
  /** @param {unknown} v @returns {string[]} */
  const list = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])
  /** @param {unknown} v @param {(k: string) => string} name */
  const counts = (v, name) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v) : [])
    .filter(([, n]) => typeof n === 'number').map(([k, n]) => ({ agent: name(k), count: Number(n) }))
  /** @param {string} id */
  const legacy = id => `craft:${id}-reviewer`
  if ('agentUnavailable' in r || 'agentFallbacks' in r) return agentUnavailableRecord(list(r['agentUnavailable']), counts(r['agentFallbacks'], k => k))
  return agentUnavailableRecord(list(r['reviewerAgentUnavailable']).map(legacy), counts(r['reviewerAgentFallbacks'], legacy))
}
