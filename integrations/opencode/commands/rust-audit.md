---
description: Full Rust crate audit — fan out the craft review agents and synthesize one severity-ranked report.
---

Run the craft Rust audit by invoking the `rust-audit` tool.

If the user passed an argument, treat it as the diff base ref and call the tool with `base` set to it:

`$ARGUMENTS`

Otherwise call `rust-audit` with no arguments (it scouts the diff base itself). Return the tool's
synthesized report verbatim.
