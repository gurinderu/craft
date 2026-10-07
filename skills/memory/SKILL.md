---
name: memory
description: >-
  Semantic memory of the consumer project's own facts — decisions on review findings (rejected, deferred, justified), lessons learned, open questions — recorded and recalled across sessions through whatever store the project has: an explicit setting, a connected memory or knowledge-graph MCP server, the harness's project memory, or files under .craft/memory. Verbs: recall(topic, scope), record-decision, record-lesson, record-question. Use when a decision, lesson or open question about this codebase should outlive the session, before working on a path to learn what was already decided about it, or before launching a craft review, whose engine takes the recalled decisions as priorDecisions. Triggers: remember this decision, record why we rejected, what did we decide about, was this already discussed, note this lesson, open question for later. Not for memory leaks or memory usage (rust-performance, rust-ownership), nor craft's own run records and review ledger.
---

# Memory — the project's decisions, lessons and questions

Facts about the consumer's project that outlive a session: *why* a finding was rejected, what a
painful bug taught, what is still open. This skill is an **abstraction** over whatever store the
project already has; it never invents one. craft's machine memory — the run store
(`~/.craft/runs/`), the review ledger, telemetry — is a different thing and is not touched here.

## Verbs

| Verb | Input | Effect |
|---|---|---|
| `recall(topic, scope)` | keywords, a path or component | the **matching active** records only (below) |
| `record-decision` | title, scope, body (the reason), author, commit, links | one `decision` record |
| `record-lesson` | title, scope, body, links | one `lesson` record |
| `record-question` | title, scope, body (what would answer it), links | one `question` record |

A record answered or overturned is not edited away: write the new record with a link to the old
one and set the old one's `status` to `superseded` (or `withdrawn` when it was simply wrong). An
answered question becomes a `decision` that supersedes it.

## Record shape (lowest common denominator)

```
{ id, kind, title, body, scope, status, date, author, commit, links[] }
  id      stable hash of kind + title + scope (below) — same fact, same id: re-recording updates it
  kind    decision | lesson | question
  title   one line, ≤ 200 chars — the finding title verbatim, the lesson, the question
  body    the reason / the lesson / what would answer it — ≤ 1200 chars
  scope   a repo-relative path (file or directory) or a component name; `.` for the whole repo
  status  active | superseded | withdrawn
  date    YYYY-MM-DD of the last write
  author  who decided — a login or a name, ≤ 120 chars (decisions; optional on the others)
  commit  the commit the decided code was at, 7–40 hex (decisions on findings; below)
  links   PR / thread / commit / issue URLs, other record ids (`supersedes: <id>`, `answers: <id>`)
```

**A decision on a review finding** carries all of `author`, `commit` and a link to where it was
made (the PR thread, the review comment): the review engine names them when it sets the finding
aside, and it sets a finding aside only while the code in `scope` is unchanged since `commit`. A
decision without a `commit` is still recorded, but a review raises its finding again every time.
The title is the finding's title as the review printed it — the engine matches on its words.

**id** = `<kind>-` + the first 10 hex chars of `sha256("<kind>\n<title>\n<scope>")`, with `title`
trimmed, inner whitespace collapsed and lower-cased, and `scope` without a leading `./` or a
trailing `/` (e.g. `printf '%s\n%s\n%s' decision 'unwrap in parser is fine' src/parse.rs |
sha256sum | cut -c1-10`). Re-recording the same kind + title + scope **updates** that record
(body, date, links) instead of adding a duplicate.

**Bounds — what happens when one is reached.** These are refusals, never silent truncation:

- `title` over 200 chars → shorten it to the claim yourself before writing; a title cut mid-word
  by a tool is a different id on the next run.
- `body` over 1200 chars → **do not write**. Summarise the reason to the limit and put the long
  form where it already lives (the PR thread, the commit) into `links`. A record that would not
  fit is reported to the caller as not written, with why.
- Index line over 150 chars (harness project memory, below) → the index line shortens its title
  with `…`; the record file keeps the full title, so nothing is lost and the id is unchanged.
- `recall` over 10 matches → return the 10 most specific (exact path before directory before
  component, newer before older) and say `N more — narrow the scope or the topic`; never drop the
  rest silently.

## Choosing the backend

Run once per session, before the first verb; print the result as **one line**:
`memory backend: <X> (<why>)`. The order is fixed — the first rule that applies wins, and the
reason names the rule.

1. **Explicit setting.** Env `CRAFT_MEMORY`, else a line `craft-memory: <value>` in the consumer's
   `AGENTS.md` or `CLAUDE.md` (repo root). Values: `mcp` (optionally `mcp <server>`), `harness`,
   `repo`, `none`. The setting **pins** the backend: if the pinned one is unavailable, the result is
   `none` with that reason — never a silent fall-through to another store. An unknown value →
   `none (CRAFT_MEMORY=<v> is not mcp|harness|repo|none)`.
2. **A connected memory / knowledge-graph MCP server, found by capability.** Look at the tools the
   session actually has (deferred ones included). A server qualifies when its own tool set offers
   **both** a text or semantic *search* over stored items **and** a *create/record* of a new item
   (an entity, node, note, observation, memory). Judge by what the tools do — their descriptions
   and parameters — never by a server or tool name; a search-only or write-only server does not
   qualify. Several qualify → the one whose store is scoped to this project (a project, workspace
   or graph parameter that names this repo); still a tie → the first by server name, and the line
   lists the others. **If that server ships its own skill or writing instructions, follow them**
   for how a decision, lesson or question becomes an item there — do not map the fields above
   yourself; the record shape is then only what you hand it.
