import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Where each window's inbox lives is listed here, so a sender outside VS Code can find it
export const INDEX_FILE = path.join(os.homedir(), '.terminal-relay', 'workspaces.json');

export interface IndexEntry {
    dir: string;       // the inbox folder: command.json, terminals.json, command-results/, terminal-history/
    pid: number;       // the extension host that owns it; an entry whose process is gone is stale
    updatedAt: string;
}

type Index = Record<string, IndexEntry>;

function normalize(p: string): string {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// The inbox is kept in the extension's own storage, outside the workspace, so nothing a repo
// contains (a committed command.json, a git pull, a branch switch) can ever write to it
export function inboxDirFor(storageRoot: string, workspacePath: string): string {
    const hash = crypto.createHash('sha256').update(normalize(workspacePath)).digest('hex').slice(0, 12);
    const base = path.basename(workspacePath).replace(/[^\w.-]/g, '_').slice(0, 40) || 'workspace';
    return path.join(storageRoot, 'workspaces', `${base}-${hash}`);
}

export function isAlive(pid: unknown): boolean {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0); // signal 0 only checks that the process exists
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function readIndex(): Index {
    try {
        const value = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
        return {};
    }
}

function writeIndex(index: Index) {
    try {
        fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
        const tmp = `${INDEX_FILE}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
        fs.renameSync(tmp, INDEX_FILE);
    } catch (err) {
        console.error('Terminal Relay: failed to write the workspace index:', err);
    }
}

// Adds this window's inbox to the index and drops entries whose window is gone
export function registerWorkspace(workspacePath: string, dir: string) {
    const index = readIndex();
    for (const [key, entry] of Object.entries(index)) {
        if (!entry || typeof entry.dir !== 'string' || !isAlive(entry.pid)) {
            delete index[key];
        }
    }
    index[workspacePath] = { dir, pid: process.pid, updatedAt: new Date().toISOString() };
    writeIndex(index);
}

export function unregisterWorkspace(workspacePath: string) {
    const index = readIndex();
    if (index[workspacePath]?.pid === process.pid) {
        delete index[workspacePath];
        writeIndex(index);
    }
}

// Inboxes of windows that are no longer open (closed, crashed, or a folder never reopened) are never
// cleaned by their own window, so every start deletes their files once they are older than maxAgeMs
export function sweepStorage(storageRoot: string, currentDir: string, maxAgeMs: number) {
    const root = path.join(storageRoot, 'workspaces');
    let names: string[];
    try {
        names = fs.readdirSync(root);
    } catch {
        return; // nothing stored yet
    }

    const live = new Set(
        Object.values(readIndex())
            .filter(entry => entry && typeof entry.dir === 'string' && isAlive(entry.pid))
            .map(entry => normalize(entry.dir)),
    );
    const cutoff = Date.now() - maxAgeMs;
    for (const name of names) {
        const dir = path.join(root, name);
        if (normalize(dir) === normalize(currentDir) || live.has(normalize(dir))) {
            continue; // an open window looks after its own inbox
        }
        try {
            pruneTree(dir, cutoff);
        } catch (err) {
            console.error('Terminal Relay: failed to clean old storage:', err);
        }
    }
}

// Deletes files last changed before cutoff, then folders left empty
function pruneTree(dir: string, cutoff: number) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            pruneTree(p, cutoff);
        } else if (fs.statSync(p).mtimeMs < cutoff) {
            fs.rmSync(p, { force: true });
        }
    }
    if (fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
    }
}
