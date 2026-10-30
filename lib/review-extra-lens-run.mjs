// A consumer repository's own reviewing agents run as extra lenses (src/review.js, Lenses phase; realm
// @nick/craft, node #295): named by the caller or discovered, dispatched once beside round 1 of the first profile.
import { discoveryApplies, DISCOVERY_SKIPPED, pickRepoReviewers } from './review-extra-lenses.mjs'
import { priorFoundSummary } from './review-coverage.mjs'
import { isAgentTypeMissing } from './agent-fallback.mjs'
import { shq } from './run-logging.mjs'
import { FINDINGS_SCHEMA, AGENT_DEFINITIONS_SCHEMA } from './review-schemas.mjs'

/**
 * @typedef {import('./review-schemas.mjs').Finding} Finding
 * @typedef {import('./review-profiles.mjs').Profile} Profile
 * @typedef {import('./review-schemas.mjs').FindingsAnswer} FindingsAnswer
 * @typedef {import('./review-schemas.mjs').AgentDefinitionsAnswer} AgentDefinitionsAnswer
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 */

/**
 * The extra lenses of one run.
 * @param {ReviewRun} reviewRun @param {{ active: Profile[], extraLensPrompt: (agentType: string, priorSummary: string, repoRules?: string[]) => string }} lenses  the active profiles and the extra lens's prompt
 */
