import { runCliReview } from '../lib/cli-review-steps.mjs'

export const meta = {
  name: 'cli-review',
  description: 'Experimental: the step protocol was observed end to end in a live session (craft 0.41.0, a Rust diff, finished with Approve); the full-lens review it now runs is not yet observed live. A driver for the craft Rust CLI\'s step-by-step review from Claude Code. By design the `craft` binary decides every step (a scout that plans the Rust profile\'s lenses, the lenses round after round until one finds nothing new, a dedup pass, verification by the engine\'s panels, then a Markdown report) and this engine only runs the agents each step hands out and hands their answers back, holding no review logic.',
  whenToUse: 'To try the CLI\'s step protocol on a Rust diff; for a real review use `review`. Args: repo=<absolute path> (the repository to review; default the session\'s checkout), base=<ref> (default the merge-base with origin\'s default branch), depth=light|full (default full: a light pass runs the diff-scoped lenses, one round, and verifies only Medium and above), craftBin=<absolute path of the craft binary> (a local build, `cargo build --release` in cli/; default the binary released with this plugin version, fetched once from its GitHub release into ~/.craft/bin/<version>/ by the plugin\'s lib/craft-bin.mjs, which is located through craftRoot=<absolute path of a craft plugin root: an installed copy, or a checkout\'s integrations/claude-code>, then the plugin root). Returns a `## Verdict` block with the verdict line the binary printed and the absolute path of the report it wrote (read that file); the run\'s state stays in the run directory, and its run record goes to the run store like review\'s.',
  phases: [
    { title: 'Start', detail: 'without craftBin, a service agent gets the released binary of this version (lib/craft-bin.mjs ensure); a service agent runs `craft review start` and returns the first tasks', model: 'haiku' },
    { title: 'Agents', detail: 'the step\'s tasks run in parallel on the model the binary named, each reading its prompt file and writing its answer file in the run directory' },
    { title: 'Submit', detail: 'a service agent runs `craft review submit`, which reads the answer files', model: 'haiku' },
    { title: 'Record', detail: 'the run record filed through lib/craft-log-run.mjs, folding the start checkpoint that names the head the binary read', model: 'haiku' },
  ],
}

export async function __run() {
// The craft release this engine shipped in, held to the plugin manifest by lib/check-workflows.mjs.
const CRAFT_VERSION = '0.43.0' // x-release-please-version
return await runCliReview({ args, agent, parallel, phase, log, budget }, CRAFT_VERSION)
}
