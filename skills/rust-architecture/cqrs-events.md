# CQRS and event sourcing

Two related-but-separable patterns that sit on top of the hexagonal core. Both are **powerful and
frequently over-applied** — read "when not to" before reaching for them.

## CQRS — separate the write model from the read model

Commands (change state) and queries (read state) often want different shapes: the write side
enforces invariants; the read side is denormalized for fast display. CQRS gives them separate
models instead of one struct serving both badly.

```
Command side: CreateOrder ─▶ domain Service ─▶ enforce invariants ─▶ persist
Query side:   GET /orders ─▶ read model (denormalized view) ─▶ return DTO directly
```

- The **command** path is your normal hexagonal domain (→ [ports.md](ports.md)): validated
  models, typed errors, repository.
- The **query** path can bypass the domain entirely — read an optimized projection/view straight
  to a response DTO. Forcing reads through aggregates is a common source of needless complexity.

CQRS does **not** require two databases or event sourcing — at its lightest it's just "don't reuse
the write entity as the read DTO" (which you already do in `rust-web`). Scale up to separate
stores only when read/write load genuinely diverges.

## Event sourcing — events are the source of truth

Instead of storing current state, store the **sequence of events** that produced it; current
state is a fold over events.

```rust
enum AccountEvent {                          // immutable facts, past tense
    Opened { owner: CustomerId },
    Deposited { amount: Money },
    Withdrawn { amount: Money },
}

#[derive(Default)]
struct Account { balance: Money, open: bool }

impl Account {
    fn apply(&mut self, e: &AccountEvent) {  // pure: event -> state transition
        match e {
            AccountEvent::Opened { .. }      => self.open = true,
            AccountEvent::Deposited { amount } => self.balance += *amount,
            AccountEvent::Withdrawn { amount } => self.balance -= *amount,
        }
    }
    fn rebuild(events: &[AccountEvent]) -> Self {     // fold the log to get current state
        let mut a = Account::default();
        for e in events { a.apply(e); }
        a
    }
}
```

The flow: a **command** is validated against current (rebuilt) state → emits one or more
**events** → events are appended to an immutable **event store** → **projections** consume the
event stream to build read models (CQRS read side).

- **Append-only**: events are never mutated or deleted; a mistake is corrected by a new
  compensating event. This is exactly the ledger discipline in `rust-fintech` (a double-entry
  ledger *is* event sourcing).
- **Snapshots**: for long streams, persist periodic state snapshots so `rebuild` doesn't replay
  from the beginning every time.
- **Schema evolution**: events are persisted forever — version them and write upcasters; you
  can't "migrate" history the way you alter a table.
- **Audit & time-travel** come for free: the log *is* the history; you can replay to any point.

## When NOT to (read this first)

Event sourcing is a big commitment with real costs: eventual consistency on the read side, event
versioning forever, more moving parts, harder debugging. Don't adopt it because it's elegant.

- Reach for **event sourcing** only when you genuinely need an audit trail, temporal queries, or
  to derive many read models from one write stream (finance, ledgers, workflow/audit-heavy
  domains).
- Reach for **CQRS (the heavy kind)** only when read and write scaling/shapes truly diverge.
- For most CRUD apps, a plain hexagonal service over a normal database (→ [ports.md](ports.md),
  `rust-web`) is correct — and the lightweight "read DTO ≠ write entity" is all the CQRS you need.

## Boundaries

- The base hexagonal structure these build on → [SKILL.md](SKILL.md) / [ports.md](ports.md).
- The ledger instance of event sourcing (idempotency, balanced entries) → `rust-fintech`.
- Event/command types as `enum`s with exhaustive handling → `rust-traits`; their errors →
  `rust-errors`.
