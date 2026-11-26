# Terminal Relay

Let AI agents and scripts run commands in your VS Code or Cursor terminal and read back the output.

A program, such as an AI agent, writes a small JSON request file. Terminal Relay runs the command in the Integrated Terminal, in front of you, and writes back which terminal ran it, the output and the exit code.

## How it works
- Each VS Code window gets a private **inbox folder**, kept in the extension's own storage outside your project.
- Its path is in the environment variable **`TERMINAL_RELAY_DIR`**, which is set in every integrated terminal of the window. Terminals that were already open before the extension started need to be reopened to get it.
- A sender writes `command.json` into the inbox. Terminal Relay reads it, clears it, runs the request, and writes the result into the inbox.
- Only the first folder of a multi-root workspace is used. Nothing runs if no folder is open, or if the folder is not trusted.

Inbox layout:
```
$TERMINAL_RELAY_DIR/
  command.json                    ← you write requests here
  terminals.json                  ← open terminals
  command-results/<requestId>.json
  terminal-history/<id>.log
```

### Finding the inbox from outside VS Code
A sender that is not running inside a VS Code terminal can look up the inbox in `~/.terminal-relay/workspaces.json`. It maps each open workspace folder to its inbox:
```json
{
  "E:\\projects\\my-app": { "dir": "C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\catscan-crypt.terminal-relay\\workspaces\\my-app-1a2b3c4d5e6f", "pid": 12345, "updatedAt": "..." }
}
```
An entry is removed when its window closes.

## The command file
```
{ "task": "...", "requestId": "optional", "payload": { ... } }
```
- `task`: `runInTerminal` or `closeTerminal`.
- `requestId` (optional): names the result file. If missing, the extension makes one (`req-<time>-<n>`). A requestId already used in this session is ignored.
- `payload`: fields depend on the task.

**Tip:** write the request to a temp file in the inbox and rename it to `command.json`, so the watcher never reads a half-written file.

### `runInTerminal`
Payload fields:
- `command` (string, required): the command to type into the terminal.
- `forceNew` (boolean): always open a new terminal.
- `target` (string or number): an existing terminal, by tracked id or by 1-based index (see `terminals.json`).
- `id` (string): id for a newly created terminal. Fails if that id is already open.
- `name` (string): display name for a newly created terminal (default `Terminal Relay`).
- `submit` (boolean): send the text as input to an app running in the terminal (for example the claude CLI), not as a shell command. See below.

With neither `forceNew` nor `target`, the command goes to a terminal Terminal Relay opened that has nothing running, or a new one is opened. It never types into a terminal you opened yourself unless you target it.

```json
{
  "task": "runInTerminal",
  "requestId": "build-1",
  "payload": {
    "command": "npm run build",
    "forceNew": true,
    "id": "build",
    "name": "Build"
  }
}
```

#### `submit: true`
For input to an app that is already running in the terminal. The text is typed, then Enter is pressed on its own, so the app doesn't read the Enter as a new line inside a paste. An empty `command` just presses Enter. The result is `done` right away, with no output or exit code. Without `target`, it goes to the first terminal Terminal Relay opened.

### `closeTerminal`
Payload fields:
- `target` (string or number, required): tracked id or 1-based index.

```json
{
  "task": "closeTerminal",
  "requestId": "close-1",
  "payload": { "target": "build" }
}
```

## Outputs

### `terminals.json`
The open terminals, updated when one opens or closes. Each entry has `index` (1-based), `id` (tracked id, or `null` for terminals you opened), `name` and `historyFile` (relative to the inbox, or `null` if that terminal isn't logged).

### `command-results/<requestId>.json`
One file per request. Fields:
- `requestId`, `task`, `command`
- `status`: `running`, `done` or `error`
- `terminal`: the terminal that took it (`index`, `id`, `name`, `historyFile`)
- `startedAt`, `endedAt`
- `exitCode`, `output` (cleaned; the last 50,000 characters are kept)
- `error`: what went wrong, when status is `error`
- `note`: for example, that there was no shell integration, so no exit code or output will be reported

Errors don't pop up in the editor. They're in the result file, and also listed in **View → Output → Terminal Relay**.

A `runInTerminal` result stays `running` until the command ends. A `closeTerminal` result is `done` right away. If the terminal is closed while a command runs or waits, the result becomes `error`. Results are written through a temp file and renamed, so they can be read at any time.

### `terminal-history/<id>.log`
Every command run in a logged terminal, with its output (ANSI codes stripped) and exit code. A command sent through `command.json` is logged as the exact text sent, tagged with its request id. By default only terminals Terminal Relay opened are logged (see `terminalRelay.logAllTerminals`).

## Settings
| Setting | Default | |
|---|---|---|
| `terminalRelay.logAllTerminals` | `false` | Also log terminals you opened yourself. |
| `terminalRelay.logRetentionMinutes` | `180` | How long history logs and finished results are kept. `0` turns history off and deletes finished results after a minute. |

## Security and privacy
**Who can send commands.** Any program running under your user account can write to the inbox, and so can run commands in your terminal. That is what this extension is for, so only install it if you're fine with that. A project's files cannot: the inbox is outside every workspace, so a cloned repo, a `git pull` or a branch switch can never send a command. Terminal Relay also does not run in folders VS Code marks as untrusted.

**What gets logged.** Commands and their output are stored as plain text in the inbox, readable by programs running as you, including the agent you use. Anything a command prints, such as a token or password, ends up there. Terminals you opened yourself are not logged unless you turn on `terminalRelay.logAllTerminals`.

**How long it's kept.** History logs and finished results are kept for **3 hours** by default. That's long on purpose: an agent that hits a usage limit can wait it out and still read what happened. If you don't need that, lower `terminalRelay.logRetentionMinutes`, or set it to `0`. Files are also removed:
- a terminal's log when the terminal closes;
- a window's logs and results when that window starts again;
- the leftovers of windows that are gone (closed, crashed, or a folder you never reopen), once they're older than the retention time, the next time any window starts.

## Known limits
- Output and exit code come from shell integration. In Cursor with PowerShell 5.1, output capture can drop output, and the exit code is only 0 or 1.
- Workaround: have the command save its own output and exit code, for example:
  ```
  mycommand | Tee-Object -FilePath out.txt; "exit=$LASTEXITCODE" | Add-Content out.txt
  ```
- Without shell integration the command is still typed in, but no output or exit code is reported.

## Requirements
VS Code or Cursor with VS Code API 1.93 or newer.

## License
Free for noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). Companies and other commercial use need a license; see [COMMERCIAL.md](COMMERCIAL.md).
