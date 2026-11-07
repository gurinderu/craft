---
name: review-init
description: >-
  Set up your own review profile of a repository for the craft CLI review — `craft init` — kept outside the repository (~/.craft/projects/<id>/review.toml), never committed: the integration points, the external systems this code talks to over the network or through their API and contracts (an operator's kube-ovn, LINSTOR, a cloud API), each with its source git URL and the tag or full commit that counts as deployed. The review then reads each one's source at that revision in its lifecycle, compatibility and race lenses and its verifiers. Use before the first cli-review of a repository, when a report says `not recorded: <system>`, or when a deployed version changes. Triggers: craft init, set up my review profile, which systems does this code integrate with, integration points for the review, the deployed version changed. Not for library dependencies (a review finds those itself), nor the project's shared memory (memory).
---

# review-init — your review profile of a repository

`craft init` keeps, per reviewer and per repository, the systems the code **integrates with**:
it calls them over the network or through their API, or implements their contract (a
Kubernetes operator watching kube-ovn's CRDs, a client of LINSTOR's REST API). A review reads
each one's source at the revision you name, so a claim about how that system behaves rests on
its code, not on memory. Library dependencies are not asked for: the review opens the version
the lockfile pins on its own.

The binary cannot ask you anything inside an agent session. So: **propose, ask, write.**

## 1. Get the binary and propose

```sh
CRAFT_BIN="$(node "<this skill's base directory>/../../lib/craft-bin.mjs" ensure)" || exit $?
"$CRAFT_BIN" init --propose --cwd "$(git rev-parse --show-toplevel)" --craft-root "<this skill's base directory>/../.."
```

A local build (`cargo build --release` in craft's `cli/`) can stand for `$CRAFT_BIN`. It prints
one JSON object: `profile` (the file's path, outside the repository), `exists`, `integrations`
(what the profile holds now: `name`, `repo`, `ref`), and `discovery` — the candidates the
repository's deployment manifests name (Helm charts and values, kustomizations, compose files,
plain manifests, Terraform git modules), each with `system`, `repo` (empty or `repoGuessed`
when unsure) and the `version` the manifest reads; `ran: false` with `why` when it could not
run. It writes nothing.

## 2. Find the rest in the code, then ask

Manifests name what the project **deploys**; an operator usually talks to systems it does not
deploy. Look in the code for clients and contracts of external systems: Kubernetes clients of
another project's CRDs or API groups, generated API clients, gRPC or OpenAPI specs vendored
from another project, SDK imports of a service. Leave out the project's own components and
plain libraries.

Then ask the reviewer in words, one numbered list of every candidate (from the profile, the
discovery and the code), each with what you found and where:

- which of these the code really integrates with (drop the rest; add any you missed);
- for each, the git URL of its source (correct a guessed or empty one);
- the **deployed** revision: a tag (`v1.12.3`) or a full 40-character commit — never a branch
  name, which the review refuses because its cache would serve it stale. A bare version whose
  upstream tag carries a `v` is resolved to it.

Tell the reviewer the revision is the profile's word: when the deployment moves to another
version, run this again.

## 3. Write

```sh
"$CRAFT_BIN" init --write --cwd "$(git rev-parse --show-toplevel)" \
  --point 'kube-ovn=https://github.com/kubeovn/kube-ovn.git@v1.12.3' \
  --point 'linstor=git@github.com:LINBIT/linstor-server.git@v1.29.0'
```

`--write` replaces the whole list: pass every point to keep, the ones already there included.
At most 8; a name is letters, digits, `.`, `_` or `-`. A refused point is named on stderr and
nothing is written. Report the file's path and the points written.

## What the review does with it

`craft review start` reads the profile and fetches each point's source, shallow, into
`~/.craft/sources/<host>/<path>@<ref>` (or `$CRAFT_SOURCES_DIR`), once per revision. A source
it cannot fetch (no network, no git, a branch, an unknown tag) is named in the report's
**External sources** section, and that system is reviewed without its context; the review goes
on. A finding that names a system the profile lacks prints `not recorded: <system>`: come back
here.
