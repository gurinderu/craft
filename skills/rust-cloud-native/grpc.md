# gRPC with tonic

`tonic` is the de-facto async gRPC stack (on tokio + hyper + prost). You define services in
`.proto`, generate Rust at build time, and implement a trait.

```toml
[dependencies]
tonic = "0.14"
tonic-prost = "0.14"
prost = "0.14"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "signal"] }

[build-dependencies]
tonic-prost-build = "0.14"
```

## Codegen

```rust
// build.rs
fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_prost_build::compile_protos("proto/authors.proto")?;
    Ok(())
}
```

```protobuf
// proto/authors.proto
syntax = "proto3";
package authors;
service Authors { rpc Create(CreateRequest) returns (Author); }
message CreateRequest { string name = 1; }
message Author { string id = 1; string name = 2; }
```

Include the generated module and implement the trait:

```rust
pub mod pb { tonic::include_proto!("authors"); }
use pb::authors_server::{Authors, AuthorsServer};

#[derive(Clone)]
struct MyAuthors { service: AuthorService }   // your domain service (→ rust-architecture)

#[tonic::async_trait]
impl Authors for MyAuthors {
    async fn create(&self, req: tonic::Request<pb::CreateRequest>)
        -> Result<tonic::Response<pb::Author>, tonic::Status>
    {
        let name = req.into_inner().name;
        let author = self.service.create(&to_domain(name)?)
            .await
            .map_err(domain_to_status)?;       // domain error -> gRPC Status
        Ok(tonic::Response::new(author.into()))
    }
}
```

The handler is a thin adapter (like an axum handler): proto → domain → call service → proto.
Business logic stays in the domain (→ `rust-architecture`).

## Errors → `Status`

Map domain errors to gRPC status codes at the boundary (the gRPC analogue of `IntoResponse`):

```rust
fn domain_to_status(e: CreateError) -> tonic::Status {
    match e {
        CreateError::NotFound(_)      => tonic::Status::not_found("author not found"),
        CreateError::Duplicate { .. } => tonic::Status::already_exists("duplicate"),
        CreateError::Invalid(m)       => tonic::Status::invalid_argument(m),
        CreateError::Unknown(e) => {
            tracing::error!("{e:?}");                          // log the defect
            tonic::Status::internal("internal error")          // don't leak detail
        }
    }
}
```

This is the failures-vs-defects split from `rust-errors`: domain failures → specific codes,
defects → `internal` + logged.

## Serving (with shutdown)

```rust
tonic::transport::Server::builder()
    .add_service(AuthorsServer::new(MyAuthors { service }))
    .serve_with_shutdown(addr, shutdown_signal())   // graceful (see SKILL.md)
    .await?;
```

## Interceptors, streaming, health/reflection

- **Interceptors** / tower layers for cross-cutting concerns (auth, tracing — wire
  `tracing` here so every RPC is a span, → observability.md).
- **Streaming**: server-, client-, and bidirectional-streaming RPCs return/accept
  `tonic::Streaming<T>`; back-pressure and cancellation matter (→ `rust-concurrency`).
- **Health** (`tonic-health`) and **reflection** (`tonic-reflection`) services make the server
  introspectable and probe-able by k8s and `grpcurl`.
