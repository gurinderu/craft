---
name: rust-navigation
description: Navigate a Rust codebase precisely with rust-analyzer over LSP instead of grepping blindly — jump to a definition, find every reference (impact before a rename), read a symbol's type/docs, outline a file, search symbols by name, find a trait's implementors, and trace a call hierarchy (who calls this / what this calls). Use when exploring an unfamiliar crate, locating a symbol, assessing the blast radius of a change, or building a call graph. Triggers: where is X defined, who calls, who uses this, find references, find implementations, who implements, call hierarchy, go to definition, rust-analyzer, LSP.
---

# Rust navigation (LSP)

`grep` finds text; rust-analyzer understands the program. For "where is this *defined*", "who
*uses* this", "who *implements* this trait", and "who *calls* this", use the `LSP` tool — it
resolves through types, modules, generics, and re-exports that a text search gets wrong.

This is the **Rust tool** for navigation; the *method* for understanding an unfamiliar repo
(map → seams → trace one flow → confirm by building) is `codebase-onboarding`, which calls this.

## Positions are 1-based, so locate first, then operate

Every `LSP` operation takes `filePath`, `line`, `character` (both 1-based, as shown in an editor)
pointing **at the symbol**. You rarely know the column up front, so it's a two-step move:

1. **Find the symbol** by name: `LSP(operation: "workspaceSymbol", query: "parse_config", …)`
   (pass any `filePath`/`line`/`character` — they're required but ignored for this op), or just
   `rg -n "fn parse_config"` to get `file:line`.
2. **Operate at that position**, pointing `character` at the symbol name itself.

## Want X → operation

| You want | Operation | Point at |
|---|---|---|
| Jump to where a symbol is defined | `goToDefinition` | a use site |
| Every place a symbol is used (impact of a change) | `findReferences` | the def or any use |
| A symbol's type + rustdoc, inline | `hover` | the symbol |
| The outline of one file (items, methods) | `documentSymbol` | anywhere in the file (e.g. `1,1`) |
| Find a symbol by name across the crate | `workspaceSymbol` + `query` | n/a (use `query`) |
| Who implements this trait / where a trait method is implemented | `goToImplementation` | the trait or method name |
| Who calls this function | `prepareCallHierarchy` → `incomingCalls` | the fn name |
| What this function calls | `prepareCallHierarchy` → `outgoingCalls` | the fn name |

## Call hierarchy is two steps

`incomingCalls`/`outgoingCalls` need a hierarchy item, so call `prepareCallHierarchy` at the
function name first, then the direction you want. Recurse to the depth you need and render it as a
tree; stop at the layer boundary (handler / trait object / `spawn`) rather than chasing forever.

```
Callers of process_request          Callees of process_request
main                                 process_request
└─ run_server                        ├─ parse_headers
   └─ handle_connection              ├─ authenticate → check_token, load_user
      └─ process_request  ◄ here     └─ send_response
```

## Two high-value uses

- **Impact before a rename/signature change.** Run `findReferences` on the item *first* — that
  set is the blast radius. Feed it to `refactoring` (change under green tests, one site at a time).
- **"Who implements this trait?"** `goToImplementation` on the trait answers the dispatch question
  directly; pair with `rust-traits` when deciding static vs `dyn` vs enum dispatch.

## When there's no LSP

The tool errors if rust-analyzer isn't configured for the workspace. Suggest
`rustup component add rust-analyzer`, and meanwhile fall back to text tools — they're coarser but
always available:

| LSP op | Fallback |
|---|---|
| `goToDefinition` | `rg -n "(fn\|struct\|enum\|trait\|const) <name>"` |
| `findReferences` | `rg -nw "<name>"` (over-reports: same name, different item) |
| `goToImplementation` | `rg -n "impl .*<Trait>( for \|<)"` |
| call hierarchy | `rg -nw "<fn>("` for callers; read the body for callees |
| `documentSymbol` / `workspaceSymbol` | `rg -n "^\s*(pub )?(fn\|struct\|enum\|trait\|mod) "` |

Macros and generated code defeat both LSP and grep equally — verify a surprising result by reading
the site.

## Boundary

- The onboarding *method* (where to start, trace one flow) → `codebase-onboarding`.
- Acting on a `findReferences` set safely → `refactoring`.
- Static vs dynamic vs enum dispatch once you've found the impls → `rust-traits`.
- Finding the *commit* that introduced a behavior (not the symbol) → `debugging` (`git bisect`).
