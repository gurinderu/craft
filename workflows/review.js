export const meta = {
  name: 'review',
  description: 'Elastic deep review of a diff — auto-detects the language(s) touched, scout-scaled lens fan-out, loop-until-dry, tool-grounded seed findings, adversarial + self-verification, synthesized into one Confirmed/Suspected report with a verdict. Rust and Nix profiles built in.',
  whenToUse: 'The single review path for any diff/PR before commit or merge. Auto-detects language; pin with args.languages (e.g. ["rust"] or ["nix"]). Scales depth to the diff automatically.',
  phases: [
    { title: 'Scout', detail: 'resolve the diff base, detect language(s), classify size/categories, pick lenses + rigor', model: 'haiku' },
    { title: 'Gate', detail: 'per-language CI-aware mechanical gate + tool-grounded seed findings' },
    { title: 'Lenses', detail: 'parallel per-lens review with context expansion; loop-until-dry' },
    { title: 'Verify', detail: 'cross-lens dedup, then adversarial refutation + self-verification of each finding' },
    { title: 'Synthesize', detail: 'calibrate severities, completeness critic, one merged report' },
  ],
}

// ---- args ----
const baseArg = (args && typeof args === 'object' && args.base) ? String(args.base) : ''
const intentArg = (args && typeof args === 'object' && args.intent) ? String(args.intent) : ''
const postComments = !!(args && typeof args === 'object' && args.comment)
const pathArg = (args && typeof args === 'object' && args.path) ? String(args.path) : ''   // optional crate-scope (audit per-crate fan-out)
const viaArg = (args && typeof args === 'object' && args._via) ? String(args._via) : ''   // set by a parent workflow (e.g. rust-audit)
const strict = !!(args && typeof args === 'object' && args.strict)   // harsh maintainability mode: confirmed maintainability findings become presumptive blockers
const requestedLangs = (args && typeof args === 'object' && Array.isArray(args.languages) && args.languages.length)
  ? args.languages.map(String) : null   // pin: restrict active profiles to these ids
const freshArg = !!(args && typeof args === 'object' && args.fresh)   // force a full first-pass review, ignore any prior round

// ================= language profiles (inline registry — the sandbox can't import, so profiles live here) =================
function rustDepContext(ctx) {
  return `8. **Dependency context** — review against the crate versions the project ACTUALLY pins, not against crates-in-the-abstract. Resolve them: \`cargo metadata --format-version 1\` (or read \`Cargo.lock\`) and match the external crates the changed files \`use\` to their locked versions. For any nontrivial dependency the diff touches, check whether the usage is correct *for that pinned version* — a since-deprecated/removed/renamed API, a changed default, a known footgun of that exact version. Consult context7 for the crate's version-specific docs instead of trusting memory. Turn a genuine version-specific misuse into a seed finding (source "dep-context", severity Medium, ruleId "DEP-001"). Known-vulnerable versions are already covered by \`cargo audit\` (ruleId "DEP-002") — do not duplicate. Best-effort: skip silently if \`cargo metadata\` fails or the diff touches no external crate.`
}
function rustGate(ctx) {
  return `You are establishing the mechanical gate for a Rust review, CI-aware, and collecting tool-grounded seed findings. Diff base: ${ctx.baseRef ? `\`${ctx.baseRef}\`` : 'uncommitted changes / most recent commit'}.

GATE (CI-aware, per the rust-review skill — load it):
1. Detect a PR + CI: \`gh pr checks --json name,state,bucket,link\` for the current branch. If gh is missing/unauthenticated/offline or no PR is found, fall through to the local gate.
2. For build/test/clippy/fmt: if a conclusive green required CI check covers it, treat it as PASSED and record provenance "via CI #<n>"; if any such check FAILED, set status=fail and list it in failedChecks. If pending/absent, run it locally (\`cargo fmt --check\`, \`cargo clippy --all-targets -- -D warnings\`, \`cargo test\`).
3. Security tools (\`cargo audit\`, \`cargo deny check\`) always run locally if installed (cheap, usually absent from CI). A vulnerability with a fix is a fail.
4. status = fail if any of fmt/clippy/test/build is red (CI or local); pass if all green; unknown if you could not establish it.

SEED FINDINGS (tool grounding — beyond the gate, scoped to the changed crates):
5. \`cargo clippy --all-targets -- -W clippy::pedantic -W clippy::nursery\` — turn each NEW pedantic/nursery diagnostic on changed lines into a seed finding (severity Low/Medium, source "clippy-pedantic"). Do not fail the gate on these.
${ctx.isLibrary ? '6. This is a library: run `cargo semver-checks check-release` if installed; each reported break is a seed finding (severity High, source "semver-checks"). If not installed, log and skip.' : '6. Not a library — skip semver-checks.'}

7. SAST seed (semgrep) — decide what configs apply, then run only if any do:
   - If a \`./semgrep/\` rules dir exists in the repo, ALWAYS include \`--config=./semgrep/\` (repo-specific banned-API/taint rules — the whole point of keeping them in-repo).
${ctx.securitySensitive
    ? '   - This diff IS security-sensitive: also include `--config=p/rust --config=p/secrets`.'
    : '   - This diff is NOT security-sensitive: do not pull the generic rulesets; rely on `./semgrep/` only (skip step 7 entirely if that dir is absent).'}
   If at least one config applies and \`semgrep\` is installed, scope it to the changed Rust files (\`git diff --name-only ${ctx.baseRef ? `--merge-base ${ctx.baseRef}` : 'HEAD'} -- '*.rs'\`) and run \`semgrep --error <configs> <files>\`. Turn each result into a seed finding (source "semgrep"; map semgrep ERROR→High, WARNING→Medium, INFO→Low). These are SEEDS, never gate failures — semgrep taint/secrets over-reports, and downstream verification refutes the false positives. If semgrep is absent or no config applies, log and skip.

${rustDepContext(ctx)}

EVIDENCE RULE: report a check as pass/fail ONLY if you ran it yourself (quote the command and its exit status / decisive output line in notes) or saw it conclusively green/red in CI (cite the check name). Never infer a pass. If the changed files are not part of a cargo project, do NOT fabricate a temporary crate/harness around them to lint or build — record build/clippy/test as not establishable (status=unknown) and say why in notes.

Set provenance to a one-line summary like "clippy/test via CI #123; fmt/audit/deny local". Put gate failures in failedChecks (NOT seedFindings). Seed findings come from clippy-pedantic / semver / semgrep / dep-context only. On every seed finding set \`ruleId\` to the matching rust-review rules.md catalog ID (e.g. "DEP-001") or "" if none fits.`
}
function nixDepContext(ctx) {
  return `6. **Dependency context** — review against the flake inputs the project ACTUALLY pins. Resolve them from \`flake.lock\` (the locked \`rev\`/\`narHash\` per input). Flag inputs that are unpinned, channel-based (\`<nixpkgs>\`), or floating where they should be locked, and \`inputs.*.follows\` that should dedupe nixpkgs but don't (source "dep-context", severity Medium, ruleId "DEP-001"). Best-effort: skip silently if there is no flake.`
}
function nixGate(ctx) {
  return `You are establishing the mechanical gate for a Nix review and collecting tool-grounded seed findings. Diff base: ${ctx.baseRef ? `\`${ctx.baseRef}\`` : 'uncommitted changes / most recent commit'}.

GATE (per the nix-review skill — load it):
1. If a \`flake.nix\` exists: \`nix flake check\` — a failure is a gate failure (list it in failedChecks), not a seed.
2. Formatter: run \`alejandra --check .\` or \`nixpkgs-fmt --check\` (whichever the repo uses — check for a formatter in the flake / a treefmt config). Mismatches are seeds (source "fmt", Low), never a gate failure unless CI enforces fmt.
3. \`nix eval\`/\`nix build\` the attrs the diff touches — an eval or build error on changed code is a gate failure.
4. status = fail if \`nix flake check\` or an eval/build of touched attrs is red; pass if green; unknown if you could not establish it (e.g. nix not installed).

SEED FINDINGS (tool grounding — scoped to the changed files):
5. Linters — \`statix check\` (anti-idioms) and \`deadnix\` (dead bindings) on the changed \`.nix\` files. Turn each diagnostic on changed lines into a seed finding (source "statix"/"deadnix", severity Low/Medium, ruleId "MNT-001"). Do not fail the gate on these. If a linter is absent, log and skip.

${nixDepContext(ctx)}

EVIDENCE RULE: report a check as pass/fail ONLY if you ran it yourself (quote the command and its exit status / decisive output line in notes) or saw it conclusively green/red in CI. Never infer a pass; a tool you could not run is "skipped" in notes, never a pass.

Set provenance to a one-line summary like "nix flake check pass; statix/deadnix local". Put gate failures in failedChecks (NOT seedFindings). Seed findings come from statix / deadnix / fmt / dep-context only. On every seed finding set \`ruleId\` to the matching nix-review rules.md catalog ID (e.g. "MNT-001") or "" if none fits.`
}

