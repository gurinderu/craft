# Distributed races — the catalogue

Every class from [SKILL.md](SKILL.md), in full. Each entry has the same four parts:

- **Question**: what to ask of the changed path.
- **Answer needed**: the concrete fact that closes the question. "Probably fine" is not an answer.
- **Where**: the carrier the answer comes from. Most of these are outside the diff.
- **Finding / fix shape**: what to report when the answer is missing or wrong.

Vocabulary is Kubernetes-flavoured because that is where these bugs are most common. The questions
apply equally to any converge-to-desired-state loop: a job scheduler, a cloud-resource
provisioner, a queue consumer with retries, or a sync daemon.

## R1 — Self-triggering write

- **Question**: does this pass write the primary object's own status, conditions, annotations or
  labels? Does that write produce a watch event on the primary that re-enqueues it, earlier than
  the requeue interval the code relies on? Is the write skipped when nothing changed?
- **Answer needed**: the list of EVERY write to the primary in one pass, on every path. That
  includes the status/condition the generic driver or error path writes on every pass, on holds
  and errors too, not only the writes the diff adds. For each write: does it change a field every
  pass (`lastTransitionTime`, a "last checked" time, a message carrying a timestamp or counter)?
  Does the primary's own watch pass it through and re-enqueue before the requeue the code relies
  on? A watch with no predicate or generation filter passes every write. Is the write guarded by
  `desired != current`?
- **Where**: the watch / `owns` / predicate setup of the controller, every patch of the primary
  in the pass, and the shared status/error writer that wraps the pass.
- **Finding**: a write that always changes something (a timestamp, a counter, a "last checked"
  field) re-enqueues the object immediately. Every backoff, deadline or `requeue_after` the code
  promises then becomes a hot loop. The fix is to guard the write on a real change, or to keep
  the moving value out of the watched object.

## R2 — Wake source

- **Question**: for every outcome the requeue/error policy can return (`requeue_after(d)`,
  `await_change`, an error mapped to backoff, an error mapped to no-requeue), what event or timer
  guarantees that a pass runs by the deadline the code promises (a teardown deadline, a grace
  period, a retry bound)?
- **Answer needed**: a table, one row per outcome and one column for the guaranteed wake source.
  A row whose only wake source is "something else will probably change" means the deadline is
  fiction.
- **Where**: the error → action policy, every early return in the pass, and the watches.
  `await_change` wakes only on an event that this controller actually watches.
- **Finding**: a deadline measured from a timestamp, such as "proceed after N minutes since
  deletionTimestamp", needs a timer that fires at that time. A pass that returns `await_change`
  while waiting for the deadline never wakes up to see it pass.

## R3 — Another controller's stale cache

- **Question**: a release, delete or reuse is decided from the state of an object that ANOTHER
  controller owns (its status, its finalizer, its child). Can that controller still act on an
  older view and recreate, re-bind or re-use what we just released?
- **Not this class**: our OWN cache being stale is R12. R3 is about the other controller's view.
- **Answer needed**: for EACH object another controller owns that the decision depends on
  (release, delete, label or finalizer removal), name that controller and find its
  observed-generation gate: `status.observedGeneration` vs `metadata.generation`, KubeVirt's
  `status.desiredGeneration`, an applied/desired pair, or a resourceVersion it echoes. Then ask
  whether it can still act, for example recreate a child from the OLD template, after we decided
  from its "absent/finished" state. The decision is safe only once its observed generation has
  caught up with the generation we rely on.
- **Where**: the other controller's source (same repo, vendored, or upstream such as KubeVirt or
  cert-manager) and the status fields it publishes.
- **Finding**: "X is gone / not ready / terminating, so we release Y" while X's controller has not
  observed the latest generation. On its next pass X's controller can recreate the thing Y
  protected. The fix is to gate on the other controller's observed generation, or to hold the
  protection until the other controller reports that it is done.

## R4 — Permissions

- **Question**: is every API verb on every resource the diff newly calls (get, list, watch,
  create, patch, delete, a subresource such as `/status` or `/eviction`, an API group never
  touched before) granted to the service account that runs the code?
- **Answer needed**: for each new call, the rule in the shipped role that grants it.
- **Where**: chart `templates/**/clusterrole*.y*ml` / `role*.y*ml`, the operator bundle's CSV,
  kubebuilder RBAC markers, or a cloud IAM policy. Read the manifest itself, not the code comment.
- **Finding**: a verb the role does not grant fails with 403 only in a real cluster. Unit tests
  against a mock API server pass. If the 403 lands on a delete or teardown path, the result is
  usually a finalizer that is never removed.

## R5 — Protection lifetime

- **Question**: is a protection (finalizer, dependency label, lock, hold, lease) released when the
  **intent** changes (the spec stops asking for it) while the consumer is still **using** the
  resource (a VM still running, a pod still mounted, a client still connected)?
