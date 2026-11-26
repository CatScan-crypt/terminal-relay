import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ANSI_PATTERN, cleanOutput } from './cleanOutput';
import { addPending, dropPending, hasPending, takePending } from './pending';
import { hasResult, initResults, isRunning, newRequestId, pruneResults, writeResult, TerminalInfo } from './results';
import { inboxDirFor, registerWorkspace, sweepStorage, unregisterWorkspace } from './storage';

// A terminal can be targeted by its tracked ID (string) or by its 1-based position (number).
type TerminalTarget = string | number;

interface RunPayload {
    command: string;
    forceNew?: boolean;
    target?: TerminalTarget;
    id?: string;   // ID to give a newly created terminal
    name?: string; // display name for a newly created terminal
    submit?: boolean; // input for an app running in the terminal (e.g. the claude CLI), not a shell command
}

interface ClosePayload {
    target: TerminalTarget;
}

// requestId is optional; without one the extension makes one up, and the result file is named after it
type CommandFile =
    | { task: 'runInTerminal'; requestId?: string; payload: RunPayload }
    | { task: 'closeTerminal'; requestId?: string; payload: ClosePayload };

const EXTENSION_NAME = 'Terminal Relay';
const DEFAULT_TERMINAL_NAME = 'Terminal Relay';
// Set in every integrated terminal of the window; points at this window's inbox
const INBOX_ENV_VAR = 'TERMINAL_RELAY_DIR';

const DEFAULT_RETENTION_MINUTES = 180;
// With retention 0 there is no history, and finished results are deleted after this long
const MIN_RESULT_AGE_MS = 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 1000;

// How long a new terminal gets to start its shell integration before the command is typed in blind
const SHELL_INTEGRATION_WAIT_MS = 5000;
// Gap between typing the text and pressing Enter, so the app doesn't read both as one paste
const SUBMIT_DELAY_MS = 300;

interface HistoryLog {
    file: string;
    startedAt: number | undefined; // time of the oldest entry still in the file
}

// ID -> terminal, for terminals this extension created
const trackedTerminals = new Map<string, vscode.Terminal>();
// Terminal -> its history log; an entry is removed (and its file deleted) when the terminal closes
const historyLogs = new Map<vscode.Terminal, HistoryLog>();
// Terminal -> requests running in it, so closing the terminal can end them
const runningRequests = new Map<vscode.Terminal, Set<string>>();
// Terminal -> number of shell commands running in it right now (typed by hand or sent)
const activeExecutions = new Map<vscode.Terminal, number>();
let nextTerminalNumber = 1;
let nextHistoryNumber = 1;
let inboxDir: string | undefined;
let stateFilePath: string | undefined;
let historyDirPath: string | undefined;
let workspacePath: string | undefined;
// View > Output > Terminal Relay; errors go here instead of popups, since the sender reads them from the result file
let output: vscode.LogOutputChannel | undefined;
// command.json is handled one change at a time; Windows fires two events per save
let queue: Promise<void> = Promise.resolve();

function config() {
    return vscode.workspace.getConfiguration('terminalRelay');
}

// 0 means no history logs at all
function retentionMs(): number {
    const minutes = config().get<number>('logRetentionMinutes', DEFAULT_RETENTION_MINUTES);
    return (typeof minutes === 'number' && minutes >= 0 ? minutes : DEFAULT_RETENTION_MINUTES) * 60 * 1000;
}

function resultMaxAgeMs(): number {
    return Math.max(retentionMs(), MIN_RESULT_AGE_MS);
}

function getTerminalId(terminal: vscode.Terminal): string | undefined {
    for (const [id, tracked] of trackedTerminals) {
        if (tracked === terminal) {
            return id;
        }
    }
    return undefined;
}

function resolveTerminal(target: TerminalTarget): vscode.Terminal | undefined {
    if (typeof target === 'string') {
        return trackedTerminals.get(target);
    }
    const terminals = vscode.window.terminals;
    if (typeof target === 'number' && target > 0 && terminals.length >= target) {
        return terminals[target - 1];
    }
    return undefined;
}

function createTrackedTerminal(id?: string, name?: string): vscode.Terminal {
    if (id && trackedTerminals.has(id)) {
        throw new Error(`A terminal with id "${id}" is already open.`);
    }

    let terminalId = id;
    while (!terminalId || trackedTerminals.has(terminalId)) {
        terminalId = `term-${nextTerminalNumber++}`;
    }

    const terminal = vscode.window.createTerminal(name ?? DEFAULT_TERMINAL_NAME);
    trackedTerminals.set(terminalId, terminal);
    writeTerminalState();
    return terminal;
}

function isBusy(terminal: vscode.Terminal): boolean {
    return (activeExecutions.get(terminal) ?? 0) > 0 || (runningRequests.get(terminal)?.size ?? 0) > 0 || hasPending(terminal);
}