const PROFILES = {}
PROFILES.rust = {
  id: 'rust',
  lang: 'Rust',
  detect: (files) => files.some(f => /\.rs$/.test(f) || /(^|\/)Cargo\.toml$/.test(f)),
  diffGlobs: ["'*.rs'"],
  rubricSkill: 'rust-review',
  navSkill: 'rust-navigation',
  reviewerAgent: 'craft:rust-reviewer',
  securityHints: 'auth, crypto, input parsing, unsafe, FFI, or dependencies',
  usesLibrary: true,
  alwaysLenses: ['intent'],
  safetyLens: 'safety',
  scoutRules: `Decide what is "in play" from the diff: unsafe → ownership+safety; async/threads → concurrency; SQL/untrusted input → safety; loops/collections → performance; changed \`pub\` surface → api-idioms; a changed HTTP-framework handler / route, an error enum or its IntoResponse (error→HTTP-status) mapping, an OpenAPI/response-annotation, or a repository error-mapping the handlers surface → api-boundary (web-service diffs only — pick it when the diff touches the api/handler layer or the error-to-status plumbing); new/changed tests → tests; new branching / growing files / large refactor → maintainability; a changed operation on a domain entity that carries a status/lifecycle field, soft-delete, scoped foreign keys, or a documented derived/effective quantity → invariants (pick it for any medium-or-larger diff touching the domain/application/infrastructure layers); a changed reconcile loop / controller / operator (a reconcile or requeue fn, a status or condition update, a create-or-patch of a child/external resource, a finalizer or delete path), a changed typed watch / secondary-watch setup (a `watcher`/`Controller::watches`/`secondary_watches`/object-mapper), or a changed admission / validating-webhook handler → reconciler (pick it whenever the diff touches a controller/reconcile loop, a retry / idempotent-apply flow, a Kubernetes typed watch, or an admission webhook — this lens reads the Helm chart's webhook `failurePolicy` and CRD schemas, not just the Rust); a changed serde attribute / renamed-or-retagged field or enum variant / added non-defaulted field on a type that is persisted (JSONB, blob, cache, event log, message payload) or sent over the wire, or a migration renaming/retyping a column the code (de)serializes → compat (pick it whenever the diff changes an at-rest or on-the-wire representation of data that other versions of the code read). ('intent' is enforced by the engine and added automatically — do not count it toward your choices.)`,
  gate: rustGate,
  depContext: rustDepContext,
  lenses: ['safety', 'errors', 'ownership', 'concurrency', 'performance', 'api-idioms', 'api-boundary', 'reconciler', 'compat', 'maintainability', 'tests', 'intent', 'invariants'],
  lensBrief: {
    safety: 'safety / injection / secrets: unwrap/expect/panic on reachable paths, unsafe without SAFETY, SQL/command injection, path traversal, hardcoded secrets, unbounded deserialization.',
    errors: 'error handling: recoverable failures handled with panic/unwrap, dropped #[must_use]/error values, Result-vs-panic, typed-error-vs-anyhow at API boundaries.',
    ownership: 'ownership & lifetimes: needless clone to satisfy the borrow checker, String where &str/impl AsRef suffices, Vec<T> where &[T] works, explicit lifetimes where elision applies.',
    concurrency: 'concurrency / async: blocking calls inside async, lock held across .await, unbounded channels, inconsistent lock order (deadlock), missing Send/Sync.',
    performance: 'performance: allocation in hot loops, to_string/to_owned where a borrow works, Vec::new+push where size is known, N+1 / repeated work in loops.',
    'api-idioms': 'API shape & public-surface idioms — spend the budget on impactful breaks, not per-item completeness nits. HIGH-VALUE (surface individually): public-API guideline breaks (API-006) — an unsealed trait meant to be closed, a private/unstable type or dependency leaked through a `pub` signature, an owned String/Vec/PathBuf parameter where &str/&[T]/&Path fits, a public enum/error without #[non_exhaustive], missing common-trait impls (Debug/Clone); a wildcard `_ =>` on a business enum that silently swallows new variants (API-002); a library leaking Box<dyn Error>/anyhow at its boundary (ERR-003). LOW-VALUE (do NOT file one finding per occurrence): missing `///` on a pub item (API-003), #[allow] without a justifying comment (API-004), crate-root #![deny(warnings)] (API-005), oversized fn / deep nesting (API-001) — roll repeated instances of each into ONE finding that names the pattern with a representative file:line, and raise an individual one only when it sits on a genuinely public library API, the doc is wrong or misleading (not merely absent), or the #[allow] hides a real defect.',
    'api-boundary': 'API boundary correctness for web services: trace every error the changed service/repository can produce to the HTTP status the handler actually returns. A domain Conflict / AlreadyExists / unique-violation / not-found (an empty fetch_one / zero-row / RowNotFound) that collapses into a generic 500 — because a broad `#[from]` on the error enum folds it into a catch-all variant, or a blanket DbError→500 in IntoResponse swallows it — instead of surfacing 409/400/404 is a finding. Method: walk the error enum `#[from]`/`From` chains and the IntoResponse/handler match arms; where the service intends a distinct typed status (a Conflict variant meaning 409, a validation error meaning 400, a not-found meaning 404) confirm a matching arm actually maps it, and flag any typed 4xx that has no variant to land in or that a `#[from]` merges into a generic error before the boundary sees it. Also OpenAPI/utoipa completeness: does the handler annotation (e.g. #[utoipa::path] responses(...)) list EVERY status the handler can actually return — cross-check the statuses the code produces (especially 404/409/400) against the documented response set, and flag any the code returns but the responses(...) omits.',
    reconciler: 'reconciler / eventual-consistency correctness for controllers and retry loops (load the rust-cloud-native skill for the idioms): a reconcile must be idempotent and safe to re-run after a partial failure. Trace the changed reconcile/requeue path and the child/secondary resources it manages. Flag where (a) a create-path and an update/patch-path for the SAME object express DIFFERENT desired state (a patch omits fields the create sets, or a new spec field never reaches the patch arm) instead of building one typed desired object (or server-side apply) that drives both arms; (b) a secondary/child step whose error is propagated AFTER the primary object was mutated but BEFORE progress is recorded (observed-generation / Ready / status) — so a transient error permanently strands state and every requeue re-mutates the primary; (c) a resource created during reconcile has NO cleanup on the delete/disable path — no owner-reference, or one that cannot work across a scope boundary (a cluster-scoped owner with a namespaced child) and no finalizer or explicit delete — leaking it; (d) a status or condition is only ever upserted and never cleared when its subject disappears (stale forever), or is written unconditionally every pass (churning transition-time / observed-generation) instead of guarding on desired != current; (e) a feature-gated path still issues API calls when the feature is disabled, or its error aborts the unrelated primary reconcile; (f) create/patch is chosen off a stale read (read-then-write TOCTOU) with no tolerance for the self-healing race — a 409 / AlreadyExists on create or a 404 on patch/delete becomes a persistent error-requeue loop; (g) a transient error on a secondary/best-effort step is SWALLOWED (mapped to None / Ok / an early return) to protect the primary reconcile, but the pass then returns a no-change / await-event outcome with NO timed requeue — and in exactly that failure mode no watch event fires either (a failed create leaves no object to watch; a failed update/delete emits no event), so an object with no further spec churn never converges the secondary state and the drift is silent. Any swallowed reconcile error must schedule a bounded timed requeue (or surface an explicit needs-requeue outcome), not rely on a watch that will not fire; (h) a cluster-wide or SHARED-CRD typed watch/list uses a strict deserialize (a validating Deserialize, required-without-#[serde(default)] fields, a newtype that rejects apiserver-admissible values) with NO decode-tolerant guard on the stream — one non-conforming object in the store (a hand-made resource, or a foreign object on a CRD this controller co-owns with another operator or with admin-created resources) fails client-side decode on the STREAM and a single decode error on the shared stream can stall reconciliation for EVERY object of that kind, not just the bad one. Any annotation/label filter that runs AFTER deserialization does not help — the decode already broke the stream. Flag it; the fix is a decode-tolerant watch (skip or dead-letter a single undecodable object instead of failing the whole stream) or #[serde(default)]/Option on fields the shared CRD does not require. (Controllers with an admission/validating webhook: cross-check the webhook handler error→decision mapping against the chart ValidatingWebhookConfiguration failurePolicy — a handler that turns Internal/apiserver-error into allowed=false while a code comment or the shipped chart claims failurePolicy: Ignore / "fails open" is a fail-open-vs-fail-closed contradiction: every CREATE/UPDATE then hard-depends on that call and fails CLOSED on a transient hiccup. Read the chart YAML, do not trust the comment.)',
    maintainability: 'maintainability & structural simplification (load the refactoring skill): missed code judo — a behavior-preserving reframing using the existing architecture that would make this change dramatically simpler or delete a whole category of complexity; file pushed across ~700 lines (decomposition smell); ad-hoc conditional / one-off branch / scattered special-case spliced into an unrelated or shared flow instead of a dedicated abstraction; needless optionality (Option that always holds), as-casts where From/TryFrom belongs, Box<dyn Any>/downcasting where a typed model fits. Flag only concrete, behavior-preserving restructurings the author could have taken — not hypothetical rewrites.',
    tests: 'tests as a COVERAGE ADVERSARY (not a presence check): enumerate what a regression could SILENTLY break, then check each has a test that would FAIL on that regression. The litmus test: if you deleted the production line/branch that carries a contract, would the suite still pass green? If yes, that contract is UNTESTED → finding (cite the missing test). Cover, at minimum: (a) every NEW branch and every distinct ERROR CONTRACT the code / handler / OpenAPI (or other documented interface) promises — not-found→404, forbidden / wrong-owner, bad-request→400, conflict→409, a typed 4xx that must not collapse into a 500 — each needs a test asserting THAT status/error, not just the happy path; (b) every SECURITY / AUTHORIZATION boundary — tenant or owner isolation: is there a test exercising a DIFFERENT user/tenant/scope and ASSERTING denial? A single-user happy path does NOT prove isolation; on a NEW authz-guarded endpoint a missing cross-tenant/cross-owner denial test is a HIGH-severity gap; (c) every behavioral CLAIM in the stated spec — identity preserved / "in place", a state that must stay put or transition exactly once, a field that must be scrubbed, an idempotent no-op — each needs a test that pins it and would fail if the claim were violated; (d) self-exclusion / dedup / unlink / bookkeeping guards — a uniqueness check that must exclude the row itself, a back-reference that must be cleared. Vacuous tests (assert!(true), no assertions) count as absent coverage.',
    intent: 'intent / spec conformance: does the change actually do what it is supposed to do? Work from the STATED SPEC / AUTHOR CLAIMS block (the verbatim PR/commit description), not just the one-line inferred intent. ENUMERATE every explicit claim or invariant the author wrote — patterns like "never fails on X", "the only way to Y", "idempotent" / "no-op", "in place" / "preserves Z", "always" / "never", and any documented trade-off — and for EACH claim trace the concrete code path that would carry it out. A claim the code contradicts is a finding (cite the exact file:line that violates it): e.g. an "idempotent no-op" that actually wipes a field, "the only way to change X" that silently no-ops for some inputs, "never fails on X" that returns Err on a transient/non-NotFound error. Also flag correct-looking code with wrong behavior, missed requirements, off-by-one against the spec.',
    invariants: 'domain invariants & lifecycle: before judging a changed operation, read the invariants documented or enforced on the TYPES it manipulates (grep the domain/entity/service modules for doc-comment invariants, status/state enums, `effective_*` / derived getters, `*_scoped` reference ids, validation fns, and transient two-phase lifecycle states — a pending-delete/soft-delete window or an in-progress-mutation state). Flag where the change (a) accepts an entity in a transient/invalid lifecycle state, (b) crosses a scope boundary (a tenant/project/network/address-range) without re-validating or re-deriving the scoped references it carries, (c) uses a raw value where a documented derived/effective quantity is required, (d) mutates/scrubs one field but not a sibling field the same invariant governs, or (e) REIMPLEMENTS an eligibility / capacity / compatibility / authorization check that an EXISTING sibling function already performs — grep for the function doing the same job (a catalog/availability filter, a permission gate, a `*_available` / `filter_*` / `*_has_room` predicate) and diff the new path against it DIMENSION BY DIMENSION; flag any FAIL-CLOSED dimension the sibling enforces but the new path drops (a hardware/family/version compatibility filter, a missing-data→unavailable rule, an overcommit/effective-quantity conversion), because the two gates disagree the moment one is missing a dimension — that is a present correctness bug, not merely future drift.',
    compat: 'serialization, persistence & rolling-deploy compatibility: a changed on-the-wire or at-rest representation checked against data written by OTHER versions of the code. Trace every type whose serde/JSON/proto/bincode representation the diff changes — a #[serde(rename)] / field rename / retag / flatten change, a field added without #[serde(default)], a renamed or reordered enum variant, a changed discriminant / repr, a Display/FromStr used as a storage key — AND every place that representation is persisted (JSONB or blob columns, caches, event logs, message-queue payloads, config/state files) or crosses a version boundary. Flag where (a) already-persisted data written under the OLD shape can no longer deserialize under the new shape and no migration backfills it (a rename with no #[serde(alias)], a new required field with no default) — every stored row fails to decode until rewritten; (b) during a ROLLING deploy old and new replicas run CONCURRENTLY, so the representation must be compatible in BOTH directions — new writers must still emit what old readers require (a bare rename breaks old readers: keep the serialized key stable via #[serde(rename = "<old-key>")] on the renamed Rust field, or split the flip across two deploys where all readers understand both keys before any writer flips) AND old writers must emit what new readers accept; (c) a DB migration renames/retypes a column or enum the running code still (de)serializes under the old contract. NOTE: an #[serde(alias = "<old>")] only covers new-code-reads-old-data — it does NOT make old code read new-data during a rollout; call that asymmetry out explicitly.',
    'negative-space': 'negative space / cross-surface interaction: the bug the diff ENABLES in UNCHANGED code. A new status/type/enum-variant/column that pre-existing endpoints mutate blindly; a latent bug in an unchanged helper the diff makes reachable for the first time.',
  },
}
PROFILES.nix = {
  id: 'nix',
  lang: 'Nix',
  detect: (files) => files.some(f => /\.nix$/.test(f) || /(^|\/)flake\.lock$/.test(f)),
  diffGlobs: ["'*.nix'", "'flake.lock'"],
  rubricSkill: 'nix-review',
  navSkill: '',
  reviewerAgent: 'craft:nix-reviewer',
  securityHints: 'secrets handling (agenix/sops-nix), fetchers/hashes, module security options, or build-script interpolation',
  usesLibrary: false,
  alwaysLenses: ['intent'],
  safetyLens: 'injection',
  scoutRules: `Decide what is "in play" from the diff: derivations / fetchers / hashes → packaging+purity; flake inputs / flake.lock / IFD → reproducibility; string interpolation into build or shell scripts → injection; devShell / direnv / formatters → dev-env; NixOS or home-manager modules / options / secrets → modules; dead or anti-idiomatic Nix → maintainability. ('intent' is enforced by the engine and added automatically — do not count it toward your choices.)`,
  gate: nixGate,
  depContext: nixDepContext,
  lenses: ['purity', 'reproducibility', 'injection', 'packaging', 'dev-env', 'modules', 'maintainability', 'intent'],
  lensBrief: {
    purity: 'purity: impure builtins (currentTime/getEnv/<nixpkgs>), fetchers without a fixed hash — anything that makes a build non-reproducible (PUR-*).',
    reproducibility: 'reproducibility: unpinned/channel inputs, missing flake.lock entries, import-from-derivation (IFD), --impure reliance (REP-*).',
    injection: 'injection: untrusted values interpolated into build or shell scripts; builtins.exec (INJ-*).',
    packaging: 'packaging: mkDerivation correctness — dep hashes (cargoHash/vendorHash/npmDepsHash), builder choice, phases, meta/license (PKG-*).',
    'dev-env': 'dev-env: devShell/direnv correctness, writeShellApplication, the allowUnfree-not-propagated-to-nix-develop gotcha (DEV-*).',
    modules: 'modules: NixOS/home-manager option typing and defaults, cross-platform (Linux+Darwin), secrets kept out of the world-readable store — agenix/sops-nix (MOD-*).',
    maintainability: 'maintainability: dead code (deadnix), anti-idioms (statix), needless rec/with, over-abstraction (MNT-*).',
    intent: 'intent / spec conformance: does the change do what it should? Work from the STATED SPEC / AUTHOR CLAIMS block (the verbatim PR/commit description), not just the one-line inferred intent. ENUMERATE every explicit claim or invariant the author wrote — patterns like "never fails on X", "the only way to Y", "idempotent" / "no-op", "in place" / "preserves Z", "always" / "never", documented trade-offs — and for EACH claim trace the concrete code path that would carry it out; a claim the code contradicts is a finding (cite the exact file:line). Also flag correct-looking code with wrong behavior.',
    'negative-space': 'negative space / cross-surface interaction: the breakage the diff ENABLES in UNCHANGED Nix — a renamed option or output that existing modules/consumers still reference; a changed default that unchanged config relies on.',
  },
}

