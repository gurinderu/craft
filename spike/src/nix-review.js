export const meta = {
  name: 'nix-review',
  description: 'Nix-pinned entry to the generic review engine — reviews only the Nix files in a diff. Prefer `review` (auto-detects language); use this to force a Nix-only pass.',
  whenToUse: 'Explicit Nix-only diff review; the generic default is `review`. Same args as `review`: repo=<absolute path> to review ANOTHER repository (without it every git command runs in the checkout the session itself sits in), base, intent, comment, strict, path=<repo-relative pathspec> to narrow the scope INSIDE that repo, and priorDecisions (object argument only). priorDecisions is optional: without it the engine itself recalls the active decisions for the paths of the diff through the craft:memory skill, and the report names the source (an empty list skips the recall). To post findings on a PR pass comment — never post findings by hand: only comments from the engine carry the marker that ties a later rejection to its finding.',
  phases: [{ title: 'Review', detail: 'delegates to the review engine pinned to the nix profile' }],
}

// ---- args ----
// The thin pin normalizes too, and it MUST: it hands the child a real object, so a string arg
// dropped here reaches `review` as a valid-looking shape that its own normalizer cannot warn about.
// A caller typing `base=v0.17.0` would get a confident verdict over the working tree with no line
// anywhere saying the base was gone — the exact failure this shared parser exists to end, surviving
// in the two engines the record-filing roster does not name.
import { normalizeArgs } from '../../lib/workflow-args.mjs'

// The delegation resolves the child under whichever name this registry carries — the fence's own
// comment states the rule and the fallback's single trigger.
// >>> craft-inline lib/nested-workflow.mjs nestedWorkflow
/**
 * @param {(name: string, args: unknown) => Promise<unknown>} workflow
 * @param {string} name
 * @param {unknown} args
 * @param {(msg: string) => void} [warn]
 * @returns {Promise<unknown>} the nested run's result — `null` when it died
 */
async function nestedWorkflow(workflow, name, args, warn = () => {}) {
  /** @param {unknown} e @returns {unknown} the refusal's message, or the thrown value itself */
  const messageOf = e => (e && /** @type {{ message?: unknown }} */ (e).message) || e
  /** @param {unknown} e */
  const unresolved = e => /no workflow with that name/i.test(String(messageOf(e)))
  try {
    return await workflow(`craft:${name}`, args)
  } catch (e) {
    if (!unresolved(e)) throw e
    warn(`nested workflow 'craft:${name}' did not resolve here — retrying as '${name}'`)
    try {
      return await workflow(name, args)
    } catch (e2) {
      if (unresolved(e2)) {
        throw new Error(`nested workflow '${name}': neither 'craft:${name}' nor '${name}' resolved — the nested run did NOT happen (last refusal: ${String(messageOf(e2))})`)
      }
      throw e2
    }
  }
}
// <<< craft-inline

// Thin pin over the generic engine (review.js holds the engine + PROFILES registry). Invoked only as
// a root (humans/agents), so it never nests (workflow() nesting is one level only).
return await nestedWorkflow(workflow, 'review', { ...normalizeArgs(args, log), languages: ['nix'] }, log)