// Never one the user opened, and never one with a command still running in it
function idleTrackedTerminal(): vscode.Terminal | undefined {
    for (const terminal of trackedTerminals.values()) {
        if (!isBusy(terminal)) {
            return terminal;
        }
    }
    return undefined;
}

function waitForShellIntegration(terminal: vscode.Terminal): Promise<vscode.TerminalShellIntegration | undefined> {
    if (terminal.shellIntegration) {
        return Promise.resolve(terminal.shellIntegration);
    }
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            listener.dispose();
            resolve(undefined);
        }, SHELL_INTEGRATION_WAIT_MS);
        const listener = vscode.window.onDidChangeTerminalShellIntegration(e => {
            if (e.terminal === terminal) {
                clearTimeout(timer);
                listener.dispose();
                resolve(e.shellIntegration);
            }
        });
    });
}

async function runCommandInTerminal(requestId: string, payload: RunPayload) {
    const { command, forceNew, target, id, name, submit } = payload;
    if (typeof command !== 'string' || (!submit && !command.trim())) {
        throw new Error('payload.command is missing or empty.');
    }

    let targetTerminal: vscode.Terminal | undefined;

    if (forceNew) {
        targetTerminal = createTrackedTerminal(id, name);
    }
    else if (target !== undefined) {
        targetTerminal = resolveTerminal(target);
        if (!targetTerminal) {
            throw new Error(`No open terminal matches target ${JSON.stringify(target)}.`);
        }
    }
    else if (submit) {
        // Input goes to an app that is already running, so the terminal is expected to be busy
        targetTerminal = trackedTerminals.values().next().value;
        if (!targetTerminal) {
            throw new Error('payload.submit needs a target: no terminal opened by Terminal Relay is open.');
        }
    }
    else {
        targetTerminal = idleTrackedTerminal() ?? createTrackedTerminal(id, name);
    }

    targetTerminal.show();
    if (submit) {
        await submitInput(requestId, targetTerminal, command);
        return;
    }
    const shell = await waitForShellIntegration(targetTerminal);
    writeResult(requestId, {
        status: 'running',
        terminal: terminalInfo(targetTerminal),
        ...(!shell && { note: 'No shell integration: the command was typed in, but no exit code or output will be reported.' }),
    });
    // Typed in rather than shell.executeCommand: in a new PowerShell terminal, executeCommand loses the first
    // command's output. The start event matches the run back to this request.
    addPending(targetTerminal, { requestId, command });
    targetTerminal.sendText(command);
}

// Text and Enter sent together arrive as one paste, so an app like the claude CLI takes the Enter as a new line.
// Type the text, then press Enter alone. An empty command just presses Enter. No shell runs, so it's done at once.
async function submitInput(requestId: string, terminal: vscode.Terminal, text: string) {
    if (text) {
        terminal.sendText(text, false);
        await new Promise(resolve => setTimeout(resolve, SUBMIT_DELAY_MS));
    }
    terminal.sendText('\r', false);
    writeResult(requestId, { status: 'done', terminal: terminalInfo(terminal), endedAt: new Date().toISOString() });
}

function closeTerminal(requestId: string, payload: ClosePayload) {
    const terminal = resolveTerminal(payload.target);
    if (!terminal) {
        throw new Error(`No open terminal matches target ${JSON.stringify(payload?.target)}.`);
    }
    // Map cleanup and the state file update happen in onDidCloseTerminal
    terminal.dispose();
    writeResult(requestId, { status: 'done', endedAt: new Date().toISOString() });
}

// Only terminals this extension opened are logged, unless logAllTerminals is on; nothing is logged with retention 0
function shouldLog(terminal: vscode.Terminal): boolean {
    return historyDirPath !== undefined
        && retentionMs() > 0
        && (getTerminalId(terminal) !== undefined || config().get<boolean>('logAllTerminals', false));
}

// Assigned lazily; named after the tracked ID, or terminal-N for terminals opened by hand
function getHistoryLog(terminal: vscode.Terminal): HistoryLog | undefined {
    if (!historyDirPath || !shouldLog(terminal)) {
        return undefined;
    }

    let log = historyLogs.get(terminal);
    if (!log) {
        const usedFiles = new Set([...historyLogs.values()].map(l => l.file));
        let key = getTerminalId(terminal)?.replace(/[^\w.-]/g, '_');
        while (!key || usedFiles.has(path.join(historyDirPath, `${key}.log`))) {
            key = `terminal-${nextHistoryNumber++}`;
        }
        log = { file: path.join(historyDirPath, `${key}.log`), startedAt: undefined };
        historyLogs.set(terminal, log);
    }
    return log;
}