- **Answer needed**: the event that marks end of use, and evidence that the release waits for it.
- **Where**: the release site, and the consumer's lifecycle (its controller, its status, its
  termination signal).
- **Finding**: release on spec change opens a window where the resource can be deleted under a
  live consumer. Release on end of use, or hold until the consumer is observed gone. If a hold has
  a deadline, the deadline needs a wake source (R2).

## R6 — Migration window

- **Question**: objects created before this change lack a field, label, annotation, status entry
  or finalizer the new logic relies on. What does the new code do with them, on its first pass and
  on the delete path?
- **Answer needed**: the behaviour for an object that has none of the new fields. Either a
  backfill, or a code path that treats "absent" correctly. Treating "absent" as "nothing to
  protect" or "already done" is usually wrong.
- **Where**: the CRD schema before and after, the migration or backfill code, and the
  `Option`/default handling of each new field.
- **Finding**: "absent means safe to release / safe to skip" on an object that predates the field.
  Name the field, and say what the old object looks like to the new code.

## R7 — Divergent desired state (create vs update)

- **Question**: do the create path and the update/patch path for the same object express the same
  desired state?
- **Answer needed**: the field set built by each arm, or one shared desired-object builder (or
  server-side apply) that drives both arms.
- **Where**: both arms in the diff, and the builder they call.
- **Finding**: a patch that omits fields the create sets, or a new spec field that never reaches
  the patch arm. The fix is one typed desired object.

## R8 — Partial-failure strand

- **Question**: can a step fail after the primary was mutated but before progress
  (observedGeneration / Ready / status) is recorded? Or is progress recorded even though a step
  that can fail did not succeed?
- **Answer needed**: the order of writes in the pass, and what the next pass reads after each
  possible failure.
- **Where**: the pass, read in execution order. The review workflow's `failure-windows` lens runs
  this procedure pair by pair.
- **Finding**: a transient error leaves state permanently stranded, or every requeue re-mutates
  the primary.

## R9 — Cleanup

- **Question**: does every resource created during reconcile have a delete path?
- **Answer needed**: an owner reference that works across the scope boundary (a cluster-scoped
  owner cannot own a namespaced child), a finalizer, or an explicit delete.
- **Where**: the create site, and the delete/disable path.
- **Finding**: a leaked child or external resource.

## R10 — Stale or churning status

- **Question**: is a status entry or condition cleared when its subject disappears, and written
  only when desired != current?
- **Answer needed**: the clear path, and the guard on the write.
- **Where**: every status write.
- **Finding**: a condition that stays stale forever, or a transition-time / observedGeneration that
  churns on every pass. Churn also feeds R1.

## R11 — Feature gate

- **Question**: does a disabled feature still issue API calls, or can its error abort the
  unrelated primary reconcile?
- **Answer needed**: where the gate is checked relative to the calls, and how its errors map.
- **Where**: the feature flag and the call sites behind it.
- **Finding**: a disabled path that still costs calls and permissions (R4), or that fails the
  primary reconcile.

## R12 — Read-then-write race

- **Question**: is create vs patch chosen from a possibly stale read?
- **Answer needed**: what happens on 409/AlreadyExists after a create, and on 404 after a patch or
  delete.
- **Where**: the create/patch decision and its error mapping.
- **Finding**: a self-healing race becomes a persistent error-requeue loop. The fix is to treat
  409/404 as converged (or re-read) and retry, or to use server-side apply.

## R13 — Swallowed error with no timer

- **Question**: is a secondary or best-effort error swallowed (mapped to None, Ok or an early
  return) and the pass then returns no-change / await-change?
- **Answer needed**: the wake source in exactly that failure mode. A failed create leaves no
  object to watch, and a failed update or delete emits no event.
- **Where**: the swallow site and the outcome returned after it. This is R2 for the error path.
- **Finding**: silent drift that never converges. A swallowed error must schedule a bounded timed
  requeue.

## R14 — Strict decode on a shared stream

- **Question**: does a cluster-wide or shared-CRD watch use a strict decoder (required fields,
  validating types) with no decode-tolerant guard?
- **Answer needed**: what happens to the stream when one object fails to decode.
- **Where**: the watch construction and the decoded type. A filter that runs after decode does not
  help.
- **Finding**: one foreign or hand-made object stalls reconciliation for every object of that kind.
  The fix is a decode-tolerant watch, or optional/defaulted fields.

## R15 — Webhook failure policy

- **Question**: does the admission handler's error → decision mapping match the shipped
  `failurePolicy`?
- **Answer needed**: what an internal or apiserver error turns into (allowed/denied), and what the
  chart declares.
- **Where**: the handler and the chart's ValidatingWebhookConfiguration / MutatingWebhookConfiguration.
- **Finding**: a handler that denies on internal error while the chart or a comment claims
  `Ignore` / "fails open". Every CREATE/UPDATE then fails closed on a transient error.
