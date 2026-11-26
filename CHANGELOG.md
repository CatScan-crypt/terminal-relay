# Change Log

All notable changes to Terminal Relay (formerly IDE-Terminal-Controller) are documented in this file.

## [0.4.0]

### Changed (breaking)
- Renamed to **Terminal Relay** (`terminal-relay`).
- The inbox moved out of the workspace. `command.json`, `terminals.json`, `command-results/` and `terminal-history/` now live in the extension's own storage. Its path is in `TERMINAL_RELAY_DIR` in every integrated terminal, and in `~/.terminal-relay/workspaces.json`. Senders must write to `$TERMINAL_RELAY_DIR/command.json` instead of `.vscode/command.json`. Old files in `.vscode/` are no longer used and can be deleted.
- `historyFile` in `terminals.json` and results is relative to the inbox.
- Without `target` or `forceNew`, a command goes to an idle terminal Terminal Relay opened (or a new one), never to the first open terminal.
- Only terminals Terminal Relay opened are logged by default.
- A failed request no longer shows a popup. The error is in its result file and in View → Output → Terminal Relay.

### Added
- Setting `terminalRelay.logAllTerminals` (default `false`).
- Setting `terminalRelay.logRetentionMinutes` (default `180`; `0` turns history off).
- On startup, files left by windows that are gone are deleted once older than the retention time.
- License: PolyForm Noncommercial 1.0.0.

### Security
- A project's files can no longer send commands: a committed `command.json`, a `git pull` or a branch switch used to be able to run a command.
- Does not run in untrusted workspaces.
- A request left over from a previous session is dropped, not run.

### Fixed
- No message on every window opened without a folder.

## [0.3.0]

### Added
- `runInTerminal` payload `submit: true`: input for an app running in the terminal (e.g. the claude CLI). Types the text, then presses Enter on its own, so the app doesn't read the Enter as a new line in a paste. An empty `command` just presses Enter. The result is `done` at once.

## [0.2.0]

### Added
- `.vscode/command-results/<requestId>.json`: one result file per request (status, terminal, times, exit code, output, error, note). Cleared on startup; finished results are pruned after 3 hours.
- `.vscode/terminals.json`: list of open terminals, including each one's history file.
- `.vscode/terminal-history/<id>.log`: each command's output (ANSI stripped) and exit code. Removed when the terminal closes, wiped after 3 hours, cleared on startup.
- `closeTerminal` task; `runInTerminal` accepts `target` as an id or index, plus `id` and `name` for new terminals; optional `requestId`.

### Fixed
- Commands no longer run twice (Windows fires two change events per save).
- Bad JSON, an unknown terminal or a missing command now gives a warning and an `error` result instead of failing silently.
- The history log shows the exact command sent, tagged with its request id.

### Known issues
- Cursor on PowerShell 5.1 can drop captured output, and the exit code is only 0 or 1.

## [0.1.0]

- Initial release