---
name: rust-ml
description: >-
  Machine learning and numerical computing in Rust — tensors (ndarray/candle), the framework choice (candle vs burn vs tch vs ort vs dfdx vs linfa/smartcore), dtypes (f32/f16/bf16) and determinism, avoiding needless copies of large tensors, GPU device management, and serving a model without blocking the async runtime. Use when doing inference or training in Rust, loading a model (safetensors/ONNX), tokenizing, wiring a data pipeline (polars/arrow), or deploying a model behind an API. Triggers: candle, burn, tch, tch-rs, libtorch, ort, ONNX, onnxruntime, dfdx, linfa, smartcore, ndarray, polars, arrow, safetensors, tokenizers, tensor, inference, embeddings, GPU, CUDA, spawn_blocking model.
---

# Rust ML

Rust in ML is mostly an **inference and data-plane** language: you rarely train large models here,
you serve them fast, safely, and without a GIL. The cardinal skill is **picking the right stack for
the job** (classical vs deep, train vs infer-only, CPU vs GPU) and then not fighting it — most Rust
ML pain comes from choosing the wrong framework or copying tensors around. Framework choice →
[frameworks.md](frameworks.md); putting a model behind an API → [serving.md](serving.md).

## When to Use

- Inference: loading a model (safetensors / ONNX / GGUF) and running it in a Rust service
- Embeddings, tokenization, classical ML (regression, trees, clustering)
- Numerical / tensor computing (ndarray, linear algebra)
- Data pipelines feeding a model (Polars / Arrow)
- Training, when you deliberately choose Rust (burn / candle / tch) — the rarer case

## The cardinal rule: don't reinvent BLAS, and don't fight the framework

Numeric kernels (matmul, conv) are decades of hand-tuned BLAS/cuDNN. **Never hand-roll them.** Pick a
framework that binds the right backend and use its tensor type end-to-end. The wrong choice — a
training framework for pure inference, a pure-Rust one where you needed libtorch parity — is the #1
source of pain. Decide deliberately → [frameworks.md](frameworks.md).

```toml
# Inference-first, pure-Rust, HF ecosystem — the common default:
candle-core = "0.8"
candle-nn = "0.8"
candle-transformers = "0.8"     # ready model architectures
tokenizers = "0.20"             # HF tokenizers, no Python
safetensors = "0.4"            # safe, zero-copy weights (never pickle)
```

Versions drift fast in this ecosystem — resolve the ones actually pinned in the project
(`cargo metadata`) and check the crate's current API rather than trusting memory (→ `rust-ecosystem`,
and context7 for live docs).

## Tensors are big — treat copies as bugs

A tensor is not a `Vec<f32>` you clone freely; it can be gigabytes. The ownership discipline from
`rust-ownership` matters *more* here, not less:

- Pass tensors by reference; slice/view instead of copying. `ndarray` has `.view()`/`.slice()`;
  candle ops borrow. A stray `.to_vec()` / `.clone()` in a hot path can copy hundreds of MB.
- Load weights **zero-copy** with `safetensors` (memory-maps the file) — never deserialize a pickle
  (`.pt`/`.bin`) from an untrusted source: pickle is arbitrary code execution (→ `rust-security`).
- Move a model to the device **once**, at load; don't re-upload per request.

## Dtype and determinism are explicit decisions

- **Dtype is a correctness/perf knob, not a default.** `f32` is the safe baseline; `f16`/`bf16` halve
  memory and speed up GPU inference but change numerics — choose per model, and know that `bf16` (wider
  exponent) tolerates the dynamic range of activations better than `f16`. CPU math in `f16` is usually
  emulated and slow.
- **Determinism must be engineered.** Seed every RNG (`rand` + the framework's own seed); note that GPU
  reductions and multi-threaded CPU ops are **not** bit-reproducible by default. If you assert exact
  outputs in tests, pin threads/backend or assert with a tolerance (`assert_relative_eq!` from
  `approx`), never `==` on floats.

## CPU parallelism vs GPU — and never block the runtime

- CPU-bound tensor work parallelizes with **rayon** (data parallelism), not async — see
  `rust-concurrency` for threads-vs-async. `ndarray` integrates with rayon via `ndarray = { features =
  ["rayon"] }`.
- A forward pass is a **blocking, CPU/GPU-bound** call. In an async service it must run on
  `tokio::task::spawn_blocking` (or a dedicated thread pool / inference actor), never inline in a
  handler — one inference on the async worker stalls every other connection. Full serving pattern →
  [serving.md](serving.md).

## Data pipelines

- **Polars** (Arrow-backed DataFrame) for tabular ETL/feature engineering — lazy, multi-threaded,
  columnar; the pandas replacement. **arrow** directly when interop with other Arrow systems matters.
- **ndarray** for dense numeric arrays and classical-ML feature matrices (`linfa` builds on it).
- Stream large datasets; don't materialize the whole set into `Vec` before feeding a model — batch.

## Testing ML code

Exactness lives behind floating point and randomness, so test **invariants and tolerances**, not
exact bytes (→ `rust-testing`):

- Shape/dtype contracts: output shape and dtype are what the next stage expects.
- Numerical tolerance: compare against a reference with `approx`, not `==`.
- Determinism where you claimed it: same seed → same result (within tolerance).
- A **golden/regression** sample: pin one known input→output pair so a silent model/preprocessing
  change (wrong normalization, tokenizer drift) fails the build.
- Property tests for preprocessing (normalize→denormalize round-trips, tokenizer encode/decode).

## Boundaries

- Framework decision matrix (candle / burn / tch / ort / dfdx / linfa / smartcore) →
  [frameworks.md](frameworks.md).
- Serving a model behind an API (load-once `Arc`, batching, `spawn_blocking`, GPU device, warmup) →
  [serving.md](serving.md), and the HTTP wiring → `rust-web`, deployment/observability →
  `rust-cloud-native`.
- Avoiding tensor copies / view semantics → `rust-ownership`; rayon vs async → `rust-concurrency`.
- Profiling a slow pipeline, dtype/alloc tuning → `rust-performance`.
- Choosing/pinning crates, features, MSRV → `rust-ecosystem`.
- Untrusted model files / pickle RCE / dependency vulns → `rust-security`.