async function appendHistory(terminal: vscode.Terminal, text: string) {
    const log = historyLogs.get(terminal);
    if (!log) {
        return; // terminal was closed while its output was still streaming
    }
    try {
        await fs.promises.mkdir(path.dirname(log.file), { recursive: true });
        await fs.promises.appendFile(log.file, text);
        log.startedAt ??= Date.now();
    } catch (err) {
        console.error('Failed to write terminal history:', err);
    }
}

function deleteHistoryFile(file: string) {
    fs.rm(file, { force: true }, (err) => {
        if (err) console.error('Failed to delete terminal history:', err);
    });
}

// Captures the output of requests, and logs commands in terminals that are logged
async function recordExecution(terminal: vscode.Terminal, execution: vscode.TerminalShellExecution) {
    // read() must be called right away, or output produced before the call is lost
    const stream = execution.read();
    const exitCode = new Promise<number | undefined>(resolve => {
        const listener = vscode.window.onDidEndTerminalShellExecution(e => {
            if (e.execution === execution) {
                listener.dispose();
                resolve(e.exitCode);
            }
        });
    });

    activeExecutions.set(terminal, (activeExecutions.get(terminal) ?? 0) + 1);
    try {
        // The shell reports long or wrapped commands badly, so the text sent is used when this is a request
        const request = takePending(terminal, execution.commandLine.value);
        const command = request?.command ?? execution.commandLine.value;
        if (request) {
            runningRequests.set(terminal, (runningRequests.get(terminal) ?? new Set()).add(request.requestId));
        }

        const logged = getHistoryLog(terminal) !== undefined;
        if (logged) {
            await appendHistory(terminal, `\n=== [${new Date().toISOString()}]${request ? ` (${request.requestId})` : ''} ${command}\n`);
        }

        // Written as it arrives, so a command waiting on a prompt still shows what it printed
        let raw = '';
        for await (const data of stream) {
            if (request) raw += data;
            if (logged) await appendHistory(terminal, data.replace(ANSI_PATTERN, ''));
        }

        const code = await exitCode;
        if (logged) {
            await appendHistory(terminal, `\n=== exit code: ${code ?? 'unknown'}\n`);
        }
        if (request) {
            runningRequests.get(terminal)?.delete(request.requestId);
            if (isRunning(request.requestId)) {
                writeResult(request.requestId, {
                    status: 'done', exitCode: code ?? null, output: cleanOutput(raw, command), endedAt: new Date().toISOString(),
                });
            }
        }
    } finally {
        const count = (activeExecutions.get(terminal) ?? 1) - 1;
        if (count > 0) activeExecutions.set(terminal, count);
        else activeExecutions.delete(terminal);
    }
}

function pruneOld() {
    const now = Date.now();
    const maxAge = retentionMs();
    for (const log of historyLogs.values()) {
        if (log.startedAt !== undefined && (maxAge === 0 || now - log.startedAt >= maxAge)) {
            log.startedAt = undefined;
            deleteHistoryFile(log.file);
        }
    }
    pruneResults(resultMaxAgeMs());
}

function terminalInfo(terminal: vscode.Terminal): TerminalInfo {
    const log = getHistoryLog(terminal);
    return {
        index: vscode.window.terminals.indexOf(terminal) + 1,
        id: getTerminalId(terminal) ?? null,
        name: terminal.name,
        // relative to the inbox folder
        historyFile: log && inboxDir ? path.relative(inboxDir, log.file).replace(/\\/g, '/') : null,
    };
}

