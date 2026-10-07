# Backend mechanics

How the record shape from [SKILL.md](SKILL.md) lands in each backend. The *choice* of backend is
SKILL.md's ("Choosing the backend"); this file only says how to write and search once chosen.

## MCP memory / knowledge-graph server

- **Its own instructions first.** When the server ships a skill, a prompt or tool descriptions
  saying how to write (which item type, which fields, which modes, where to anchor), follow them
  and hand it the record's content — title, body, scope, kind, author, commit, links. Do not force the fields
  below onto a store that has its own discipline.
- **Without instructions**, the plain mapping: one item per record; the item's name = `title`;
  its text = `body`; `kind`, `scope`, `status`, `id`, `author`, `commit` as tags, attributes or observations,
  whichever the tool accepts; `links` as relations when the tool has them, else as text.
- **Recall returns the record shape**: whatever the server stores, a recalled record handed on
  (to a subagent, or to a review as `priorDecisions`) is rebuilt as the SKILL.md shape — `author`
  and `commit` included when the item carries them.
- **Search, don't list**: `recall` calls the server's search with the topic keywords and the scope,
  then filters the hits by `scope` and `status` — never a full listing.
- **Supersede** by the server's own means (a status field, a supersede relation, a mode); if it has
  none, write the new item and append `superseded by <id>` to the old one.

## Harness project memory (Claude Code)

The directory is the one the harness names in the session's instructions (in Claude Code,
`~/.claude/projects/<project-slug>/memory/`, with `MEMORY.md` as its index). An agent that does not
have the index in context — a workflow's agent, a subagent — derives the directory itself. The
harness keys project memory by the repository's **main checkout**, never a worktree or a
subdirectory (a worktree session gets its own `~/.claude/projects/` entry, but without
`memory/`). The root is `dirname "$(git rev-parse --path-format=absolute --git-common-dir)"`
(the same from any worktree or subdirectory), `pwd` only outside a git repo; the slug is that
root with every character that is not an ASCII letter or digit replaced by `-` (observed:
`/home/ubuntu/projects/my/craft` → `-home-ubuntu-projects-my-craft`). This is an observed
convention, not a documented one: `~/.claude/projects/<slug>/memory/` must exist; if it does
not, say `none — harness memory directory <path>/memory not found` and never guess a near
match. Use the harness's format, not a craft one:

- **One file per record**, `<id>.md`:

  ```markdown
  ---
  name: <id>
  description: "<kind>: <title>"
  metadata:
    type: project
    craft_kind: decision
    craft_scope: src/parse.rs
    craft_status: active
    craft_author: alice
    craft_commit: 33d0240d4fe0
    modified: 2026-10-06
  ---

  <body>

  Links: <links, one per line>
  ```

- **One index line per record** in `MEMORY.md`, which the harness loads every session — keep it
  short — a Markdown link whose text is `<kind>: <title>` and whose target is the record file
  `<id>.md`, then ` — <scope>`; at most 150 characters (shorten the title with
  `…` past that; the file keeps the full one). Superseded/withdrawn records leave the index (their
  files stay, `craft_status` updated) so the always-loaded index carries only live facts.
- **Recall**: the index is in the main session's context (an agent without it reads `MEMORY.md`
  at the derived path) — match scope and keywords there, then read only
  the matching files; for history, `grep -l "craft_scope: <path>"` over the directory.
  Handed on (a subagent's brief, a review's `priorDecisions`) as the SKILL.md shape: `name` → `id`,
  `craft_kind` → `kind`, the title from `description` without its `<kind>: ` prefix, `craft_scope`
  → `scope`, `craft_status` → `status`, `modified` → `date`, `craft_author` → `author`,
  `craft_commit` → `commit`, the body, and the `Links:` lines → `links`.
- **Refused write** (a `PreToolUse` guard exiting non-zero, a permission denial, an index line or
  instruction saying "do not write here") → the backend is unavailable: do not retry, do not route
  around the guard; go to the next rule.

## Files in the consumer repo

`.craft/memory/<kind>/<id>.md` — `kind` ∈ `decision`, `lesson`, `question`:

```markdown
---
id: <id>
kind: decision
title: <title>
scope: src/parse.rs
status: active
date: 2026-10-06
author: alice
commit: 33d0240d4fe0
links:
  - https://github.com/org/repo/pull/42
---

<body>
```

- **One file per record**, never a single append-only log: a log conflicts on every parallel
  branch and must be read whole to recall one fact.
- **Supersede / withdraw**: set `status`, add the successor to `links`, and `git mv` the file to
  `.craft/memory/archive/<kind>/<id>.md`. The live directories hold only active records, so a
  plain `grep -rl` over them never returns a retired fact.
- **Recall**: `grep -rl -e "scope: <path>" -e "scope: <parent-dir>" .craft/memory/<kind>/`, then
  keyword-filter titles and bodies of those files only. `archive/` is searched only when history is
  asked for.
- **An existing ADR directory** (`docs/adr/`, …) shows the project already keeps decisions in the
  repo, so this backend is chosen without asking — but it is not a place to write: craft records
  go to `.craft/memory/`, and an ADR stays the project's to write in its own format. Recall may
  also grep the ADR directory read-only.
- The files are committed with the change they explain; say so when you create the first one.
