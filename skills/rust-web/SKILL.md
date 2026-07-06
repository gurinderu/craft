---
name: rust-web
description: >-
  Building web services in Rust with axum, tokio, tower, and sqlx — routing, extractors, shared state, error responses, database access, middleware, and graceful shutdown. Use when building an HTTP API/server in Rust, wiring axum handlers, sharing state, returning typed errors as responses, or connecting a database. Triggers: axum, extractor, State, IntoResponse, tower, tower-http, sqlx, connection pool, CORS.
---

# Rust Web (axum)

The de-facto async web stack — **axum** (routing/handlers) on **tokio** (runtime), **tower**
(middleware), **sqlx** (database). The structural decisions belong to `rust-architecture`: a web
server is just an **inbound adapter** over your domain. This skill is the axum-specific
mechanics. Deep dives in the sub-files.

## When to Use

- Building an HTTP API or server in Rust
- Wiring axum routes, extractors, handlers, shared state
- Returning domain errors as HTTP responses
- Connecting a database and adding middleware

## The stack

```toml
[dependencies]
axum = "0.8"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "net", "signal"] }
tower = "0.5"
tower-http = { version = "0.6", features = ["trace", "cors", "timeout", "compression-full"] }
sqlx = { version = "0.9", features = ["runtime-tokio", "postgres", "macros", "migrate"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

## Request lifecycle

```
TCP → tower middleware (trace, cors, timeout) → router matches path
    → extractors run (State, Path, Query, Json) → handler (async fn)
    → handler calls the domain service → Result<impl IntoResponse, ApiError>
    → response serialized back out
```

The handler is a **translator**, not a place for business logic: extract → call the domain →
map the result to a response. Logic lives in the domain `Service` (→ `rust-architecture`).

## Hello, server

```rust
use axum::{routing::get, Router};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let app = Router::new().route("/health", get(|| async { "ok" }));
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await?;
    axum::serve(listener, app).await?;
    Ok(())
}
```

## Decision points

| Question | Answer | Where |
|---|---|---|
| Pass shared state (db pool, config) to handlers | `State<T>` extractor + `with_state` | [handlers.md](handlers.md) |
| Return an error as a proper HTTP response | `ApiError: IntoResponse` | [handlers.md](handlers.md) |
| Talk to a database | `sqlx` pool as state, queries in an outbound adapter | [data-and-middleware.md](data-and-middleware.md) |
| Add logging / CORS / timeouts | `tower-http` layers | [data-and-middleware.md](data-and-middleware.md) |
| Shut down cleanly | `axum::serve(...).with_graceful_shutdown(...)` | [data-and-middleware.md](data-and-middleware.md) |
| Authenticate / authorize requests | argon2 + JWT + an auth extractor (401/403) | [auth.md](auth.md) |
| Generate OpenAPI / Swagger docs | `utoipa` (`ToSchema` + `#[utoipa::path]`) | [handlers.md](handlers.md) |

## axum 0.8 note

Path parameters use **brace syntax**: `/users/{id}` (the old `:id` form was removed in 0.8). A
route like `/users/:id` silently won't match — use `{id}` and extract with `Path`.

## Boundaries

- *How to structure* the app (domain core, ports, this server as an inbound adapter) →
  `rust-architecture`. This skill assumes that shape and fills in axum.
- Domain errors → HTTP mapping is `IntoResponse` here, but the error *design* (typed variants,
  `Unknown`/defect) → `rust-errors`.
- `Arc` shared state, `Send` futures, blocking-in-async → `rust-concurrency`.
- Handler/integration testing (`tower`'s `oneshot`, `testcontainers`) → `rust-testing` and the
  testing note in [handlers.md](handlers.md).
