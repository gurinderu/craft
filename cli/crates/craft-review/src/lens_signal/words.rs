//! What each lens signal looks for on a line of a hunk — added, removed or the function around
//! it: a line heuristic over source text, not a parser, which errs toward firing — a lens it lets
//! through costs tokens, one it holds back costs findings (realm @nick/craft, node #625).

/// Words of an identifier that name money, matched whole after splitting snake and camel case.
#[rustfmt::skip]
const MONEY: [&str; 99] = [
    "amount", "amounts", "price", "prices", "priced", "pricing", "balance", "balances", "currency",
    "currencies", "decimal", "decimals", "cents", "cent", "money", "monetary", "payment",
    "payments", "pay", "paid", "payer", "payers", "payee", "payees", "payable", "payout", "payouts",
    "receivable", "invoice", "invoices", "invoiced", "refund", "refunds", "refunded", "refunding",
    "refundable", "wallet", "wallets", "fee", "fees", "tax", "taxes", "bill", "bills", "billed",
    "billing", "usd", "eur", "gbp", "jpy", "eth", "usdc", "sats", "satoshi", "gwei", "wei", "btc",
    "lamports", "fiat", "charge", "charges", "charged", "ledger", "ledgers", "credit", "credits",
    "credited", "debit", "debits", "debited", "transfer", "transfers", "transferred",
    "transferring", "deposit", "deposits", "withdraw", "withdraws", "withdrawal", "withdrawals",
    "cost", "costs", "total", "totals", "subtotal", "subtotals", "discount", "discounts", "settle",
    "settles", "settled", "settlement", "settlements", "escrow", "revenue", "revenues", "salary",
    "salaries", "rounding",
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

pub(super) fn is_money(line: &str) -> bool {
    words(line).any(|w| MONEY.contains(&w.as_str()))
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

/// The lower-case words of `line`'s identifiers: split on anything not alphanumeric, then before
/// each capital that opens a word — one after a lower-case letter or a digit, or the last of a run
/// of capitals before a lower-case letter (`totalAmount` → `total`, `amount`; `USDAmount` → `usd`,
/// `amount`; `v2Amount` → `v2`, `amount`).
fn words(line: &str) -> impl Iterator<Item = String> + '_ {
    line.split(|c: char| !c.is_ascii_alphanumeric())
        .flat_map(camel)
        .map(str::to_ascii_lowercase)
}

/// `ident`, all ASCII, cut into its camel-case words.
fn camel(ident: &str) -> Vec<&str> {
    let b = ident.as_bytes();
    let upper = |i: usize| b.get(i).is_some_and(u8::is_ascii_uppercase);
    let lower = |i: usize| b.get(i).is_some_and(u8::is_ascii_lowercase);
    let mut out = Vec::new();
    let mut start = 0;
    for i in 1..b.len() {
        if upper(i) && (!upper(i - 1) || lower(i + 1)) {
            out.push(ident.get(start..i).unwrap_or(""));
            start = i;
        }
    }
    out.push(ident.get(start..).unwrap_or(""));
    out
}
