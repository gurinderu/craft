---
name: compatibility
description: >-
  Backward compatibility of a change in any language — the questions a review must answer about everyone still holding the old shape: data persisted under the old shape, old and new replicas in a rolling deploy, migrations against running code, an alias that only covers reading, the public contract (CLI flags, exit codes, output format, config keys, env vars, Helm values, changed defaults), API/schema versions (CRD fields removed, required or narrowed, a version with no conversion or no longer served, proto/OpenAPI breaks), rollout order across components, renamed exported names, and a diff against the last released tag. Use when reviewing or writing a change to a stored or wire format, a CLI, config, a chart, a CRD, a public API or an exported name. Triggers: backward compatibility, breaking change, rolling deploy, schema migration, CRD version, deprecate a flag, rename a field. Not for a Rust crate's semver alone (rust-ecosystem), nor refactors with no outside consumer (refactoring).
---

# Compatibility — what the holders of the old shape make of the change

A change is compatible only if every party that still holds the **old** shape keeps working: rows
written last month, a replica not yet rolled, a script parsing yesterday's output, a chart pinned
one release back, a client that never upgrades, a repository that references a name. The break is
almost never visible on the changed line. It sits in a reader or caller the diff does not show.
This skill is a list of **questions**, each with the answer a reviewer must produce and where that
answer lives. A question you cannot answer from evidence is a finding to raise as open, not a pass.

## How to work it

```
1. MAP      — list every surface the diff changes that something OUTSIDE this version reads, calls
              or runs against: stored data, wire messages, CLI/config/env/chart surface, API/schema
              versions, exported names. For each, name the consumers and the versions they run.
2. ASK      — run each class below against that map. Skip a class only by saying why it cannot apply.
              Apply each class to EVERY instance in the diff, not to the first convenient one.
3. SOURCE   — answer from the carrier named in "where", not from comments or the PR text.
4. BASELINE — diff each surface against the last released tag (C13): a break present at HEAD and
              absent from the release is a regression; one already released is a standing state.
5. REPORT   — a finding names the old party, the new shape, and the sequence (write → upgrade →
              read, or the deploy order) that produces the failure, and says what it does NOT
              establish (live data actually affected, consumers actually broken).
```

## The classes

Each class: **question → the answer needed → where to get it.** Full wording, examples and the
fix shape for every class are in [catalogue.md](catalogue.md).

| # | Class | The question |
|---|---|---|
| C1 | Old data under the new shape | Can data already persisted under the old shape (rows, blobs, caches, event logs, queue payloads, state files) still be read by the new code, with no backfill? |
| C2 | Rolling deploy, both directions | While old and new run together, does the new writer still emit what old readers require, AND does the new reader accept what old writers emit? |
| C3 | Read-only alias | Does an alias / fallback / "accept both" cover only new-reads-old, while old code must also read what the new code writes? |
| C4 | Migration vs running code | Does a migration rename, retype, drop or tighten something the old code still reads or writes during the rollout? |
| C5 | CLI contract | Is a flag, subcommand, positional, exit code or output format (columns, JSON keys, stdout vs stderr) that scripts depend on removed, renamed or changed? |
| C6 | Config, env and chart surface | Is a config key, env var or Helm value renamed, removed or retyped, with the old name neither read nor rejected loudly? |
| C7 | Changed default | Does a default change behaviour for every user who never set the option? |
| C8 | Schema field narrowed | Is a CRD/schema field removed, made required, narrowed (enum shrunk, pattern or range tightened) or retyped while objects or clients under the old schema exist? |
| C9 | API version lifecycle | Is a new version added with no conversion, the storage version switched with no migration of stored objects, or a version no longer served while clients or stored objects still use it? |
| C10 | IDL break | Does a proto / OpenAPI / GraphQL / Avro change reuse or renumber a field, change a type, drop a value or tighten required-ness? |
| C11 | Rollout order across components | When components ship separately (controller vs chart/CRDs, client vs server, producer vs consumer), does every allowed order of upgrade work? |
| C12 | Renamed exported identifier | Is an exported name that consumers reference (a package export, an RPC or route, a metric or label, a skill, agent or workflow name, an event type) renamed with no alias? |
| C13 | Regression or standing state | Against the last released tag, is the break new in this change, or already shipped? |

C1, C2, C4, C8, C9, C11, C12 and C13 need evidence from **outside the diff**: stored data, the
previous version's reader, the served/storage version list, the other component's release, the
consumers of a name, the released tag. Read that source; the diff alone cannot answer them.

## Where answers live

| Answer | Carrier |
|---|---|
| What is already stored | the schema/migration history, the persistence layer's (de)serializer, a sample of stored data |
| What the old version reads and writes | the previous release's source (`git show <tag>:<file>`) |
| What consumers call | grep across the repo, its docs, examples and charts; dependents (forge code search); cross-references by name |
| What versions are served and stored | the CRD's `versions[]` (`served`, `storage`), the conversion webhook, the gateway config |
| What order components ship in | release notes, the chart's `appVersion` / image pin, the deploy pipeline, the upgrade doc |
| Whether a break is new | `git describe --tags --abbrev=0`, then `git diff <tag> -- <surface>` |

## Relation to other skills

Semver of a Rust crate's public API (`cargo semver-checks`) is `rust-ecosystem`; this skill asks
the same question of every other surface and every language. Objects created before a change that
a controller must still handle are also `distributed-races` R6. The review workflow's `compat`
lens reads this catalogue.
