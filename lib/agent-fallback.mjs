// When a craft agent type (craft:rust-reviewer, craft:rust-security-scanner, …) is not registered in the
// session — typically the craft plugin is not enabled in that project — an engine runs the work on the
// generic subagent instead. That keeps the review or audit going, but without the agent's rubric, and an
// operator who sees only a failed probe or a log line reads a weaker run as a normal one. These helpers
// are the ONE way both engines (review, rust-audit) recognise that case and say it in the report
// (realm @nick/craft #113, #116). Pasted into the engines through `craft-inline` fences; pure.

// Only an error about the AGENT TYPE counts: a missing model, a file or tool not found inside the agent,
// or an HTTP 404 also say "not found", and an "install the plugin" line for those would send the
// operator to the wrong fix.
/** @param {unknown} msg @param {string} [agent] */
export function isAgentTypeMissing(msg, agent) {
  const m = String(msg ?? '')
  return /not found/i.test(m) && (/agent type/i.test(m) || (!!agent && m.includes(agent)))
}

// The report section. `missing`: [{ agent, what, error }] — an agent type the engine learned is not
// registered, and what ran without it ("every rust lens", "the audit dimensions that use it").
// `emptied`: [{ agent, count, what, error? }] — dispatches the generic subagent answered after the agent
// came back EMPTY (an unregistered agent on some runtimes, or a transient failure) or, with `error`,
// threw a "not found" isAgentTypeMissing does not recognise (the harness's wording for an unregistered
// type is unobserved, #116) — said softly, without the install line, the error quoted. Empty string
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
  const lines = [
    ...hard.map(x => `- \`${x.agent}\` is not registered in this session, so ${x.what} went to the generic subagent, without that agent's rubric — this run is weaker than a normal one, not broken.${x.error ? ` (${String(x.error).slice(0, 160)})` : ''}`),
    ...soft.map(x => x.error
      ? `- \`${x.agent}\` failed with "${String(x.error).slice(0, 160)}" on ${x.count} ${x.what}, which were re-run on the generic subagent, without its rubric (an unregistered agent in wording this engine does not recognise, or a missing model or tool).`
      : `- \`${x.agent}\` returned nothing for ${x.count} ${x.what}, which were re-run on the generic subagent, without its rubric (an unregistered agent on some runtimes, or a transient failure).`),
  ]
  const fix = hard.length ? 'Enable the plugin in this project (`/plugin install craft@craft`, project or local scope) and re-run to use it.\n' : ''
  return `## ⚠️ Reviewer agent unavailable\n${lines.join('\n')}\n${fix}\n`
}
