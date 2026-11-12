import { makeTypeFallback } from './agent-type-fallback.mjs'

// The agent type an engine's service steps run as (realm @nick/craft, node #397): craft's own minimal
// `engine-service` agent (agents/engine-service.md: tools Bash, Read and Write, `omitClaudeMd: true`, no model —
// each call passes its own). Observed (Claude Code 2.1.319, the plugin loaded by --plugin-dir): a plugin agent with
// `omitClaudeMd` starts without the project's CLAUDE.md and AGENTS.md, its first request about 3k tokens of
// context against 50–64k for an engine agent on the default type; the field needs Claude Code 2.1.271 or later.
// It has no write limit, so a step whose prompt is self-sufficient and names its own commands takes it, writers
// (a checkpoint, the run record) included; one that needs another tool, the consumer's project instructions or
// judgement keeps its type. Not observed: a launch of a plugin agent with this field from the Workflow sandbox —
// hence makeDefaultTypeFallback below.
export const SERVICE_AGENT_TYPE = 'craft:engine-service'

/** @typedef {{ agentType?: string | undefined, schema?: object | undefined, label?: string | undefined }} ServiceOpts */

/**
 * A dispatch that re-runs a SERVICE_AGENT_TYPE call once on the default agent type, and retires the type when it
 * cannot launch: the soft path every non-default type takes (lib/agent-type-fallback.mjs, realm @nick/craft #113,
 * #116, #152), each call named a service step in the log.
 * @template {ServiceOpts} O
 * @template R
 * @param {(prompt: string, opts: O) => Promise<R>} dispatch
 * @param {(message: string) => void} logLine
 * @param {() => boolean} [stopped]
 * @param {(got: unknown) => boolean} [isDeadline]
 */
export function makeDefaultTypeFallback(dispatch, logLine, stopped = () => false, isDeadline = () => false) {
  return makeTypeFallback({ agentType: SERVICE_AGENT_TYPE, what: 'service step' }, dispatch, logLine, stopped, isDeadline)
}
