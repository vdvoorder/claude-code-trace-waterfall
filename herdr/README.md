# Trace panel for Herdr

The Trace panel draws the waterfall of the Claude Code session in a Herdr terminal: the same rows, bars, figures and colours as the Trace pane in Claude Code, as a panel in the Herdr desktop app. It reads the live trace file that the trace-waterfall Claude Code mod writes for each Herdr terminal, described in [FORMAT.md](FORMAT.md).

## Requirements

- The Herdr desktop app, 0.1.9 or newer. Tested on Windows with 0.1.9.
- The trace-waterfall Claude Code mod in a version that writes the live trace file, in a session that runs in a Herdr terminal.

## Installation

On Windows, in PowerShell, from the folder of your clone of this repository:

```powershell
cd C:\git\rv\claude-code-trace-waterfall
Copy-Item -Recurse -Force herdr\trace-waterfall "$HOME\.config\herdr-app\mods\"
herdr-app check "$HOME\.config\herdr-app\mods\trace-waterfall"
```

On Linux:

```bash
cd ~/git/claude-code-trace-waterfall
cp -r herdr/trace-waterfall ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/trace-waterfall
```

When `HERDR_APP_HOME` is set, copy the folder into its `mods` folder instead. The check prints `check passed` when the panel loads.

The first time Herdr sees the folder, it docks the panel at the right edge of the layout on screen, 460 px wide and as tall as the window. After that the layout decides: the panel is a block with the content `{ "mod": "trace-waterfall" }`, which you can move or resize in your own layout. To update the panel, copy the folder again; Herdr reloads it in place. To remove it, delete the folder and the block.

## Use

- Docked, the panel shows the trace of the focused terminal. While a mod pane has the focus, it keeps the terminal it showed.
- Beside one terminal, the panel shows that terminal only, whatever has the focus:

  ```powershell
  herdr-app do pane.split '{"direction":"right","mod":"trace-waterfall","props":{"terminal":"t9"}}'
  ```

- One row per span: the request, each model call, each tool call and each subagent, nested under what started it, with its duration and estimated cost.
- A running span grows every second, and a line marks the present moment.
- Click a row to sum only that span and what it started; click it again, click below the rows or press Escape for the whole request. After a click in the panel, Up and Down move the selection and Left and Right page through the requests.
- ◀ Earlier and Later ▶ page through the requests in the file. The panel follows the request the Claude Code pane follows (`main` in the file, else the request with the latest span) until you page, and goes back to it when that request changes.
- A terminal without a trace file, or a session without requests, gets one sentence instead of the waterfall. When the file does not parse, the panel keeps what it showed and reads the file again on its next change.
- Terminals on other machines are not shown.

## Fixtures

`fixtures/` holds trace files to try the panel without a running session:

- `finished.json`: two finished requests. The second has model calls, tool calls, an Explore subagent with its own calls and a second turn after the agent's message; the first has a failed Edit.
- `live.json`: a running request with a pending model call and a background subagent whose model call is pending. Its times are fixed, so the pending spans run from 30/10/2026 until now; shift every time in it to now to see a request a few seconds old.
- `main-older.json`: two requests, with `main` on the older one, so the panel opens on the first.
- `no-traces.json`: a session without requests, as after `/clear`.
- `empty.json`: an empty file.
- `broken.json`: a file cut off halfway, which does not parse.

Copy one to `%LOCALAPPDATA%\trace-waterfall\live\<terminal>.json` on Windows, or `~/.local/state/trace-waterfall/live/<terminal>.json` on Linux (under `$XDG_STATE_HOME` when it is set), where `<terminal>` is the address `herdr-app ls` lists for the focused pane. A Claude Code session in that terminal overwrites the file.
