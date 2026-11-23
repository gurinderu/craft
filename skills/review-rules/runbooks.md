# Runbooks — a procedure reviewed step by step

A runbook is a Markdown file whose steps an operator runs against live systems: shell blocks, or
numbered steps, that call a cluster, a forge, a cloud, a database or a host (`kubectl`, `gh`,
`helm`, `terraform`, `curl` to a URL, `psql`, `aws`, `ssh` and the like; a build or a package
manager's command, which runs in the checkout, is no such step). The review takes such a file as a
procedure, not as prose, when its change touches a step: its defects are what happens to the system when someone follows it.

## Walk it as the operator will

Read the changed steps in order and, for each command, say what it does in the system it talks to.
Then ask, step by step:

1. **What state does it assume, and does anything check it?** A reference the command it reads
   from does not show (pod annotations do not carry the owner a later step needs; an object name
   only a template binding resolves), an id taken from an earlier step's output that no step
   prints, a precondition no earlier step establishes or verifies.
2. **What can move between two steps?** A controller, an operator, an autoscaler, a cron job or a
   second operator acting between step N and N+1, so what step N read is stale: a pod recreated, a
   lease taken back, a resource reconciled back to its old spec.
3. **What is irreversible, and what stops a wrong one?** Deletes, overwrites, force flags, data
   and schema changes, merges, releases. Is there a dry run, a check, a backup step before it? What
   does a retry do after a step half-succeeded?
4. **Does it still match the code beside it?** A command, flag, name, path, port, label or order
   that the repository's code, manifests or charts no longer use. Open them.
5. **Can it run as written?** A missing namespace or context flag, a construct that breaks when
   pasted, a placeholder never named.
6. **What does it expose or open?** A password, token or key on a command line or in a URL, a
   secret echoed, a credential fetched from an unpinned URL or piped into a shell, a grant wider
   than the step needs, a destructive command with no guard (a dry run, a confirmation, a check
   of the target) before it.

The review reads the procedure; it never runs a step of it.

## Other systems' behaviour

A claim about how an external system answers a step stands on that system's source at the version
the consumer deploys. When the review lists it among its external sources, cite the line you
opened; otherwise open it yourself or leave the claim as an open question. Such a finding is
usually **EXT**; a step racing a controller is **RACE**; a step whose effect has no record to
resume from is **RECOV**; a step that no longer matches the code is **DOCS** rated by what the
operator then does (sweeps.md §5).

## Severity

Rate by the harm of following the procedure (severity.md): a step that deletes or corrupts what
cannot be restored is `data-loss` or `irreversible`; a secret exposed or access widened is
`security`; one that wedges a system an operator must recover by hand is `operator-recovery`; a
wrong command that fails loudly and harms nothing is optional. Wording, formatting and style are
not findings.
