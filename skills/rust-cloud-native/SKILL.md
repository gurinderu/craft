---
name: rust-cloud-native
description: Cloud-native Rust services — gRPC with tonic, observability (tracing + OpenTelemetry), health/readiness probes, 12-factor config, graceful shutdown, and lean containers. Use when building microservices, gRPC APIs, or services to run in Docker/Kubernetes, or adding tracing/metrics/health checks. Triggers: cloud-native, microservice, gRPC, tonic, kubernetes, k8s, docker, container, observability, tracing, opentelemetry, OTLP, health check, readiness, liveness, graceful shutdown, 12-factor, distroless.
---

# Rust Cloud-Native

Services that run in containers under an orchestrator: they must be **observable**, **resilient**,
and **operable** — not just correct. Rust's small static binaries and low footprint are a great
fit. gRPC and observability deep-dives are in the sub-files; ops concerns are here.

## When to Use

- Building a microservice or gRPC API
- Running a service in Docker / Kubernetes
- Adding tracing, metrics, health checks, graceful shutdown

## The concerns

| Concern | Approach | Where |
|---|---|---|
| Service-to-service RPC | gRPC via `tonic` (proto + codegen) | [grpc.md](grpc.md) |
| Logs / traces / metrics | `tracing` + OpenTelemetry (OTLP) | [observability.md](observability.md) |
| Is it alive / ready? | liveness + readiness endpoints | below |
| Config | 12-factor: env-driven, fail-fast | below |
| Clean rollout | graceful shutdown on SIGTERM | below |
| Deploy artifact | multi-stage, minimal container | below |

The HTTP side (REST, axum) is `rust-web`; this skill is the service/infra layer that wraps it.

## Health: liveness ≠ readiness

Kubernetes probes two different things — don't conflate them:

- **Liveness** — "is the process wedged?" Fails → pod restarted. Keep it cheap and dependency-free
  (a deadlocked process should fail; a slow database should *not* trigger a restart loop).
- **Readiness** — "can it serve traffic right now?" Fails → removed from the load balancer. This
  one *does* check dependencies (DB reachable, caches warm). On shutdown, fail readiness first so
  traffic drains before you stop.

Expose both as tiny endpoints (gRPC health service, or `/livez` and `/readyz` in axum).

## Config: 12-factor, fail fast

Configure from the **environment** (env vars / mounted secrets), not baked-in files — the same
image runs in every environment. Load once at startup into a typed struct, **validate, and exit
on error** — a misconfigured service should crash at boot, not fail per request (→ `rust-errors`:
startup precondition is a defect). Layer env over file over defaults with `figment`
(→ `rust-cli` config). Read secrets into a `secrecy::SecretBox` (→ `rust-security`).

## Graceful shutdown

Orchestrators send **SIGTERM** then wait, then SIGKILL. Catch SIGTERM, **fail readiness**, stop
accepting new requests, drain in-flight ones, close pools, exit:

```rust
async fn shutdown_signal() {
    let term = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .unwrap().recv().await;
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = term => {},
    }
}
// axum::serve(..).with_graceful_shutdown(shutdown_signal())   (rust-web)
// tonic Server::builder()...serve_with_shutdown(addr, shutdown_signal())
```

## Container: small, static, non-root

- **Multi-stage build**: compile in a full Rust image, copy only the binary into a tiny runtime.
- **Minimal base**: `gcr.io/distroless/cc` (or a static `musl` build into `scratch`) — no shell,
  smaller attack surface.
- **Non-root** user; **read-only** filesystem where possible.
- Build deps with `cargo chef` to cache the dependency layer and speed CI.
- Scan the image / deps (`cargo deny`, `cargo audit`) → `rust-security`.

```dockerfile
FROM rust:1 AS build
WORKDIR /app
COPY . .
RUN cargo build --release
FROM gcr.io/distroless/cc:nonroot
COPY --from=build /app/target/release/svc /svc
USER nonroot:nonroot                       # distroless non-root user (uid 65532)
ENTRYPOINT ["/svc"]
```

## Boundaries

- REST/HTTP handlers → `rust-web`; async runtime/tasks → `rust-concurrency`.
- Mapping domain errors to gRPC `Status` → `rust-errors` + [grpc.md](grpc.md).
- Dependency/supply-chain/secret scanning and in-memory secret handling → `rust-security`.
- Config layering mechanics (`figment`) → `rust-cli`.
