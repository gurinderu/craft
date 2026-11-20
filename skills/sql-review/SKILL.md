---
name: sql-review
description: >-
  SQL code-review rubric for PostgreSQL — migrations (the lock each ALTER form takes, what rewrites a table since PG 11, NOT NULL without a default, CREATE INDEX without CONCURRENTLY, large backfills, rollout order between the old code and the new schema, reversibility, migration-number conflicts between branches) and queries (match with the schema's types and NULLs, joins, transactions and isolation level, an index for a new query, N+1, injection), in .sql files and in query strings embedded in Rust (sqlx, diesel, postgres) or any other code; severity by harm from review-rules. Use when reviewing a migration or a query, asking whether a migration is safe to deploy, or rating a SQL finding. Triggers: review this migration, is this migration safe, ALTER TABLE lock, table rewrite, CREATE INDEX CONCURRENTLY, NOT NULL column, backfill, migration conflict, N+1, sqlx query, isolation level. Not for Rust code beside the query (rust-review) nor for the review workflow itself (craft:review).
---

# SQL Review

The rubric for reviewing SQL: schema migrations and queries, against PostgreSQL semantics unless the
repository names another engine. Severity, finding classes and sweeps come from `review-rules`; this
skill keeps what is specific to SQL. Each item below has a catalog ID in [rules.md](rules.md).

**The review entry point is the `craft:review` workflow.** It sends every changed `.sql` file to the SQL
profile, whose two lenses — `sql-migrations` and `sql-queries` — always run, on the host's default
agent. A Rust or other source file whose changed lines hold a query string (a `sqlx::query`,
`query!`, `query_as!`, `sql_query` call, or a string literal opening with `SELECT`, `INSERT INTO`,
`UPDATE … SET`, `DELETE FROM` or `WITH`) also gets the `sql-queries` lens in its own profile's
review. There is no mechanical SQL gate: the verdict rests on the lenses and their verifiers.

## Facts the checklist rests on

Lock levels (PostgreSQL docs, "Explicit Locking" and `ALTER TABLE`):

| Statement | Lock on the table | Held for |
|---|---|---|
| most `ALTER TABLE` forms (ADD/DROP COLUMN, ALTER TYPE, SET/DROP DEFAULT, SET/DROP NOT NULL, ADD CHECK, ADD UNIQUE/PRIMARY KEY, RENAME) | ACCESS EXCLUSIVE — blocks reads and writes | the statement, plus any scan or rewrite it does |
| `ADD FOREIGN KEY` | SHARE ROW EXCLUSIVE on both tables | the validating scan, unless `NOT VALID` |
| `VALIDATE CONSTRAINT` | SHARE UPDATE EXCLUSIVE — reads and writes go on | the scan |
| `CREATE INDEX` | SHARE — blocks writes | the whole build |
| `CREATE INDEX CONCURRENTLY` | SHARE UPDATE EXCLUSIVE | the build; cannot run in a transaction block; a failed build leaves an INVALID index to drop |
| `DROP INDEX`, `DROP TABLE`, `TRUNCATE` | ACCESS EXCLUSIVE | the statement (`DROP INDEX CONCURRENTLY` avoids it) |

Any lock waits in the queue behind the transactions already holding a conflicting one, and every
later query on the table waits behind it: a brief ACCESS EXCLUSIVE behind one long transaction stops
the table. A migration on a hot table sets `lock_timeout` (and retries) for that reason.

What rewrites the table and its indexes:

| Change | Rewrite? |
|---|---|
| `ADD COLUMN` with no default, or a non-volatile default (a constant, `now()`) | no, since PG 11 |
| `ADD COLUMN` with a volatile default (`gen_random_uuid()`, `clock_timestamp()`, a serial or identity), or a `STORED` generated column | yes |
| `ALTER COLUMN TYPE` to a binary-coercible type (`varchar(n)` → `varchar(m)`, m > n, or → `text`) | no |
| `ALTER COLUMN TYPE` otherwise (`int` → `bigint`, `text` → `int`, `varchar` narrowed) | yes |
| `timestamp` ↔ `timestamptz` | no rewrite from PG 12 when the session time zone is UTC; a rewrite otherwise |
| `SET NOT NULL` | no rewrite, but a full scan under ACCESS EXCLUSIVE — skipped (PG 12+) when a validated `CHECK (col IS NOT NULL)` exists |
| `DROP COLUMN` | no (the column is only marked dropped) |

## Migrations checklist

- **Lock** (MIG-001): a statement that holds ACCESS EXCLUSIVE or SHARE through a scan, a rewrite or
  an index build on a table that has traffic. The safe forms: `CREATE INDEX CONCURRENTLY`, then
  `ADD CONSTRAINT … USING INDEX`; `ADD CONSTRAINT … NOT VALID`, then `VALIDATE CONSTRAINT`.
- **Rewrite** (MIG-002): a type change or added column from the rewrite table above, on a large table.
- **NOT NULL** (MIG-003): `ADD COLUMN … NOT NULL` without a `DEFAULT` fails on a table with rows;
  `SET NOT NULL` without the validated CHECK scans under ACCESS EXCLUSIVE.
- **Index** (MIG-004): `CREATE [UNIQUE] INDEX` on an existing table without `CONCURRENTLY`; with it,
  a migration tool that wraps the file in a transaction (sqlx: opt out with a `-- no-transaction`
  first line; diesel: `run_in_transaction = false` in the migration's `metadata.toml`).
- **Backfill** (MIG-005): one `UPDATE` or `INSERT … SELECT` over a large table, or a backfill in the
  same transaction as DDL — long row locks, any DDL lock held to the end, WAL and replica lag. Batch it,
  outside the schema migration.
- **Rollout order** (MIG-006): during a deploy the old code runs against the new schema (and the new
  code against the old when migrations run after the rollout). A dropped or renamed column or table
  still used on the base, a new NOT NULL column old INSERTs omit, a type old code decodes, an enum
  value old code cannot parse. Expand first, migrate the code, contract in a later release. Grep the
  repository's code in every language for the object.
- **Reversibility** (MIG-007): a down migration missing where the repository keeps them, or one that
  cannot restore what the up removed.
- **Migration numbers** (MIG-008): the base's and the trunk's migrations are listed with
  `git ls-tree --name-only <ref> -- <migrations dir>/`; a version this diff reuses, one that sorts
  before the latest on the trunk (refused by tools that forbid out-of-order, never applied by tools
  that record only the current version), or an edit to a migration the base already holds (a checksum
  mismatch, or a change no applied database ever sees).

A statement on a table the same branch creates has no lock or rollout harm.

## Queries checklist

- **Schema match** (QRY-001): read the table's migrations at HEAD; every column exists with the
  type the code binds and decodes; a nullable column (an outer join's side included) decoded into a
  non-optional type.
- **NULL and joins** (QRY-002): `= NULL`; `NOT IN (subquery)` over a NULL; SUM/MAX over no rows
  returning NULL; a WHERE on a LEFT JOIN's right table; a join on an incomplete key multiplying rows.
- **Transactions** (QRY-003): a read-then-write outside one transaction, or at READ COMMITTED (the
  default) without `FOR UPDATE`, a conditional UPDATE, a unique constraint or `ON CONFLICT`; a
  serialization failure (40001) or deadlock (40P01) never retried; a statement sent on the pool
  instead of the transaction (`&pool` for `&mut *tx` in sqlx); a transaction held across a slow call.
- **Index** (QRY-004): a new WHERE/JOIN/ORDER BY on a growing table with no index whose leading
  columns serve it; a function or cast on the column, or a leading-wildcard LIKE, defeating a b-tree.
- **N+1** (QRY-005): a query per row or per loop item; one query with a JOIN or `= ANY($1)` instead.
- **Injection** (QRY-006): query text built from a value instead of a bind parameter; an
  identifier not quoted with `quote_ident`/`format('%I')`.

## Severity

By the harm cap of `review-rules` (`severity.md`), never above it:

- **must-fix** — `outage`: a table locked or rewritten under traffic, a migration that fails on
  deploy, old code broken by the new schema; `data-loss`: data dropped, truncated or corrupted that
  no durable source restores; `security`: injection from outside input; `intent-unmet`: a query
  that does not do what the change says.
- **should-fix** — a missing index or an N+1 whose traffic is not named; a non-reversible down
  migration where the repository keeps them (a `repo-rule` when its rule is written down).
- **not a finding** — keyword case, formatting, alias or constraint naming, style.

Table size and traffic are premises: cite where they were seen, or say they are unknown.
