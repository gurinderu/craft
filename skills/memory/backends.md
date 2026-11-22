# Backend mechanics

How the record shape from [SKILL.md](SKILL.md) lands in each backend. The *choice* of backend is
SKILL.md's ("Choosing the backend"); this file only says how to write and search once chosen.

## MCP memory / knowledge-graph server

- **A pinned store** (`craft-memory: mcp <server> <store>`, SKILL.md rule 1; `<server>` matches
  the server whose tool prefix, such as `mcp__<...>__`, contains it, ignoring case; more words
  than that is an unknown value, so `none` with the reason): every search and
  every create passes the store as the tools' scope parameter (a graph, project or workspace
  argument, whatever that server calls it), or as the scope of the server's own skill. A tool that
  takes no scope, or refuses the store, makes the backend unavailable: `none` with that reason,
  never a write to the server's default or another store.
- **Its own instructions first.** When the server ships a skill, a prompt or tool descriptions
  saying how to write (which item type, which fields, which modes, where to anchor), follow them
  and hand it the record's content — title, body, scope, kind, author, commit, deferred, line, lens, toolRule, links. Do not force the fields
  below onto a store that has its own discipline.
- **Without instructions**, the plain mapping: one item per record; the item's name = `title`;
  its text = `body`; the other fields under fixed keys, prefixed `craft_` as in the harness format
  below — `craft_kind`, `craft_id`, `craft_scope`, `craft_status`, `craft_author`, `craft_commit`,
  `craft_deferred`, `craft_line`, `craft_lens`, `craft_tool_rule` — as attributes, tags
  (`craft_kind:decision`) or observations, whichever the tool accepts, never under another name;
  `links` as relations when the tool has them, else as text.
- **Recall searches both spellings**: records written before these keys were fixed may carry them
  bare (`kind`, `id`, `scope`, `status`, …). Search and filter by the `craft_` key **and** the bare
  one (`craft_kind:decision` or `kind:decision`), never by one alone, and hand the record on with the
  bare names of SKILL.md.
- **Recall returns the record shape**: whatever the server stores, a recalled record handed on
  (to a subagent, or to a review as `priorDecisions`) is rebuilt as the SKILL.md shape — `author`,
  `commit`, `deferred`, `line`, `lens` and `toolRule` included when the item carries them, and an
  `external` record's `system`, `repo`, and `versionFrom` and `versionMatch` or a stated `version`.
- **Ids — the convention for a server with its own ids**: `id` is the skill-rule id (SKILL.md,
  from kind + title + scope), and the server's own id goes into `links` as `store: <id>`. `kind`,
  `title` and `scope` are always handed on as stored, so the id can be derived again — a review
  engine sets `id` from them itself whenever a record carries a `store:` link or an id not of the
  form `<kind>-<10 hex>`, and `answers:` / `supersedes:` links name skill-rule ids.
