# ML frameworks — the decision matrix

Pick along two axes: **classical vs deep learning**, and **inference-only vs training**. The wrong
choice is the dominant source of Rust-ML pain, so decide before you write code.

## Deep learning

| Crate | Backend | Best for | Trade-off |
|---|---|---|---|
| **candle** | pure Rust + CUDA/Metal | inference-first, HF models, small deploy, WASM | younger op coverage than torch; some ops you may implement |
| **burn** | pluggable (wgpu, ndarray, tch, candle) | training **and** inference in pure Rust, backend-portable | newer API, moves fast; larger learning surface |
| **tch** (tch-rs) | libtorch (C++) | full PyTorch parity, training, port existing torch models | ships/links libtorch (large, platform-specific build); `unsafe` FFI boundary |
| **ort** | ONNX Runtime (C++) | fastest path to serve an **existing** model exported to ONNX | inference-only; model must export cleanly to ONNX |
| **dfdx** | pure Rust, const-generic shapes | compile-time-checked tensor shapes, small nets | smaller ecosystem; const-generics ergonomics |

Rules of thumb:

- **Serve a model someone else trained** → export to **ONNX** and run **ort**, or if it's a HF model
  with a candle implementation, **candle**. Don't pull libtorch just to run inference.
- **Train in Rust on purpose** → **burn** (portable) or **tch** (torch parity). Most people still train
  in Python and only serve in Rust — that's fine and common.
- **Port existing PyTorch code faithfully** → **tch** (closest API), accept the libtorch build cost.
- **Compile-time shape safety on small models** → **dfdx**.
- **WASM / tiny binary / no C++ toolchain** → **candle** (or burn+wgpu).

## Classical ML & numerics

| Crate | Use for |
|---|---|
| **linfa** | the scikit-learn of Rust — regression, SVM, k-means, PCA, trees; built on `ndarray` |
| **smartcore** | alternative classical-ML toolkit (similar scope) |
| **ndarray** | dense n-d arrays, linear algebra (`ndarray-linalg` for BLAS/LAPACK) |
| **nalgebra** | small fixed-size linear algebra (graphics, robotics, geometry) |
| **polars** | Arrow-backed DataFrames — ETL, feature engineering (pandas replacement) |
| **arrow** | columnar interop with the wider Arrow ecosystem |

For anything that isn't a neural net (gradient boosting, clustering, dimensionality reduction), reach
for **linfa/smartcore + ndarray** before a deep-learning framework.

## Support crates (framework-agnostic)

- **safetensors** — safe, zero-copy, memory-mapped weight format. Prefer over `.pt`/`.bin` pickle
  (pickle = arbitrary code execution on load → `rust-security`).
- **tokenizers** — HF tokenizers, no Python; load the same `tokenizer.json` the model shipped with.
- **hf-hub** — download models/weights from the Hugging Face Hub.
- **gguf** / **llama.cpp** bindings — quantized LLM inference (GGUF format) on CPU.

## Sanity checks before committing to a stack

- Does the framework have the **ops your model needs**? (candle/dfdx op coverage is narrower than
  torch — check attention/conv variants you rely on.)
- **Build cost**: tch/ort link a large C++ library; candle/burn/dfdx are pure Rust (or optional CUDA).
  This decides your CI, container size, and cross-compilation story (→ `rust-ecosystem`).
- **GPU target**: CUDA (candle/tch), Metal (candle), wgpu (burn) — match your deploy hardware.
- **Versions move fast** — pin exact versions and verify the current API (`cargo metadata` + context7);
  do not trust an example from six months ago.
