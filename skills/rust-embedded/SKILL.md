---
name: rust-embedded
description: >-
  Bare-metal / microcontroller Rust (no_std firmware) — the constraints (no heap, interrupts, real-time deadlines, single-instance peripherals) and the patterns that satisfy them: heapless collections, peripheral singletons, embedded-hal drivers, ISR-safe critical sections, and RTIC vs Embassy. Use when writing firmware for Cortex-M / RISC-V / ESP or picking an MCU concurrency model. Triggers: no_std, cortex-m, esp32, stm32, rp2040, embedded-hal, RTIC, embassy, heapless, defmt, probe-rs.
---

# Rust Embedded

Firmware on a microcontroller: no OS, RAM measured in **kilobytes**, interrupts that preempt
anything, and deadlines that are physical. There's no runtime to catch you — the compiler and the
ownership model *are* your safety net. The job is to make the borrow checker enforce hardware
invariants (one owner per peripheral, no data race with an ISR) at compile time.

The `#![no_std]`/`#![no_main]`/`core`/`alloc`/`#[panic_handler]` scaffold, target triples,
`.cargo/config.toml`, and cross-compilation are **build mechanics owned by `rust-ecosystem`**
([build-and-targets.md](../rust-ecosystem/build-and-targets.md)). This skill assumes that scaffold
and owns the *domain* patterns.

## When to Use

- Firmware for a Cortex-M / RISC-V / ESP part — a `no_std` binary that runs on bare metal
- Driving peripherals (GPIO/SPI/I2C/UART/DMA) or writing/using a HAL or `embedded-hal` driver
- Choosing a concurrency model on an MCU (bare super-loop vs RTIC vs Embassy)

## Constraints → Rust answer

| Constraint | Why it's physical | Rust answer |
|---|---|---|
| No heap (often no allocator) | deterministic memory; an OOM at 2 a.m. has no `kill -9` | `heapless` fixed-capacity collections, arrays, static buffers — no `Vec`/`Box`/`String` |
| Interrupts preempt at any time | an ISR can fire between any two instructions of `main` | share via `critical_section::Mutex<RefCell<…>>` or atomics — **never** `std::sync::Mutex` (no OS to block on) |
| Real-time deadlines | a missed deadline is a defect, not slowness | bounded work on the hot path, no unbounded loops/alloc, priorities (→ [concurrency.md](concurrency.md)) |
| A peripheral is one physical thing | two owners = bus/pin conflict | move-ownership singletons: `take()` once; the HAL consumes pins **by value** |
| No std (no OS) | no files / threads / net / `println!` | `core` only (→ `rust-ecosystem`); log with `defmt` over RTT, not `println!` |
| A panic can't unwind | it aborts or hangs the chip | a `#[panic_handler]` (`panic-probe`/`panic-halt`); design to return `Result`, not panic |

## Memory without a heap: `heapless`

Capacity lives **in the type**, so allocation is static and failure is a value, not a crash:

```rust
use heapless::Vec;                 // heapless = "0.9"

let mut buf: Vec<u8, 64> = Vec::new();   // 64-byte capacity, on the stack/static — no allocator
buf.push(0xAB).ok();                     // returns Err(value) when full; never reallocates
```

```rust
let mut s: heapless::String<32> = heapless::String::new();   // bounded String
let q: heapless::spsc::Queue<u8, 16> = heapless::spsc::Queue::new();  // ISR→main, lock-free
```

Pulling in the `alloc` crate (+ `embedded-alloc`) to use `Vec`/`String` is possible but a smell on
a small part — it reintroduces fragmentation and non-determinism you came here to avoid. Reach for
it only with a real reason and headroom.

## Peripherals are singletons — the borrow checker as a hardware mutex

`Peripherals::take()` hands out the register block **once** (`None` afterward), so two pieces of
code can't both think they own the UART. The HAL then **consumes pins by value**, so a pin can't be
configured into two roles:

```rust
let dp = pac::Peripherals::take().unwrap();          // ✓ one-time boot precondition; unwrap is fine here
let gpioa = dp.GPIOA.split();
let led = gpioa.pa5.into_push_pull_output();          // pa5 is moved — no one else can claim it
// dp.GPIOA …                                          // ✗ already moved; conflict caught at compile time
```

Write drivers against **`embedded-hal` 1.0** traits (`SpiDevice`, `I2c`, `OutputPin`, …) rather
than a concrete chip, so the same driver runs on STM32, nRF, RP2040, ESP — dispatch/generics are
`rust-traits`.

## Sharing with an interrupt (the signature pattern)

`main` and an ISR both touch a peripheral → you need a **critical section** (briefly disable
interrupts), not a blocking lock. The portable idiom is the `critical-section` crate:

```rust
use critical_section::Mutex;     // NOT std::sync::Mutex — this one disables interrupts
use core::cell::RefCell;

static LED: Mutex<RefCell<Option<Led>>> = Mutex::new(RefCell::new(None));

// in main, after init: move the peripheral into the static (prior None is discarded)
critical_section::with(|cs| LED.borrow(cs).replace(Some(led)));

// in the ISR and in main:
critical_section::with(|cs| {
    if let Some(led) = LED.borrow(cs).borrow_mut().as_mut() { led.toggle(); }
});
```

It builds on interior mutability (`RefCell` → `rust-ownership`), but the `Mutex` is a
critical-section mutex (no OS to park a thread). For a single flag/counter, a lock-free **atomic**
is cheaper than a critical section. Atomics, `portable-atomic` for chips without native CAS,
SPSC queues, and the full **RTIC vs Embassy** decision → [concurrency.md](concurrency.md).

## Log and flash: `defmt` + `probe-rs`

There's no console, so don't `println!`. Use **`defmt`** (deferred formatting — the format string
stays on the host, only IDs go over the wire) via `defmt-rtt`, and `panic-probe` to print panics.
Flash and run with **`probe-rs run`** / `cargo embed` (these supersede the old `probe-run`); wire
it as the `runner` in `.cargo/config.toml`. Add `flip-link` for near-zero-cost stack-overflow
protection.

## Don't panic in steady state

A panic on an MCU aborts or hangs the chip. `take().unwrap()` at init is fine (a one-time boot
precondition); past init, keep everything `Result`-based and avoid `unwrap`/indexing that can
panic. Errors are usually small enums deriving `defmt::Format` (`core::error::Error` is available
since 1.81 if you need it). The error *strategy* is `rust-errors`; `#[entry] fn main() -> !` never
returns.

## Boundaries

- `#![no_std]`/`#![no_main]`/`core`/`alloc`/`#[panic_handler]`, target triples,
  `.cargo/config.toml`, cross-compilation → `rust-ecosystem` ([build-and-targets.md](../rust-ecosystem/build-and-targets.md)).
- `RefCell`/`Cell` interior mutability and `Drop`/RAII that the ISR mutex builds on → `rust-ownership`
  (the *critical-section* mutex is embedded-specific and owned here).
- `Send`/`Sync` and the threads-vs-async model on a hosted OS → `rust-concurrency` (an MCU has no
  threads; ISR / RTIC / Embassy concurrency lives in [concurrency.md](concurrency.md)).
- `Result`-vs-panic, defects vs failures → `rust-errors`. Portable driver generics → `rust-traits`.
- `unsafe` for raw MMIO / register access, or hand-writing a PAC → `rust-unsafe`.
