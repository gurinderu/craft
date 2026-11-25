# craft for Codex

The Codex delivery does not live in this directory: its manifest stays at the repository root, in
`.codex-plugin/plugin.json`, with its marketplace in `.agents/plugins/marketplace.json` (plugin source `.`).

Why the root. Codex copies only the plugin root into its cache, and leaves out every symlink in it (observed
on codex-cli 0.167.0: a plugin root here, with `skills/` and `integrations/shared/` linked in, installed as `.codex-plugin/`
alone). The skills and the hooks' scripts must therefore be real directories inside the plugin root, which
only the repository root gives without a second copy of them.

The manifest names the Claude Code delivery's hooks file, `./integrations/claude-code/hooks/hooks.json`, through
its `hooks` field; Codex runs those hooks with `${CLAUDE_PLUGIN_ROOT}` set to its cached copy of the repository
root, so the commands reach `integrations/shared/` there.

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
review on the codex backend then fails every task and ends INCOMPLETE.

Cause: Ubuntu 24.04 sets `kernel.apparmor_restrict_unprivileged_userns=1`, so bwrap cannot use the user namespace it
creates: AppArmor confines it there without capabilities, so its loopback setup fails. An AppArmor profile that allows
`userns` lifts this (observed with codex-cli 0.167.0 from nixpkgs).

Fix: add a profile for the bwrap Codex actually runs, as `/etc/apparmor.d/codex-bwrap`, and load it with
`sudo apparmor_parser -r /etc/apparmor.d/codex-bwrap`. For a nix install, where Codex may run either its bundled
`codex-resources/bwrap` or nixpkgs' bubblewrap:

```
abi <abi/4.0>,
include <tunables/global>
profile codex-bwrap /nix/store/*-{codex-*/integrations/shared/codex/codex-resources,bubblewrap-*/bin}/bwrap flags=(unconfined) {
  userns,
  include if exists <local/codex-bwrap>
}
```

The profile exempts every binary at a path matching the glob from the user-namespace restriction: each gets
unrestricted user namespaces. On a single-user machine the glob is fine. On a shared or multi-user Nix machine, where
another user can build a store path with that name, attach the profile to the exact hashed path the `strace` line below
prints instead, and re-load it after Codex or bubblewrap is upgraded.

For another install, find the path with `strace -f -e trace=execve codex sandbox true 2>&1 | grep bwrap` and put it
in the profile. The profile persists across reboots; check it with `codex sandbox true && echo SANDBOX-OK`.

## Install, upgrade and what runs

Install: see "Codex" in the repository's `README.md`.

The marketplace is pinned to the release tag because `bin/craft` runs the `craft` binary of the plugin's release
version: a marketplace that followed `main` would run newer skills and content with an older binary. To move to a
new release — or off a marketplace added without `--ref` — remove the marketplace first: Codex refuses to add
`craft` again from another ref ("already added from a different source"), and `codex plugin marketplace upgrade
craft` only refreshes the ref already pinned. Then add it at the new tag and add the plugin again.

Codex runs a plugin's hooks only once you trust them: open `/hooks` in the Codex TUI and trust craft's. The skills
appear as `craft:<name>`. Under Codex the hooks also count the project's own agent roles (`.codex/agents/*.toml`)
as declared roles; when the review command cannot run or fails, they tell the session to review the diff itself.
Codex has no Workflow tool, so the review loop of `craft:develop` does not run there either.

The review command runs its tasks in parallel, 4 at once by default (`--concurrency <n>`), on Codex's configured
model unless `--models <model>` or `--models opus=<m>,sonnet=<m>,haiku=<m>` (or `CRAFT_CODEX_MODELS`) names one per
tier, each with the session's login. It writes under `~/.craft` and starts model calls, so it runs outside Codex's
sandbox.
