# Database (sqlx) and middleware (tower)

## sqlx: pool, queries, migrations

Create one pool at startup and share it (it's `Arc` inside — cheap to clone). The pool and the
queries belong to an **outbound adapter** (the repository), not to handlers (→ `rust-architecture`).

```rust
use sqlx::postgres::PgPoolOptions;

let pool = PgPoolOptions::new()
    .max_connections(20)
    .connect(&database_url).await?;
```

### Queries

```rust
// Runtime-checked query mapped to a struct
let author = sqlx::query_as::<_, AuthorRow>("SELECT id, name FROM authors WHERE id = $1")
    .bind(id)
    .fetch_optional(&pool).await?;

// Compile-time-checked macros: verified against the real schema at build time
let row = sqlx::query!("SELECT id, name FROM authors WHERE id = $1", id)
    .fetch_one(&pool).await?;
```

Under sqlx 0.9 the runtime `query*` functions take `&'static str` (a `SqlSafeStr`); the
string-literal examples above compile as-is, but non-literal SQL must be wrapped explicitly in
`sqlx::query::AssertSqlSafe(..)`.

The `query!`/`query_as!` **macros check your SQL against the database at compile time** — set
`DATABASE_URL`, or run `cargo sqlx prepare` to cache schema in `.sqlx/` for offline/CI builds.
Always use **bind parameters** (`$1`), never string interpolation — that's the SQL-injection
finding in `rust-review`.

### Migrations

```rust
sqlx::migrate!("./migrations").run(&pool).await?;   // embeds & runs ./migrations/*.sql
```

Manage with `sqlx-cli` (`sqlx migrate add <name>`, `sqlx migrate run`). Translate sqlx errors to
domain errors inside the repository adapter (e.g. a unique-violation → `Duplicate`), so the
domain never sees `sqlx::Error` (→ `rust-errors`, `rust-architecture`).

## Middleware with tower / tower-http

Cross-cutting concerns are `tower` layers applied to the router. `tower-http` ships the common
ones:

```rust
use tower_http::{trace::TraceLayer, cors::CorsLayer, timeout::TimeoutLayer,
                 compression::CompressionLayer};
use std::time::Duration;

let app = Router::new()
    .route("/authors", post(create_author))
    .layer(TimeoutLayer::new(Duration::from_secs(10)))  // request timeout
    .layer(CompressionLayer::new())                      // gzip/br responses
    .layer(CorsLayer::permissive())                      // CORS (tighten in prod)
    .layer(TraceLayer::new_for_http())                   // structured request logging
    .with_state(state);
```

Layer ordering is **outermost-last**: the last `.layer(...)` wraps everything, so it sees the
request first and the response last. Put `TraceLayer` outermost (logs the whole exchange);
per-route layers go on the sub-`Router`. Use `ServiceBuilder` to compose a stack in reading
order when it grows.

`TraceLayer` emits request/response spans and events; it relies on a tracing subscriber being
installed for those to surface. Initialize the tracing subscriber once at startup →
`rust-cloud-native` (observability). Tune what `TraceLayer` records here with
`RUST_LOG=info,tower_http=debug` against that subscriber.

## Graceful shutdown

Drain in-flight requests on SIGINT/SIGTERM instead of dropping connections. The axum-specific
wiring is just passing a future to `.with_graceful_shutdown(...)`:

```rust
axum::serve(listener, app)
    .with_graceful_shutdown(shutdown_signal())
    .await?;
```

For the SIGTERM-aware `shutdown_signal()` pattern → `rust-cloud-native`.

## Configuration

Load config once at startup (env vars / a config crate) into a typed struct, validate it, and
put it in state — don't read env vars from handlers. A bad config should fail at boot
(`expect`/exit), not per request (→ `rust-errors`: startup precondition is a defect).
