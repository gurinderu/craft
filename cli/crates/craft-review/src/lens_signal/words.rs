//! What each lens signal looks for on an added line: a line heuristic over source text, not a
//! parser, which errs toward firing — a lens it lets through costs tokens, one it holds back costs
//! findings (realm @nick/craft, node #625).

/// Unsafe code and the foreign-function boundary: `unsafe`, `extern "C"`, raw pointers,
/// `transmute`, the FFI modules and C layouts.
const UNSAFE: [&str; 16] = [
    "unsafe",
    "extern \"",
    "#[no_mangle]",
    "transmute",
    "*const ",
    "*mut ",
    "ffi::",
    "libc::",
    "#[repr(C",
    "from_raw",
    "into_raw",
    "MaybeUninit",
    "as_ptr()",
    "as_mut_ptr()",
    "ptr::read",
    "ptr::write",
];

/// Words of an identifier that name money, matched whole after splitting snake and camel case.
#[rustfmt::skip]
const MONEY: [&str; 34] = [
    "amount", "amounts", "price", "prices", "pricing", "balance", "balances", "currency",
    "currencies", "decimal", "decimals", "cents", "money", "monetary", "payment", "payments",
    "invoice", "invoices", "refund", "refunds", "wallet", "wallets", "fee", "fees", "tax", "taxes",
    "billing", "payout", "payouts", "usd", "eur", "satoshi", "lamports", "wei",
];

/// Threads, async spawns, locks, atomics and channels, across the languages the profiles review.
#[rustfmt::skip]
const CONCURRENCY: [&str; 38] = [
    "thread::spawn", "std::thread", "tokio::spawn", "task::spawn", "spawn_blocking", "spawn_local",
    "JoinSet", "JoinHandle", "Mutex", "RwLock", "Atomic", "Ordering::SeqCst", "Ordering::Acquire",
    "Ordering::Release", "Ordering::Relaxed", "Ordering::AcqRel", "mpsc", "oneshot", "broadcast::",
    "crossbeam", "rayon", "par_iter", "Condvar", "Semaphore", "Barrier", "select!", "Promise.all",
    "Promise.race", "new Worker(", "worker_threads", "Atomics.", "SharedArrayBuffer", "threading",
    "multiprocessing", "asyncio.gather", "asyncio.create_task", "go func", "sync.WaitGroup",
];

/// An allocation or an I/O call: what a loop body pays for on every turn.
#[rustfmt::skip]
const LOOP_COST: [&str; 30] = [
    ".clone()", ".to_string()", ".to_owned()", ".to_vec()", ".collect", "format!(", "vec![",
    "Vec::new", "String::new", "String::from", "Box::new", "HashMap::new", "BTreeMap::new",
    "JSON.parse", "JSON.stringify", "fs::", "File::", "std::io", "read_to_string", ".read(",
    ".write(", ".await", "await ", "fetch(", "Command::new", "readFileSync", "writeFileSync",
    ".execute(", ".query(", "open(",
];

/// How many lines past a loop's opening an allocation or I/O call still counts as its body.
pub(super) const LOOP_BODY: u32 = 10;

pub(super) fn is_unsafe(line: &str) -> bool {
    UNSAFE.iter().any(|t| line.contains(t))
}

pub(super) fn is_money(line: &str) -> bool {
    words(line).any(|w| MONEY.contains(&w.as_str()))
}

pub(super) fn is_concurrency(line: &str) -> bool {
    CONCURRENCY.iter().any(|t| line.contains(t))
}

pub(super) fn is_loop_cost(line: &str) -> bool {
    LOOP_COST.iter().any(|t| line.contains(t))
}

/// Whether `line` opens a loop: a `for`, `while` or `loop` statement, or an iterator's
/// `for_each`/`forEach`.
pub(super) fn opens_loop(line: &str) -> bool {
    let t = line.trim_start();
    ["for ", "for(", "while ", "while(", "loop {", "loop{"]
        .iter()
        .any(|o| t.starts_with(o))
        || line.contains(".for_each(")
        || line.contains(".forEach(")
}

/// The lower-case words of `line`'s identifiers: split on anything not alphanumeric, then at each
/// lower-to-upper case change (`totalAmount` → `total`, `amount`).
fn words(line: &str) -> impl Iterator<Item = String> + '_ {
    line.split(|c: char| !c.is_ascii_alphanumeric())
        .flat_map(camel)
        .map(str::to_ascii_lowercase)
}

fn camel(ident: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = ident;
    while let Some(at) = rest
        .as_bytes()
        .windows(2)
        .position(|w| matches!(w, [a, b] if a.is_ascii_lowercase() && b.is_ascii_uppercase()))
    {
        let (word, tail) = rest.split_at(at + 1);
        out.push(word);
        rest = tail;
    }
    out.push(rest);
    out
}