// ---- shared schemas ----
const FINDING_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['severity', 'title', 'file', 'line', 'why', 'fix', 'blastRadius', 'source', 'ruleId'],
  properties: {
    severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low', 'Info'] },
    title: { type: 'string', description: 'one-line what is wrong' },
    file: { type: 'string', description: 'path; empty string if not applicable' },
    line: { type: 'integer', description: '1-based line; 0 if not applicable' },
    why: { type: 'string', description: 'why it matters' },
    fix: { type: 'string', description: 'direction of the fix' },
    blastRadius: { type: 'string', description: 'callers affected / breaking-change note; empty if n/a' },
    source: { type: 'string', description: 'lens name or tool name that produced this' },
    ruleId: { type: 'string', description: 'catalog rule ID from the active profile\'s rules.md (e.g. "CON-003" for rust, "PUR-001" for nix) if the finding maps to one; empty string otherwise' },
    fp: { type: 'string', description: 'line-tolerant fingerprint; empty if not from a ledger' },
    symbol: { type: 'string', description: 'enclosing fn/type name; empty if unknown' },
    tier: { type: 'string', description: 'confirmed|suspected|refuted; empty if n/a' },
    disposition: { type: 'string', description: 'open|closed|rejected|justified|deferred; empty if n/a' },
  },
}

// The persisted ledger entry has its OWN shape (the 11 fields `toLedgerEntry` writes) — NOT
// FINDING_ITEM. Reusing FINDING_ITEM here would require `fix`/`blastRadius` (which the ledger omits),
// so a strict validator could reject the loader's output and null out `priorRound`, silently
// degrading a re-review to a first pass.
const LEDGER_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['fp', 'file', 'line', 'symbol', 'severity', 'tier', 'disposition', 'source', 'ruleId', 'title', 'why'],
  properties: {
    fp: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'integer' },
    symbol: { type: 'string' },
    severity: { type: 'string' },
    tier: { type: 'string' },
    disposition: { type: 'string' },
    source: { type: 'string' },
    ruleId: { type: 'string' },
    title: { type: 'string' },
    why: { type: 'string' },
  },
}

const PRIOR_ROUND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['found', 'round', 'head', 'ledger'],
  properties: {
    found: { type: 'boolean' },
    round: { type: 'integer', description: 'the prior round number; 0 when found=false' },
    head: { type: 'string', description: 'prior HEAD sha; empty when found=false' },
    ledger: { type: 'array', items: LEDGER_ITEM, description: 'prior findings with fp/symbol/tier/disposition; empty when found=false' },
  },
}

const DETECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['baseRef', 'files', 'spec', 'branch', 'head', 'notes'],
  properties: {
    baseRef: { type: 'string', description: 'git ref the diff was computed against; empty if none resolved' },
    files: { type: 'array', items: { type: 'string' }, description: 'changed file paths in the diff' },
    spec: { type: 'string', description: 'verbatim change description — the open PR title+body, else the commit messages on the diff range; truncated to ~4000 chars; empty string if none' },
    branch: { type: 'string', description: 'current git branch name; empty string if detached HEAD' },
    head: { type: 'string', description: 'current HEAD short SHA; empty string if not a git repo' },
    notes: { type: 'string', description: 'one line on what was detected' },
  },
}

const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sizeBucket', 'lenses', 'maxRounds', 'verifyVotes', 'lensModel', 'isLibrary', 'securitySensitive', 'intent', 'churn', 'notes'],
  properties: {
    sizeBucket: { type: 'string', enum: ['small', 'medium', 'large'] },
    lenses: { type: 'array', items: { type: 'string' }, description: 'subset of the profile lens catalog to run' },
    maxRounds: { type: 'integer', description: 'loop-until-dry cap: 1 for small, 2 for medium, 3 for large' },
    verifyVotes: { type: 'integer', description: 'skeptic votes for CRITICAL/HIGH findings (1 or 3); default-tier findings always get 1' },
    lensModel: { type: 'string', enum: ['sonnet', 'opus'], description: 'model for lens + verify agents' },
    isLibrary: { type: 'boolean', description: 'true if a published library (→ semver-checks); always false where not applicable' },
    securitySensitive: { type: 'boolean' },
    intent: { type: 'string', description: 'what the change should do, from the brief/args; empty if unknown' },
    churn: { type: 'array', items: { type: 'string' }, description: 'hot/often-changed files to scrutinize; may be empty' },
    notes: { type: 'string', description: 'one line on what was detected' },
  },
}

const GATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'provenance', 'failedChecks', 'seedFindings', 'notes'],
  properties: {
    status: { type: 'string', enum: ['pass', 'fail', 'unknown'] },
    provenance: { type: 'string', description: 'e.g. "build/test/clippy/fmt via CI #123; audit/deny local"' },
    failedChecks: { type: 'array', items: { type: 'string' } },
    seedFindings: { type: 'array', items: FINDING_ITEM },
    notes: { type: 'string' },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'findings'],
  properties: {
    lens: { type: 'string' },
    findings: { type: 'array', items: FINDING_ITEM },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['refuted', 'citedLineMatches', 'reachable', 'reason'],
  properties: {
    refuted: { type: 'boolean', description: 'true if the finding does not hold up' },
    citedLineMatches: { type: 'boolean', description: 'true if the cited file:line actually contains what the finding claims' },
    reachable: { type: 'boolean', description: 'true if the path is reachable in production (not test/example-only)' },
    reason: { type: 'string' },
  },
}

const CRITIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['missingLenses', 'notes'],
  properties: {
    missingLenses: { type: 'array', items: { type: 'string' }, description: 'lenses from the candidate list that should also run; empty if coverage is complete' },
    notes: { type: 'string', description: 'one line on anything else likely missed, or "coverage complete"' },
  },
}

const CHANGED_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['changed', 'reason'],
  properties: { changed: { type: 'boolean' }, reason: { type: 'string' } },
}
const ADJUDICATE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['status', 'currentLine', 'note'],
  properties: {
    status: { type: 'string', enum: ['resolved', 'still-open', 'regressed'] },
    currentLine: { type: 'integer', description: 're-located 1-based line; 0 if not found' },
    note: { type: 'string' },
  },
}

// ---- resilient agent call ----
// agent() returns null when the subagent dies on a terminal API error (after the harness's own
// retries) or is skipped. A single quiet re-dispatch recovers most API deaths. Budget-exceeded
// THROWS and is deliberately not caught — retrying it would just throw again.
const AGENT_TRIES = 2
async function ragent(prompt, opts = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await agent(prompt, attempt === 1 ? opts : { ...opts, label: `retry:${opts.label || 'agent'}` })
    if (res !== null && res !== undefined) return res
    if (attempt >= AGENT_TRIES) return null
    log(`⚠️ agent '${opts.label || '?'}' returned no result (API death or skip) — re-dispatching once`)
  }
}

// ---- run-record helpers (VERBATIM mirror of lib/run-record.mjs — the sandbox can't import; keep in sync) ----
// Mirrors: countBySeverity, summarizeFindings, reviewVerdict, indexProjection, titleShingle,
// fingerprint, shingleOverlap, matchesPrior, DISPOSITION_FROM_TRIAGE, dispositionFromTriage,
// rereviewVerdict, selectPriorRound.
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info']
function countBySeverity(findings) {
  const by = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 }
  for (const f of (Array.isArray(findings) ? findings : [])) {
    if (f && Object.prototype.hasOwnProperty.call(by, f.severity)) by[f.severity] += 1
  }
  return by
}
function summarizeFindings(findings) {
  const bySeverity = countBySeverity(findings)
  return { total: SEVERITIES.reduce((n, s) => n + bySeverity[s], 0), bySeverity }
}
function reviewVerdict(confirmed) {
  const by = countBySeverity(confirmed)
  if (by.Critical || by.High) return 'Block'
  if (by.Medium) return 'Warning'
  return 'Approve'
}
// finalVerdict is workflow-local — NOT part of the lib/run-record.mjs mirror above.
// In strict mode the maintainability bar is a presumption of block: any Confirmed
// maintainability finding at Medium or above escalates the verdict to Block. Outside strict mode
// the base verdict stands (maintainability findings are at most a Warning).
// A finding counts as maintainability for the strict escalation if its own source is maintainability
// OR a maintainability finding was merged into it during cross-lens dedup (dedupPool carries every
// contributing source in `sources`). Without the second clause a maintainability finding absorbed
// under a same-severity non-maintainability base would silently escape the strict Block.
function isMaintainability(f) {
  return (f.source || '') === 'maintainability' || (Array.isArray(f.sources) && f.sources.includes('maintainability'))
}
function finalVerdict(confirmed) {
  if (strict && confirmed.some(f => isMaintainability(f)
    && (f.severity === 'Critical' || f.severity === 'High' || f.severity === 'Medium'))) return 'Block'
  return reviewVerdict(confirmed)
}
function indexProjection(r) {
  return {
    schemaVersion: r.schemaVersion, runtime: r.runtime ?? null, ts: r.ts, kind: r.kind, name: r.name,
    project: r.project, commit: r.commit, dirty: r.dirty,
    branch: r.branch ?? null, head: r.head ?? null, round: r.round ?? 0,
    verdict: r.verdict, findingsTotal: r.findings ? r.findings.total : 0,
    nested: r.nested, via: r.via, outputTokens: r.outputTokens ?? null,
  }
}
async function logRun(record) {
  const index = indexProjection(record)
  await ragent(
    `You are the craft observability logger. Persist ONE run record to the global store \`~/.craft/runs/\`. This is mechanical IO — do not analyze.
Steps:
1. \`mkdir -p ~/.craft/runs\`.
2. Compute: TS=\`date -u +%Y-%m-%dT%H-%M-%SZ\`; PROJECT=\`pwd\`; COMMIT=\`git rev-parse --short HEAD 2>/dev/null\` (empty string if not a git repo); DIRTY=true if \`git status --porcelain\` prints anything, else false.
3. Take RECORD below, add fields {"ts":TS,"project":PROJECT,"commit":COMMIT,"dirty":DIRTY}, and write the result as pretty JSON to \`~/.craft/runs/<TS>-<kind>-<name>.json\` (kind and name are fields in RECORD).
4. Take INDEX below, add the same four fields, and append it as ONE compact line (single atomic \`>>\`) to \`~/.craft/runs/index.jsonl\`.
5. If \`~/.craft/runs/README.md\` does not exist, create it describing the store: "craft run records. index.jsonl = one compact JSON line per run (load with jq); <ts>-<kind>-<name>.json = full per-run detail. Common fields: schemaVersion, ts, kind (workflow|agent), name, project, commit, dirty, verdict, findings{total,bySeverity}, nested, via. Workflows add scout/dimensions/verification/notRun/outputTokens; agents add toolsRun." Include two jq examples: \`jq -s 'group_by(.name)[]|{name:.[0].name,runs:length}' index.jsonl\` and \`jq 'select(.verdict|test("Block"))' index.jsonl\`.
Best-effort: if anything fails, report it but do NOT error the run.

RECORD:
${JSON.stringify(record, null, 2)}

INDEX:
${JSON.stringify(index)}`,
    { label: 'log-run', phase: 'Synthesize', model: 'haiku', effort: 'low' },
  )
}

