import * as fs from 'fs';
import * as path from 'path';

// One file per request in .vscode/command-results/<requestId>.json, so the sender can tell
// whether its command was taken, which terminal ran it, and when it finished
export interface TerminalInfo {
    index: number;
    id: string | null;
    name: string;
    historyFile: string | null;
}

export interface CommandResult {
    requestId: string;
    task: string;
    command?: string;
    status: 'running' | 'done' | 'error';
    error?: string;
    note?: string;
    terminal?: TerminalInfo;
    startedAt: string;
    endedAt?: string;
    exitCode?: number | null;
    output?: string;
}

let resultsDirPath: string | undefined;
const results = new Map<string, CommandResult>();
let nextRequestNumber = 1;

export function initResults(dir: string) {
    resultsDirPath = dir;
    // Results from a previous session refer to terminals that no longer exist
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
        console.error('Failed to clear old command results:', err);
    }
}

export function newRequestId(): string {
    return `req-${Date.now()}-${nextRequestNumber++}`;
}

export function hasResult(requestId: string): boolean {
    return results.has(requestId);
}

export function isRunning(requestId: string): boolean {
    return results.get(requestId)?.status === 'running';
}

// Merges `patch` into the request's result and writes it; written via a temp file so a reader never sees half a file
export function writeResult(requestId: string, patch: Partial<CommandResult>) {
    const result = { ...results.get(requestId), ...patch, requestId } as CommandResult;
    results.set(requestId, result);
    if (!resultsDirPath) {
        return;
    }
    const file = path.join(resultsDirPath, `${requestId.replace(/[^\w.-]/g, '_')}.json`);
    try {
        fs.mkdirSync(resultsDirPath, { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(result, null, 2));
        fs.renameSync(`${file}.tmp`, file);
    } catch (err) {
        console.error('Failed to write command result:', err);
    }
}

export function pruneResults(maxAgeMs: number) {
    const now = Date.now();
    for (const [requestId, result] of results) {
        const at = Date.parse(result.endedAt ?? result.startedAt);
        if (result.status !== 'running' && now - at >= maxAgeMs) {
            results.delete(requestId);
            if (resultsDirPath) {
                fs.rm(path.join(resultsDirPath, `${requestId.replace(/[^\w.-]/g, '_')}.json`), { force: true }, () => {});
            }
        }
    }
}
