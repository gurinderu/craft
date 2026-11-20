# SQL review — rule catalog

Stable IDs for the checklists in `SKILL.md`. A finding that maps to a rule **cites its ID** (e.g.
`MIG-004`) so it is addressable, dedup-able across rounds, and greppable in a report. IDs are
append-only: never renumber or reuse a retired ID.

This catalog **mirrors** the `SKILL.md` checklists — the checklists are the prose, this is the index.
Each severity is the rule's **default**, bounded by the harm cap of the `review-rules` skill
(`severity.md`) — a finding is never rated above the harm it names. Not every finding maps to a
catalog rule (novel issues are fine — report them without an ID).

| ID | Severity | Rule |
|---|---|---|
| **MIG-001** | HIGH | ACCESS EXCLUSIVE or SHARE lock held through a scan, rewrite or index build on a table with traffic |
| **MIG-002** | HIGH | Table rewrite on a large table (non-coercible type change, volatile default, stored generated column) |
| **MIG-003** | HIGH | `ADD COLUMN … NOT NULL` without a default on a table with rows; `SET NOT NULL` scanning under ACCESS EXCLUSIVE |
| **MIG-004** | HIGH | `CREATE INDEX` on an existing table without `CONCURRENTLY`; `CONCURRENTLY` inside a transaction, beside another statement in its file, or on a partitioned parent |
| **MIG-005** | MEDIUM | Backfill of a large table in one statement or in the DDL's transaction |
| **MIG-006** | HIGH | Rollout order: old code broken by the new schema, or new code by the old |
| **MIG-007** | MEDIUM | Down migration missing where the repository keeps them, or unable to restore what the up removed |
| **MIG-008** | HIGH | Migration version reused, out of order against the trunk, or an applied migration edited |
| **MIG-009** | HIGH | `NOT VALID` and its `VALIDATE CONSTRAINT` (or CHECK → VALIDATE → `SET NOT NULL`) in one transactional migration: the first lock held through the scan |
| **QRY-001** | HIGH | Query does not match the schema: a missing column, a wrong type, a nullable column decoded as non-null |
| **QRY-002** | HIGH | NULL or join semantics returning wrong rows (`= NULL`, `NOT IN` over NULL, LEFT JOIN made inner, fan-out) |
| **QRY-003** | HIGH | Read-then-write race, an unretried serialization failure, a statement outside its transaction |
| **QRY-004** | MEDIUM | New query on a growing table with no index serving it |
| **QRY-005** | MEDIUM | N+1: a query per row or per loop item |
| **QRY-006** | CRITICAL | Query text built from outside input instead of a bind parameter |

## Adding a rule

Append a new ID under the right prefix (next free number); never renumber existing rows. Keep the
row in sync with the `SKILL.md` checklist prose. Prefixes: `MIG` migrations · `QRY` queries.
