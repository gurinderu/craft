# Reality — what a claim is checked against
The realm is the model of the work, the repo is part of its embodiment; this file names the third thing — what the work becomes when it runs, and how to look at it. A claim is settled by its canonical carrier, never by the source that was supposed to produce it; tests are a rung of evidence, not a carrier.

| Claim class | Canonical carrier | How to observe | Who |
|---|---|---|---|
| "the released plugin behaves this way for a consumer" | the installed plugin in a consuming repo | install from the marketplace and exercise it there; falsifier — the skill/agent/workflow is missing from the consumer's session or behaves otherwise | user |
| "the manifests are valid" | the manifests as the official validator reads them | `npx --yes @anthropic-ai/claude-code plugin validate . --strict` | agent |
| "this skill/agent is well-formed and its `craft:` refs resolve" | the checker's verdict over `skills/`, `agents/`, `workflows/` | `node lib/check-skills.mjs` | agent |
| "this workflow script still parses in the sandbox" | the script compiled inside the sandbox wrapper | `node lib/check-workflows.mjs` | agent |
| "the two deliveries of a review agent reach the same required content" | the requirement keys each side's body reaches, per group of the checker's `REQUIREMENTS` registry | `node lib/check-delivery-parity.mjs` | agent |
| "the helper logic is correct" | the test run — with the fix reverted, the test must fail | `node --test 'lib/**/*.test.mjs' 'opencode/**/*.test.mjs'` | agent |
| "the engine does X on a run" (logic inside `workflows/*.js`) | the engine executed in the harness | `runEngine(name, {args, script})` from `lib/engine-harness.mjs` in a test; a string match on the script catches a deletion, not a defect | agent |
| "the code is lint-clean" | ESLint over the linted scope | `npm run lint` — read the raw exit code, not a wrapper's summary | agent |
| "the OpenCode plugin type-checks" | `tsc --noEmit --strict` over `opencode/plugin/*.ts` | `npm run check:types` (after `npm ci --prefix opencode/plugin`) | agent |
| "`lib/` is type-clean" | `tsc --checkJs` over non-test `lib/*.mjs`, non-strict, types from JSDoc, against Node 22 typings | `npm run check:types:lib`; falsifiers — an injected `git([...], cwd).ok` on the string overload fails it, and so does a post-22 API such as `fs.mkdtempDisposableSync` or a browser global such as `window` | agent |
| "a module on the strict list is clean at maximum strictness" | `tsc` over `lib/tsconfig.strict.json` `files` (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes and the rest) — the second half of `npm run check:types:lib` | `npm run check:types:lib`; falsifier — an injected `[1][0].toFixed()` in a listed module fails the strict tier and passes the non-strict one | agent |
| "every module inlined into the engines is on the strict list" | `node lib/check-workflows.mjs` | falsifier — delete an inlined module's entry from `lib/tsconfig.strict.json` `files`: the checker exits 1 with a `missing from lib/tsconfig.strict.json` FAIL line | agent |
| "the eval corpus is well-formed" | the checker's verdict | `node lib/check-evals.mjs` | agent |
| "trunk actually contains this" | `origin/main` at the forge, never a local ref | `gh api repos/gurinderu/craft/commits/main --jq .sha` | agent |
| "a session hook fires on its event and stays quiet otherwise" | the command stored in `.claude/settings.json`, fed a payload | `jq -r '<path>.command' .claude/settings.json`, then pipe `{tool_input:{command},tool_response:{stdout}}` into `sh -c` with it; falsifier — fires on `echo git push`, or prints invalid JSON. Live: a failing command (`git push --dry-run origin refs/heads/no-such:refs/heads/x`) wakes no PostToolUse hook, a succeeding one does — the filters rely on that | agent |
| "a role agent's own bridge comes up" | the tool list of a launched role subagent, in a session started after the role file landed (the harness reads `.claude/agents/` at session start) | launch the role and have it list its `mcp__iskron-sub-<role>__iskron_*` tools; falsifier — none present. `node ~/.iskron-bridge/iskron-bridge.mjs doctor` from the repo root proves only the entry's form (no `НАДО:` lines), not that a launch gets the tools | agent |
| "a push/merge hook sees the command as run" | the command after user-level rewrites: `rtk hook claude` turns `git …`/`gh …` into `rtk git …`/`rtk gh …` before project hooks see it | `echo '{"tool_name":"Bash","tool_input":{"command":"git push"}}' \| rtk hook claude`; feed the rewritten command to the hook as in the row above (surface pinned in realm `@nick/craft`, #128) | agent |

**A gate attests to form, not to behaviour.** A green suite proves the thing compiles, parses and matches its fixture — never that a function is called with what you think. Close a behavioural claim by executing it with before/after shown: revert the change, watch the test fail, restore it. Logic in a file that cannot be imported (`workflows/*.js`) is extracted into `lib/` so it can be executed.

**Ceiling**:
- "this skill triggers on this prompt" — the triggering evals are a local harness that needs a live model and are excluded from CI (`evals/README.md`); a green CI says nothing about triggering. The ceiling is a local eval run.
- "the review engine produces good findings" — a judgment over someone else's code; no carrier in this repo decides it. Closed only by the owner's reading of a real run's `run-record`.

**The table grows by use.** A session that learned a carrier the table lacks (an unnamed carrier, an observation reachable or not — then under *Ceiling*, a wrong command here) writes the row then, before closing the work that taught it. Only what observation needs goes here; dated measurements and history are realm nodes.
