---
name: rust-architecture
description: >-
  Hexagonal architecture (ports and adapters) in Rust — a domain core that depends on nothing, ports as traits, adapters at the edges, and one-way dependency flow toward the domain. Use when structuring an application/service, isolating business logic from frameworks (axum/sqlx), deciding module layout, or making code testable without infrastructure. Triggers: ports and adapters, clean architecture, dependency inversion, repository pattern, decouple framework, where does this code go.
---

# Rust Architecture — Hexagonal (Ports & Adapters)

One rule drives everything: **dependencies point only toward the domain.** Business logic sits
at the center knowing nothing about HTTP, SQL, or any framework; the outside world plugs in
through traits (ports) implemented at the edges (adapters). The Rust mechanics — ports as
traits, the service struct, error translation — are in the sub-files.

## When to Use

- Structuring a service/application beyond a single file
- Keeping business logic independent of axum/sqlx/etc. so frameworks can change
- Making logic testable without a database or network
- Deciding "where does this code go?"

When **not** to: a tiny CLI or script doesn't need ports — the indirection costs more than it
saves. Reach for this when the app has real business rules and more than one external dependency.
Read **Criticism** below before adopting it wholesale — this pattern is frequently over-applied.

## Criticism — when to keep it simple

The Rust community pushes back hard on cargo-culting this pattern (HN/Lobsters/Reddit on the
guide that inspired this skill). Take the critiques seriously:

- **Don't abstract before you have 2–3 real implementations.** A port (trait) with a single
  implementor is pure indirection — "hell is full of single-implementation abstractions." Start
  with concrete types; extract a port when a *second* adapter actually appears.
- **The "where tf" problem.** Layers scatter logic; to follow control flow you hop through traits
  to find the one impl. Indirection has a real readability cost — pay it only for real flexibility.
- **Generics everywhere fight the language.** `Service<R, M, N>` and `Clone + Send + Sync +
  'static` bounds propagate, collide with lifetimes, and push you toward `Arc`/`Mutex` — losing
  the stack allocation and borrowing that make Rust fast. `async fn` in traits needs the
  `-> impl Future + Send` desugar or `trait-variant`; that tax is real.
- **The swap rarely happens.** "We might switch databases" almost never materializes, and when
  it does the semantic differences dwarf the abstraction's help.

Pragmatic middle grounds many prefer:
- **Functional core, imperative shell** — pure logic over plain data in the center, side effects
  at the edges; often gets you testability without a web of traits.
- **Colocated trait-based injection** — `repo.upsert(&conn).await?` keeps logic readable without
  a full ports layer.
- **Integration tests over mocks** — `testcontainers` or a real local DB exercises the actual
  adapter; mocking the database can test your mock instead of your code.

Rule: **start concrete, introduce ports when a real second implementation or a genuine testing
seam demands one.** Use the full structure below for apps that have earned it — not by default.

## The three layers

```
        inbound adapters                         outbound adapters
   (HTTP handler, CLI, gRPC)                  (sqlx repo, email, metrics)
            │  call                                   ▲  implement
            ▼                                         │
   ┌─────────────────────────────  DOMAIN  ─────────────────────────────┐
   │  models (validated)   inbound ports (traits)   outbound ports (traits)│
   │  Service: implements inbound ports, orchestrates outbound ports       │
   │  domain errors        — depends on NOTHING external —                 │
   └──────────────────────────────────────────────────────────────────────┘
```

- **Domain / core** — models, ports, errors, and the `Service`. No framework types here, ever.
- **Ports** — traits the domain *owns*. **Inbound (driving)**: how the world calls the domain
  (e.g. `AuthorService`). **Outbound (driven)**: what the domain needs from the world
  (`AuthorRepository`, `Notifier`, `Metrics`). Details: [ports.md](ports.md).
