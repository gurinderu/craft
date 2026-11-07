# Sweeps — search moves a lens runs before it stops

A lens that finds one defect has found a class of defect. These moves turn that one place into the
set of places the class could live in, and turn a judgement of a changed line into a judgement of
the code around it.

## 1. Sibling sweep

A finding of the same class at another place is **not a repeat**. Earlier rounds and other lenses
may have reported a class at one place; the same class at a different error arm, persisted record,
hook, code path or legacy cohort is a new finding.

1. For each class you have a finding in (classes.md) — yours or one listed as already found — build
   the table of places the class can occur in this change: every error arm beside the success arm,
   every record written in the same pass, every hook or handler registered alongside, every path
   (create, update, delete, recover), every cohort of old objects the new code meets.
2. Mark the rows a finding already covers.
3. Report every uncovered row where the defect holds, each as its own finding at its own place.

The same place reported again is a repeat; drop it. Another place of the same class is not.

## 2. Early-exit diff

Early exits are where maintenance gets skipped.

1. List every early return, hold, refusal, skip and degraded hook the changed code has — `return`
   before the end, a "not ready, requeue", a guard that refuses, a feature flag that turns a step off.
2. For each, list the maintenance steps the full path runs after that point: status updates, latch
   releases, cleanup, metrics, recorded progress, scheduled wake-ups.
3. Diff the two lists. Each step the early exit skips is a question: what state does skipping it
   leave, and does that state wedge (nothing will ever move it) or drift (it slowly diverges)?
4. Report each skipped step that wedges or drifts, naming the state.

## 3. Attribution check

Code that reconstructs ownership, membership or a hold from observed state — a label, a name
prefix, an annotation, a matching field — must not claim objects that are not its own.

- Name an unrelated object that satisfies the same match: another release's object with the same
  label, a user-created resource with the same prefix, a previous incarnation with the same name.
  If you can name one, the match is too wide; report what the code then does to it.
- Evidence captured from one incarnation of an object (a status, a recorded id, a cached value) must
  be fenced to that incarnation's unique id before it is merged into a later one. A same-named
  object recreated after a delete is a different object.

## 4. Context before judgment

Judge a changed function only after reading:

- its **call sites** and the arguments they actually pass, including the values the diff never
  shows (defaults, flags, empty collections);
- the **bodies of the helpers** it calls, including their no-op and early-return branches — a
  helper that silently does nothing under some input changes what the caller does;
- the **readers of each persisted field** it writes, in other modules, binaries or packages too: a
  status field, a database column, a file, a message.

A finding that depends on any of these cites the place it read. A judgement made without them is a
guess about the diff, and is reported as open, not as fact.

## 5. Consequence of a false claim

When a comment, doc, name, log line or test name claims something false, the finding is not the
text. State the behaviour that follows from someone trusting it — the next caller that relies on
the documented guarantee, the operator who reads the status, the test that passes while the
behaviour is broken — and rate the finding by that behaviour (severity.md). If nobody acts on the
claim, it is a DOCS finding at the optional level.
