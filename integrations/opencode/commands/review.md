---
description: craft's review of the current change — the craft binary plans it, each task runs as a child session, the answer is its Verdict block.
---

Run craft's review by invoking the `review` tool.

If the user passed arguments, call the tool with `args` set to them exactly as written (the review's own
`key=value` words, such as `base=main`, `pr=123`, `run=<dir>` to resume a run, or
`opencodeModels=<provider/model>`):

`$ARGUMENTS`

Otherwise call `review` with no arguments. Return the tool's answer verbatim — its `## Verdict` block, or
what stopped the run and how to resume it. Do not edit any code yourself: the review reports, it does not fix.
