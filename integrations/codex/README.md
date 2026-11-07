# craft for Codex

The Codex delivery does not live in this directory: its manifest stays at the repository root, in
`.codex-plugin/plugin.json`, with its marketplace in `.agents/plugins/marketplace.json` (plugin source `.`).

Why the root. Codex copies only the plugin root into its cache, and leaves out every symlink in it (observed
on codex-cli 0.167.0: a plugin root here, with `skills/` and `lib/` linked in, installed as `.codex-plugin/`
alone). The skills and the hooks' scripts must therefore be real directories inside the plugin root, which
only the repository root gives without a second copy of them.

The manifest names the Claude Code delivery's hooks file, `./integrations/claude-code/hooks/hooks.json`, through
its `hooks` field; Codex runs those hooks with `${CLAUDE_PLUGIN_ROOT}` set to its cached copy of the repository
root, so the commands reach `lib/` there. The workflow engines and the review agents are Claude Code only.

Install: see "Codex" in the repository's `README.md`.