3. **The harness's project memory — the default.** In Claude Code: the project memory directory
   the harness names in this session's instructions; an agent without it in context (a workflow's
   agent, a subagent) derives it from the repository's main checkout root, never a worktree or
   subdirectory — path rule in
   [backends.md](backends.md). Written without asking (it is private to the
   user and tied to this project). A refused write — a `PreToolUse` guard, a permission denial,
   the consumer's instructions forbidding that directory — means **unavailable**: go to 4. Format
   → [backends.md](backends.md).
4. **Files in the consumer repo**, `.craft/memory/<kind>/<id>.md` — only when `.craft/memory/`
   already exists, or a decisions/ADR directory exists (`docs/adr/`, `docs/decisions/`, `adr/`,
   `doc/adr/`, `decisions/`), or the user says yes. Ask **once**, saying the files will be
   committed and visible to everyone with the repo: yes → create `.craft/memory/` (its existence
   is the remembered yes); no → `none` for this session, and offer the line
   `craft-memory: none` for `AGENTS.md` so later sessions do not ask again (written only on their
   word).
5. **None.** Write nothing, say so in the line, and offer to set one up (rule 1 or 4).

**Privacy.** A consumer's facts go only to a store tied to this project. An MCP server whose store
is global or shared across projects (no project scoping visible in its tools) needs the user's
consent before the first write — without it, treat the server as not qualifying and continue at
rule 3. Never put secrets, credentials or personal data in a record, whatever the backend.

## recall

1. **Scope match.** A record matches a touched path when its `scope` equals the path, is a
   directory containing it, or names the component the path belongs to; `.` matches everything
   and ranks last.
2. **Keyword match.** `topic` keywords against `title` and `body`; with both scope and topic,
   a record must match the scope and at least one keyword.
3. **Only matches come back.** Use the backend's search (the MCP search tool, `grep -l` over the
   memory files, the harness index `MEMORY.md`) — never load the whole store into
   context.
4. **Active only by default.** `superseded` and `withdrawn` stay hidden unless the caller asks for
   history; a superseded record shown on request carries its successor's id.
5. **A recalled decision is context, not a verdict.** Check it still holds against the code as it
   is now: the reason was "the input is always validated upstream" and the validation is gone →
   say so, and supersede the decision instead of applying it. Recall inside a review engine is
   read-only: its agent supersedes nothing — it returns such a decision in a `stale` list with the
   reason, the report names it on the `memory:` line, and superseding stays with
   `craft:addressing-findings`.

## Before a review — `priorDecisions`

A session that launches a craft review workflow (`review`, `rust-review`, `nix-review`,
`adversarial-review`, or `rust-audit`, which hands them to its nested reviews) may do this first.
Without `priorDecisions` the engine does it itself: one read-only agent runs this recall (or, if
the skill is unavailable, the backend order above), and the report names the source on its
`memory:` line (`adversarial-review`: its `memory` field).

1. `recall(<no topic>, <each path of the diff>)` — `git diff --name-only <base>...HEAD`. Decisions
   only (`kind: decision`), **active** only.
2. Pass them to the workflow as the argument `priorDecisions` — **only in an object argument**,
   `{ …, priorDecisions: [<records>] }`: a list of the records in the shape above, as recalled —
   `id`, `title`, `scope`, `body`, `date`, `author`, `commit`, `links` — nothing rewritten, nothing
   summarised. Never as a string: a `key=value` line cannot delimit the value (a reason holding
   `comment=true` would become an option), so the engine refuses any string and applies nothing.
   No match, or backend `none` → pass an empty list (say so in one line): it skips the engine's
   own recall, and the review sets nothing aside.
3. The engine never drops a finding silently: one a decision answers is listed under **Rejected
   before** with the decision's reason, author, date and link, outside the verdict. It is raised
   again as a normal finding when it is Critical/High, when the code in the decision's scope changed
   since its `commit`, when the decision has no `commit`, or when the repository does not know that
   `commit` (a squash-merged branch, another clone — named under **Prior decisions not applied**).
   More than 100 decisions, or a record that does not fit (a missing title or reason, a field past
   its bound, a control character in `id`, `scope` or `commit`, a scope outside the repo or holding
   characters other than letters, digits and `._@+/ -`),
   is refused and named — the report's **Prior decisions not applied** section (`adversarial-review`:
   its `priorDecisionsNotApplied` and `rejectedBefore` fields) — narrow the recall.

## Subagents

Subagents usually lack the MCP tools (`tools:` in their frontmatter) and the harness memory, so
they cannot `recall` themselves. **Known limit:** the launcher recalls and puts the matching
records, verbatim with their ids, into the subagent's brief; a subagent that reaches a decision
returns it in its result and the launcher records it.

## Boundaries

- The run store, the review ledger's `disposition` field and telemetry → `addressing-findings`
  ("Writing dispositions to the review ledger") and craft's run records; this skill does not read
  or write them.
- A decision that needs a product/spec call to be made at all → `specs`; this skill only keeps
  the open question and, later, the answer.
- Per-backend mechanics (file formats, the index line, the MCP field hand-off) →
  [backends.md](backends.md).
