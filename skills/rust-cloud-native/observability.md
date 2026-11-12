# Observability: tracing, metrics, traces

Three signals: **logs** (events), **metrics** (aggregates), **traces** (causal spans across
services). In Rust they share one foundation — the `tracing` crate — exported to your backend via
OpenTelemetry.

```toml
[dependencies]
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
opentelemetry = "0.32"
# opentelemetry-otlp + tracing-opentelemetry to export to a collector
```

## Structured logging with `tracing`

Emit **structured** events (key-value fields), not formatted strings — they're queryable.

```rust
use tracing::{info, error, instrument};

#[instrument(skip(db), fields(author_id = %id))]   // creates a span; adds fields
async fn get_author(db: &Db, id: Uuid) -> Result<Author, Error> {
    info!(%id, "fetching author");                  // event within the span
    db.get(id).await.inspect_err(|e| error!(error = %e, "fetch failed"))
}
```

`#[instrument]` wraps the function in a **span**; events inside inherit its fields. Spans nest, so
you get the call tree. `skip` large/secret args; never log secrets (→ `rust-security`,
`secrecy`).

## The subscriber

Initialize once at startup. JSON in production (machine-parseable), pretty locally; filter via
`RUST_LOG`:

```rust
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

tracing_subscriber::registry()
    .with(EnvFilter::from_default_env())   // RUST_LOG=info,my_svc=debug
    .with(fmt::layer().json())             // structured output
    .init();
```

## Distributed tracing (OpenTelemetry)

A request crossing services should be **one trace**. OpenTelemetry propagates a trace/span id in
headers (HTTP) or metadata (gRPC), so spans from different services join up in your backend
(Jaeger/Tempo/etc.).

- Add a `tracing-opentelemetry` layer that turns `tracing` spans into OTel spans and exports them
  over **OTLP** to a collector.
- **Propagate context** at boundaries: inject the current context into outgoing request
  headers/metadata, and extract it on the server side so child spans attach to the caller's trace.
- Every log line then carries a `trace_id` — that's how you jump from a log to the full trace.

## Async + spans: don't lose context

A span entered with `enter()` doesn't follow a future across `.await` (the task may move threads).
Attach the span to the future instead:

```rust
use tracing::Instrument;
tokio::spawn(do_work().instrument(tracing::info_span!("worker")));
```

`#[instrument]` on an `async fn` handles this correctly; the manual pitfall is `let _g =
span.enter();` before an `.await` (→ `rust-concurrency` for why the task moves).

## Metrics

For counters/histograms (request rate, latency, error count) use OpenTelemetry metrics (or the
`metrics` crate) and export to Prometheus/OTLP. Track the RED signals — **R**ate, **E**rrors,
**D**uration — per endpoint; they're what alerts and dashboards are built on. Wire metric
recording into the same tower/interceptor layer as tracing so every request is counted and timed
once.
