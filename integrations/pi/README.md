# craft for pi

A pi driver for the craft CLI's step-by-step review (`craft review start`, then `craft review submit`
after each step's agents ran), as `integrations/claude-code/workflows/review.js` (the `craft:review` workflow) drives it from Claude Code.
The binary decides every step; the driver only runs the agents a step hands out and hands their answers back.

## Install

The repository is a pi package. Its manifest — the `pi` key of the root `package.json` — loads one resource, the
`craft-review` skill in `skills/craft-review/` here, and nothing else (no extension, none of craft's other skills):

```sh
pi install git:github.com/gurinderu/craft@v<release>
```

Ask pi for a review, or run `/skill:craft-review [key=value ...]`. The skill has the session run
`node <package root>/lib/pi-review.mjs` once and relay its `## Verdict` block.

## How a task runs

Each task the binary hands out is its own `pi -p --no-session --no-context-files --no-skills --no-prompt-templates
--tools read,bash,write,grep,find,ls [--model <m>] -- <message>` in the reviewed repository, up to `concurrency=` at
once (default 4). The message is the craft agent's prompt body the task names (from
`integrations/claude-code/agents/`, or a consumer's `.claude/agents/`), then the instruction to read the task's prompt
file and write its answer file with pi's write tool, and where a skill the prompt names is (`skills/<name>/SKILL.md` in the
package; pi loads none of craft's), with `${CLAUDE_PLUGIN_ROOT}` spelled out as the package root. pi has no schema output; the binary validates each answer and
hands an invalid one back for a retry. Login and the default model are pi's own: no key is passed, and `--model` is
given only for a tier `piModels=` (or `CRAFT_PI_MODELS`) maps. A task past its deadline is abandoned; one that failed or
wrote no answer is left for the binary to ask again; the usage limit, or pi not logged in, starts no further task and
stops the run where it can be resumed.
