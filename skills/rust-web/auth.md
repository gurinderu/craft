# Authentication & authorization

Auth lives in the **inbound adapter** — verify identity at the edge, hand the domain a trusted
`UserId` (the domain shouldn't know about JWTs or cookies). Two separate questions: **authn**
(who are you?) and **authz** (are you allowed?).

```toml
[dependencies]
jsonwebtoken = "10"
argon2 = "0.5"
axum-extra = { version = "0.12", features = ["typed-header", "cookie"] }
```

## Password hashing — `argon2`, never anything fast

Store a password **hash**, never the password, and never a fast hash (MD5/SHA): those are
brute-forceable. Argon2id is the current default; it produces a self-describing PHC string
(algo + params + salt + hash) you store as one column.

```rust
use argon2::{Argon2, PasswordHasher, PasswordVerifier, password_hash::{SaltString, PasswordHash, rand_core::OsRng}};

fn hash(password: &str) -> String {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default().hash_password(password.as_bytes(), &salt).unwrap().to_string()
}
fn verify(password: &str, phc: &str) -> bool {
    let parsed = PasswordHash::new(phc).unwrap();
    Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok()
}
```

`verify` is constant-time. Don't reveal whether the *email* or the *password* was wrong — one
generic "invalid credentials" (avoids user enumeration).

## JWT — `jsonwebtoken`

Stateless tokens: sign claims at login, verify on each request. Keep the signing key in a
`secrecy::SecretString` (→ `rust-security`), and always set an **expiry**.

```rust
use jsonwebtoken::{encode, decode, Header, Validation, EncodingKey, DecodingKey};

#[derive(serde::Serialize, serde::Deserialize)]
struct Claims { sub: String, exp: usize }   // sub = user id, exp = unix expiry (required)

fn issue(user_id: &str, key: &EncodingKey) -> String {
    let exp = (jsonwebtoken::get_current_timestamp() + 15 * 60) as usize;  // now + 15 min
    encode(&Header::default(), &Claims { sub: user_id.into(), exp }, key).unwrap()
}
fn verify(token: &str, key: &DecodingKey) -> Result<Claims, jsonwebtoken::errors::Error> {
    decode::<Claims>(token, key, &Validation::default()).map(|d| d.claims)  // checks exp + signature
}
```

Short-lived access token + a longer refresh token (stored/revocable) is the usual shape — pure
JWT can't be revoked before expiry, so keep `exp` small.

## An auth extractor

Make "must be logged in" a type. An extractor runs before the handler and rejects unauthenticated
requests with 401 — handlers that need auth just take `AuthUser`:

```rust
use axum::{extract::FromRequestParts, http::request::Parts};
use axum_extra::{TypedHeader, headers::{Authorization, authorization::Bearer}};

struct AuthUser { id: UserId }

impl<S: Send + Sync> FromRequestParts<S> for AuthUser {
    type Rejection = ApiError;          // -> 401 (→ handlers.md error mapping)
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let TypedHeader(Authorization(bearer)) =
            TypedHeader::<Authorization<Bearer>>::from_request_parts(parts, state)
                .await.map_err(|_| ApiError::Unauthorized)?;
        let claims = verify(bearer.token(), decoding_key(state))
            .map_err(|_| ApiError::Unauthorized)?;
        Ok(AuthUser { id: UserId::parse(&claims.sub)? })
    }
}

async fn me(user: AuthUser) -> Json<Profile> { /* user.id is trusted here */ }
```

Prefer this per-handler extractor over blanket middleware — it's explicit (the signature shows
the route needs auth) and gives you the `UserId` directly. Use a `tower` layer only for
truly-global concerns.

## Sessions & cookies

For browser apps, signed/encrypted cookies via `axum-extra` (`SignedCookieJar` /
`PrivateCookieJar`) instead of bearer tokens; pair with CSRF protection and `HttpOnly`+`Secure`
+`SameSite` flags. Server-side sessions (id in cookie, state in Redis/DB) when you need
revocation.

## Authorization ≠ authentication

A verified `AuthUser` only says *who*. Whether they may do *this* is a **domain** decision —
check roles/ownership in the service, not the handler:

```rust
// in the domain service, not the adapter
if order.owner != user.id && !user.is_admin() {
    return Err(OrderError::Forbidden);   // -> 403 (distinct from 401)
}
```

401 = not authenticated (who are you?); 403 = authenticated but not allowed. Keep them distinct.

## Don't

- Log tokens, passwords, or `Authorization` headers (→ `rust-security` / `secrecy`; skip them in
  `tracing` spans).
- Put secrets/keys in code or plain config fields — load into `SecretString`.
- Roll your own crypto or token format — use the vetted crates above.
