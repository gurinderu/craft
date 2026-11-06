import { runCliReview } from '../lib/cli-review-steps.mjs'

export const meta = {
  name: 'cli-review',
  description: 'Experimental: drives the craft Rust CLI\'s step-by-step review from Claude Code. The `craft` binary decides every step (one Rust correctness lens, then verification of each finding, then a Markdown report); this engine only runs the agents each step hands out and hands their answers back. It holds no review logic.',
  whenToUse: 'To try the CLI\'s step protocol on a Rust diff; for a real review use `review`. Args: repo=<absolute path> (the repository to review; default the session\'s checkout), base=<ref> (default the merge-base with origin\'s default branch), craftBin=<absolute path of the craft binary> (default <craftRoot>/cli/target/release/craft, craftRoot=<absolute path of a craft checkout> defaulting to the plugin root). The binary must be built first (`cargo build --release` in cli/). Returns the verdict and the report the binary wrote; the run\'s state stays in the run directory the report names.',
  phases: [
    { title: 'Start', detail: 'a service agent runs `craft review start` and returns the first tasks', model: 'haiku' },
    { title: 'Agents', detail: 'the step\'s tasks run in parallel on the model the binary named, each reading its prompt file and writing its answer file in the run directory' },
    { title: 'Submit', detail: 'a service agent runs `craft review submit`, which reads the answer files', model: 'haiku' },
    { title: 'Report', detail: 'a service agent reads the report the binary wrote', model: 'haiku' },
  ],
}

export async function __run() {
// The craft release this engine shipped in, held to the plugin manifest by lib/check-workflows.mjs.
const CRAFT_VERSION = '0.40.1' // x-release-please-version
return await runCliReview({ args, agent, parallel, phase, log }, CRAFT_VERSION)
}
