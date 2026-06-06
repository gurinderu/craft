# Integrity: idempotency, ledgers, audit

Exact arithmetic isn't enough — a money system must never lose, duplicate, or silently mutate
value, even under retries and crashes.

## Idempotency

Networks retry. A retried "charge $50" must **not** charge twice. Make money-moving operations
idempotent with a client-supplied **idempotency key**:

```rust
// The key uniquely identifies the *intent*. Store it with the result; on a repeat, return the
// stored result instead of acting again.
async fn charge(&self, key: IdempotencyKey, req: ChargeRequest) -> Result<Charge, PayError> {
    if let Some(existing) = self.store.find_by_key(&key).await? {
        return Ok(existing);          // replay: same response, no second charge
    }
    let charge = self.process(req).await?;
    self.store.insert(&key, &charge).await?;   // unique constraint on key enforces it
    Ok(charge)
}
```

Enforce uniqueness at the database (unique index on the key) so two concurrent retries can't both
slip through — the DB is the source of truth, not an in-memory check (→ `rust-concurrency` for the
race, `rust-web` for where the key enters).

## Double-entry ledger

The accounting invariant: every transaction is a set of entries whose **debits equal credits**.
Money is never created or destroyed, only moved between accounts.

```rust
use std::collections::HashMap;

struct Entry { account: AccountId, amount: Money }   // signed; debit + credit
struct Transaction { id: Uuid, entries: Vec<Entry>, at: OffsetDateTime }

fn validate(tx: &Transaction) -> Result<(), LedgerError> {
    // Balance *per currency* — summing raw Decimal across currencies would let
    // +100 USD / -100 EUR net to zero and wrongly pass.
    let mut by_currency: HashMap<Currency, Decimal> = HashMap::new();
    for e in &tx.entries {
        *by_currency.entry(e.amount.currency()).or_default() += e.amount.amount();
    }
    if by_currency.values().any(|&sum| sum != Decimal::ZERO) {
        return Err(LedgerError::Unbalanced);   // every currency must net to zero
    }
    Ok(())
}
```

- The ledger is **append-only** — never update or delete a posted entry; correct with a
  reversing transaction. This preserves an auditable history.
- A balance is a *projection* (sum of entries), not a mutable field you increment — that avoids
  drift and makes every balance reconstructible.

## Audit trail

Record who/what/when for every money movement: actor, reason, idempotency key, timestamps
(`time::OffsetDateTime`, store UTC), and the resulting entries. It's append-only and immutable —
regulators and incident response depend on it. Don't log raw card numbers / PII (see secret
handling in `rust-security`).

## Consistency & exactness end-to-end

- **Transactional** money moves: post all entries of a transaction atomically (DB transaction) or
  none — a partial posting breaks the balance invariant.
- **Exact storage**: `NUMERIC`/`DECIMAL` columns, never `float`; map to `Decimal` in Rust
  (→ `rust-web`/`rust-ecosystem`).
- **Time**: store UTC, convert at the edges; financial dates (value date vs booking date) are
  domain concepts — model them explicitly, don't conflate with wall-clock.

## Test the invariants

Property tests (→ `rust-testing` proptest) are how you trust this:

- conservation: across any sequence of operations, total money is unchanged;
- idempotency: applying the same keyed op twice equals applying it once;
- ledger: every transaction nets to zero; a balance equals the sum of its entries.