function key(f) {
  return `${(f.file || '').toLowerCase()}:${f.line || 0}:${(f.title || '').toLowerCase().replace(/\s+/g, ' ').trim()}`
}

// Normalized, word-order-independent word-set of a finding title. Used inside the fingerprint and
// for fuzzy cross-round matching so a lightly reworded title still matches its prior-round twin.
function titleShingle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ')
}

// Line-tolerant finding identity: hash of file + enclosing symbol + ruleId + title shingle.
// djb2 (not crypto) — the sandbox has no crypto and bans Math.random, and we only need a stable,
// collision-resistant-enough key, computed identically in the lib and in the workflow mirror.
function fingerprint(f) {
  const basis = [f?.file || '', f?.symbol || '', f?.ruleId || '', titleShingle(f?.title)].join('\0')
  let h = 5381
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0')
}

function shingleOverlap(a, b) {
  const sa = new Set(titleShingle(a).split(' ').filter(Boolean))
  const sb = new Set(titleShingle(b).split(' ').filter(Boolean))
  if (!sa.size || !sb.size) return 0
  let inter = 0
  for (const w of sa) if (sb.has(w)) inter++
  return inter / Math.max(sa.size, sb.size)
}

// True when `cur` (a freshly located finding) is the same defect as `prior` (from the ledger).
// file + ruleId must match exactly; a symbol mismatch only disqualifies when BOTH carry one (a
// finding can move symbols across a fix, so an absent symbol is not a veto); titles must overlap.
function matchesPrior(cur, prior, { threshold = 0.6 } = {}) {
  if ((cur?.file || '') !== (prior?.file || '')) return false
  if ((cur?.ruleId || '') !== (prior?.ruleId || '')) return false
  if ((cur?.symbol || '') && (prior?.symbol || '') && cur.symbol !== prior.symbol) return false
  return shingleOverlap(cur?.title, prior?.title) >= threshold
}

// A ledger disposition sourced from a human triage decision. accept/needs-decision/conflict stay
// `open` (still to be adjudicated or fixed); only reject/defer carry a settled disposition.
const DISPOSITION_FROM_TRIAGE = { reject: 'rejected', defer: 'deferred', accept: 'open', 'needs-decision': 'open', conflict: 'open' }
function dispositionFromTriage(v) {
  return Object.prototype.hasOwnProperty.call(DISPOSITION_FROM_TRIAGE, v) ? DISPOSITION_FROM_TRIAGE[v] : 'open'
}

// Re-review verdict: reviewVerdict over the findings that still matter this round. resolved and
// carried (rejected/justified) findings are excluded by the caller, so they never reach here.
function rereviewVerdict({ stillOpen = [], regressed = [], neu = [] } = {}) {
  return reviewVerdict([...stillOpen, ...regressed, ...neu])
}

// Pick the newest prior `review` run for this project+branch from the loaded index.jsonl entries.
// ts strings are UTC and lexically sortable (YYYY-MM-DDTHH-MM-SSZ), so a string max is chronological.
function selectPriorRound(indexEntries, { project, branch }) {
  let best = null
  for (const e of (Array.isArray(indexEntries) ? indexEntries : [])) {
    if (!e || e.kind !== 'workflow' || e.name !== 'review') continue
    if (e.project !== project || e.branch !== branch || !e.branch) continue
    if (!best || String(e.ts) > String(best.ts)) best = e
  }
  return best
}

// A finding is "tool-sourced" — deterministic and re-runnable, so a verifier may refute it ONLY by
// re-running the tool — when it came from neither a review lens nor the negative-space lens nor
// dep-context. dep-context is a *reasoning* seed from the gate (version-specific API misuse) with no
// re-runnable tool behind it, so it must be verifiable by argument like a lens finding; classifying
// it as a tool would make it effectively unfalsifiable ("keep an unverifiable tool finding alive")
// and inflate the verdict with false Warnings.
function isToolSource(profile, source) {
  return !(profile.lenses.includes(source) || source === 'negative-space' || source === 'dep-context')
}

// ================= Detect base + languages =================
phase('Scout')
const detected = await ragent(
  `You are resolving the review base and the changed files. Use shell + read only — do NOT review.${pathArg ? `\n\nSCOPE: consider ONLY files under \`${pathArg}\`; pass \`-- ${pathArg}\` to the git commands below.` : ''}
1. Resolve the diff base. ${baseArg
    ? `Use \`${baseArg}\`.`
    : 'Try in order until one resolves: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`. If the tree has uncommitted changes, target those.'}
2. List the changed file paths: \`git diff --name-only <base>...HEAD\`${pathArg ? ` -- ${pathArg}` : ''} (and include uncommitted changes from \`git status --porcelain\` if the tree is dirty).
3. Capture the VERBATIM change description as \`spec\` — the authors' own written claims/invariants, checked against code later. If the current branch has an OPEN PR, run \`gh pr view --json body,title\` and use its title + body. Otherwise use the commit messages on the diff range: \`git log <base>..HEAD --format=%B\`. Do not summarize or paraphrase — copy the text as-is. Truncate to ~4000 chars. Empty string if there is no PR and no commit body (e.g. only uncommitted changes). If \`gh\` is missing/unauthenticated, fall through to the commit messages.
4. Capture \`branch\` = \`git rev-parse --abbrev-ref HEAD\` (empty string if detached) and \`head\` = \`git rev-parse --short HEAD\` (empty string if not a git repo).
Return baseRef (the ref you resolved, empty string if none), files (the changed paths), spec (the verbatim description), branch, and head.`,
  { label: 'detect', schema: DETECT_SCHEMA, model: 'haiku', effort: 'low' },
)
// If base resolution died even after the retry, say so loudly — falling through would
// produce a misleading "Approve — no supported language" on an empty file list.
if (!detected) {
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null,
    languages: [], verdict: 'INCOMPLETE (detect died)', findings: summarizeFindings([]), dimensions: [], verification: null, notRun: ['base/changed-files detection'], outputTokens: budget.spent(),
  })
  return [`## Verdict`, `⚠️ INCOMPLETE — the base-resolution agent died twice (API error); nothing was reviewed. Re-run the review.`].join('\n')
}
const baseRef = detected?.baseRef ?? baseArg
const changedFiles = Array.isArray(detected?.files) ? detected.files : []
// The authors' OWN written spec (PR body/title or commit messages) — checked claim-by-claim
// against the code by the intent lens. The one-line inferred `intent` is not enough: precise
// claims ("never fails on X", "the only way to Y", "idempotent no-op") live in the full body.
const spec = (typeof detected?.spec === 'string' ? detected.spec : '').slice(0, 4000)
const branch = (typeof detected?.branch === 'string' ? detected.branch : '').trim()
const head = (typeof detected?.head === 'string' ? detected.head : '').trim()

// Round detection: find the newest prior `review` run for this branch, and accept it as the prior
// round ONLY if its head is an ANCESTOR of the current HEAD (a rebase/force-push makes a stale run
// non-ancestor → treat as a fresh first review). `fresh` skips the whole mechanism.
let priorRound = null
if (!freshArg && branch && head) {
  priorRound = await ragent(
    `You are locating the prior review round for this branch, if any. Shell + read only.
1. If \`~/.craft/runs/index.jsonl\` does not exist, return {found:false}.
2. Read it. Select the newest line with kind="workflow", name="review", project=\`pwd\`, branch=${JSON.stringify(branch)} (newest = lexical-max ts). If none, return {found:false}.
3. That line has a \`head\` field (a prior commit). Check ancestry: \`git merge-base --is-ancestor <priorHead> HEAD\` (exit 0 = ancestor). If NOT an ancestor (rebase/force-push/unrelated), return {found:false}.
4. Reconstruct the full record path \`~/.craft/runs/<ts>-workflow-review.json\` from that line's ts, read it, and return {found:true, round:<its round>, head:<its head>, ledger:<its ledger array, or [] if absent>}.
Best-effort: any error → {found:false}.`,
    { label: 'prior-round', schema: PRIOR_ROUND_SCHEMA, model: 'haiku', effort: 'low', phase: 'Scout' },
  )
  if (!priorRound?.found) priorRound = null
}
if (priorRound) log(`Re-review: prior round ${priorRound.round} @ ${priorRound.head} · ${priorRound.ledger?.length || 0} ledger finding(s)`)
else log(freshArg ? 'Fresh review (—fresh): prior round ignored' : 'First review for this branch (no prior round)')

// On a re-review the lenses look only at the fix commits (prevHead...HEAD) — cheap, and it catches
// regressions the fixes introduced. `fresh` (priorRound=null) keeps the full base...HEAD scan.
const lensBase = priorRound ? priorRound.head : baseRef

// Active profiles: detected in the diff, intersected with any explicit pin. If a pin names a profile
// the detector missed (best-effort detection), honor the pin. If nothing matches, report and stop.
let active = Object.values(PROFILES).filter(p => (!requestedLangs || requestedLangs.includes(p.id)) && p.detect(changedFiles))
if (!active.length && requestedLangs) active = requestedLangs.map(id => PROFILES[id]).filter(Boolean)
if (!active.length) {
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null,
    languages: [], verdict: 'Approve (NO LANGUAGE)', findings: summarizeFindings([]), dimensions: [], verification: null, notRun: [], outputTokens: budget.spent(),
  })
  return [`## Verdict`, `✅ Approve — no supported language (Rust/Nix) found in this diff; nothing to review.`, ``, `## Detected`, detected?.notes || `${changedFiles.length} changed file(s)`].join('\n')
}
log(`Active profiles: ${active.map(p => p.id).join(', ')}${requestedLangs ? ` (pinned: ${requestedLangs.join(',')})` : ''} · base ${baseRef || 'HEAD'}`)

// Changed files no active profile covers are NOT reviewed — say so instead of silently shrinking scope.
const uncoveredFiles = changedFiles.filter(f => !active.some(p => p.detect([f])))
if (uncoveredFiles.length) log(`Outside all active profiles (not reviewed): ${uncoveredFiles.join(', ')}`)