export function makeExtraLenses(reviewRun, { active, extraLensPrompt }) {
const { key, repoArg, extraLensRequest, extraLensOutcome, ragent } = reviewRun
const { log: logLine, parallel: runParallel } = reviewRun.sb
// Dispatches every requested extra lens once, in parallel, on its own agent type: no generic fallback,
// since a generic subagent is not the consumer's reviewer. A throw, a null and an off-schema answer are
// each recorded by class (the error text goes to the log only) and the lens contributes nothing.
/** @param {string[]} agents @param {string} priorSummary @param {string[]} repoRules @returns {Promise<Finding[]>} */
async function runExtraLenses(agents, priorSummary, repoRules) {
  const settled = await runParallel(agents.map(agentType => () => dispatchExtraLens(agentType, priorSummary, repoRules)))
  return settled.flatMap(r => r || [])
}

/** The extra lenses' findings: dispatched for the first profile only. @param {Profile} profile @param {Finding[]} pool @param {string[]} [repoRules]  the repository's rule files the scout found @returns {Promise<Finding[]>} */
function extraLensesFor(profile, pool, repoRules = []) {
  reviewRun.lensPhaseReached = true
  if (profile !== active[0]) return Promise.resolve([])
  extraLensOutcome.reached = true
  if (extraLensRequest.how === 'off') return Promise.resolve([])
  const summary = priorFoundSummary(pool)
  return chosenExtraLenses().then(agents => (agents.length ? runExtraLenses(agents, summary, repoRules) : []))
}

// Named by the caller, or discovered: ONE cheap agent lists the session project's agent definitions
// and pickRepoReviewers keeps those that review and do not edit (realm @nick/craft, node #295); on a
// `repo` that is not the session's project (discoveryApplies) none is run.
/** @returns {Promise<string[]>} */
async function chosenExtraLenses() {
  if (extraLensRequest.how === 'named') return extraLensRequest.agents
  const listed = await listRepoAgents()
  if (!listed) {
    extraLensOutcome.discovery = 'the agent listing the session project\'s agent definitions did not answer'
    return []
  }
  if (!discoveryApplies(Boolean(repoArg), listed.sessionCommonDir, listed.repoCommonDir)) {
    extraLensOutcome.discovery = DISCOVERY_SKIPPED
    logLine(`extra lenses: ${DISCOVERY_SKIPPED} (session ${JSON.stringify(listed.sessionCommonDir)}, repo ${JSON.stringify(listed.repoCommonDir)})`)
    return []
  }
  const defs = Array.isArray(listed.agents) ? listed.agents : []
  const agents = pickRepoReviewers(defs)
  extraLensOutcome.discovery = defs.length ? `${defs.length} agent definition(s) read, none describes itself as reviewing without editing` : 'the session\'s project declares no agent under .claude/agents'
  logLine(`extra lenses discovered: ${agents.length ? agents.join(', ') : 'none'} (of ${defs.length} agent definition(s) in the session's project)`)
  return agents
}

// The session project's own agent definitions, or null when the listing agent died, threw or hit the
// budget: discovery is best-effort and never fails the run. Read where the session started, NOT in
// `repo`: a bare agent type is assumed, not observed, to resolve among the session's agents (realm
// @nick/craft, node #178), so the names and their tool checks come from there too (node #295).
/** @returns {Promise<AgentDefinitionsAnswer | null>} */
async function listRepoAgents() {
  try {
    return await ragent(`List the agent definitions the project this session runs in declares: the \`.claude/agents/*.md\` files directly in \`.claude/agents\` at the root of the session's project -- the git toplevel of the directory you START in (\`git rev-parse --show-toplevel\`; that directory itself when it is not a git repository). Not recursive: never a file inside \`.claude/worktrees/\`, a vendored or dependency tree, a plugin, or anywhere else. Do not cd into any other repository. For each, read its YAML frontmatter and return its \`name\` (the file name without .md when there is none), its \`description\` verbatim, and its \`tools\` and \`disallowedTools\` values verbatim ("" for each one absent). No such directory or no files -> agents: [].
Also report sessionCommonDir: the absolute, symlink-resolved git common dir of the directory you start in (\`(cd "$(git rev-parse --git-common-dir)" && pwd -P)\`), "" when it is not a git repository; and repoCommonDir: ${repoArg ? `the same for ${shq(repoArg)} (\`(cd ${shq(repoArg)} && cd "$(git rev-parse --git-common-dir)" && pwd -P)\`), "" when that fails` : '""'}. Use shell + read only; change nothing.`,
    { label: 'extra-lens-discovery', phase: 'Lenses', schema: AGENT_DEFINITIONS_SCHEMA, model: 'haiku', effort: 'low', inSessionDir: true })
  } catch (e) {
    logLine(`\u26a0\ufe0f extra-lens discovery threw: ${String((e && /** @type {{ message?: unknown }} */ (e).message) || e).slice(0, 160)}`)
    return null
  }
}
/** Adds the findings whose key is not yet seen. @param {Finding[]} found @param {Set<string>} seen @param {Finding[]} pool */
function pushUnseen(found, seen, pool) {
  for (const f of found) { const k = key(f); if (!seen.has(k)) { seen.add(k); pool.push(f) } }
}

// A consumer repository's own agent type, launched by the name its repository gives it: the one launch not
// under craft's prefix, marked for lib/launch-names.mjs (realm @nick/craft, node #295). The mark is read in the
// shipped bundle, and esbuild's syntax minifier inlines a call to a function that only returns its argument, so
// the body is not the bare `return name`: String() of the name the caller already holds as a string.
/** @param {string} name */
function consumerAgentType(name) {
  return String(name)
}

/** @param {string} agentType @param {string} priorSummary @param {string[]} repoRules @returns {Promise<Finding[]>} */
async function dispatchExtraLens(agentType, priorSummary, repoRules) {
  /** @type {FindingsAnswer | null} */
  let res = null
  try {
    res = await ragent(extraLensPrompt(agentType, priorSummary, repoRules), { label: `extra-lens:${agentType}`, phase: 'Lenses', schema: FINDINGS_SCHEMA, agentType: consumerAgentType(agentType) })
  } catch (e) {
    const msg = String((e && /** @type {{ message?: unknown }} */ (e).message) || e)
    logLine(`\u26a0\ufe0f extra lens ${agentType} threw: ${msg.slice(0, 160)}`)
    extraLensOutcome.failed.push({ agent: agentType, why: isAgentTypeMissing(msg, agentType) ? 'the agent type is not registered in this session' : 'the agent failed before answering' })
    return []
  }
  if (res == null || !Array.isArray(/** @type {{ findings?: unknown }} */ (res).findings)) {
    extraLensOutcome.failed.push({ agent: agentType, why: res == null ? 'returned nothing (an unknown agent type on some runtimes, or a dead agent)' : 'answered off-schema (no findings array)' })
    logLine(`\u26a0\ufe0f extra lens ${agentType} returned no findings array${extraLensRequest.how === 'named' ? ' -- recorded as a coverage gap' : ' -- reported, not a gap (discovered)'}`)
    return []
  }
  extraLensOutcome.ran.push(agentType)
  return res.findings.map(f => ({ ...f, source: `extra:${agentType}`, foundInRound: 1 }))
}
return { extraLensesFor, pushUnseen }
}
