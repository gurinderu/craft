# Concurrency on an MCU: ISRs, atomics, RTIC, Embassy

No threads, no OS scheduler. Concurrency on a microcontroller comes from **interrupts** preempting
the main loop by priority. The whole game is sharing state between an ISR and `main` (or between
ISRs) without a data race, while keeping ISRs short enough to meet deadlines.

## Pick the cheapest sharing primitive that works

| Shared thing | Use | Cost |
|---|---|---|
| A flag / counter / single scalar | an **atomic** (`AtomicBool`, `AtomicU32`) | lock-free; no interrupts disabled |
| A scalar on a chip without native atomics (Cortex-M0/M0+ `thumbv6m`, some RISC-V) | `portable-atomic` (CAS via critical section under the hood) | transparent fallback |
| A whole peripheral / non-`Copy` struct | `critical_section::Mutex<RefCell<Option<T>>>` | disables interrupts for the section — keep it tiny |
| A stream of items ISR→main | `heapless::spsc::Queue` (single-producer/-consumer) | lock-free; no critical section per item |

Prefer an atomic to a critical section whenever the state is a single scalar — a critical section
blocks *every* interrupt (including higher-priority, deadline-critical ones) for its duration.

```rust
use core::sync::atomic::{AtomicBool, Ordering};
static DATA_READY: AtomicBool = AtomicBool::new(false);

// ISR: do the minimum, then signal
#[interrupt] fn EXTI0() { DATA_READY.store(true, Ordering::Release); }

// main: react
if DATA_READY.swap(false, Ordering::Acquire) { process(); }
```

## Keep ISRs short — defer the work

An ISR runs with interrupts (partly) masked and steals time from everything. Do the minimum inside
it — read the hardware register that cleared the flag, then **hand off**: set an atomic, push to an
`spsc::Queue`, or wake a task. Do the real work in `main` or a lower-priority task. A long ISR is
how you miss the *next* interrupt.

## The model: bare loop, RTIC, or Embassy

| Model | Shape | Best for | Cost |
|---|---|---|---|
| **Bare super-loop** | `loop { poll(); }` + raw `#[interrupt]` fns + statics | trivial firmware, one or two interrupts | you hand-roll all sharing/critical sections |
| **RTIC 2** | tasks bound to interrupts, scheduled by **priority** | hard real-time, interrupt-driven, preemption with static guarantees | declarative; compile-time-checked resource locks |
| **Embassy** | `async`/`.await` on bare metal, an executor + async HALs | many concurrent *waits* (I/O, timers), state machines | async runtime; one executor per priority level |

Rule of thumb: **RTIC** when the design is "respond to interrupts by priority and meet deadlines";
**Embassy** when it's "await lots of I/O / timers concurrently"; bare loop only when it's tiny.

### RTIC 2 — priority-scheduled tasks, lock-free-feeling sharing

Resources are declared once; RTIC enforces access by **priority ceiling**, so `lock` can't
deadlock and a higher-priority task never blocks on a lower one. Tasks may be `async`.

```rust
#[rtic::app(device = pac, dispatchers = [SWI0_EGU0])]
mod app {
    #[shared] struct Shared { counter: u32 }
    #[local]  struct Local  { led: Led }

    #[init]
    fn init(cx: init::Context) -> (Shared, Local) { /* take peripherals, set up */ }

    #[task(binds = TIMER0, shared = [counter], priority = 2)]
    fn tick(mut cx: tick::Context) {
        cx.shared.counter.lock(|c| *c += 1);   // priority-ceiling lock; no spin, no deadlock
    }
}
```

Shared, static, no heap; preemption is by `priority`. A lower-priority task accessing `counter`
briefly raises the ceiling so `tick` can't corrupt it — the borrow is checked, not hoped.

### Embassy — async on bare metal

Tasks are `async fn`s; `.await` yields the CPU (often sleeping the core) until a hardware event,
instead of busy-waiting. Great for "do N things that are mostly waiting."

```rust
use embassy_executor::Spawner;
use embassy_time::{Duration, Timer};

#[embassy_executor::task]
async fn blink(mut led: Led) {
    loop {
        led.toggle();
        Timer::after(Duration::from_millis(500)).await;   // core can sleep here
    }
}

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    let p = embassy_stm32::init(Default::default());
    spawner.spawn(blink(Led::new(p.PA5))).unwrap();
}
```

The async model here is the same `Future`/`.await` machinery as `rust-concurrency`, but the
executor is `no_std` and single-core; there are no OS threads. Cross-task sharing uses Embassy's
`Mutex`/`Signal`/`Channel` (async-aware), not `std::sync`.

## Boundaries

- The `async`/`.await`/`Future` model itself, and `Send`/`Sync` reasoning → `rust-concurrency`.
- The ISR-mutex's interior mutability (`RefCell`) foundation → `rust-ownership`.
- Picking static vs `dyn` for portable drivers → `rust-traits`.
