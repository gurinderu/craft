# Writing good scenarios

Craft notes for the Given/When/Then itself — independent of the framework that runs it.

## Declarative, not imperative

Write what the user is trying to achieve, not the keystrokes.

```gherkin
# Bad — imperative: brittle, couples the spec to the UI, hides the intent
Scenario: login
  Given I open "/login"
  When I type "ada@x.com" into "#email"
  And I type "hunter2" into "#password"
  And I click "#submit"
  Then I see ".dashboard"

# Good — declarative: states intent; survives UI changes
Scenario: a registered user signs in
  Given a registered user "ada@x.com"
  When she signs in with the correct password
  Then she reaches her dashboard
```

The declarative version reads as a requirement and only breaks when the *behavior* changes —
which is exactly when a spec *should* break.

## Choosing examples — cover classes, not every input

You can't (and shouldn't) enumerate all inputs. For each rule, pick representatives:

- **Happy path** — one typical valid case.
- **Boundaries** — exactly at the limit and just past it (the off-by-one home).
- **The error case that matters** — the failure the rule exists to prevent.

```
Rule: withdrawal allowed up to the balance
  balance 100, withdraw  50  → ok        (happy)
  balance 100, withdraw 100  → ok        (boundary: exactly at limit)
  balance 100, withdraw 101  → rejected  (boundary: one past)
  balance 100, withdraw  -1  → rejected  (error: invalid amount)
```

Four examples pin the rule; a hundred more random amounts add nothing. (For *exhaustive*
input coverage of an invariant, that's property-based testing — `rust-testing` → `proptest`.)

## Data-driven scenarios (Scenario Outline)

When one scenario shape has many example rows, use an outline + table instead of copy-paste:

```gherkin
Scenario Outline: withdrawal limits
  Given an account with balance <balance>
  When I withdraw <amount>
  Then the outcome is <result>

  Examples:
    | balance | amount | result   |
    | 100     | 50     | ok       |
    | 100     | 100    | ok       |
    | 100     | 101    | rejected |
```

This is the Gherkin equivalent of table-driven tests (`rstest` `#[case]` in Rust). Keep the
rows to the representatives above — the table is for clarity, not for dumping inputs.

## Shared context — Background

Lift `Given` steps common to every scenario in a feature into a `Background` so each scenario
shows only what's distinctive:

```gherkin
Background:
  Given a registered user "ada@x.com"

Scenario: signing in
  When she signs in with the correct password
  Then she reaches her dashboard
```

Don't overload `Background` — if a scenario doesn't need a step, it doesn't belong there.

## Keep scenarios independent

Each scenario sets up its own world and asserts its own outcome. No scenario may rely on state
left behind by a previous one — order-dependent specs are flaky and unreadable. (In `cucumber`
the per-scenario `World` enforces this; in plain tests, construct fresh fixtures each test.)

## Name scenarios as sentences

The scenario title is the spec line. `rejecting an overdraft` reads in a report;
`test_withdraw_2` does not. The title plus the three beats should explain the rule with no
other context.