// ================= Prompt builders (profile-parameterized) =================
function scoutPrompt(profile) {
  return `You are scouting a ${profile.lang} diff to plan an elastic review. Use shell + read only — do NOT review yet.${pathArg ? `\n\nSCOPE: review ONLY the crate/dir at \`${pathArg}\`. Pass \`-- ${pathArg}\` to every \`git diff\` command below.` : ''}

Diff base: ${lensBase ? `\`${lensBase}\`` : 'uncommitted changes / most recent commit'}. Consider only this profile's files (${profile.diffGlobs.join(' ')}).
1. Inspect \`git diff --stat ${lensBase ? `${lensBase}...HEAD` : 'HEAD'} -- ${profile.diffGlobs.join(' ')}\`. Set sizeBucket:
   small = a few files / < ~80 changed lines; large = many files / > ~400 lines or a public-API-heavy change; medium otherwise.
2. lenses: choose from ${JSON.stringify(profile.lenses)}.
   - small: only the touched categories (minimum 2; always include the dominant category, and include '${profile.safetyLens}' unless the diff clearly touches nothing related to ${profile.securityHints}).
   - medium: the categories plausibly in play.
   - large: all of them.
   ${profile.scoutRules}${strict ? '\n   STRICT MODE is on: ALWAYS include \'maintainability\' in lenses regardless of size.' : ''}
3. maxRounds: small=1, medium=2, large=3. verifyVotes: small/medium=1, large=3. lensModel: opus for all sizes (review reasoning runs on Opus; depth scales via maxRounds/verifyVotes/lens count).
4. isLibrary: ${profile.usesLibrary ? 'true if this is a published library (has `[lib]`/looks publishable) — best effort.' : 'always false (not applicable to this language).'}
5. securitySensitive: true if the diff touches ${profile.securityHints}.
6. intent: ${intentArg ? `the caller provided: "${intentArg}". Refine it from the diff if needed.` : 'infer the change\'s purpose from the diff and any PR/commit messages; empty string if unclear.'}
7. churn: list up to 5 files in the diff that git shows as frequently changed (\`git log --oneline -n 50 -- <file> | wc -l\` is a rough proxy). May be empty.`
}

function negativeSpacePrompt(priorSummary, profile, plan) {
  const intent = plan?.intent ?? intentArg
  return `You are the **negative-space** review lens for a ${profile.lang} change. Unlike the other lenses, your job is NOT to review the changed lines — it is to find the bug the diff ENABLES in code it did NOT touch. ${profile.navSkill ? `Load the ${profile.navSkill} skill for whole-repo search; use` : 'Use'} Grep/Glob across the ENTIRE tree, not just the diff.

Diff base: ${lensBase ? `\`${lensBase}\`` : 'uncommitted changes / most recent commit'}.
${intent ? `INTENT (what the change should do): ${intent}` : ''}
${plan?.spec ? `STATED SPEC / AUTHOR CLAIMS (verbatim PR/commit description — an invariant the author claims here may be broken by the UNCHANGED code you inventory below):\n"""\n${plan.spec}\n"""` : ''}

METHOD — follow in order:
1. Inventory the NEW surface the diff introduces. Read the FULL diff: \`git diff ${lensBase ? `--merge-base ${lensBase}` : 'HEAD'}\`. List every new: ${profile.lang === 'Nix' ? 'flake output / module option / package attr / overlay / renamed binding' : 'enum variant / status value / DB column / table / migration / public fn / route / struct field'}. ALSO list any UNCHANGED definition the diff now references or relies on for the first time.
2. For EACH item, Grep the UNCHANGED tree for existing code that reads, references, ${profile.lang === 'Nix' ? 'imports, or overrides' : 'lists, updates, deletes, cascades, serializes, orders, or authorizes'} that shape. Ask: does this pre-existing path violate an invariant the change assumes?
3. Report each concrete violation ANCHORED TO THE UNCHANGED file:line that is actually wrong, not the diff line. That anchor is real — cite it precisely so it can be verified.

Only report a violation you can name a concrete reachable path for. Put the triggering surface in \`blastRadius\`; in \`why\`, state the invariant and the exact old path that breaks it. Do NOT restate findings already in the ALREADY-FOUND set below — look for what they MISSED.

ALREADY-FOUND (from other lenses / earlier rounds — do not repeat):
${priorSummary}

Return {lens: "negative-space", findings: [...]} using the shared finding schema. Set \`ruleId\` to the matching ${profile.rubricSkill} rules.md ID or "" if none fits. Observability: the workflow records this run — do NOT write your own record.`
}

function lensPrompt(lens, priorSummary, profile, plan) {
  if (lens === 'negative-space') return negativeSpacePrompt(priorSummary, profile, plan)
  return `You are the **${lens}** review lens for a ${profile.lang} diff. Review ONLY this slice; ignore everything else (other lenses cover it). Load the ${profile.rubricSkill} skill for the rubric${profile.navSkill ? ` and the ${profile.navSkill} skill for context expansion` : ''}.

SLICE: ${profile.lensBrief[lens] || lens}
${strict && lens === 'maintainability' ? '\nSTRICT MODE: apply the maintainability bar as a *presumption of block* — each maintainability issue is a blocker unless the author clearly justified it in the diff or brief. Be harsh, but stay grounded — every finding still needs a concrete cited file:line and survives refutation; do not invent issues.\n' : ''}
Diff base: ${lensBase ? `\`${lensBase}\`` : 'uncommitted changes / most recent commit'}. Review with \`git diff ${lensBase ? `--merge-base ${lensBase}` : 'HEAD'} -- ${profile.diffGlobs.join(' ')}\`.
${priorRound ? `RE-REVIEW: you are reviewing ONLY the fix commits since the prior round (base ${lensBase}). Prior findings are adjudicated separately — do not re-report them; surface only NEW defects the fixes introduced.` : ''}
${plan.intent ? `INTENT (what the change should do): ${plan.intent}` : ''}
${plan.spec ? `STATED SPEC / AUTHOR CLAIMS (verbatim PR/commit description — treat as the spec; the intent lens must check EACH claim against the code, and any lens may use it):\n"""\n${plan.spec}\n"""` : ''}
${plan.churn?.length ? `HOT FILES (scrutinize harder): ${plan.churn.join(', ')}` : ''}

CONTEXT EXPANSION (required): for each finding, trace definitions / uses / consumers of the changed symbols (Grep/Glob${profile.navSkill ? ' + LSP' : ''}) before judging — do not read the diff in isolation. If a finding depends on code outside the diff, say so in \`why\`.
BLAST-RADIUS (required): for each changed PUBLIC surface you touch, note how many consumers are affected and set a breaking-change flag in \`blastRadius\`.
CONFIDENCE: report everything you suspect, located. Do NOT self-censor borderline findings — verification happens downstream. Each finding needs file:line (use file:"" line:0 only when truly not locatable).
RULE ID (required field): set \`ruleId\` to the matching catalog ID from the ${profile.rubricSkill} skill's rules.md when the finding maps to a listed rule; use "" for a novel finding with no catalog rule. Do not force a bad fit.
${profile.id === 'rust' && lens === 'tests' && (plan.sizeBucket === 'medium' || plan.sizeBucket === 'large') ? 'If `cargo mutants` is installed, you MAY run it time-boxed on the changed files to surface contracts no test would catch a regression on; skip silently if absent.' : ''}
ALREADY-FOUND (do not repeat; look for what these MISSED):
${priorSummary}

Return {lens, findings[]}.

Observability: the review workflow records this run — do NOT write your own record.`
}

function verifyPrompt(f, idx, isTool, gateProvenance) {
  const head = isTool
    ? `You are verifier #${idx + 1} for a TOOL-REPORTED code review finding (source: ${f.source}). Deterministic tool output outranks your judgement — you may refute it ONLY by re-running the tool, never on reasoning alone.`
    : `You are skeptic #${idx + 1} trying to REFUTE a code review finding. Default to refuted=true when uncertain whether the technical claim holds — only let real findings through.`
  return `${head}

FINDING: [${f.severity}] ${f.title}
  at ${f.file || '?'}:${f.line || 0}
  why: ${f.why}
  source: ${f.source}${f.ruleId ? ` · rule ${f.ruleId}` : ''}

MECHANICAL CHECK FIRST: if a tool can decide this finding (a clippy lint, statix/deadnix rule, semgrep rule, cargo-audit advisory — infer from source/ruleId/title), RUN it scoped to the cited file; its output overrides your judgement in BOTH directions: tool still reports it → refuted=false; tool demonstrably no longer reports it → refuted=true (quote the output in reason).${gateProvenance ? ` The gate invoked the tools as: "${gateProvenance}" — if a tool is not on PATH, reproduce the gate's invocation (e.g. \`nix run nixpkgs#<tool> --\`) before declaring it unrunnable.` : ''}${isTool ? ' If you STILL cannot run the tool, set refuted=false — an unverifiable tool finding stays alive.' : ' If no tool applies, judge it yourself.'}

REFUTATION RULE: refuted=true means the finding's TECHNICAL CLAIM is false — the cited code does not contain the claimed defect, or the deciding tool demonstrably no longer reports it. Context is NOT refutation: that the code is test/fixture/example-only, looks intentional, is unlikely to be built or run, or has low impact NEVER justifies refuted=true. Record that context in reachable=false and reason instead — severity is calibrated downstream.

Open the cited file and check:
1. citedLineMatches: does ${f.file || '?'}:${f.line || 0} actually contain what the finding claims? (If the citation is wrong/hallucinated → citedLineMatches=false.)
2. reachable: is this code reachable in production, or is it test/example/fixture-only code? (Test-only → reachable=false. This does NOT refute the finding — it only calibrates severity downstream.)
3. refuted: is the technical claim itself false? (${isTool ? 'Tool-decided as above.' : 'Mechanical check first, then your judgement; when uncertain about the claim, refuted=true.'})

Return {refuted, citedLineMatches, reachable, reason}.`
}

// Cross-lens dedup BEFORE verification. key() above is exact (file:line:title), so two lenses
// wording the same defect differently both enter the pool — and each duplicate would buy its own
// verifier fan-out. A cheap grouping pass merges same-defect findings first; synthesis keeps its
// own dedup instruction as a safety net.
const SEV_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 }
const DEDUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['groups'],
  properties: {
    groups: {
      type: 'array',
      items: { type: 'array', items: { type: 'integer' } },
      description: 'each inner array = indices of findings that describe the SAME underlying defect; singletons omitted; empty if all distinct',
    },
  },
}
async function dedupPool(pool, profile) {
  if (pool.length < 2) return pool
  const isToolSrc = f => isToolSource(profile, f.source)
  const listing = pool.map((f, i) => `${i}. ${f.file || '?'}:${f.line || 0} [${f.severity}] (${f.source}) ${f.title} — ${String(f.why || '').slice(0, 160)}`).join('\n')
  let res = null
  try {
    res = await ragent(
      `You are deduplicating code-review findings BEFORE verification. Different lenses word the same defect differently. Group ONLY findings that describe the SAME underlying defect — same root cause, where one edit fixes all of them (e.g. one redundant loop reported by both a performance and an idioms lens). Same file+line alone is NOT enough: two distinct defects can share a line. When in doubt, do NOT group.

FINDINGS:
${listing}

Return {groups: [[i, j, ...], ...]} — index groups of same-defect findings; omit singletons; {groups: []} if all are distinct.`,
      { label: `dedup:${profile.id}`, phase: 'Verify', schema: DEDUP_SCHEMA, model: 'haiku', effort: 'low' },
    )
  } catch (e) {
    log(`[${profile.id}] dedup pass failed (${String((e && e.message) || e).slice(0, 80)}) — verifying the raw pool`)
  }
  const groups = (res?.groups ?? []).filter(g => Array.isArray(g) && g.length > 1 && g.every(i => Number.isInteger(i) && i >= 0 && i < pool.length))
  const merged = []
  const inGroup = new Set()
  for (const g of groups) {
    if (g.some(i => inGroup.has(i))) continue // overlapping groups: first wins
    for (const i of g) inGroup.add(i)
    const members = g.map(i => pool[i])
    // Base = the strictest member: tool-sourced first (a tool finding can only be refuted by
    // re-running the tool), then highest severity.
    const base = members.slice().sort((a, b) => (isToolSrc(b) - isToolSrc(a)) || ((SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9)))[0]
    const others = members.filter(m => m !== base)
    // Carry ALL contributing sources so a downstream source-keyed rule (strict maintainability
    // escalation) still fires when its trigger lens was merged into a different-source base.
    const sources = [...new Set(members.map(m => m.source).filter(Boolean))]
    merged.push({ ...base, sources, why: `${base.why} (same defect also reported by: ${others.map(m => m.source).join(', ')})` })
  }
  if (!merged.length) return pool
  const out = pool.filter((_f, i) => !inGroup.has(i)).concat(merged)
  log(`[${profile.id}] Dedup before verify: ${pool.length} → ${out.length} (${pool.length - out.length} cross-lens duplicate(s) merged)`)
  return out
}

// Verify a pool of findings → {confirmed, suspected, dropped, refuted}. Rigor scales with the profile's plan.
// Staged verification: cull votes run on a cheap model (sonnet); a High/Critical additionally gets exactly
// ONE authoritative opus vote, so the cheap model can neither confirm nor drop a high-stakes finding alone.
const DEMOTE = { Critical: 'High', High: 'Medium', Medium: 'Low', Low: 'Info', Info: 'Info' }
const CULL_MODEL = 'sonnet'
async function verifyPool(items, plan, profile, gateProvenance) {
  const judged = await parallel(items.map(f => () => {
    // Anything not produced by a review lens came from a deterministic tool (gate seeds: clippy-pedantic, statix, deadnix, semgrep, …) — except dep-context, a reasoning seed (see isToolSource).
    const isTool = isToolSource(profile, f.source)
    const isHigh = f.severity === 'Critical' || f.severity === 'High'
    const n1 = isHigh ? Math.max(1, plan.verifyVotes) : 1
    // Cull votes on the cheap model.
    const cullVotes = Array.from({ length: n1 }, (_unused, i) => () =>
      ragent(verifyPrompt(f, i, isTool, gateProvenance), { label: `verify:${f.file || '?'}:${f.line || 0}#c${i + 1}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: CULL_MODEL }),
    )
    // A High/Critical always gets exactly one authoritative opus vote combined with the cull votes.
    const authVotes = isHigh
      ? [() => ragent(verifyPrompt(f, n1, isTool, gateProvenance), { label: `verify:${f.file || '?'}:${f.line || 0}#auth`, phase: 'Verify', schema: VERDICT_SCHEMA, model: plan.lensModel })]
      : []
    return parallel([...cullVotes, ...authVotes]).then(vs => {
      const v = vs.filter(Boolean)
      if (!v.length) return { ...f, tier: 'suspected' } // verification died → don't drop, demote
      const half = v.length / 2
      const lineOk = v.filter(x => x.citedLineMatches).length >= Math.ceil(half)
      const reach = v.filter(x => x.reachable).length >= Math.ceil(half)
      const refutes = v.filter(x => x.refuted).length
      let tier
      if (!lineOk) tier = 'refuted'            // hallucinated citation
      else if (refutes > half) tier = 'refuted'
      else if (refutes === 0) tier = 'confirmed'
      else tier = 'suspected'
      // Test/example-only code doesn't kill a finding — it lowers the stakes: confirm, but one severity notch down.
      if (tier === 'confirmed' && !reach) {
        const demoted = DEMOTE[f.severity] || f.severity
        return { ...f, tier, severity: demoted, why: `${f.why} (severity demoted ${f.severity}→${demoted}: not on a production-reachable path)` }
      }
      return { ...f, tier }
    })
  }))
  const vp = judged.filter(Boolean)
  const refuted = vp.filter(f => f.tier === 'refuted')
  return {
    confirmed: vp.filter(f => f.tier === 'confirmed'),
    suspected: vp.filter(f => f.tier === 'suspected'),
    dropped: refuted.length,
    refuted,
  }
}

