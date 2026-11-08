---
name: review-init
description: >-
  Set up your own review profile of a repository for the craft CLI review — `craft init` — kept outside the repository (~/.craft/projects/<id>/review.toml), never committed: the integration points, the external systems this code talks to over the network or through their API and contracts (an operator's kube-ovn, LINSTOR, a cloud API), each with its source git URL and the tag or full commit that counts as deployed. The review reads each one's source at that revision. It proposes the project memory's `external` records, each with the revision its version file names now, for you to confirm. Use before the first cli-review of a repository, when a report says `not recorded: <system>`, or when a deployed version changes. Triggers: craft init, set up my review profile, which systems does this code integrate with, integration points for the review, the deployed version changed. Not for library dependencies (a review finds those itself), nor the project's shared memory (memory).
---

# review-init — your review profile of a repository

`craft init` keeps, per reviewer and per repository, the systems the code **integrates with**:
it calls them over the network or through their API, or implements their contract (a
Kubernetes operator watching kube-ovn's CRDs, a client of LINSTOR's REST API). A review reads
each one's source at the revision you name, so a claim about how that system behaves rests on
its code, not on memory. Library dependencies are not asked for: the review opens the version
the lockfile pins on its own.

The binary cannot ask you anything inside an agent session. So: **propose, ask, write.**

## 1. Recall the memory's external systems

The project's shared memory may already record the systems the code relies on (`external`
records, kept by the craft:memory skill). Recall them with that skill — every active `external`
record, every scope — and keep the list as JSON, each record with `system`, `repo`, `scope` and
`versionFrom` with `versionMatch`, or a stated `version`. None recalled, or no memory configured:
go on without it.

## 2. Get the binary and propose

```sh
CRAFT_BIN="$(node "<this skill's base directory>/../../lib/craft-bin.mjs" ensure)" || exit $?
printf '%s' '<the recalled records as one JSON list>' | "$CRAFT_BIN" init --propose --cwd "$(git rev-parse --show-toplevel)" --craft-root "<this skill's base directory>/../.." --memory-externals -
```

With nothing recalled, drop the pipe and `--memory-externals -`. A local build (`cargo build
--release` in craft's `cli/`) can stand for `$CRAFT_BIN`. It prints one JSON object: `profile`
(the file's path, outside the repository), `exists`, `integrations` (what the profile holds now:
`name`, `repo`, `ref`), `memory` and `discovery`. It writes nothing.

- `memory` — the recalled records as candidates, each with `system`, `repo` (its source), `ref`
  (the revision read now from its `versionFrom` file with its `versionMatch` pattern, or its
  stated `version`), `scope`, `point` (the `--point` that writes it), `profileRef` (the revision
  the profile holds for that system, `null` when none) and, when the point would be refused,
  `refused` with why; `refused` at the top names each record that gave no candidate (withdrawn,
  a field missing, its file unreadable or naming no version). `ran: false` with `why` when no
  records were given or they could not be read.
- `discovery` — the candidates the repository's deployment manifests name (Helm charts and
  values, kustomizations, compose files, plain manifests, Terraform git modules) that neither the
  profile nor the memory covers, each with `system`, `repo` (empty or `repoGuessed` when unsure)
  and the `version` the manifest reads; `ran: false` with `why` when it could not run.

## 3. Find the rest in the code, then ask

Manifests name what the project **deploys**; an operator usually talks to systems it does not
deploy. Look in the code for clients and contracts of external systems: Kubernetes clients of
another project's CRDs or API groups, generated API clients, gRPC or OpenAPI specs vendored
from another project, SDK imports of a service. Leave out the project's own components and
plain libraries.

Then ask the reviewer in words, one numbered list of every candidate (from the profile, the
memory, the discovery and the code), each with what you found and where — a memory record with
its system, its source and the revision its file names now, and the profile's own revision beside
it when they differ:

- which of these the code really integrates with (drop the rest; add any you missed) — a memory
  record is a candidate like any other, written only on the reviewer's yes;
- for each, the git URL of its source (correct a guessed or empty one);
- the **deployed** revision: a tag (`v1.12.3`) or a full 40-character commit — never a branch
  name, which the review refuses because its cache would serve it stale. A bare version whose
  upstream tag carries a `v` is resolved to it.

Tell the reviewer the revision is the profile's word: when the deployment moves to another
version, run this again.

## 4. Write

```sh
"$CRAFT_BIN" init --write --cwd "$(git rev-parse --show-toplevel)" \
  --point 'kube-ovn=https://github.com/kubeovn/kube-ovn.git@v1.12.3' \
  --point 'linstor=git@github.com:LINBIT/linstor-server.git@v1.29.0'
```

`--write` replaces the whole list: pass every point to keep, the ones already there included.
At most 8; a name is letters, digits, `.`, `_` or `-`. A confirmed memory record goes in as its
`point`, as printed. A refused point is named on stderr and nothing is written; so is a profile
written by a craft of another format. Report the file's path and the points written.

## What the review does with it

`craft review start` reads the profile and fetches each point's source, shallow, into
`~/.craft/sources/<host>/<path>@<ref>` (or `$CRAFT_SOURCES_DIR`), once per revision. A source
it cannot fetch (no network, no git, a branch, an unknown tag) is named in the report's
**External sources** section, and that system is reviewed without its context; the review goes
on. A finding that names a system the profile lacks prints `not recorded: <system>`: come back
here.
