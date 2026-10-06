# Compatibility — the catalogue

Every class from [SKILL.md](SKILL.md), in full. Each entry has the same four parts:

- **Question**: what to ask of the changed surface.
- **Answer needed**: the concrete fact that closes the question. "Probably fine" is not an answer.
- **Where**: the carrier the answer comes from. Most of these are outside the diff.
- **Finding / fix shape**: what to report when the answer is missing or wrong.

Language details (Rust/serde, Go, TypeScript, Kubernetes) appear as examples only. The questions
apply to any surface that a party running a different version reads, calls or deploys against.

## C1 — Old data under the new shape

- **Question**: can data already persisted under the OLD shape still be read by the new code?
  "Persisted" covers database rows (JSON/JSONB, blob, enum columns), caches, event logs, message
  queue payloads, config/state files on disk, and objects in a cluster's store.
- **Answer needed**: for every type whose serialized form the diff changes, the decode result of
  an old-shape value under the new type, and the backfill or migration that rewrites old values
  if decoding fails.
- **Where**: the type's serialization attributes before and after (`git show <tag>:<file>`), every
  place that type is persisted, and the migration directory.
- **Examples**: Rust — a field renamed with no `#[serde(alias)]`, a new field without
  `#[serde(default)]`, a reordered enum under `bincode`, a changed `Display`/`FromStr` used as a
  storage key. Go — a changed `json:"…"` tag, a field made non-pointer so absent decodes to zero.
  TS — a zod/io-ts schema that makes a previously optional key required.
- **Finding**: every stored record of the old shape fails to decode (or decodes to a wrong zero
  value) until rewritten. Fix: accept the old shape on read (alias, default, optional), or ship a
  backfill that runs before the new reader.

## C2 — Rolling deploy, both directions

- **Question**: while old and new replicas run concurrently (rolling deploy, canary, a rollback),
  does the new writer still emit what old readers require, AND does the new reader accept what old
  writers emit?
- **Answer needed**: two answers, one per direction, for every changed representation that crosses
  between replicas (shared DB, queue, cache, RPC between services of different versions).
- **Where**: the old version's reader and writer (previous release's source), and the new ones.
- **Examples**: a bare rename breaks old readers even if new readers alias the old key; keep the
  serialized key stable (Rust: `#[serde(rename = "<old-key>")]` on the renamed field) or split the
  flip across two deploys — first all readers understand both keys, then writers flip.
- **Finding**: name the direction that breaks and the deploy window in which it happens. A
  rollback re-opens the same window in reverse.

## C3 — Read-only alias

- **Question**: does an alias, fallback or "accept both" cover only new-code-reads-old-data, while
  old code (during a rollout or after a rollback) must read what new code writes?
- **Answer needed**: which key/value the new code WRITES, and whether the old code reads it.
- **Where**: the writer in the diff and the old reader.
- **Examples**: Rust `#[serde(alias = "<old>")]`; a Go decoder that tries two keys; a config loader
  that reads `NEW_VAR || OLD_VAR` but a tool that writes only `NEW_VAR`.
- **Finding**: call the asymmetry out explicitly — the alias makes the change look compatible and
  covers half of it.

## C4 — Migration against running code

- **Question**: does a migration rename, retype, drop, tighten (NOT NULL, CHECK, unique) or
  re-enumerate something the code still running at migration time reads or writes?
- **Answer needed**: when the migration runs relative to the code rollout (before, after, in the
  same deploy), and what the old code does against the migrated schema.
- **Where**: the migration, the deploy order (pipeline, init container, helm hook), and the old
  code's queries.
- **Finding**: old replicas fail queries or writes for the length of the rollout. Fix: expand →
  migrate code → contract, across separate deploys.

## C5 — CLI contract

- **Question**: is a flag, short flag, subcommand, positional argument, exit code, or output format
  (text columns, JSON keys, stdout vs stderr, a line that scripts grep) removed, renamed or changed?
- **Answer needed**: the old invocation and the old output, and what the new binary does with them:
  accepts with a deprecation warning, rejects with an error naming the replacement, or silently
  does something else.
- **Where**: the argument parser before and after, `--help` of the released binary, scripts, CI
  files, docs and charts that invoke it (grep the repo and its dependents).
- **Finding**: a silent change (a flag now ignored, an exit code 0 where it was non-zero, a renamed
  JSON key) is the worst case: scripts keep "working" wrongly. Fix: keep the old spelling as a
  deprecated alias for a release, or fail loudly naming the new one.

## C6 — Config, env and chart surface

- **Question**: is a config file key, environment variable or Helm `values.yaml` key renamed,
  removed, moved under another parent or retyped?
- **Answer needed**: what happens to a deployment that still sets the OLD name: is it read, is it
  rejected with a message naming it, or is it silently ignored so the default applies?
- **Where**: the config loader / env reads, `values.yaml` and the templates that consume it, the
  chart's `values.schema.json`, and existing users' values (examples, other charts, docs).