// Writes every open terminal (tracked or not) to terminals.json in the inbox
function writeTerminalState() {
    if (!stateFilePath) {
        return;
    }

    const state = vscode.window.terminals.map(terminalInfo);
    // Synchronous, so two quick updates can't race on the temp file; renamed so a reader never sees half a file
    const tmp = `${stateFilePath}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, stateFilePath);
    } catch (err) {
        console.error('Failed to write terminal state:', err);
    }
}

async function processCommandFile(uri: vscode.Uri) {
    let content: string;
    try {
        content = fs.readFileSync(uri.fsPath, 'utf8').trim();
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(err);
        return;
    }
    if (!content) {
        return; // already handled: the file is cleared after each command
    }

    // Cleared before running, so the second change event of the same save finds it empty
    try {
        fs.writeFileSync(uri.fsPath, '');
    } catch (err) {
        console.error('Failed to clear command file:', err);
    }

    let commandFile: CommandFile;
    try {
        commandFile = JSON.parse(content);
    } catch (parseErr) {
        reportError(newRequestId(), 'unknown', `command.json is not valid JSON: ${(parseErr as Error).message}`);
        return;
    }
    if (!commandFile || typeof commandFile !== 'object') {
        reportError(newRequestId(), 'unknown', 'command.json must contain a JSON object.');
        return;
    }

    const requestId = typeof commandFile.requestId === 'string' && commandFile.requestId ? commandFile.requestId : newRequestId();
    if (hasResult(requestId)) {
        return; // the same request written twice
    }
    const command = commandFile.task === 'runInTerminal' ? commandFile.payload?.command : undefined;
    writeResult(requestId, { task: String(commandFile.task), command, status: 'running', startedAt: new Date().toISOString() });

    try {
        if (commandFile.task === 'runInTerminal' && commandFile.payload) {
            await runCommandInTerminal(requestId, commandFile.payload);
        }
        else if (commandFile.task === 'closeTerminal' && commandFile.payload) {
            closeTerminal(requestId, commandFile.payload);
        }
        else {
            throw new Error(`Unknown task ${JSON.stringify(commandFile.task)} or missing payload.`);
        }
    } catch (err) {
        reportError(requestId, String(commandFile.task), (err as Error).message);
    }
}

function reportError(requestId: string, task: string, error: string) {
    output?.warn(`[${requestId}] ${error}`);
    const now = new Date().toISOString();
    writeResult(requestId, { task, status: 'error', error, endedAt: now, ...(!hasResult(requestId) && { startedAt: now }) });
}

export function activate(context: vscode.ExtensionContext) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') {
        console.log(`${EXTENSION_NAME}: no local folder is open, so there is nothing to do.`);
        return;
    }

    output = vscode.window.createOutputChannel(EXTENSION_NAME, { log: true });
    context.subscriptions.push(output);
    workspacePath = folder.uri.fsPath;
    inboxDir = inboxDirFor(context.globalStorageUri.fsPath, workspacePath);
    stateFilePath = path.join(inboxDir, 'terminals.json');
    historyDirPath = path.join(inboxDir, 'terminal-history');
    const commandFilePath = path.join(inboxDir, 'command.json');

    try {
        fs.mkdirSync(inboxDir, { recursive: true });
        // Logs and results from a previous session belong to terminals that no longer exist,
        // and a request left over from it is stale, so it is dropped rather than run
        fs.rmSync(historyDirPath, { recursive: true, force: true });
        fs.writeFileSync(commandFilePath, '');
    } catch (err) {
        console.error(`${EXTENSION_NAME}: failed to prepare the inbox:`, err);
    }
    initResults(path.join(inboxDir, 'command-results'));

    registerWorkspace(workspacePath, inboxDir);
    sweepStorage(context.globalStorageUri.fsPath, inboxDir, resultMaxAgeMs());

    // Lets an agent running in any terminal of this window find the inbox
    context.environmentVariableCollection.description = `${EXTENSION_NAME}: ${INBOX_ENV_VAR} points to this window's command inbox.`;
    context.environmentVariableCollection.replace(INBOX_ENV_VAR, inboxDir);

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(inboxDir), 'command.json'));
    const enqueue = (uri: vscode.Uri) => {
        queue = queue.then(() => processCommandFile(uri)).catch(err => console.error('Failed to process command file:', err));
    };
    watcher.onDidChange(enqueue);
    watcher.onDidCreate(enqueue);

    // Keep terminals.json in sync with terminals opened or closed by hand too
    const onOpen = vscode.window.onDidOpenTerminal(() => writeTerminalState());
    const onClose = vscode.window.onDidCloseTerminal(terminal => {
        const endedAt = new Date().toISOString();
        for (const requestId of runningRequests.get(terminal) ?? []) {
            writeResult(requestId, { status: 'error', error: 'The terminal was closed while the command ran.', endedAt });
        }
        for (const { requestId } of dropPending(terminal)) {
            if (isRunning(requestId)) {
                writeResult(requestId, { status: 'error', error: 'The terminal was closed before the command started.', endedAt });
            }
        }
        runningRequests.delete(terminal);
        activeExecutions.delete(terminal);

        const id = getTerminalId(terminal);
        if (id) {
            trackedTerminals.delete(id);
        }
        const log = historyLogs.get(terminal);
        if (log) {
            historyLogs.delete(terminal);
            deleteHistoryFile(log.file);
        }
        writeTerminalState();
    });

    const onExecution = vscode.window.onDidStartTerminalShellExecution(e => {
        recordExecution(e.terminal, e.execution).catch(err => {
            console.error('Failed to record terminal command:', err);
        });
    });
    const pruneTimer = setInterval(pruneOld, PRUNE_INTERVAL_MS);

    context.subscriptions.push(watcher, onOpen, onClose, onExecution, { dispose: () => clearInterval(pruneTimer) });
    writeTerminalState();
    output.info(`Watching ${commandFilePath}`);
}

export function deactivate() {
    if (workspacePath) {
        unregisterWorkspace(workspacePath);
    }
}