- **Recall by the attribute, then narrow** — the same calls every run, each kept with what it
  answered:
  1. List the craft records of each kind through the search's **attribute filter** with the exact
     value — `craft_kind` equal to `decision`, then `question`, `rule`, `external` — then the same
     on the bare `kind`. Never a wildcard such as `craft_kind:*` (a filter may read it as the
     literal value), and never a text query on the word `craft_kind` or a kind name in its place:
     a text query matches names and bodies, not attributes.
  2. A search that refuses a call without a text query (it asks for `q`, `query` or the like)
     gets an empty one (`""`) beside the filter; one that refuses that too, the broadest it takes
     (`*`) beside the filter — never the filter's words as the query.
  3. **Read every page**: ask for the largest number of results the search takes and follow its
     offset, page or cursor, or its "N more not shown", until it says there is no more. A backend
     that says it holds more than was read and gives no way to read the rest makes the recall
     **truncated**: say what it said (`12 found, 10 shown`); a review then reads its memory as
     degraded, whatever was recalled.
  4. **Text fallback**: only when every attribute listing came back empty, run the text search on
     the kind name once (`decision`, then the others) and take a hit only when it carries the craft
     kind as an attribute, a tag or an observation — a record written as text rather than attribute
     (SKILL.md's plain mapping allows either). Say which call found the records.
  5. Narrow what was listed by `scope` (to the paths, as "recall" in SKILL.md matches them), then
     by `status` and the topic keywords — yourself, or through the search's own scope or status
     filter beside the attribute one; never by a text query per path alone, and never a listing of
     the whole store with no attribute filter.
- **An empty recall that may have failed is named, never read as no memory.** When the recall
  comes back with no record and either a call errored or was refused (past the step 2 retry), or
  every call was a text query and none an attribute listing, or the attribute listing came back
  empty while the store shows craft records exist (an index, a count the server reports, a craft
  record seen in any other answer) — never for records the scope narrowing (step 5) left out, nor
  for the fallback's not-found after a clean empty listing, both clean answers — say `recall found
  nothing — backend query may have failed: <the call, its tool and arguments, and its error or
  answer>`. A review engine's recall agent puts that call and error in its answer's `queryError`
  (and a truncated answer in `truncated`); the review then names its memory as degraded.
- **Supersede** by the server's own means (a status field, a supersede relation, a mode); if it has
  none, write the new item and append `superseded by <id>` to the old one.

## Harness project memory (Claude Code)

The directory is the one the harness names in the session's instructions (in Claude Code,
`~/.claude/projects/<project-slug>/memory/`, with `MEMORY.md` as the harness's index and
`craft-memory.md` as craft's, below). An agent that does not
have the index in context — a workflow's agent, a subagent — derives the directory itself. The
harness keys project memory by the repository's **main checkout**, never a worktree or a
subdirectory (a worktree session gets its own `~/.claude/projects/` entry, but without
`memory/`). The root is `dirname "$(git rev-parse --path-format=absolute --git-common-dir)"`
(the same from any worktree or subdirectory), `pwd` only outside a git repo; the slug is that
root with every character that is not an ASCII letter or digit replaced by `-` (for example
`/home/alice/src/app` → `-home-alice-src-app`). This is an observed
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
    craft_kind: decision    # decision | rule | lesson | question | external
    craft_scope: src/parse.rs
    craft_status: active
    craft_author: alice
    craft_commit: 33d0240d4fe0
    craft_deferred: true    # a deferred question only
    craft_line: 42          # the finding's line, when known
    craft_lens: safety      # the lens that raised it, when known; on a rule, the lens it is narrowed to
    craft_tool_rule: clippy::needless_pass_by_value  # the gate tool's own rule the finding fired, when known
    # an external record only: craft_system, craft_repo, craft_version_from and craft_version_match, or craft_version
    modified: 2026-10-06
  ---

  <body>

  Links: <links, one per line>
  ```

- **craft's own index, `craft-memory.md`**, in the same directory: one line per active record,
  grouped under a `## <scope>` heading per scope (headings sorted, `.` last), each line a Markdown
  link whose text is `<kind>: <title>` and whose target is the record file `<id>.md`; at most 150
  characters (the title shortened with `…` past that; the file keeps the full one). Superseded and
  withdrawn records leave the index (their files stay, `craft_status` updated). The index is a
  speed aid, not the source of truth — the record files are (recall below finds those it misses).
  It is rebuilt from the record files, never edited line by line, and only after a `record-*`
  write — **a recall never writes**, here or in `MEMORY.md`:

  ```sh
  CRAFT_BIN="$(sh "<this skill's base directory>/../../integrations/shared/craft-cli.sh" --ensure --print-path)" &&
  "$CRAFT_BIN" memory reindex --dir "<the memory directory>"
  ```

  It rewrites `craft-memory.md` and the migration below in one move, writes only what changed,
  and prints `{indexed, moved, indexWritten, harnessWritten, skipped}` (`skipped`: record files it
  could not read as text, each named). It writes nothing where the directory holds no craft record,
  and refuses, exiting non-zero and naming why, when a line of `MEMORY.md` is the no-write marker:
  after any Markdown prefix (heading `#`s, a quote `>`, a list marker `-` `*` `+` or `N.`,
  emphasis) and at most one short label ending in `:`, `—` or ` - ` (`Note:`, `Memory —`), the line
  starts with "do not write here", in any case — never a craft index line, nor the phrase in the
  middle of a sentence. That is the refused write below, which the binary honours as an agent's
  own write does. Without the binary
  (no network, no release for the platform), do the same by hand as this list describes, or leave
  the index stale: recall still finds the record.
- **One pointer line in `MEMORY.md`**, never one line per record: the harness loads `MEMORY.md`
  into every session and truncates it past its load limit, so a line per record grows it until
  the harness silently drops the tail — records the agent then never sees. The pointer is one
  list item, added once, at the end: a Markdown link with the text `craft memory index` and the
  target `craft-memory.md`, then ` — craft's decisions, rules, lessons and questions; read on recall`.
- **Migration from the older layout** (earlier releases wrote one line per record into
  `MEMORY.md`): a line of `MEMORY.md` is craft's only when it is a Markdown list link whose
  target is `<kind>-<10 hex>.md` (`kind` one of the five) and that file exists with `craft_kind`
  in its frontmatter; it leaves `MEMORY.md` (its record is in `craft-memory.md` when active).
  Every other line — the user's own, another tool's, a heading, a blank, a link to a file that is
  not craft's — stays exactly as it is, in its place. `craft-memory.md` is written before
  `MEMORY.md`, so an interrupted run loses no line, and a second run changes nothing. A refused
  write of `MEMORY.md` (rule below) leaves it as it is: recall still reads both files.
- **Recall** (read only): read `craft-memory.md` at the derived path — match the scope headings
  and keywords there — and, while a migration has not run, also the craft lines still in
  `MEMORY.md` (the main session has it in context; an agent without it reads it at the derived
  path). Then find the records neither lists: `grep -l "craft_kind:"` over the directory's
  `<kind>-<10 hex>.md` files, those whose file name no index line links to; match them by their
  `craft_scope` and title like the indexed ones, and say how many of them are active — `index
  stale: N record(s) outside the index — run craft memory reindex after recording`. A superseded or
  withdrawn record is outside the index by design and never counts as stale. Read only the matching
  files; for history, `grep -l "craft_scope: <path>"` over the directory.
  Handed on (a subagent's brief, a review's `priorDecisions`) as the SKILL.md shape: `name` → `id`,
  `craft_kind` → `kind`, the title from `description` without its `<kind>: ` prefix, `craft_scope`
  → `scope`, `craft_status` → `status`, `modified` → `date`, `craft_author` → `author`,
  `craft_commit` → `commit`, `craft_deferred` → `deferred` (a boolean), `craft_line` → `line` (a
  number), `craft_lens` → `lens`, `craft_tool_rule` → `toolRule`, `craft_system` → `system`, `craft_repo` → `repo`,
  `craft_version_from` → `versionFrom`, `craft_version_match` → `versionMatch`, `craft_version` → `version`, the body, and the `Links:` lines → `links`.
- **Refused write** (a `PreToolUse` guard exiting non-zero, a permission denial, an index line or
  instruction saying "do not write here") → the backend is unavailable: do not retry, do not route
  around the guard; go to the next rule.

## Files in the consumer repo

`.craft/memory/<kind>/<id>.md` — `kind` ∈ `decision`, `rule`, `lesson`, `question`, `external`
(an external record carries `system`, `repo`, and `versionFrom` and `versionMatch` or a stated `version` in
its frontmatter beside `scope`):

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
deferred: true   # a deferred question only
line: 42         # the finding's line, when known
lens: safety     # the lens that raised it, when known
toolRule: clippy::needless_pass_by_value  # the gate tool's own rule the finding fired, when known
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