- **Finding**: an ignored old key silently reverts the user's setting to the default. Fix: read
  both for a release, or fail on the old key with a pointer to the new one (Helm: `fail` in a
  template, or a schema that rejects the old key).

## C7 — Changed default

- **Question**: does a default value change (a timeout, a feature enabled, a policy, a port, a
  retention, a replica count, a log format)?
- **Answer needed**: who never set the option, and what their behaviour becomes.
- **Where**: the default before and after, the release notes, the chart defaults.
- **Finding**: every user who relied on the old default changes behaviour on upgrade with no
  action of their own. Report it as breaking unless the release notes say so and the change is
  intended.

## C8 — Schema field removed, required or narrowed

- **Question**: in a CRD, JSON Schema, OpenAPI or database schema, is a field removed, made
  required, narrowed (enum value dropped, pattern, min/max or maxLength tightened, a type changed)
  while objects or clients written under the old schema exist?
- **Answer needed**: what happens to existing stored objects (they keep validating only on
  write — the next update of an old object is rejected) and to clients still sending the old shape.
- **Where**: the schema before and after (`git diff <tag> -- <crds dir>`), stored objects, clients.
- **Finding**: Kubernetes structural schemas prune unknown fields — a removed field is silently
  dropped on the next write; a newly required field rejects every update of an old object. Fix:
  add a new version, or keep the field optional with a default.

## C9 — API version lifecycle

- **Question**: is a new API version added with no conversion (no webhook, `strategy: None` while
  schemas differ), the storage version switched with no migration of already-stored objects, or a
  version marked `served: false` / removed while clients or stored objects still use it?
- **Answer needed**: the `versions[]` list before and after (`served`, `storage`), the conversion
  strategy, and the storage-version migration plan (`status.storedVersions`).
- **Where**: the CRD manifest(s), the conversion webhook, the clients' pinned versions.
- **Finding**: an unserved version breaks every client still on it; a removed version that is still
  in `status.storedVersions` blocks the CRD update. Fix: serve both with conversion, migrate stored
  objects, then stop serving.

## C10 — IDL break

- **Question**: in proto / OpenAPI / GraphQL / Avro / Thrift, is a field number reused or
  renumbered, a type changed, an enum value removed or renumbered, a field made required, an
  endpoint or method removed or renamed, a response field dropped?
- **Answer needed**: the wire meaning of an old message under the new definition, both directions.
- **Where**: the IDL before and after; `buf breaking` / `oasdiff` / a schema registry's
  compatibility check where the repo has one — run it if it is there.
- **Finding**: a reused field number decodes old bytes as the wrong field, silently. Fix: `reserved`
  the old number and name, add new fields only.

## C11 — Rollout order across components

- **Question**: when components ship or upgrade separately — a controller image vs the chart and
  CRDs, a client vs a server, a producer vs a consumer, an agent vs its control plane — does every
  order the release process allows work?
- **Answer needed**: the allowed orders (chart CRDs applied before or after the image? clients may
  lag servers by how many versions?) and the behaviour of each mixed pair: new controller + old
  CRD/chart, old controller + new CRD, new client + old server, old client + new server.
- **Where**: the chart (CRDs in `crds/` are not upgraded by `helm upgrade`), `appVersion` / image
  pin, the deploy pipeline, the upgrade doc, the version-skew policy.
- **Finding**: a new controller reading a field the old CRD schema prunes, or a new client calling
  an endpoint the old server lacks with no fallback. Name the pair and the order.

## C12 — Renamed exported identifier

- **Question**: is an exported name that consumers reference renamed or removed — a package export,
  a public function or type, an RPC method or HTTP route, a metric name or label key, an event
  type, a feature flag name, a plugin's skill, agent or workflow name, a CLI subcommand?
- **Answer needed**: every consumer of the old name (in the repo and outside it), and whether the
  old name still resolves (alias, re-export, redirect, deprecation shim).
- **Where**: grep the whole repository for the old name, including docs, configs, charts,
  dashboards and alert rules; dependents via forge code search; cross-references by string
  (`plugin:skill` references, `subagent_type`, dashboards querying a metric).
- **Examples**: Go — a renamed exported identifier breaks every importer at compile time; TS — a
  removed named export breaks at bundle time; a renamed Prometheus metric breaks dashboards and
  alerts silently; a renamed skill or agent leaves every `plugin:<name>` reference dangling.
- **Finding**: name the consumers left dangling and whether they fail loudly or silently.

## C13 — Regression or standing state

- **Question**: is the break new in this change, or was it already in the last release?
- **Answer needed**: the last released tag (`git describe --tags --abbrev=0`, or the release list
  on the forge) and the surface at that tag (`git show <tag>:<file>`, `git diff <tag> -- <surface>`).
- **Where**: the tag, not the merge base: unreleased commits on trunk have no consumers yet.
- **Finding**: a contract PRESENT in the release and GONE at HEAD is a regression and raises
  severity; a break already shipped is a standing state — report it, but say which it is. A break
  between two unreleased commits on trunk affects nobody outside the repo.
