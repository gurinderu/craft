import { normalizeArgs } from '../lib/workflow-args.mjs'
import { nestedWorkflow } from '../lib/nested-workflow.mjs'

export const meta = {
  name: 'rust-review',
  description: 'Rust-pinned entry to the generic review engine — reviews only the Rust files in a diff. Prefer `review` (auto-detects language); use this to force a Rust-only pass.',
  whenToUse: 'Explicit Rust-only diff review; the generic default is `review`. Same args as `review`: repo=<absolute path> to review ANOTHER repository (without it every git command runs in the checkout the session itself sits in), base, intent, comment, strict, path=<repo-relative pathspec> to narrow the scope INSIDE that repo, and priorDecisions (object argument only). The engine itself always recalls the active decisions and questions for the paths of the diff through the craft:memory skill; priorDecisions is optional and ADDS to that recall, never replaces it (merged by id, the recalled record kept on a clash; an empty list adds nothing; a passed record may leave out id when it carries kind, title and scope, the id then derived from them by the memory skill rule), and the report names both parts. To post findings on a PR pass comment — never post findings by hand: only comments from the engine carry the marker that ties a later rejection to its finding.',
  phases: [{ title: 'Review', detail: 'delegates to the review engine pinned to the rust profile' }],
}

// The thin pin normalizes too, and it MUST: it hands the child a real object, so a string arg
// dropped here reaches `review` as a valid-looking shape that its own normalizer cannot warn about.
// A caller typing `base=v0.17.0` would get a confident verdict over the working tree with no line
// anywhere saying the base was gone — the exact failure this shared parser exists to end, surviving
// in the two engines the record-filing roster does not name. The delegation resolves the child under
// whichever name this registry carries (lib/nested-workflow.mjs states the rule and the fallback's trigger).
export async function __run() {
// Thin pin over the generic engine. review.js holds the engine + PROFILES registry; this just
// restricts it to the rust profile. Invoked only as a root (humans/agents) — rust-audit calls
// the review engine directly, so this never nests (workflow() nesting is one level only).
return await nestedWorkflow(workflow, 'review', { ...normalizeArgs(args, log), languages: ['rust'] }, log)
}
