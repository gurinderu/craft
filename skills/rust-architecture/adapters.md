# Adapters, error translation, and testing

Adapters are where framework types are allowed — and where they must **stop**. Their job is to
translate between the outside world and the domain.

## Outbound adapter — wrap the library, expose only the port

Wrap the external crate in your own struct and implement the domain port; translate the
library's errors into domain errors at this seam.

```rust
#[derive(Clone)]
pub struct Sqlite { pool: sqlx::SqlitePool }   // sqlx lives here, nowhere else

impl AuthorRepository for Sqlite {
    async fn create_author(&self, req: &CreateAuthorRequest)
        -> Result<Author, CreateAuthorError>
    {
        sqlx::query(/* ... */).execute(&self.pool).await
            .map_err(|e| match e {
                // translate storage-specific failure -> domain failure
                e if is_unique_violation(&e) =>
                    CreateAuthorError::Duplicate { name: req.name().clone() },
                // everything unexpected becomes the catch-all defect
                other => CreateAuthorError::Unknown(other.into()),
            })?;
        Ok(/* Author */)
    }
}
```

"Expose only the functionality your application requires" — the rest of `sqlx` never leaks past
`Sqlite`.

## Domain errors → transport errors at the boundary

Domain error enums are exhaustive descriptions of business failures, plus one `Unknown` for the
unexpected. This is the failures-vs-defects split from `rust-errors`, applied per use case:

```rust
#[derive(Debug, thiserror::Error)]
pub enum CreateAuthorError {
    #[error("author with name {name} already exists")]
    Duplicate { name: AuthorName },           // domain failure — callers branch on it
    #[error(transparent)]
    Unknown(#[from] anyhow::Error),           // defect — carried opaquely
}
```

The **inbound adapter** maps domain errors to its transport, keeping internal detail out of the
response (and the public error type separate from the domain one):

```rust
impl From<CreateAuthorError> for ApiError {
    fn from(e: CreateAuthorError) -> Self {
        match e {
            CreateAuthorError::Duplicate { name } =>
                ApiError::UnprocessableEntity(format!("{name} already exists")),
            CreateAuthorError::Unknown(cause) => {
                tracing::error!("{cause:?}");                // detail to logs
                ApiError::InternalServerError                // generic to client
            }
        }
    }
}
```

Rule: **always separate your public errors from their domain representations** — never serialize
a domain error straight to the client.

## Inbound adapter — translate, don't compute

The handler converts an HTTP DTO to a domain request, calls the inbound port, and converts the
result back. It contains no business logic. Generic over the port for static dispatch:

```rust
pub async fn create_author<AS: AuthorService>(
    State(state): State<AppState<AS>>,
    Json(body): Json<CreateAuthorHttpRequestBody>,
) -> Result<Json<AuthorResponse>, ApiError> {
    let req = body.try_into_domain()?;                 // HTTP DTO -> domain (validates)
    let author = state.service.create_author(&req).await?;
    Ok(Json(author.into()))                            // domain -> HTTP DTO
}
```

`CreateAuthorHttpRequestBody`, `AuthorResponse`, JSON/`serde` annotations, status codes — all
live in `inbound/http`, never on the domain models.

## Testing: fake the ports, skip the infrastructure

Because the service depends on traits, unit tests inject fakes and run with no database or
network — fast and cheap instead of slow and flaky.

```rust
// CreateAuthorError holds anyhow::Error and is NOT Clone, so don't clone a stored
// Result — store a factory closure that produces a fresh Result on each call.
#[derive(Clone)]
struct StubRepo {
    make: Arc<dyn Fn() -> Result<Author, CreateAuthorError> + Send + Sync>,
}

impl AuthorRepository for StubRepo {
    async fn create_author(&self, _: &CreateAuthorRequest)
        -> Result<Author, CreateAuthorError> {
        (self.make)()
    }
}

#[tokio::test]
async fn create_author_reports_duplicates() {
    let repo = StubRepo {
        make: Arc::new(|| Err(CreateAuthorError::Duplicate {
            name: AuthorName::new("ada").unwrap(),
        })),
    };
    let service = Service::new(repo, NoopMetrics, NoopNotifier);
    let err = service.create_author(&req()).await.unwrap_err();
    assert!(matches!(err, CreateAuthorError::Duplicate { .. }));
}
```

Hand-written fakes are clearest for a couple of methods; for larger ports use `mockall`'s
`#[automock]` (see `rust-testing` → mocking). Either way, you exhaustively test every error path
without standing up infrastructure.

But don't mistake mocked tests for proof the adapter works — a green test against a fake repo
says nothing about your SQL. **Cover the real adapters with integration tests** (`testcontainers`
or a local DB); reserve mocks/fakes for the *business logic* in the service. Over-mocking tests
your mocks, not your code (see the Criticism section in the skill entry).
