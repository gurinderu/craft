# craft for pi

Planned: a pi driver for the craft CLI's step-by-step review (`craft review start`, then `craft review submit`
after each step's agents ran), as `integrations/claude-code/workflows/review.js` (the `craft:review` workflow) drives it from Claude Code.
The binary decides every step; the driver only runs the agents a step hands out and hands their answers back.

Nothing ships here yet.
