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
  optional/default handling of each new field.
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
  An error that is handled but mapped to await-change is R16.
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

## R16 - Retry bound lost on an error path

- **Question**: when a step on the error path fails (a `PatchStatus` / status write, a
  `Context` or lookup error, a failed API call), does the pass still end in a bounded, timed
  retry? Or does it return `await_change` (an `AwaitChange` requeue, a `None` / no-requeue
  action) and wait for a change only another actor can make?
- **Not this class**: an error that is swallowed and never surfaces is R13. R16 is the error that
  IS handled, but whose handling drops the retry bound the happy path had.
- **Answer needed**: for EVERY error arm in the pass, the requeue it produces and the wake source
  behind it. Pay special attention to errors raised while writing the status that would have
  recorded the failure: the status write failed, so no status event fires either. "The object
  will change eventually" is not a wake source.
- **Where**: the error -> action policy (`error_policy`, the reconcile's `Result` mapping, every
  `?` inside the pass), each `await_change` / no-requeue return, and the watches that could wake
  it (R2).
- **Finding**: name the error, the arm that maps it to await-change, and the actor whose change
  the object now waits for. The object stalls forever when nothing else touches it. The fix is a
  bounded `requeue_after` (with backoff) on every error arm, the status-write failure included.

## R17 - Hold or requeue only an unwatched object can clear

- **Question**: the pass holds (a finalizer, a hold condition, a "waiting for X" status, a
  deferred delete) or requeues until some other object reaches a state. Does this controller
  watch that other object, so that its change re-enqueues the waiting one?
- **Answer needed**: for each hold or wait, the object whose state releases it, and the watch /
  `owns` / `watches` mapping that maps a change of that object back to the waiting primary. If
  there is no such watch, the timer that re-checks it instead, with its period.
- **Where**: the hold site and its release condition, the controller's watch setup (including the
  mapper that turns the other object's event into the primary's key), and the requeue it returns.
- **Finding**: a hold whose only release is a change on an object the controller does not watch
  (a KubeVirt VMI, a kube-ovn IP or subnet, a pod of another operator) plus `await_change`. The
  hold clears only by accident, when something unrelated re-enqueues the primary. The fix is a
  watch with a mapper to the waiting object, or a bounded timed requeue while held.

## R18 - Status written from a cached snapshot without a version fence

- **Question**: is a status (or any) write built from an object read out of a reflector / informer
  cache and sent as a full replace or merge patch with no `resourceVersion` precondition? Can
  another writer (another controller, a second replica, the same controller's earlier pass) have
  written the same object since the snapshot was taken?
- **Not this class**: R12 is choosing create vs patch from a stale read. R18 is the write itself
  overwriting fields a concurrent writer just set.
- **Answer needed**: for each write, its patch type (replace, JSON merge, strategic merge,
  server-side apply with field manager), whether it carries `metadata.resourceVersion` as an
  optimistic-concurrency fence, and which fields other writers own on that object.
- **Where**: the write call and the object it is built from (the reflector store / cached `Arc`
  vs a fresh GET), and the other writers of the same object (its status conditions often have
  several authors).
- **Finding**: a write from a cached snapshot with no resourceVersion fence silently reverts a
  concurrent writer's fields (a condition, a list entry, an annotation). The fix is a
  resourceVersion-fenced replace that re-reads and retries on 409, a patch that names only this
  controller's fields, or server-side apply with its own field manager.

## R19 - No identity fence between selecting and mutating

- **Question**: the pass selects an object by name (a lookup, a list filter, a label selector, a
  name derived from the primary) and later mutates or deletes it. Can that object be deleted and
  recreated with the same name between the selection and the mutation, so the mutation lands on
  a different object?
- **Answer needed**: whether the mutation is fenced on the identity that was selected:
  `metadata.uid` as a delete precondition (`Preconditions { uid }`), the `uid` in an owner
  reference that is checked before acting, or a `resourceVersion` precondition. Name the window
  (an await, a requeue, a second pass) between selection and mutation.
- **Where**: the selection site, every later write by name to the selected object, and the
  delete / patch parameters (preconditions).
- **Finding**: a delete, finalizer removal or patch by name only, after a window in which the
  object can be recreated. A new object with the same name gets the mutation meant for the old
  one: its finalizer stripped, its data deleted, its status overwritten. The fix is a UID
  precondition on the write, or a re-check of the UID immediately before it.

## R20 - Unverified claim about an external system

- **Question**: does the code (or its comment, or the PR text) rely on a claim about how an
  external system behaves: the API server (ordering, defaulting, what a field means, when an
  event fires), KubeVirt (when a VMI is recreated, what a status field means), kube-ovn (when an
  IP is released, how a subnet behaves), a cloud API?
- **Answer needed**: for each such claim, the pinned source of that system at the version the
  deployment runs (its `go.mod` / `Cargo.lock` / chart version), or its versioned documentation,
  with the file or section that establishes it. A claim checked only against memory, a comment or
  a different version is unverified.
- **Where**: the dependency pin (lockfile, chart, image tag) for the version, then that system's
  source or docs at that version.
- **Finding**: name the claim, where the code relies on it, and that it was not checked against
  the pinned source. Report it as an open finding even when it might be true: a wrong claim
  about the external system turns every other answer in this catalogue into fiction.

## Severity floor

A finding on a deletion or recovery path (finalizer removal, teardown, a delete handler,
crash or partial-failure recovery, an error / retry path) is at least **Medium**. These are the
paths that run rarely, that tests exercise least, and where a defect strands or destroys state.
Severity calibration never demotes one to Low.
