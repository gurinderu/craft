# Routing, extractors, state, and error responses

## Routing and handlers

```rust
use axum::{Router, routing::{get, post}, extract::{Path, Query, State, Json}};

let app = Router::new()
    .route("/authors", post(create_author).get(list_authors))
    .route("/authors/{id}", get(get_author))   // 0.8: brace syntax
    .with_state(state);
```

A handler is an `async fn` whose parameters are **extractors** and whose return type implements
`IntoResponse`.

## Extractors

Each parameter pulls something out of the request:

```rust
async fn get_author(
    State(state): State<AppState>,          // shared app state
    Path(id): Path<Uuid>,                   // /authors/{id}
    Query(params): Query<ListParams>,       // ?limit=10
    Json(body): Json<CreateAuthorBody>,     // request body (must be LAST)
) -> Result<Json<AuthorResponse>, ApiError> { /* ... */ }
```

Order matters: a body-consuming extractor (`Json`, `String`, `Bytes`) takes the request body, so
it must be the **last** parameter. `State`, `Path`, `Query`, headers come before it.

## Shared state

Hold the db pool, config, and your domain service in a `Clone` state struct and attach it with
`.with_state`. It's cloned per request — wrap expensive things in `Arc` (or use already-cheap-to-
clone handles like `sqlx::Pool`, which is `Arc` inside).

```rust
#[derive(Clone)]
struct AppState {
    service: AuthorService,      // your domain service (Clone; → rust-architecture)
    // pool is usually inside the service's repository adapter, not exposed here
}
```

For several independent pieces of state, derive/implement `FromRef` so `State<Sub>` can be
extracted from the whole:

```rust
#[derive(Clone)]
struct AppState { service: AuthorService, config: Arc<Config> }
impl axum::extract::FromRef<AppState> for Arc<Config> {
    fn from_ref(s: &AppState) -> Self { s.config.clone() }
}
```

## DTOs: keep HTTP types out of the domain

Request/response bodies are `serde` types living in the web layer — never put `#[derive(Serialize)]`
or axum types on domain models (→ `rust-architecture`). Convert at the edge:

```rust
#[derive(serde::Deserialize)]
struct CreateAuthorBody { name: String }

#[derive(serde::Serialize)]
struct AuthorResponse { id: Uuid, name: String }

impl CreateAuthorBody {
    fn into_domain(self) -> Result<CreateAuthorRequest, ApiError> {
        Ok(CreateAuthorRequest { name: AuthorName::new(&self.name)? }) // validates here
    }
}
impl From<Author> for AuthorResponse { /* domain -> wire */ }
```

## Error responses — `IntoResponse`

Map domain errors to HTTP at the boundary; log internals, don't leak them. This is the web
realization of `rust-errors` (domain failures vs defects):

```rust
use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};

enum ApiError {
    NotFound(String),
    UnprocessableEntity(String),
    Internal(anyhow::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            ApiError::NotFound(m)            => (StatusCode::NOT_FOUND, m),
            ApiError::UnprocessableEntity(m) => (StatusCode::UNPROCESSABLE_ENTITY, m),
            ApiError::Internal(e) => {
                tracing::error!("{e:?}");                       // detail to logs
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
            }
        };
        (status, Json(serde_json::json!({ "error": msg }))).into_response()
    }
}

// Let `?` work in handlers by converting domain errors into ApiError
impl From<CreateAuthorError> for ApiError {
    fn from(e: CreateAuthorError) -> Self {
        match e {
            CreateAuthorError::Duplicate { name } =>
                ApiError::UnprocessableEntity(format!("{name} already exists")),
            CreateAuthorError::Unknown(e) => ApiError::Internal(e),
        }
    }
}
```

Now a handler reads cleanly: `let req = body.into_domain()?; let a = state.service.create(&req).await?;`

## The handler in full

```rust
async fn create_author(
    State(state): State<AppState>,
    Json(body): Json<CreateAuthorBody>,
) -> Result<(StatusCode, Json<AuthorResponse>), ApiError> {
    let req = body.into_domain()?;                          // validate -> domain
    let author = state.service.create_author(&req).await?;  // domain does the work
    Ok((StatusCode::CREATED, Json(author.into())))          // domain -> wire
}
```

## Testing handlers without a server

`tower`'s `ServiceExt::oneshot` drives the `Router` directly — no sockets, fast:

```rust
use tower::ServiceExt;          // for .oneshot
use axum::body::Body;
use axum::http::{Request, StatusCode};

#[tokio::test]
async fn health_ok() {
    let app = router(test_state());
    let resp = app.oneshot(
        Request::builder().uri("/health").body(Body::empty()).unwrap()
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}
```

Inject a fake service/repo (→ `rust-architecture`, `rust-testing`) so handler tests cover error
paths without a database; cover the real DB adapter with integration tests.

## OpenAPI docs with `utoipa`

Generate an OpenAPI spec (and Swagger UI) from the code so the docs can't drift from the API —
annotate the DTOs and handlers you already have.

```toml
[dependencies]
utoipa = { version = "5", features = ["axum_extras"] }
utoipa-axum = "0.2"                                   # collects paths from the router
utoipa-swagger-ui = { version = "9", features = ["axum"] }
```

Derive `ToSchema` on the wire DTOs (the same `serde` types, not domain models):

```rust
#[derive(serde::Deserialize, utoipa::ToSchema)]
struct CreateAuthorBody { name: String }

#[derive(serde::Serialize, utoipa::ToSchema)]
struct AuthorResponse { id: Uuid, name: String }
```

Annotate handlers with `#[utoipa::path]` (it documents, doesn't change behavior):

```rust
#[utoipa::path(
    post, path = "/authors",
    request_body = CreateAuthorBody,
    responses(
        (status = 201, body = AuthorResponse),
        (status = 422, description = "validation failed"),
    ),
)]
async fn create_author(/* ...as before... */) { }
```

Assemble with `utoipa-axum`'s `OpenApiRouter` so routes and their specs stay in one place, then
serve the UI:

```rust
use utoipa_axum::{router::OpenApiRouter, routes};
use utoipa_swagger_ui::SwaggerUi;

let (router, api) = OpenApiRouter::new()
    .routes(routes!(create_author))      // registers the route AND its #[utoipa::path]
    .split_for_parts();

let app = router
    .merge(SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", api))
    .with_state(state);
```

Keep schema annotations on the **HTTP DTOs**, never on domain models — same boundary rule as
serialization (→ `rust-architecture`). The generated `openapi.json` doubles as a contract for
clients and codegen.
