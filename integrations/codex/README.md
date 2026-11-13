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

The review has a Codex route, new and not yet observed running in a real Codex session: the `codex-review` skill has
the session run `sh <plugin root>/bin/craft review run --backend codex`. `bin/craft` runs the `craft` binary of the
plugin's version (downloaded from its GitHub release into `~/.craft/bin/<version>/` the first time), and the binary
drives the review itself, each task its own `codex exec --ephemeral -s read-only --output-schema <schema> -o <answer>
-C <repo> -`, the prompt on stdin. Codex has no agent types, so a task naming a craft agent runs with that agent's
prompt body from `integrations/claude-code/agents/` (a real directory in the plugin root) before its own prompt; and
Codex sends `--output-schema` in the API's strict mode, so a task schema with optional fields is handed over as a
strict copy and the nulls it forces are dropped from the answer. The other workflow engines (`rust-audit`,
`triage-findings`) are Claude Code only.

## Sandbox on Ubuntu 24.04 (bwrap: loopback: Failed RTM_NEWADDR)

Symptom: `codex sandbox true` fails with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. A craft
review on the codex backend then ends INCOMPLETE with every lens failing, or Codex asks for approval on every command.

Cause: Ubuntu 24.04 sets `kernel.apparmor_restrict_unprivileged_userns=1`, so bwrap cannot create its user namespace
without an AppArmor profile that allows `userns` (observed with codex-cli 0.167.0 from nixpkgs).

Fix: add a profile for the bwrap Codex actually runs, as `/etc/apparmor.d/codex-bwrap`, and load it with
`sudo apparmor_parser -r /etc/apparmor.d/codex-bwrap`. For a nix install, where Codex may run either its bundled
`codex-resources/bwrap` or nixpkgs' bubblewrap:

```
abi <abi/4.0>,
include <tunables/global>
profile codex-bwrap /nix/store/*-{codex-*/lib/codex/codex-resources,bubblewrap-*/bin}/bwrap flags=(unconfined) {
  userns,
  include if exists <local/codex-bwrap>
}
```

For another install, find the path with `strace -f -e trace=execve codex sandbox true 2>&1 | grep bwrap` and put it
in the profile. The profile persists across reboots; check it with `codex sandbox true && echo SANDBOX-OK`.

Install: see "Codex" in the repository's `README.md`.
