# craft

Personal collection of opinionated engineering skills, review agents, and workflows —
a broad **Rust** skill set and a **Nix** skill set — plus the generic `review` engine and the
`rust-audit` workflow. Self-contained: owns its domain knowledge, declares no plugin dependencies,
and carries no generic engineering-process content. See `README.md` / `MAP.md` for the full contents.

## Review requests run as a background subagent

When the user asks for a review ("сделай ревью", "review this", "проверь изменения", etc.),
do **not** review inline in the main conversation. Dispatch the matching review **handler** in the
background — a workflow (the default review and the full audit) via the Workflow tool, or an agent
via the Agent tool with `run_in_background: true` — then continue working; report the verdict when
it notifies completion.

Pick the handler by scope:

| Ask | Handler |
|---|---|
| Review a diff / change before commit or merge (default) | `review` **workflow** (background) — auto-detects language (Rust/Nix) |
| Force a Rust-only / Nix-only diff review | `rust-review` / `nix-review` **workflow** pin (background) |
| Deep adversarial review of a mixed / non-Rust-Nix diff, or when money-path (payments/ledger) invariants matter | `adversarial-review` **workflow** (background) — language-agnostic, subscription-friendly rate. Not to be confused with `review --strict` (harsh maintainability-block mode of the default engine) |
| Ad-hoc single-pass diff review (when you explicitly don't want the workflow) | `rust-reviewer` / `nix-reviewer` **agent** (background) |
| Whole-project structural / architecture audit (not a diff) | `rust-architecture-reviewer` **agent** |
| Security / dependency / unsafe-surface scan | `rust-security-scanner` **agent** |
| `unsafe` code under Miri (UB check) | `rust-miri` **agent** |
| Full audit — all of the above in parallel, one synthesized report | `rust-audit` **workflow** |

Give the agent a self-contained brief: the diff range (e.g. `git diff main...HEAD`) or target
paths, and what the change is supposed to do. The `craft:rust-review` skill covers how to craft
the brief and act on the verdict.

**Always a fresh agent.** Every review request spawns a **new** agent via the Agent tool — it
starts with a clean context and never inherits this conversation. Never continue or reuse a
prior review agent (no `SendMessage`); spawn a fresh one each time, including re-reviews after
fixes. Because the agent sees only the brief, restate the diff range / paths and intent on
every dispatch — don't assume it remembers a previous round.

The default review runs the `review` **workflow** (multi-agent, launched in the background, verdict
reported on completion) — it **auto-detects the language(s)** in the diff (Rust and/or Nix), runs each
language's gate + lens set, and merges into one report; it scales depth to the diff. `rust-review` /
`nix-review` are thin pins over the same engine that force a single language (`workflow('review',
{languages:['rust'|'nix']})`). The single-pass `rust-reviewer` / `nix-reviewer` agents remain for an
ad-hoc, non-workflow review when you explicitly want one.

If the user explicitly asks for a synchronous/inline review, honor that instead.

## Self-review before opening a PR

Self-review is a **gate in the authoring loop**, not a one-shot report you file and forget. Before
running `gh pr create` on a Rust/Nix change, close the loop first:

1. Run the `review` workflow on the branch diff (`git diff main...HEAD`).
2. Feed every finding through the `craft:triage-findings` skill (validate against the code, dedupe,
   order).
3. Work them to green with the `craft:addressing-findings` fix loop.
4. Re-review (a **fresh** agent — see above) and repeat until the verdict is **Approve** (or
   **Warning** with each remaining item explicitly justified in the PR body).

Only then open the PR. A PR should never go up with open blocking findings the self-review already
surfaced. The craft-flavoured fix loop is `craft:addressing-findings`.