// ================= Per-profile pipeline: scout → gate → lenses → verify → critic =================
async function reviewProfile(profile) {
  // ---- Scout ----
  const scout = await ragent(scoutPrompt(profile), { label: `scout:${profile.id}`, schema: SCOUT_SCHEMA, model: 'haiku', effort: 'low', phase: 'Scout' })
  const plan = {
    sizeBucket: scout?.sizeBucket ?? 'medium',
    lenses: (scout?.lenses?.length ? scout.lenses.filter(l => profile.lenses.includes(l)) : profile.lenses.slice()),
    maxRounds: scout?.maxRounds ?? 2,
    verifyVotes: scout?.verifyVotes ?? 1,
    lensModel: scout?.lensModel ?? 'opus',
    isLibrary: profile.usesLibrary ? (scout?.isLibrary ?? false) : false,
    securitySensitive: scout?.securitySensitive ?? true,
    intent: scout?.intent ?? intentArg,
    spec,
    churn: scout?.churn ?? [],
  }
  if (!plan.lenses.length) plan.lenses = profile.lenses.slice()
  // "Always" lenses are enforced HERE, not left to the scout: smoke runs showed prompt-side
  // "always include X" gets dropped. 'intent' is the lens that catches correct-looking code
  // with wrong behavior — it runs at every size.
  for (const l of (profile.alwaysLenses || [])) if (profile.lenses.includes(l) && !plan.lenses.includes(l)) plan.lenses.push(l)
  if (strict && profile.lenses.includes('maintainability') && !plan.lenses.includes('maintainability')) plan.lenses.push('maintainability')
  // Security-sensitive rigor floor: don't let the size heuristic gate rigor on a security-touching change.
  if (plan.securitySensitive) {
    for (const l of profile.lenses) if (!plan.lenses.includes(l)) plan.lenses.push(l)
    plan.verifyVotes = Math.max(plan.verifyVotes, 3)
    plan.maxRounds = Math.max(plan.maxRounds, 2)
  }
  // Negative-space lens where new reachable surface tends to appear.
  if ((plan.securitySensitive || plan.sizeBucket === 'large') && !plan.lenses.includes('negative-space')) plan.lenses.push('negative-space')
  // Compat lens on large diffs too: changed serialized/persisted representations break other-versioned
  // readers (rolling deploy, already-stored rows) invisibly to the code-intrinsic lenses. Security-sensitive
  // diffs already get it via the all-lenses floor above (compat ∈ profile.lenses).
  if (plan.sizeBucket === 'large' && profile.lenses.includes('compat') && !plan.lenses.includes('compat')) plan.lenses.push('compat')
  log(`[${profile.id}] ${scout?.notes ?? 'scout: medium/all lenses'} · ${plan.sizeBucket}${plan.securitySensitive ? ' · SECURITY floor (all lenses, 3-vote)' : ''}${plan.lenses.includes('negative-space') ? ' · +negative-space' : ''}`)

  // Lens runner: prefer the profile's dedicated reviewer agent; if that agent type is not
  // registered in this session (stale plugin registry), fall back to the generic workflow
  // subagent — lens prompts are self-contained. The miss is LEARNED once (reviewerAgentMissing):
  // without it the absent agent type is re-attempted on every lens × round, which floods the run
  // with "agent type '<x>' not found". Both failure shapes are handled — a thrown /not found/ and
  // a null return (some runtimes signal an unknown agent type that way). Record the real failure
  // reason so INCOMPLETE reporting doesn't have to guess (budget vs registry vs death).
  const lensFailures = new Map()
  let reviewerAgentMissing = false
  async function runLens(lens, prompt, phaseName, labelSuffix) {
    const opts = { label: `lens:${profile.id}:${lens}${labelSuffix}`, phase: phaseName, schema: FINDINGS_SCHEMA, model: plan.lensModel }
    const runGeneric = async () => {
      try {
        return await ragent(prompt, opts)
      } catch (e) {
        lensFailures.set(lens, String((e && e.message) || e).slice(0, 160))
        return null
      }
    }
    if (reviewerAgentMissing) return runGeneric()
    try {
      const res = await ragent(prompt, { ...opts, agentType: profile.reviewerAgent })
      if (res != null) return res
      // Null (not a throw) from the reviewer path: on some runtimes an unknown agent type returns
      // null rather than throwing. ragent already retried; try the generic subagent once. Do NOT
      // set reviewerAgentMissing — a null can be a transient API death, so later lenses still get
      // a shot at the real reviewer agent.
      return await runGeneric()
    } catch (e) {
      const msg = String((e && e.message) || e)
      if (!/not found/i.test(msg)) { lensFailures.set(lens, msg.slice(0, 160)); return null }
      reviewerAgentMissing = true
      log(`⚠️ [${profile.id}] agent type '${profile.reviewerAgent}' not registered here — routing remaining lenses to the generic subagent`)
      return await runGeneric()
    }
  }

  // ---- Gate ----
  const gate = await ragent(profile.gate({ baseRef, isLibrary: plan.isLibrary, securitySensitive: plan.securitySensitive }),
    { label: `gate:${profile.id}`, schema: GATE_SCHEMA, phase: 'Gate', effort: 'medium' })
  const gateStatus = gate?.status ?? 'unknown'
  const gateProvenance = gate?.provenance ?? 'gate not established'
  const failedChecks = gate?.failedChecks ?? []
  const seedFindings = (gate?.seedFindings ?? []).map(f => ({ ...f, source: f.source || 'tool' }))
  log(`[${profile.id}] Gate: ${gateStatus} — ${gateProvenance}${failedChecks.length ? ` · failed: ${failedChecks.join(', ')}` : ''}`)
  if (gateStatus === 'fail') {
    return { profile, plan, gateStatus, gateProvenance, failedChecks, confirmed: [], suspected: [], dropped: 0, notRun: [], criticNotes: '' }
  }

  // ---- Probe reviewer-agent availability ONCE up front ----
  // The per-lens fallback (runLens) already recovers, but it learns the miss only after the FIRST
  // attempt — and the round-1 lenses fan out in parallel, so without this every lens in round 1
  // would fail with "agent type '<x>' not found" before the memo is set. One cheap probe collapses
  // that opening wave to a single attempt. Best-effort: only a thrown /not found/ marks it missing;
  // a result, a null, or an unrelated error leaves the per-lens fallback to decide.
  if (profile.reviewerAgent && !reviewerAgentMissing) {
    try {
      await agent('Reply with the single word: OK.', { label: `probe:${profile.id}`, phase: 'Gate', model: 'haiku', effort: 'low', agentType: profile.reviewerAgent })
    } catch (e) {
      if (/not found/i.test(String((e && e.message) || e))) {
        reviewerAgentMissing = true
        log(`[${profile.id}] reviewer agent '${profile.reviewerAgent}' not registered — all lenses will use the generic subagent`)
      }
    }
  }

  // ---- Lenses (loop-until-dry) ----
  phase('Lenses')
  const seen = new Set()
  const pool = []
  for (const f of seedFindings) { const k = key(f); if (!seen.has(k)) { seen.add(k); pool.push(f) } }
  const notRun = []
  const ranAtLeastOnce = new Set()
  let dry = false
  for (let round = 1; round <= plan.maxRounds && !dry; round++) {
    const priorSummary = pool.length ? pool.map(f => `${f.file || '?'}:${f.line || 0} ${f.title}`).join('\n') : 'none yet'
    const results = (await parallel(plan.lenses.map(lens => () =>
      runLens(lens, lensPrompt(lens, priorSummary, profile, plan), 'Lenses', ` r${round}`),
    ))).filter(Boolean)
    for (const r of results) ranAtLeastOnce.add(r.lens)
    const fresh = []
    for (const r of results) {
      for (const f0 of (r.findings || [])) {
        const f = { ...f0, source: r.lens }
        const k = key(f)
        if (!seen.has(k)) { seen.add(k); fresh.push(f) }
      }
    }
    pool.push(...fresh)
    log(`[${profile.id}] Lenses round ${round}: +${fresh.length} new (pool ${pool.length})`)
    if (!fresh.length) dry = true
  }

  // ---- Resurrection sweep ----
  // A lens agent occasionally returns null on a transient API death / connection drop and never
  // enters `ranAtLeastOnce`, which alone marks the whole review INCOMPLETE — even when the surviving
  // lenses found plenty. Since the failure is transient, a targeted retry of ONLY the missing lenses
  // recovers most of them. Bounded to 2 extra attempts; re-uses the same runLens/lensPrompt path.
  let missing = plan.lenses.filter(l => !ranAtLeastOnce.has(l))
  for (let sweep = 1; sweep <= 2 && missing.length; sweep++) {
    log(`[${profile.id}] Resurrection sweep ${sweep}: retrying ${missing.length} lens(es) that never returned (${missing.join(', ')})`)
    const priorSummary = pool.length ? pool.map(f => `${f.file || '?'}:${f.line || 0} ${f.title}`).join('\n') : 'none yet'
    const results = (await parallel(missing.map(lens => () =>
      runLens(lens, lensPrompt(lens, priorSummary, profile, plan), 'Lenses', ` resurrect${sweep}`),
    ))).filter(Boolean)
    for (const r of results) {
      ranAtLeastOnce.add(r.lens)
      for (const f0 of (r.findings || [])) {
        const f = { ...f0, source: r.lens }
        const k = key(f)
        if (!seen.has(k)) { seen.add(k); pool.push(f) }
      }
    }
    missing = plan.lenses.filter(l => !ranAtLeastOnce.has(l))
  }

  const droppedLenses = plan.lenses.filter(l => !ranAtLeastOnce.has(l))
  if (droppedLenses.length) {
    const reasons = droppedLenses.map(l => `${l}: ${lensFailures.get(l) || 'returned no result (skipped or died without an error)'}`).join(' · ')
    notRun.push(`${profile.id} lenses that never returned — ${reasons}`)
    log(`⚠️ [${profile.id}] ${droppedLenses.length} lens(es) never returned (${reasons}). Review marked INCOMPLETE.`)
  }
  if (!pool.length) {
    return { profile, plan, gateStatus, gateProvenance, failedChecks, confirmed: [], suspected: [], dropped: 0, notRun, criticNotes: '' }
  }

  // ---- Verify ----
  phase('Verify')
  const deduped = await dedupPool(pool, profile)
  let { confirmed, suspected, dropped, refuted } = await verifyPool(deduped, plan, profile, gateProvenance)
  log(`[${profile.id}] Verify: ${confirmed.length} confirmed · ${suspected.length} suspected · ${dropped} refuted`)

  // ---- Completeness critic (large or security-sensitive; budget-gated) ----
  phase('Synthesize')
  let criticNotes = ''
  const criticInScope = plan.sizeBucket === 'large' || plan.securitySensitive
  if (criticInScope && (!budget.total || budget.remaining() > 90000)) {
    const candidates = profile.lenses.filter(l => !plan.lenses.includes(l))
    const critic = await ragent(
      `You are a completeness critic for a ${profile.lang} review of the diff (base ${baseRef || 'HEAD'}).
Lenses already run: ${plan.lenses.join(', ')}. Confirmed: ${confirmed.length}, Suspected: ${suspected.length}.
Name any review lens that was NOT run but SHOULD be, given what the diff touches — choose ONLY from: ${JSON.stringify(candidates)}.
Also note in one line anything else likely missed (a changed file no finding touched, a claim left unverified). If coverage is complete, return missingLenses: [] and notes: "coverage complete".`,
      { label: `critic:${profile.id}`, phase: 'Synthesize', schema: CRITIC_SCHEMA, effort: 'low' },
    )
    criticNotes = critic?.notes ?? ''
    const followups = (critic?.missingLenses ?? []).filter(l => candidates.includes(l))
    if (followups.length && (!budget.total || budget.remaining() > 60000)) {
      log(`[${profile.id}] Completeness critic → follow-up lenses: ${followups.join(', ')}`)
      const priorSummary = `Earlier lenses already produced ${pool.length} findings — do NOT repeat them; surface only what your lens would add.`
      const extra = (await parallel(followups.map(lens => () =>
        runLens(lens, lensPrompt(lens, priorSummary, profile, plan), 'Synthesize', ' (critic)'),
      ))).filter(Boolean).flatMap(r => r.findings || [])
      const fresh = extra.filter(f => { const k = key(f); if (seen.has(k)) return false; seen.add(k); return true })
      if (fresh.length) {
        const v = await verifyPool(await dedupPool(fresh, profile), plan, profile, gateProvenance)
        confirmed = confirmed.concat(v.confirmed)
        suspected = suspected.concat(v.suspected)
        dropped += v.dropped
        refuted = refuted.concat(v.refuted)
        log(`[${profile.id}] Critic follow-up: +${v.confirmed.length} confirmed · +${v.suspected.length} suspected · ${v.dropped} refuted`)
      }
    } else if (followups.length) {
      notRun.push(`${profile.id} critic follow-up lenses (${followups.join('/')})`)
      log(`Budget low (~${Math.round(budget.remaining() / 1000)}k left) — SKIPPED [${profile.id}] critic follow-up lenses. Review marked INCOMPLETE.`)
    }
  } else if (criticInScope) {
    notRun.push(`${profile.id} completeness-critic`)
    log(`Budget low (~${Math.round(budget.remaining() / 1000)}k left) — SKIPPED [${profile.id}] completeness critic. Review marked INCOMPLETE.`)
  }

  return { profile, plan, gateStatus, gateProvenance, failedChecks, confirmed, suspected, dropped, refuted, notRun, criticNotes }
}

