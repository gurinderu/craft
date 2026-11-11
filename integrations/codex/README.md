# craft for Codex

The Codex delivery does not live in this directory: its manifest stays at the repository root, in
`.codex-plugin/plugin.json`, with its marketplace in `.agents/plugins/marketplace.json` (plugin source `.`).

Why the root. Codex copies only the plugin root into its cache, and leaves out every symlink in it (observed
on codex-cli 0.167.0: a plugin root here, with `skills/` and `lib/` linked in, installed as `.codex-plugin/`
alone). The skills and the hooks' scripts must therefore be real directories inside the plugin root, which
only the repository root gives without a second copy of them.

The manifest names the Claude Code delivery's hooks file, `./integrations/claude-code/hooks/hooks.json`, through
its `hooks` field; Codex runs those hooks with `${CLAUDE_PLUGIN_ROOT}` set to its cached copy of the repository
root, so the commands reach `lib/` there.

The review runs in Codex through its own driver, `lib/codex-review.mjs`, which the `codex-review` skill has the
session run: a Node script over the `craft` binary's step protocol, sharing the Claude Code driver's command lines,
step reader and answer (`lib/cli-review-*.mjs`), each task its own `codex exec --ephemeral -s read-only
--output-schema <schema> -o <answer> -C <repo> -`, the prompt on stdin. Codex has no agent types, so a task naming a
craft agent runs with that agent's prompt body from `integrations/claude-code/agents/` (a real directory in the
plugin root) before its own prompt; and Codex sends `--output-schema` in the API's strict mode, so a task schema with
optional fields is handed over as a strict copy and the nulls it forces are dropped from the answer. The other
workflow engines (`rust-audit`, `triage-findings`) are Claude Code only.

Install: see "Codex" in the repository's `README.md`.
