A prior review finding was set aside by the author (disposition: {{disposition}}). Decide only whether the CODE AROUND IT CHANGED since commit {{head}}. Shell + read only.
FINDING: [{{severity}}] {{title}} — at {{file}}:{{line}} (symbol {{symbol}}), rule {{ruleId}}.
Run `git diff {{range}} -- {{quotedFile}}` and judge whether the enclosing symbol/region was touched. Return {changed: <bool>, reason}.