// ================= Run each active profile, then merge =================
const results = []
for (const p of active) results.push(await reviewProfile(p))

// A red gate on any active language blocks the whole review (findings can't be trusted on a broken tree).
const gateFailed = results.filter(r => r.gateStatus === 'fail')
const mergedProvenance = results.map(r => `[${r.profile.id}] ${r.gateProvenance}`).join(' · ')
const mergedGateStatus = gateFailed.length ? 'fail' : (results.every(r => r.gateStatus === 'pass') ? 'pass' : 'unknown')

function reviewRecord(extra) {
  return {
    schemaVersion: 1,
    runtime: 'claude-code',
    kind: 'workflow',
    name: 'review',
    nested: !!viaArg,
    via: viaArg || null,
    branch, head,
    languages: active.map(p => p.id),
    uncoveredFiles,
    scout: results.map(r => ({ language: r.profile.id, size: r.plan.sizeBucket, lenses: r.plan.lenses, model: r.plan.lensModel, maxRounds: r.plan.maxRounds, verifyVotes: r.plan.verifyVotes })),
    gate: { status: mergedGateStatus, provenance: mergedProvenance },
    outputTokens: budget.spent(),
    ...extra,
  }
}

if (gateFailed.length) {
  await logRun(reviewRecord({ verdict: 'Block', round: priorRound ? (priorRound.round || 1) + 1 : 1, findings: summarizeFindings([]), dimensions: [], verification: null, notRun: [], failedChecks: gateFailed.flatMap(r => (r.failedChecks || []).map(c => `[${r.profile.id}] ${c}`)) }))
  return [
    `## Verdict`,
    `⛔ Block — mechanical gate is red (${gateFailed.map(r => r.profile.id).join(', ')}).`,
    ``,
    `## Gate`,
    mergedProvenance,
    `\nFailed checks:\n${gateFailed.flatMap(r => (r.failedChecks || []).map(c => `- [${r.profile.id}] ${c}`)).join('\n')}`,
    ``,
    `Fix the gate before a semantic review is worthwhile.`,
  ].join('\n')
}

let confirmed = results.flatMap(r => r.confirmed)
let suspected = results.flatMap(r => r.suspected)

// ---- Adjudicate track (re-review only) ----
// For each prior-round finding, decide its fate this round. rejected/justified are carried (not
// re-raised) unless the code around them changed; open/deferred/confirmed priors get a targeted
// "is it still here?" check against the current tree.
const adjudicated = { resolved: [], stillOpen: [], regressed: [], carried: [] }
if (priorRound?.ledger?.length) {
  phase('Adjudicate')
  const settled = priorRound.ledger.filter(f => f.disposition === 'rejected' || f.disposition === 'justified')
  const toCheck = priorRound.ledger.filter(f => !(f.disposition === 'rejected' || f.disposition === 'justified'))

  // Settled priors: carried unless the code around them changed since the prior round.
  const carriedResults = (await parallel(settled.map(f => () =>
    ragent(
      `A prior review finding was dismissed by the author (disposition: ${f.disposition}). Decide only whether the CODE AROUND IT CHANGED since commit ${priorRound.head}. Shell + read only.
FINDING: [${f.severity}] ${f.title} — at ${f.file}:${f.line} (symbol ${f.symbol || '?'}), rule ${f.ruleId || '—'}.
Run \`git diff ${priorRound.head}...HEAD -- ${JSON.stringify(f.file)}\` and judge whether the enclosing symbol/region was touched. Return {changed: <bool>, reason}.`,
      { label: `carry:${f.file}:${f.line}`, phase: 'Adjudicate', schema: CHANGED_SCHEMA, model: CULL_MODEL },
    ).then(r => ({ f, changed: !!r?.changed })),
  ))).filter(Boolean)
  for (const { f, changed } of carriedResults) {
    if (changed) adjudicated.stillOpen.push({ ...f, why: `${f.why} (reopened: dismissed as ${f.disposition}, but the code around it changed — re-verify the justification)` })
    else adjudicated.carried.push(f)
  }

  // Open/deferred/confirmed priors: is the defect still at its (re-located) site?
  const checkResults = (await parallel(toCheck.map(f => () =>
    ragent(
      `You are adjudicating whether a prior review finding is still present after a fix attempt. Load the ${active[0].rubricSkill} skill for the rubric. Shell + read only; do NOT hunt for new bugs.
FINDING: [${f.severity}] ${f.title}
  originally at ${f.file}:${f.line} (enclosing symbol ${f.symbol || '?'}), rule ${f.ruleId || '—'}
  why it mattered: ${f.why}
METHOD: re-locate the symbol (grep it — the line has likely moved), read it, and decide:
  - "resolved": the defect is gone (the fix addressed it).
  - "still-open": the defect is still present (cite the current file:line).
  - "regressed": the site was changed but now has a DIFFERENT defect of the same kind (cite it).
Return {status, currentLine, note}.`,
      { label: `adjudicate:${f.file}:${f.line}`, phase: 'Adjudicate', schema: ADJUDICATE_SCHEMA, model: results[0]?.plan?.lensModel || 'opus' },
    ).then(r => ({ f, r })),
  ))).filter(Boolean)
  for (const { f, r } of checkResults) {
    const status = r?.status || 'still-open'   // verification died → assume still-open (safe: keeps it in the verdict)
    const located = { ...f, line: r?.currentLine || f.line }
    if (status === 'resolved') adjudicated.resolved.push({ ...located, disposition: 'closed' })
    else if (status === 'regressed') adjudicated.regressed.push({ ...located, why: `${f.why} — REGRESSED after fix: ${r?.note || ''}` })
    else adjudicated.stillOpen.push(located)
  }
  log(`Adjudicate: ${adjudicated.resolved.length} resolved · ${adjudicated.stillOpen.length} still-open · ${adjudicated.regressed.length} regressed · ${adjudicated.carried.length} carried`)
}

const dropped = results.reduce((n, r) => n + r.dropped, 0)
const notRun = results.flatMap(r => r.notRun)
const criticNotes = results.map(r => r.criticNotes).filter(n => n && n.trim() && n.trim() !== 'coverage complete').map(n => n.trim()).join(' · ')

