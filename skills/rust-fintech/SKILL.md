---
name: rust-fintech
description: >-
  Financial/money code in Rust — exact decimal arithmetic (never floats), a Money type with currency, rounding modes, splitting without losing cents, idempotency, and double-entry ledgers. Use when handling money, prices, currencies, payments, or accounting, where rounding and exactness are correctness-critical. Triggers: decimal, rust_decimal, banker's rounding, idempotency, ledger, double-entry.
---

# Rust Fintech

In money code, **rounding and exactness are correctness** — a fraction of a cent lost per
transaction is a real bug. The domain's non-negotiable rules and the Rust types that enforce
them. Deep dives in the sub-files.

## When to Use

- Representing or computing money, prices, currencies
- Payments, billing, accounting, trading
- Anywhere a rounding error or lost cent is a defect

## The cardinal rule: never `f64` for money

Floating point can't represent `0.10` exactly — `0.1 + 0.2 != 0.3`. Money must be **exact
decimal**. Use `rust_decimal::Decimal` (128-bit fixed-scale) or integer minor units (cents), never
`f32`/`f64`.

```rust
// Bad — silent rounding error, accumulates
let total: f64 = 0.1 + 0.2;          // 0.30000000000000004

// Good — exact
use rust_decimal::{Decimal, dec};
let total: Decimal = dec!(0.1) + dec!(0.2);   // exactly 0.3
```

```toml
[dependencies]
# `macros` re-exports the dec! macro from rust_decimal itself;
# `serde` backs the string-serialization advice in money.md.
rust_decimal = { version = "1", features = ["macros", "serde"] }
```

The separate `rust_decimal_macros` crate still works (`use rust_decimal_macros::dec;`), but the
`macros` feature keeps everything under one crate.

Treating money as a float is the #1 fintech bug — flag it in review like an `unwrap` on a hot
path (→ `rust-review`).

## Model money as a type, not a number

A bare `Decimal` lets you add dollars to euros. Wrap amount **and** currency in a newtype so
illegal operations don't compile (→ `rust-traits` newtype / illegal-states):

```rust
pub struct Money { amount: Decimal, currency: Currency }
```

Adding two `Money` of different currencies must be a domain error, not a silent bug. Construction,
arithmetic, rounding, and splitting → [money.md](money.md).

## Rounding is a decision, state it explicitly

There is no "default" correct rounding — the *domain* dictates it (tax rules, exchange
conventions). Make it explicit at every point where precision is reduced:

- **Banker's rounding** (round-half-to-even) is common for finance — it avoids the upward bias of
  round-half-up over many operations.
- Round **once, at the boundary** (display, settlement), not on every intermediate — rounding
  intermediates compounds error.
- Splitting a total across N parties must **conserve the total to the cent** (allocate remainders
  deterministically) — see [money.md](money.md).

## Integrity: money systems must not lose or double-count

Beyond arithmetic, the domain demands:

- **Idempotency** — a retried payment must not charge twice (idempotency keys).
- **Double-entry** — every movement is balanced debits = credits; the ledger is append-only and
  auditable.
- **Exactness end-to-end** — store `Decimal`/integer in the DB (e.g. `NUMERIC`), never `float`
  columns.

Patterns in [integrity.md](integrity.md).

## Testing money code

Exactness bugs hide in edge cases — assert **invariants** with property tests (→ `rust-testing`
proptest): "split then sum equals the original", "round-trip serialize preserves value", "no
operation creates or destroys money". These catch lost-cent bugs that example tests miss.

## Boundaries

- The `Money` newtype technique and "make illegal states unrepresentable" → `rust-traits`.
- Domain errors (`InsufficientFunds`, `CurrencyMismatch`) → `rust-errors` (and they're the
  running example there).
- Property-based invariant testing → `rust-testing`.
