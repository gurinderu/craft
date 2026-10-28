# Finding classes

A class names the kind of defect, independent of the language and of the lens that found it. It
decides where to look for siblings (sweeps.md §1) and which questions the fix has to answer.

## Choosing the class

**Pick the class whose fix removes the defect.** Many defects show symptoms of several classes: a
retry that never stops (FAIL) leaves a status that says Ready (CONV) after two controllers raced
(RACE). Ask what the smallest correct change would be. If it bounds the retry, the class is FAIL;
if it makes the status follow the real state, CONV; if it fences the two writers, RACE. Name the
others in the finding's text, not in its class.

When two fixes are both needed, there are two findings.

## The classes

| Class | The defect | Typical shape |
|---|---|---|
| **CONV** | Convergence. The system does not reach, or does not report, the state it promises. | A status or condition that claims success the system has not reached; a latch or hold set on one path and never released; a loop that stops before the goal with nothing waking it again. |
| **LIFE** | Lifecycle and ownership. Something is created, held or released at the wrong time, or by the wrong owner. | A finalizer removed before the teardown it guards; a child with no owner left behind on delete; a handle closed while another path still uses it; ownership inferred from a label anyone can set. |
| **RECOV** | Recovery. An effect happens without a durable record of the intent behind it, so a crash or restart cannot finish or undo it. | An external call made before the decision is written down; a value computed in memory and persisted only by a later step that may never run; a rename that a restarted process cannot tell from an unrelated object. |
| **EXT** | External system. The code assumes a behaviour of something it does not own, and that system behaves differently. | An API that returns 200 on a no-op, an event that does not fire on update, a field whose meaning changed in the pinned version, a library default the code relies on without reading it. |
| **WIRE** | Contract between versions or parties. The shape on the wire or on disk does not match what the other side reads. | A schema field removed or narrowed; patch semantics that replace a list where a merge was meant; a renamed key; old and new replicas disagreeing during a rollout. |
| **RACE** | Interleaving. Two actors (threads, processes, controllers, requests) can order their steps so the result is wrong. | A check and an act on a stale read; a write with no version or identity fence; a dependency scan done once before a concurrent create. |
| **FAIL** | Failure handling. An error is lost, misread, or retried without a bound. | A swallowed error; an error arm that skips the cleanup the success arm does; a failed write treated as done; a retry with no limit, or a limit that one error path forgets. |
| **TEST** | A behaviour that matters has no test that would fail if it broke. | A new branch or error contract with no test; a test whose assertion holds whatever the code does. Rate it by the defect it would catch (severity.md). |
| **DOCS** | A comment, doc, message or name says something the code does not do. | A stale paragraph above a changed function; a doc contract the new caller does not meet. Rate it by what a reader will do on the false claim (sweeps.md §5). |
| **MAINT** | Structure. The code works but is harder to change than it needs to be. | A special case spliced into a shared flow; duplication; a needless abstraction; a file grown past easy reading. Optional unless a harm is named. |

## Relation to other catalogues

The language rubrics and the specific catalogues keep their own rule IDs. A finding can carry such
an ID and still have a class: a `distributed-races` R1 self-triggering write is usually RACE or
CONV, a `compatibility` C-class is WIRE, a language's missing-test rule is TEST. The class is what
the sibling sweep groups by; the rule ID is what makes the finding addressable.
