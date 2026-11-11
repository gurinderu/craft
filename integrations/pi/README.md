# craft for pi

A pi driver for the craft CLI's step-by-step review (`craft review start`, then `craft review submit`
after each step's agents ran), as `integrations/claude-code/workflows/review.js` (the `craft:review` workflow) drives it from Claude Code.
The binary decides every step; the driver only runs the agents a step hands out and hands their answers back.
The route is new and not yet observed running in a real pi session: its loop is tested against fake `craft` and `pi`
binaries only. Its driver, `lib/pi-review.mjs`, is the process-per-task runner the Codex driver shares
(`lib/task-process-*.mjs`), with pi as its host (`lib/pi-review-task.mjs`).

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
--no-approve --no-extensions --no-mcp --tools read,bash,grep,find,ls [--model <m>] -- <message>` in the reviewed
repository, up to `concurrency=` at once (default 4). `--no-approve` keeps the reviewed branch's own pi resources
(`.pi/`, project `.agents/skills`) from loading; `--no-extensions` and `--no-mcp` keep your extensions and MCP servers
from starting in every task process. pi's hosted providers and their logins are not extensions, so they still work; a
provider that only an extension adds (a custom provider, the built-in llama.cpp one) is not available to the tasks.

The message is the craft agent's prompt body the task names (from `integrations/claude-code/agents/`, or a consumer's
`.claude/agents/`), then the instruction to read the task's prompt file and print the answer as one JSON object at the
end, and where a skill the prompt names is (`skills/<name>/SKILL.md` in the package; pi loads none of craft's), with
`${CLAUDE_PLUGIN_ROOT}` spelled out as the package root. The driver takes the answer from what pi printed — the last
fenced `json` block, else the last top-level object that parses — and writes it to the task's answer file; pi has no
schema output, and the binary validates each answer and hands an invalid one back for a retry.

A task gets no tool that writes or edits a file. **pi has no sandbox**: `bash` stays, because the review agents need
git, and it is not contained — a task's shell runs with your permissions in the reviewed checkout. Review a branch you
do not trust with `gate=false` and inside a container or VM.

Login and the default model are pi's own: no key is passed, and `--model` is given only for a tier `piModels=` (or
`CRAFT_PI_MODELS`) maps. A task past its deadline is abandoned; one that failed or printed no answer is left for the
binary to ask again; the usage limit, or pi not logged in, starts no further task and stops the run where it can be
resumed.
