# Serving a model behind an API

Inference is a **blocking, CPU/GPU-bound** call sitting inside an async service. Four things decide
whether the service is fast and stable: load once, keep the runtime unblocked, batch, and warm up.

## 1. Load once, share immutably

Load the model and move it to the device **at startup**, then share it read-only across requests.
Re-loading or re-uploading per request is the classic latency bug.

```rust
// Load once; Arc gives cheap cloning of a shared, immutable model into each handler.
let model = Arc::new(Model::load(&weights, &device)?);   // device chosen once (below)
let state = AppState { model, tokenizer: Arc::new(tokenizer) };
```

If the framework's model type is not `Sync` (some hold interior state), don't wrap-and-hope — put it
behind an **inference worker**: a dedicated thread (or small pool) owning the model, fed by a bounded
`mpsc` channel of `(input, oneshot::Sender<output>)`. That also gives you a natural batching point (§3).

## 2. Never block the async runtime

A forward pass on a tokio worker thread stalls every other connection on that thread. Run it on a
blocking pool:

```rust
async fn infer(State(s): State<AppState>, Json(req): Json<Req>) -> Result<Json<Resp>, ApiError> {
    let model = s.model.clone();
    // CPU/GPU-bound work off the async runtime:
    let out = tokio::task::spawn_blocking(move || model.forward(&req.input)).await??;
    Ok(Json(out.into()))
}
```

Prefer a **dedicated inference thread pool / worker** over unbounded `spawn_blocking` when inference is
your main workload — it bounds concurrency to what the hardware (and GPU memory) can serve, giving
back-pressure instead of thrashing. Threads-vs-async and bounded channels → `rust-concurrency`.

## 3. Batch under load

GPUs (and BLAS) are far more efficient on batches than on single items. Collect requests arriving
within a small window (e.g. a few ms or up to N items) into one forward pass, then scatter results
back via each request's `oneshot`. This is the single biggest throughput lever for GPU serving — and
the worker from §1 is exactly where it lives.

## 4. Warm up and manage the device

- **Warmup**: run a dummy inference at startup so the first real request doesn't eat lazy CUDA context
  init / cuDNN autotuning / allocator growth. Fail readiness until warmup completes.
- **Device selection once**: `Device::cuda_if_available(0)` (or Metal/CPU) at load; thread it through.
  Log which device you got — silently falling back to CPU is a common "why is prod slow" bug.
- **GPU memory is finite**: batch size × model size must fit. Bound concurrency (§2) so you don't OOM
  the device; treat GPU OOM as a typed 503, not a panic (→ `rust-errors`).

## 5. Operational surface

- **Observability**: record inference latency, batch size, queue depth, device — as metrics/traces
  (→ `rust-cloud-native`). Queue depth climbing is your saturation signal.
- **Graceful shutdown**: drain in-flight inferences before exit (→ `rust-cloud-native` SIGTERM).
- **Health/readiness**: not ready until the model is loaded, on-device, and warmed up.
- **Container**: model weights dominate image size — bake them in or fetch at boot via `hf-hub`;
  keep the runtime image lean (→ `rust-cloud-native`).

## Boundaries

- HTTP routing, extractors, typed error responses, shared `State` → `rust-web`.
- Bounded channels, worker pools, `spawn_blocking`, back-pressure → `rust-concurrency`.
- Metrics/tracing, health, 12-factor config, containers, graceful shutdown → `rust-cloud-native`.
- Avoiding tensor copies across the boundary → `rust-ownership`; latency profiling → `rust-performance`.