// A re-review with adjudicated content (still-open/regressed/resolved/carried priors) must fall
// through to the full synthesis so the re-review report renders — a bare "Approve — no findings"
// here would wrongly erase still-open/regressed priors.
const hasAdjudicated = !!(adjudicated.stillOpen.length || adjudicated.regressed.length || adjudicated.resolved.length || adjudicated.carried.length)
if (!confirmed.length && !suspected.length && !hasAdjudicated) {
  await logRun(reviewRecord({ verdict: `Approve${notRun.length ? ' (INCOMPLETE)' : ''}`, round: priorRound ? (priorRound.round || 1) + 1 : 1, findings: summarizeFindings([]), dimensions: [], verification: { candidates: dropped, confirmed: 0, refuteRate: dropped ? 1 : 0 }, notRun }))
  const verdictLine = notRun.length
    ? `⚠️ Approve (INCOMPLETE) — gate ${mergedGateStatus}; no findings survived, but ${notRun.join('; ')} — coverage is NOT trustworthy; fix the cause and re-run.`
    : `✅ Approve — gate ${mergedGateStatus}; no findings across ${active.map(p => p.id).join('+')}.`
  return [`## Verdict`, verdictLine, ``, `## Gate`, mergedProvenance,
    ...(uncoveredFiles.length ? [``, `## Not reviewed (no language profile)`, ...uncoveredFiles.map(f => `- ${f}`)] : []),
  ].join('\n')
}

// ================= Synthesize one merged report =================
phase('Synthesize')
const isRereview = !!priorRound
const rereviewData = isRereview ? {
  resolved: adjudicated.resolved, stillOpen: adjudicated.stillOpen,
  regressed: adjudicated.regressed, carried: adjudicated.carried, neu: confirmed,
} : null
const report = await ragent(
  `You are consolidating a code review (languages: ${active.map(p => p.id).join(', ')}) into ONE markdown report. Do NOT invent findings — only use what is given.

VERDICT RULE: the verdict is driven ONLY by Confirmed findings.
- ⛔ Block if any Confirmed Critical or High.
- ⚠️ Warning if Confirmed Medium only.
- ✅ Approve if no Confirmed Critical/High/Medium.
Suspected findings NEVER change the verdict — they are surfaced for the author.${strict ? '\nSTRICT MODE: the maintainability bar is a presumption of block — if ANY Confirmed finding has source "maintainability" (or lists "maintainability" among its merged `sources`) at Medium or above, the verdict is ⛔ Block (state in the verdict line that strict maintainability mode escalated it).' : ''}

CALIBRATE severities across the Confirmed set so the same kind of issue is not Critical in one place and Medium in another; adjust outliers and say so in one line if you do.

DEDUPLICATE across lenses: findings that describe the same underlying defect (same file, same/overlapping lines, fixes that collapse into one edit) MUST be merged into ONE entry — keep the highest severity and the clearest why, credit the other lens in one clause. Never list per-lens duplicates as separate findings.

${isRereview ? `This is a RE-REVIEW (round ${(priorRound.round || 1) + 1}). Produce, in order:
1. \`## Verdict\` — driven ONLY by Still-open + Regressed + New Confirmed findings (Block on any Critical/High; Warning on Medium; else Approve). Resolved and Carried NEVER change the verdict.${notRun.length ? ` Append " · ⚠️ INCOMPLETE — parts of the review did not run: ${notRun.join('; ')}; findings may be undercounted." to the verdict line.` : ''}
2. \`## Gate\` — ${JSON.stringify(mergedProvenance)}.
3. \`## ✅ Resolved\` — prior findings the fixes closed (one line each); omit if empty.
4. \`## 🔴 Still open\` — prior findings still present; \`severity · file:line · [ruleId] · what · why\`; omit if empty.
5. \`## ⚠️ Regressed\` — new defects the fixes introduced at a prior site; omit if empty.
6. \`## 🆕 New\` — Confirmed findings from the delta lenses (same format); omit if empty.
7. \`## 🔽 Carried\` — dismissed priors (rejected/justified) carried forward unchanged, collapsed to a count + one-line list; omit if empty.${uncoveredFiles.length ? `\n8. \`## Not reviewed\` — these changed files match no active language profile and were NOT reviewed; list them verbatim: ${JSON.stringify(uncoveredFiles)}` : ''}${criticNotes ? `\n9. \`## Coverage gaps\` — surface verbatim: ${JSON.stringify(criticNotes)}` : ''}
RE-REVIEW DATA (JSON): ${JSON.stringify(rereviewData, null, 2)}` : `Produce, in order:
1. \`## Verdict\` — one line (emoji + reason).${notRun.length ? ` Append " · ⚠️ INCOMPLETE — parts of the review did not run: ${notRun.join('; ')}; findings may be undercounted." to the verdict line.` : ''}
2. \`## Gate\` — ${JSON.stringify(mergedProvenance)}.
3. \`## Confirmed\` — findings by severity (Critical first), each as \`severity · file:line · [ruleId] · what · why · fix\` and a blast-radius note when present. Include the \`ruleId\` in brackets when the finding has a non-empty one; omit the brackets otherwise.
4. \`## Suspected (needs confirmation)\` — same format; omit the section if empty.
5. \`## Fix first\` — the few highest-leverage Confirmed items.
${uncoveredFiles.length ? `6. \`## Not reviewed\` — these changed files match no active language profile and were NOT reviewed; list them verbatim: ${JSON.stringify(uncoveredFiles)}` : ''}
${criticNotes ? `7. \`## Coverage gaps\` — surface verbatim: ${JSON.stringify(criticNotes)}` : ''}`}

CONFIRMED (JSON): ${JSON.stringify(confirmed, null, 2)}

SUSPECTED (JSON): ${JSON.stringify(suspected, null, 2)}`,
  { label: 'synthesis', phase: 'Synthesize', effort: 'medium' },
)

// Optional: post Confirmed findings as inline PR comments (best-effort).
if (postComments && confirmed.length) {
  await ragent(
    `Post these Confirmed code-review findings as inline comments on the current branch's PR using \`gh\`. If gh is missing/unauthenticated or there is no PR, do nothing and report that — never fail.
For each finding with a real file:line, add a review comment "[severity] why — fix" anchored to that file:line. Findings:
${JSON.stringify(confirmed.map(f => ({ file: f.file, line: f.line, severity: f.severity, why: f.why, fix: f.fix })), null, 2)}`,
    { label: 'pr-comments', phase: 'Synthesize', effort: 'low' },
  )
}

const allReviewFindings = confirmed.concat(suspected)
const totalVerified = confirmed.length + suspected.length + dropped
let recordVerdict = isRereview
  ? rereviewVerdict({ stillOpen: adjudicated.stillOpen, regressed: adjudicated.regressed, neu: confirmed })
  : finalVerdict(confirmed)
// Strict-mode maintainability escalation applies to a re-review too (finalVerdict already covers the
// first-pass path): a Confirmed Medium+ maintainability finding among the live re-review set blocks.
if (isRereview && strict && [...adjudicated.stillOpen, ...adjudicated.regressed, ...confirmed]
  .some(f => isMaintainability(f) && (f.severity === 'Critical' || f.severity === 'High' || f.severity === 'Medium'))) {
  recordVerdict = 'Block'
}
// Persist the ledger so round N+1 can find round N. On a re-review, carry the still-relevant priors
// forward (still-open/regressed as 'open', dismissed carried with their disposition) UNIONed with the
// new delta findings; resolved priors are intentionally dropped. Without this the ledger would hold
// only this round's delta, and a finding open across 3+ rounds — or a dismissed finding — would
// silently vanish after one hop.
const toLedgerEntry = (f, disposition, tier) => ({
  fp: f.fp || fingerprint(f), file: f.file || '', line: f.line || 0, symbol: f.symbol || '',
  severity: f.severity, tier: tier || f.tier || 'suspected', disposition: disposition || f.disposition || 'open',
  source: f.source || '', ruleId: f.ruleId || '', title: f.title || '', why: f.why || '',
})
const reviewLedger = isRereview
  ? [
    ...confirmed.map(f => toLedgerEntry(f, 'open', 'confirmed')),
    ...suspected.map(f => toLedgerEntry(f, 'open', 'suspected')),
    ...adjudicated.stillOpen.map(f => toLedgerEntry(f, 'open')),
    ...adjudicated.regressed.map(f => toLedgerEntry(f, 'open')),
    ...adjudicated.carried.map(f => toLedgerEntry(f, f.disposition)),
  ]
  : allReviewFindings.map(f => toLedgerEntry(f, 'open', confirmed.includes(f) ? 'confirmed' : 'suspected'))
await logRun(reviewRecord({
  verdict: recordVerdict + (notRun.length ? ' (INCOMPLETE)' : ''),
  round: priorRound ? (priorRound.round || 1) + 1 : 1,
  findings: summarizeFindings(allReviewFindings),
  ledger: reviewLedger,
  dimensions: results.flatMap(r => r.plan.lenses.map(l => {
    const s = summarizeFindings(r.confirmed.filter(f => (f.source || '') === l))
    const confirmedCount = r.confirmed.filter(f => (f.source || '') === l).length
    const suspectedCount = r.suspected.filter(f => (f.source || '') === l).length
    const refutedCount = (r.refuted || []).filter(f => (f.source || '') === l).length
    return { dimension: `${r.profile.id}:${l}`, verdict: '', findingCount: s.total, bySeverity: s.bySeverity, confirmedCount, suspectedCount, refutedCount }
  })),
  verification: { candidates: totalVerified, confirmed: confirmed.length, refuteRate: totalVerified ? Math.round((dropped / totalVerified) * 100) / 100 : 0 },
  notRun,
}))

// If the synthesis agent died even after the retry, don't lose the whole run — assemble a
// mechanical report from the verified findings (unmerged, but complete).
function fallbackReport() {
  // On a re-review the verdict must come from recordVerdict (still-open+regressed+new), NOT
  // finalVerdict(confirmed) — confirmed holds only the delta, so finalVerdict would print a false
  // Approve and hide live still-open/regressed priors. Render those tracks too.
  const emoji = { Block: '⛔ Block', Warning: '⚠️ Warning', Approve: '✅ Approve' }[isRereview ? recordVerdict : finalVerdict(confirmed)]
  const fmt = f => `- ${f.severity} · \`${f.file || '?'}:${f.line || 0}\`${f.ruleId ? ` · [${f.ruleId}]` : ''} · ${f.title} · ${f.why} · Fix: ${f.fix}`
  const bySev = a => a.slice().sort((x, y) => (SEV_RANK[x.severity] ?? 9) - (SEV_RANK[y.severity] ?? 9))
  return [
    `## Verdict`,
    `${emoji} — synthesis agent died twice; mechanical fallback report (findings listed unmerged).${notRun.length ? ` · ⚠️ INCOMPLETE — parts of the review did not run: ${notRun.join('; ')}.` : ''}`,
    ``, `## Gate`, mergedProvenance,
    ...(isRereview && adjudicated.stillOpen.length ? [``, `## 🔴 Still open`, ...bySev(adjudicated.stillOpen).map(fmt)] : []),
    ...(isRereview && adjudicated.regressed.length ? [``, `## ⚠️ Regressed`, ...bySev(adjudicated.regressed).map(fmt)] : []),
    ``, `## ${isRereview ? '🆕 New' : 'Confirmed'}`, ...(confirmed.length ? bySev(confirmed).map(fmt) : ['- none']),
    ...(suspected.length ? [``, `## Suspected (needs confirmation)`, ...bySev(suspected).map(fmt)] : []),
    ...(uncoveredFiles.length ? [``, `## Not reviewed (no language profile)`, ...uncoveredFiles.map(f => `- ${f}`)] : []),
  ].join('\n')
}

return report || fallbackReport()
