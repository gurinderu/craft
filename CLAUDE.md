# craft

Personal collection of opinionated Rust engineering skills, review agents, and the
`rust-audit` workflow; builds on the `superpowers` plugin (a declared dependency) for the
generic engineering-process discipline. See `README.md` / `MAP.md` for the full contents.

## Review requests run as a background subagent

When the user asks for a review ("сделай ревью", "review this", "проверь изменения", etc.),
do **not** review inline in the main conversation. Dispatch a review **agent** with the Agent
tool using `run_in_background: true`, then continue working; report the verdict when the agent
notifies completion.

Pick the agent by scope:

| Ask | Agent |
|---|---|
| Review a diff / change before commit or merge (default) | `rust-reviewer` |
| Whole-project structural / architecture audit (not a diff) | `rust-architecture-reviewer` |
| Security / dependency / unsafe-surface scan | `rust-security-scanner` |
| `unsafe` code under Miri (UB check) | `rust-miri` |
| Full audit — all of the above in parallel, one synthesized report | `rust-audit` workflow |

Give the agent a self-contained brief: the diff range (e.g. `git diff main...HEAD`) or target
paths, and what the change is supposed to do. The `craft:rust-review` skill covers how to craft
the brief and act on the verdict; the generic review discipline lives in the superpowers plugin
(`superpowers:requesting-code-review`, `superpowers:receiving-code-review`).

**Always a fresh agent.** Every review request spawns a **new** agent via the Agent tool — it
starts with a clean context and never inherits this conversation. Never continue or reuse a
prior review agent (no `SendMessage`); spawn a fresh one each time, including re-reviews after
fixes. Because the agent sees only the brief, restate the diff range / paths and intent on
every dispatch — don't assume it remembers a previous round.

If the user explicitly asks for a synchronous/inline review, honor that instead.
