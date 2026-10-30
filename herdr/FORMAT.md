# Live trace file

The Claude Code mod writes one file per Herdr terminal while a session runs in it. The Herdr pane reads the file of the terminal it shows. Only terminals on the machine the pane runs on are read: a terminal on another machine has its file on that machine.

## Where

- Windows: `%LOCALAPPDATA%\trace-waterfall\live\<terminal>.json`
- Linux and macOS: `$XDG_STATE_HOME/trace-waterfall/live/<terminal>.json`, or `~/.local/state/trace-waterfall/live/<terminal>.json` when `XDG_STATE_HOME` is unset or not an absolute path

`<terminal>` is the value of `HC_TERMINAL_ID` in the Claude Code process, for example `t9`. Without `HC_TERMINAL_ID` the mod writes nothing, and it also writes nothing when the value holds a character other than a letter, a digit, `.`, `_` or `-`, or starts with `.`.

The mod creates the `trace-waterfall/live` folder when it is missing.

## Content

```json
{
  "format": "trace-waterfall/1",
  "terminal": "t9",
  "session": "3a8a808b-53e0-4194-a1e2-fc904d1c3235",
  "written": 1793380000000,
  "theme": "dark",
  "main": null,
  "traces": []
}
```

- `traces` is the mod's `Trace[]` exactly as `types/index.d.ts` defines it, oldest first, at most `MAX_TRACES`.
- `main` is the `id` of the trace the Claude Code pane follows (the `trace` of the mod's `main` value), or `null`. With `null`, or an `id` that is not in `traces`, the Claude Code pane follows the newest trace, and the Herdr pane does the same.
- `theme` is the Claude Code theme, light or dark. The Herdr pane does not use it: it follows Herdr's own light or dark setting.
- Every time (`written`, `Trace.start`, `Span.start`, `Span.end`) is milliseconds since 1970-01-01 UTC.
- A span that has not ended yet has `pending` above 0; the pane draws it up to the current time, as `displayEnd` in `hooks/trace.ts` does.
- The file stays under 1 MiB. When the traces do not fit, the mod drops the oldest traces first, then the oldest spans of the oldest remaining trace, keeping that trace's root span (the span whose `id` is the trace's `id`). When the trace that `main` names is dropped, `main` is `null`.
- The mod rewrites the whole file after each change, at most every 300 ms. It writes the file in place, because the mod API has no rename, so the pane can read a file that is only partly written. The pane keeps what it showed when the file does not parse, and reads it again on the next change.
- After `/clear` the file gets the new session id, `main` is `null` and `traces` is empty.
- When Claude Code exits, the mod writes the file once more and the file stays, so the pane can still show the last trace. When Claude Code exits in the middle of a request, the spans that had not ended stay pending in the file. Once the terminal no longer runs Claude Code, the pane ends those spans at `written`.
