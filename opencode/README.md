# craft for opencode

This subtree makes the craft Rust skills, review agents, and audit/triage workflows usable from
[opencode](https://opencode.ai). The Claude Code surface is unchanged — this is a thin, contained
adapter layer.

## Install

From the repo root, symlink the adapters into an opencode tree:

```bash
opencode/install.sh            # project-scoped: ./.opencode  (default)
opencode/install.sh --global   # ~/.config/opencode
```

Then restart opencode (or reopen the project) so it rescans `skills/`, `agents/`, `commands/`,
and `plugins/`.

### superpowers co-requisite

craft skills defer to `superpowers:*` skills (generic engineering-process discipline). opencode
reads the same Anthropic skill spec, so install superpowers' skills the same way — symlink their
skill directories into your opencode `skills/` dir. **Without them craft still works**; only the
generic-process deferrals go inert (the Rust knowledge is self-contained).

### Plugin dependencies

opencode auto-loads the plugin from `plugins/craft-rust` and Bun installs its `package.json`
dependencies on startup. If your opencode version doesn't auto-install them, add
`@opencode-ai/plugin` and `@opencode-ai/sdk` to your opencode tree's `package.json` and restart.

## Use

- **Skills** — auto-discovered; opencode's `skill` tool lists all 24 and routes by description.
- **Agents** — `rust-reviewer`, `rust-architecture-reviewer`, `rust-security-scanner`, `rust-miri`
  are hidden subagents (they don't clutter `@`-autocomplete); the workflows dispatch them.
- **Workflows** — `/rust-audit [base-ref]` and `/triage-findings <locator>`.

## Model strategy

opencode is provider-agnostic, so the agents **inherit your configured session model** (none pin
a model). Tune by task — strongest model + high effort where reasoning is heaviest:

| Component | Suggested tier | Effort |
|---|---|---|
| architecture audit | strongest (e.g. Opus-tier) | high/xhigh |
| diff review | mid (e.g. Sonnet-tier); strongest when bug-finding is critical | high |
| security scan | mid | medium |
| Miri | mid | medium |
| (workflow scouting/synthesis) | cheap/mid | low/medium |

## Containment

The plugin is deliberately inert until you invoke it: it registers **only** the two workflow
tools and installs **no** global hooks (no message/event/permission interception). It talks only
to the local opencode server, opens no ports, and makes no outbound calls. Installed project-scoped
by default.

## Parity caveats

- Skill sub-files aren't first-class bundled in opencode — the agent reads them by path on demand.
- `craft:` / `superpowers:` namespace prefixes in skill bodies are cosmetic here (skill name = bare
  dir); the model still resolves them.
- Workflow determinism rides on opencode's child-session API; the plugin retries sequentially and
  surfaces a clear error if a child session is stuck (opencode #8528 / #6573).
