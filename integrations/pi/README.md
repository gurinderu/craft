# craft for pi

craft's review from pi: the craft CLI drives it itself (`craft review run --backend pi`), each task its own `pi -p`
process, as `integrations/claude-code/workflows/review.js` (the `craft:review` workflow) drives the same steps from
Claude Code. The package runs the binary through `bin/craft`, which downloads the binary of the package's version
from its GitHub release into `~/.craft/bin/<version>/` the first time (`CRAFT_BIN=<path>` runs a local build).
The route is new: it has been seen running end to end from a checkout, not yet as an installed pi package.

## Install

The repository is a pi package. Its manifest — the `pi` key of the root `package.json` — loads two resources, the
extension `lib/pi-extension.mjs` and the `craft-review` skill in `skills/craft-review/` here, and nothing else (none
of craft's other skills):

<!-- x-release-please-start-version -->
```sh
pi install git:github.com/gurinderu/craft@v0.52.0
```
<!-- x-release-please-end -->

The extension registers the `craft_review` tool: it runs `bin/craft review run --backend pi --events json` with the
flags it is given, shows the run's progress while it runs and, when it ends, the verdict, the findings and the
report's path. In print or JSON mode it answers in plain text. Ask pi for a review, or run
`/skill:craft-review [flags ...]`: the skill has the session call the tool once and relay its `## Verdict` block, or,
without the extension, run `sh <package root>/bin/craft review run --backend pi` itself.

## How a task runs

Each task the binary hands out is its own `pi -p --no-session --no-context-files --no-skills --no-prompt-templates
--no-approve --no-extensions --no-mcp --tools read,bash,grep,find,ls [--model <m>] -- <message>` in the reviewed
repository, up to `--concurrency` at once (default 4). `--no-approve` keeps the reviewed branch's own pi resources
(`.pi/`, project `.agents/skills`) from loading; `--no-extensions` and `--no-mcp` keep your extensions and MCP servers
from starting in every task process. pi's hosted providers and their logins are not extensions, so they still work; a
provider that only an extension adds (a custom provider, the built-in llama.cpp one) is not available to the tasks.

The message is the craft agent's prompt body the task names (from `integrations/claude-code/agents/`, or a consumer's
`.claude/agents/`), then the instruction to read the task's prompt file and print the answer as one JSON object at the
end, in a fence of its own (```` ```craft-answer ````), and where a skill the prompt names is (`skills/<name>/SKILL.md` in the package; pi loads none of craft's), with
`${CLAUDE_PLUGIN_ROOT}` spelled out as the package root. The binary takes the answer from what pi printed — the last
`craft-answer` block, else the last `json` block, else the last top-level object that parses, each fence at the start
of a line — and writes it to the task's answer file; pi has no
schema output, and the binary validates each answer and hands an invalid one back for a retry.

A task gets no tool that writes or edits a file. **pi has no sandbox**: `bash` stays, because the review agents need
git, and it is not contained — a task's shell runs with your permissions in the reviewed checkout. Review a branch you
do not trust with `--no-gate` and inside a container or VM.

Login and the default model are pi's own: no key is passed, and `--model` is given only for a tier `--models` (or
`CRAFT_PI_MODELS`) maps. Each task gets `--thinking` by the tier it asks for — opus `high`, sonnet `medium`, haiku
`low` — unless `--thinking <level>` or `--thinking opus=<level>,sonnet=<level>,haiku=<level>` (or `CRAFT_PI_THINKING`)
names others, or the tier's `--models` model already ends in its own `:<level>`; so a thinking level set in pi's own
settings is overridden on every task unless `--thinking` or `CRAFT_PI_THINKING` is given. A task past its deadline is
abandoned; one that failed or printed no answer is left for the binary to ask again; the usage limit, or pi not logged
in, starts no further task and stops the run where it can be resumed.