- **Adapters** — concrete impls at the edges. **Inbound**: an axum handler that translates an
  HTTP DTO into a domain call. **Outbound**: a `Sqlite` struct wrapping `sqlx` that implements
  `AuthorRepository`. Details: [adapters.md](adapters.md).

## The dependency rule

Adapters depend on the domain; the domain never depends on an adapter. Because the domain
defines the ports and adapters implement them, the compile-time dependency arrow is inverted —
this is dependency inversion, enforced by the module graph. If `domain/` `use`s anything from
`outbound/` or a framework crate, the architecture is already broken.

## Wiring: `main` is the only place that knows everything

The domain is generic over its ports; `main` picks concrete adapters and assembles them:

```rust
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let repo     = Sqlite::new(&cfg.database_url).await?;  // outbound adapter
    let metrics  = Prometheus::new();                      // outbound adapter
    let notifier = EmailNotifier::new(&cfg.smtp);          // outbound adapter
    let service  = Service::new(repo, metrics, notifier);  // domain, wired (all three ports)
    let server   = HttpServer::new(service).await?;        // inbound adapter
    server.run().await
}
```

`main` is bootstrapping only — no business logic.

## Generics vs `dyn` for wiring

Wire ports with **generics by default** — `Service<R: AuthorRepository>` — for static dispatch
and zero overhead. Use `Arc<dyn AuthorRepository>` only when you genuinely need runtime
polymorphism or the set of impls isn't known at compile time. (The full static/dyn/enum
trade-off is in `rust-traits` → dispatch.)

Note: the generic port as written in [ports.md](ports.md) is **not dyn-compatible**, so
`Arc<dyn AuthorRepository>` won't compile against it unchanged. Two things block a vtable: the
`Clone` supertrait is `Sized` (a `dyn` value has no statically known size), and the RPITIT
`-> impl Future` has no single vtable-able return type. To use `dyn`, the port must drop the
`Clone` bound, box the future (`async-trait`, or a hand-written `-> Pin<Box<dyn Future + Send>>`),
and recover cheap cloning by wrapping the trait object in `Arc` (clone the `Arc`, not the impl).
See `rust-traits` → dispatch for the full dyn-compatibility constraints.

## Module layout

```
src/
├── domain/
│   └── author/
│       ├── models.rs     # Author, CreateAuthorRequest (validated constructors)
│       ├── ports.rs      # AuthorService (inbound), AuthorRepository/Metrics (outbound)
│       ├── errors.rs     # CreateAuthorError
│       └── service.rs    # Service<R, M, ...> implementing the inbound port
├── inbound/
│   └── http/             # axum handlers + HTTP DTOs ⇄ domain
├── outbound/
│   ├── sqlite.rs         # AuthorRepository impl (wraps sqlx)
│   └── prometheus.rs     # AuthorMetrics impl
└── main.rs               # wiring only
```

Names are yours to choose — keep the *direction* (inbound/domain/outbound) clear.

## Boundaries

This skill owns the *structure*: layers, the dependency rule, ports as traits, the service, and
adapter/error-translation seams. It deliberately does **not** cover the mechanics that other
craft skills own — go there for the details:

- **Dispatch (static/`dyn`/enum), dyn-compatibility, newtype & typestate** → `rust-traits`.
  Validated newtype models ("parse, don't validate") and the generics-vs-`dyn` choice live there.
- **Failures-vs-defects error design** → `rust-errors`. The catch-all `Unknown(anyhow::Error)`
  and the library-vs-app split are defined and justified there; this skill only *applies* them at
  the boundary.
- **axum handler/extractor mechanics** (`State`, `Json`, status codes, routing) → `rust-web`.
  Here we only show the translate-don't-compute shape of an inbound adapter.
- **Port mocks/fakes** (`mockall` `#[automock]`, fake injection, integration tests) → `rust-testing`.

Cross-links for scaling up: separate read/write models and event-as-source-of-truth →
[cqrs-events.md](cqrs-events.md) (CQRS & event sourcing — with a "when not to" warning).
