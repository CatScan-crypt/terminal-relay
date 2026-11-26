import * as vscode from 'vscode';

// Commands sent by the extension that haven't started yet, per terminal, so a started execution
// can be matched to its request (and keep its command text when the shell reports none)
export interface PendingCommand {
    requestId: string;
    command: string;
}

const pending = new Map<vscode.Terminal, PendingCommand[]>();

export function addPending(terminal: vscode.Terminal, entry: PendingCommand) {
    pending.set(terminal, [...(pending.get(terminal) ?? []), entry]);
}

// The oldest pending command whose text matches what the shell reports; a blank or partial report matches too
export function takePending(terminal: vscode.Terminal, commandLine: string): PendingCommand | undefined {
    const queue = pending.get(terminal) ?? [];
    const seen = commandLine.trim();
    const i = queue.findIndex(p => !seen || p.command.trim() === seen || p.command.includes(seen.slice(0, 40)));
    if (i < 0) {
        return undefined;
    }
    const [entry] = queue.splice(i, 1);
    return entry;
}

export function hasPending(terminal: vscode.Terminal): boolean {
    return (pending.get(terminal)?.length ?? 0) > 0;
}

export function dropPending(terminal: vscode.Terminal): PendingCommand[] {
    const queue = pending.get(terminal) ?? [];
    pending.delete(terminal);
    return queue;
}
