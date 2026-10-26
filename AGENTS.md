# Agent rules for this repository

## Code

- Write no code comments, in any language or file.
- Before every commit that touches the mod, run `claude plugin validate .`, `claude plugin test .` and `npx -y -p typescript@5.6.3 tsc -p .`. The type check needs the types Claude Code writes to `.claude-plugin/types/` when it loads the mod from this folder (`claude --plugin-dir .`).
- Hook `tool.call` for the tools the trace follows, not `classic.PreToolUse` or `classic.PostToolUse`. On Team and Enterprise accounts and on machines with managed settings, Claude Code can skip a user plugin's hook on an event its built-in security plugin also hooks, and it skips those two there. Before hooking a new event, run a session with `claude --debug` there and check the log has no `bypassed by cc-plugin-sec-default` line for it.

## Prices

- The price table in `hooks/trace.ts` holds Anthropic's list prices per million tokens. Check it against the published prices when a model is added, and keep a model out of the table rather than guess its price.
