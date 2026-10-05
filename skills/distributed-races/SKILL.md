---
name: distributed-races
description: >-
  Correctness of controllers, reconcile loops and retry loops in any language — the questions a review must answer about state that other actors read and write concurrently: self-triggering status writes, what wakes the loop at the deadline it promises, another controller acting on a stale cache, permissions for new API verbs, protection released on spec change instead of end of use, objects created before the change, idempotent create/patch, cleanup on delete. Use when reviewing or writing a Kubernetes operator/controller, a reconcile or requeue path, a finalizer, a watch, an admission webhook, or any converge-to-desired-state loop. Language-agnostic. Triggers: reconcile, controller, operator, requeue, finalizer, watch, informer, observedGeneration, eventual consistency, race between controllers.
---

# Distributed races — controller and reconcile-loop correctness

A reconcile loop is correct only if it converges from **every** state another actor can leave
behind: a crashed earlier pass, a second controller with an older view, a watch that never fires,
an object written by last month's version of the code. The bug is almost never on the changed line;
it is in an interleaving the author did not play out. This skill is a list of **questions**, each
with the answer a reviewer must produce and where that answer lives. A question you cannot answer
from evidence is a finding to raise as open, not a pass.

## How to work it

```
1. MAP     — name the primary object, every secondary/child it writes, every object it READS that
             another controller owns, and the requeue/error outcomes the pass can return.
2. ASK     — run each class below against that map. Skip a class only by saying why it cannot apply.
3. SOURCE  — answer from the carrier named in "where", not from comments or the PR text.
4. REPORT  — a finding names the interleaving or the request order that produces the bad state,
             and says what it does NOT establish (live behaviour, actual data loss).
```

## The classes

Each class: **question → the answer needed → where to get it.** Full wording, examples and the
fix shape for every class are in [catalogue.md](catalogue.md).

| # | Class | The question |
|---|---|---|
| R1 | Self-triggering write | Does this pass write the primary's own status/conditions/annotations, and does that write fire the primary's own watch and re-enqueue it sooner than the requeue the code relies on? Is the write skipped when nothing changed? |
| R2 | Wake source | For every outcome the requeue/error policy can return (await-change included), what event or timer guarantees a pass by the deadline the code promises? |
| R3 | Foreign stale cache | A release/delete decided from an object another controller owns — can that controller act on a stale view (its observed/desired generation vs `generation`) and recreate or re-use what we released? |
| R4 | Permissions | Is every API verb and resource the diff newly calls granted in the shipped Role/ClusterRole/chart/IAM policy? |
| R5 | Protection lifetime | Is a finalizer/label/lock/hold released on a change of **intent** (spec) when the consumer outlives the spec and the release must wait for **end of use**? |
| R6 | Migration window | Objects created before this change lack a field/label/status the new logic relies on — what does the new code do with them? |
| R7 | Divergent desired state | Do the create path and the update/patch path express the same desired object? |
| R8 | Partial-failure strand | Is progress (observedGeneration/Ready/status) recorded around a step that can fail so a transient error strands state or re-mutates the primary every pass? |
| R9 | Cleanup | Does every resource created during reconcile have a delete path (owner reference that works across the scope boundary, finalizer, or explicit delete)? |
| R10 | Stale or churning status | Is a status/condition cleared when its subject disappears, and written only when desired != current? |
| R11 | Feature gate | Does a disabled path still call the API, or can its error abort the unrelated primary reconcile? |
| R12 | Read-then-write race | Is create/patch chosen off a stale read with no tolerance for 409/AlreadyExists or 404? |
| R13 | Swallowed error, no timer | Is a secondary error swallowed and the pass returns await-change while no watch event will fire in that failure mode? |
| R14 | Strict decode on a shared stream | Can one undecodable object on a shared/cluster-wide watch stall the stream for every object? |
| R15 | Webhook failure policy | Does the admission handler's error→decision mapping match the shipped `failurePolicy`? |

R1–R6 are the classes reviews miss most: they need a source **outside the diff** (the watch setup,
the requeue table, the other controller's code, the RBAC manifest, data already in the cluster).
Read that source; the diff alone cannot answer them.

## Where answers live

| Answer | Carrier |
|---|---|
| What triggers a pass | the controller's watch/owns/predicate setup, generation-change filters |
| What a pass may return | the error → requeue policy table, every early return |
| What another controller does | that controller's source (same repo or vendored), its status fields |
| What the controller may call | Role/ClusterRole templates in the chart, operator bundle, IAM policy |
| What exists already | CRD schema history, the migration/backfill code, a release note |
| What happened on a real cluster | an integration/e2e trace, controller logs — the only carrier for "it works" |

## Relation to other skills

The language-specific idioms (client libraries, typed errors, watch APIs) live in the language
skills — for Rust, `rust-cloud-native` and the `REC-*` rules in `rust-review`. Durability windows
between two writes of one pass are the `failure-windows` lens of the review workflow.
