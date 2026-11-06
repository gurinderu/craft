import { runCliReview } from '../lib/cli-review-steps.mjs'

export const meta = {
  name: 'cli-review',
  description: 'Experimental, not yet observed in a live session: a driver for the craft Rust CLI\'s step-by-step review from Claude Code. By design the `craft` binary decides every step (one Rust correctness lens, then verification of each finding, then a Markdown report) and this engine only runs the agents each step hands out and hands their answers back, holding no review logic.',
  whenToUse: 'To try the CLI\'s step protocol on a Rust diff; for a real review use `review`. Args: repo=<absolute path> (the repository to review; default the session\'s checkout), base=<ref> (default the merge-base with origin\'s default branch), craftBin=<absolute path of the craft binary> (a local build, `cargo build --release` in cli/; default the binary released with this plugin version, fetched once from its GitHub release into ~/.craft/bin/<version>/ by the plugin\'s lib/craft-bin.mjs, which is located through craftRoot=<absolute path of a craft checkout>, then the plugin root). Returns the verdict the binary printed and the absolute path of the report it wrote (read that file); the run\'s state stays in the run directory.',
  phases: [
    { title: 'Start', detail: 'without craftBin, a service agent gets the released binary of this version (lib/craft-bin.mjs ensure); a service agent runs `craft review start` and returns the first tasks', model: 'haiku' },
    { title: 'Agents', detail: 'the step\'s tasks run in parallel on the model the binary named, each reading its prompt file and writing its answer file in the run directory' },
    { title: 'Submit', detail: 'a service agent runs `craft review submit`, which reads the answer files', model: 'haiku' },
  ],
}

export async function __run() {
// The craft release this engine shipped in, held to the plugin manifest by lib/check-workflows.mjs.
const CRAFT_VERSION = '0.41.0' // x-release-please-version
return await runCliReview({ args, agent, parallel, phase, log }, CRAFT_VERSION)
}
