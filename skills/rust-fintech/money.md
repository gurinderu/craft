# The Money type: decimal, rounding, allocation

## `rust_decimal::Decimal`

Exact, 128-bit, fixed-scale — the workhorse for money in Rust.

```rust
use rust_decimal::{Decimal, dec};   // `dec!` via the `macros` feature
use std::str::FromStr;

let price = dec!(19.99);                       // literal, exact
let parsed = Decimal::from_str("19.99")?;      // from user input
let from_cents = Decimal::new(1999, 2);        // 1999 * 10^-2 = 19.99
```

Never construct a `Decimal` *from* an `f64` you computed — if a float ever touched the value, the
error is already baked in. Parse from strings/integers.

## A `Money` newtype

Bind amount to currency so cross-currency math can't silently happen:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]   // Hash → usable as a HashMap key
pub enum Currency { Usd, Eur, Jpy }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Money { amount: Decimal, currency: Currency }

impl Money {
    pub fn new(amount: Decimal, currency: Currency) -> Self { Self { amount, currency } }

    pub fn amount(self) -> Decimal { self.amount }
    pub fn currency(self) -> Currency { self.currency }

    pub fn add(self, other: Money) -> Result<Money, MoneyError> {
        if self.currency != other.currency {
            return Err(MoneyError::CurrencyMismatch);   // domain error, not a silent bug
        }
        Ok(Money { amount: self.amount + other.amount, currency: self.currency })
    }
}
```

Don't `impl std::ops::Add` directly (it can't return `Result`); expose checked methods, or only
implement `Add` for same-currency contexts. `CurrencyMismatch` is a domain failure (→ `rust-errors`).

Currencies have different minor-unit scales (USD = 2, JPY = 0) — encode that on `Currency` and use
it when rounding/formatting; don't assume 2 decimals everywhere.

## Rounding — explicit, and at the boundary

```rust
use rust_decimal::RoundingStrategy;

let rounded = amount.round_dp_with_strategy(2, RoundingStrategy::MidpointNearestEven); // banker's
let up      = amount.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero);
```

Round **once**, when leaving the system (display, settlement, invoice line). Keep full precision
through intermediate calculations (interest, tax, fx) — rounding each step compounds bias.

## Allocation — split without losing cents

Dividing a total across parties almost never divides evenly. Never just multiply by a rounded
fraction — that leaks or invents money. Allocate the floor to each, then distribute the remainder
one minor-unit at a time:

```rust
/// Split `total` into `n` parts that sum back to exactly `total`.
/// Assumes `total >= 0`: the remainder is distributed by adding positive cents.
/// Negative totals would need sign-aware remainder distribution (subtract cents).
fn allocate(total: Decimal, n: u32) -> Vec<Decimal> {
    debug_assert!(total >= Decimal::ZERO, "allocate assumes a non-negative total");
    let n_dec = Decimal::from(n);
    let base = (total / n_dec).round_dp_with_strategy(2, RoundingStrategy::ToZero);
    let mut parts = vec![base; n as usize];
    let mut remainder = total - base * n_dec;          // the leftover cents
    let cent = Decimal::new(1, 2);
    let mut i = 0;
    while remainder >= cent {                            // hand out one cent at a time
        parts[i % n as usize] += cent;
        remainder -= cent;
        i += 1;
    }
    parts                                               // sum(parts) == total, exactly
}
```

Test this with a property: `allocate(total, n).iter().sum() == total` for arbitrary inputs
(→ `rust-testing` proptest). Weighted splits (by share) follow the same "largest-remainder"
principle.

## Serialization & storage

- Serialize as a **string** or integer minor units, never a JSON number (JSON numbers are
  doubles → precision loss). `rust_decimal`'s `serde` feature can serialize as a string.
- In the database use an exact type (`NUMERIC(precision, scale)` in Postgres), never `float`/
  `double`. With sqlx, map columns to `Decimal` (→ `rust-web`/`rust-ecosystem`).
