# Domain core and ports

The domain is the part that would survive switching from axum to actix, or sqlx to diesel,
untouched. It holds models, ports, errors, and the service — and imports no framework.

## Models: validate at construction

A domain model is valid by construction — push validation into the constructor and keep fields
private, so once you hold the type it's trustworthy (this is `rust-traits` → newtype,
"parse, don't validate").

```rust
#[derive(Clone)]
pub struct AuthorName(String);

impl AuthorName {
    pub fn new(raw: &str) -> Result<Self, AuthorNameError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() { return Err(AuthorNameError::Empty); }
        Ok(Self(trimmed.to_string()))
    }
}
```

### Separate the request from the entity

What you need to *create* something differs from the persisted thing — and the two diverge over
time. Model them separately so the API contract isn't chained to storage:

```rust
pub struct CreateAuthorRequest { name: AuthorName }        // input to a use case
pub struct Author { id: Uuid, name: AuthorName }           // persisted entity

impl CreateAuthorRequest {
    pub fn name(&self) -> &AuthorName { &self.name }       // read access for adapters
}
```

## Ports are traits the domain owns

### Outbound (driven) — what the domain needs from the world

```rust
use std::future::Future;

pub trait AuthorRepository: Clone + Send + Sync + 'static {
    fn create_author(
        &self,
        req: &CreateAuthorRequest,
    ) -> impl Future<Output = Result<Author, CreateAuthorError>> + Send;
}
```

The bounds aren't ceremony — each earns its place when this port is shared as web state:

| Bound | Why |
|---|---|
| `Clone` | frameworks like axum clone shared state per request |
| `Send + Sync` | shared across worker threads via `Arc` |
| `'static` | lives for the whole program |
| `-> impl Future + Send` | the returned future must cross threads |

> The explicit `-> impl Future<…> + Send` is the desugaring of `async fn` in a trait that lets
> you add the `Send` bound (plain `async fn` in traits can't, yet). The `trait-variant` crate's
> `#[trait_variant::make(Send)]` generates this for you if you prefer writing `async fn`.

Define one outbound port per external concern: `AuthorRepository` (storage),
`AuthorNotifier` (email), `AuthorMetrics` (telemetry). Each wraps a capability the domain
requires, named in domain terms — not "the sqlx pool".

### Inbound (driving) — how the world calls the domain

```rust
pub trait AuthorService: Clone + Send + Sync + 'static {
    fn create_author(
        &self,
        req: &CreateAuthorRequest,
    ) -> impl Future<Output = Result<Author, CreateAuthorError>> + Send;
}
```

Inbound adapters (HTTP, CLI) depend on *this* trait, never on the concrete `Service` — so the
handler is testable against a fake and the wiring stays swappable.

## The Service implements the inbound port and orchestrates outbound ports

The service is the use-case layer: it's generic over its outbound ports, so it has zero
knowledge of which adapters back them.

```rust
#[derive(Clone)]
pub struct Service<R, M, N>
where
    R: AuthorRepository,
    M: AuthorMetrics,
    N: AuthorNotifier,
{
    repo: R,
    metrics: M,
    notifier: N,
}

impl<R, M, N> AuthorService for Service<R, M, N>
where R: AuthorRepository, M: AuthorMetrics, N: AuthorNotifier {
    async fn create_author(&self, req: &CreateAuthorRequest)
        -> Result<Author, CreateAuthorError>
    {
        let author = self.repo.create_author(req).await?;   // primary work
        self.metrics.author_created();                       // cross-cutting
        self.notifier.author_created(&author).await;
        Ok(author)
    }
}
```

Business rules live here, expressed only in terms of ports and domain types. Keeping the inbound
port a trait "keeps your unit-test surface area sane" — you test the service against fake
outbound ports, and test handlers against a fake inbound port.
