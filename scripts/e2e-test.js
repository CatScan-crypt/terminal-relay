#!/usr/bin/env node
// End-to-end test for Terminal Relay. Run it from a terminal inside VS Code / Cursor, with the
// extension installed and the workspace root as the current folder:
//
//   npm run test:e2e
//
// It sends real requests through the inbox, so it opens a few "e2e" terminals and closes them at the end.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const inbox = process.env.TERMINAL_RELAY_DIR;
const workspace = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-relay-e2e-'));
const helper = path.join(tmp, 'helper.js');
const runId = Date.now().toString(36);
const startedAt = Date.now();

// Commands typed into the terminal call this helper, so they work the same in PowerShell, cmd, bash and zsh
fs.writeFileSync(helper, `
const [mode, arg] = process.argv.slice(2);
if (mode === 'echo') console.log(arg);
if (mode === 'exit') process.exit(Number(arg));
if (mode === 'sleep') setTimeout(() => {}, Number(arg));
if (mode === 'read') process.stdin.once('data', d => { require('fs').writeFileSync(arg, String(d).trim()); process.exit(0); });
`);
const q = s => `"${s}"`;
const node = (...args) => `node ${q(helper)} ${args.join(' ')}`;

let passed = 0, failed = 0, warned = 0;
const results = [];
function check(name, ok, detail = '') {
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
    ok ? passed++ : failed++;
}
function warn(name, detail) {
    results.push(`WARN  ${name}\n        ${detail}`);
    warned++;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
const resultFile = id => path.join(inbox, 'command-results', `${id.replace(/[^\w.-]/g, '_')}.json`);

let seq = 0;
async function send(task, payload, requestId = `e2e-${runId}-${++seq}`) {
    await sendRaw(JSON.stringify({ task, requestId, payload }));
    return requestId;
}
// Written to a temp file and renamed, as the README advises
async function sendRaw(text) {
    const cmd = path.join(inbox, 'command.json');
    for (let i = 0; i < 50 && fs.existsSync(cmd) && fs.readFileSync(cmd, 'utf8').trim(); i++) {
        await sleep(100); // the previous request hasn't been picked up yet
    }
    const t = path.join(inbox, `command.${process.pid}.tmp`);
    fs.writeFileSync(t, text);
    fs.renameSync(t, cmd);
}
async function waitFor(requestId, until = r => r.status !== 'running', timeoutMs = 30000) {
    const end = Date.now() + timeoutMs;
    let r;
    while (Date.now() < end) {
        r = readJson(resultFile(requestId));
        if (r && until(r)) return r;
        await sleep(150);
    }
    return r ?? { status: 'timeout', error: `no result after ${timeoutMs / 1000}s` };
}
const terminals = () => readJson(path.join(inbox, 'terminals.json')) ?? [];
const show = r => JSON.stringify(r);

async function main() {
    console.log('Terminal Relay end-to-end test\n');

    // --- Setup ---------------------------------------------------------------
    if (!inbox) {
        console.log('FAIL  TERMINAL_RELAY_DIR is not set.\n      Run this from a NEW terminal inside VS Code, with the extension installed.');
        process.exit(1);
    }
    check('inbox folder exists', fs.existsSync(inbox), inbox);
    const rel = path.relative(workspace, inbox);
    check('inbox is outside the workspace', rel.startsWith('..') || path.isAbsolute(rel), inbox);

    const index = readJson(path.join(os.homedir(), '.terminal-relay', 'workspaces.json')) ?? {};
    const entry = Object.entries(index).find(([, e]) => e && path.resolve(e.dir) === path.resolve(inbox));
    check('index lists this window', !!entry, show(index));
    if (entry) {
        check('index key is this workspace', path.resolve(entry[0]).toLowerCase() === path.resolve(workspace).toLowerCase(),
            `key ${entry[0]}, cwd ${workspace} (run from the workspace root)`);
    }

    // --- runInTerminal, default terminal --------------------------------------
    const marker = `relay-${runId}`;
    let id = await send('runInTerminal', { command: node('echo', marker) });
    let r = await waitFor(id);
    check('default run finishes', r.status === 'done', show(r));
    check('default run captures output', (r.output ?? '').includes(marker), show(r.output));
    check('default run exit code 0', r.exitCode === 0, show(r.exitCode));
    check('default run uses a Terminal Relay terminal', typeof r.terminal?.id === 'string', show(r.terminal));
    const defaultTerm = r.terminal?.id;

    if (r.terminal?.historyFile) {
        const log = path.join(inbox, r.terminal.historyFile);
        await sleep(300);
        const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
        check('history log has the command and output', text.includes(id) && text.includes(marker), log);
    } else {
        warn('history log', 'historyFile is null: logRetentionMinutes is 0, or the terminal has no shell integration.');
    }

    // --- Busy terminal is not reused ------------------------------------------
    const slowId = await send('runInTerminal', { command: node('sleep', 4000) });
    const slow = await waitFor(slowId, r => r.status !== 'running' || !!r.terminal, 10000);
    await sleep(1000); // let the shell report that the command started
    id = await send('runInTerminal', { command: node('echo', 'second') });
    r = await waitFor(id);
    check('a busy terminal is not reused', !!slow.terminal?.id && r.terminal?.id !== slow.terminal.id,
        `slow ran in ${slow.terminal?.id}, next ran in ${r.terminal?.id}`);
    const secondTerm = r.terminal?.id;
    await waitFor(slowId);

    // --- forceNew with id and name, then target by id --------------------------
    const tid = `e2e-${runId}`;
    id = await send('runInTerminal', { command: node('echo', 'new'), forceNew: true, id: tid, name: 'E2E Test' });
    r = await waitFor(id);
    check('forceNew opens a terminal with the given id', r.status === 'done' && r.terminal?.id === tid && r.terminal?.name === 'E2E Test', show(r));
    check('terminals.json lists it', terminals().some(t => t.id === tid), show(terminals()));

    id = await send('runInTerminal', { command: node('exit', 3), target: tid });
    r = await waitFor(id);
    if (r.exitCode === 3) check('target by id + exit code 3', r.terminal?.id === tid, show(r));
    else if (r.exitCode === 1) warn('exit code', 'Got 1 instead of 3. Expected on PowerShell 5.1 (see Known limits in the README).');
    else check('target by id + exit code 3', false, show(r));

    id = await send('runInTerminal', { command: node('echo', 'dup'), forceNew: true, id: tid });
    r = await waitFor(id);
    check('duplicate terminal id is refused', r.status === 'error' && /already open/.test(r.error ?? ''), show(r));

    // --- submit: input to a running app ---------------------------------------
    const appId = `e2e-app-${runId}`;
    const answer = path.join(tmp, 'answer.txt');
    id = await send('runInTerminal', { command: node('read', q(answer)), forceNew: true, id: appId, name: 'E2E App' });
    await waitFor(id, r => r.status !== 'running' || !!r.terminal, 10000);
    await sleep(1500); // let the app start reading
    id = await send('runInTerminal', { command: 'hello relay', submit: true, target: appId });
    r = await waitFor(id);
    check('submit is done at once', r.status === 'done', show(r));
    for (let i = 0; i < 40 && !fs.existsSync(answer); i++) await sleep(150);
    check('submit text reaches the app', fs.existsSync(answer) && fs.readFileSync(answer, 'utf8') === 'hello relay',
        fs.existsSync(answer) ? show(fs.readFileSync(answer, 'utf8')) : 'the app got nothing');

    // --- Errors ---------------------------------------------------------------
    id = await send('runInTerminal', { command: node('echo', 'x'), target: 'no-such-terminal' });
    r = await waitFor(id);
    check('unknown target gives an error', r.status === 'error' && /No open terminal/.test(r.error ?? ''), show(r));

    id = await send('runInTerminal', { command: '   ' });
    r = await waitFor(id);
    check('empty command gives an error', r.status === 'error', show(r));

    id = await send('somethingElse', {});
    r = await waitFor(id);
    check('unknown task gives an error', r.status === 'error' && /Unknown task/.test(r.error ?? ''), show(r));

    const before = new Set(fs.readdirSync(path.join(inbox, 'command-results')));
    await sendRaw('{ not json');
    let badJson;
    for (let i = 0; i < 40 && !badJson; i++) {
        await sleep(150);
        badJson = fs.readdirSync(path.join(inbox, 'command-results'))
            .filter(f => f.endsWith('.json') && !before.has(f))
            .map(f => readJson(path.join(inbox, 'command-results', f)))
            .find(x => x && /not valid JSON/.test(x.error ?? ''));
    }
    check('invalid JSON gives an error result', !!badJson);

    // Same requestId twice: the second is ignored, so the first result stays as it was
    const dupReq = `e2e-${runId}-dup`;
    await send('runInTerminal', { command: node('echo', 'first') }, dupReq);
    const first = await waitFor(dupReq);
    await send('runInTerminal', { command: node('echo', 'second-copy') }, dupReq);
    await sleep(2000);
    const again = readJson(resultFile(dupReq));
    check('a repeated requestId is ignored', again?.command === first.command && !(again?.output ?? '').includes('second-copy'), show(again));

    // --- closeTerminal --------------------------------------------------------
    for (const target of new Set([tid, appId, defaultTerm, slow.terminal?.id, secondTerm].filter(Boolean))) {
        id = await send('closeTerminal', { target });
        r = await waitFor(id);
        if (target === tid) check('closeTerminal by id', r.status === 'done', show(r));
    }
    await sleep(500);
    check('closed terminals leave terminals.json', !terminals().some(t => t.id === tid || t.id === appId), show(terminals()));

    // --- Nothing written into the workspace -----------------------------------
    const written = [];
    const walk = dir => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (['node_modules', '.git', 'out'].includes(e.name)) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (fs.statSync(p).mtimeMs >= startedAt && !p.startsWith(tmp)) written.push(path.relative(workspace, p));
        }
    };
    walk(workspace);
    check('nothing was written into the workspace', written.length === 0, written.join(', '));
}

main()
    .catch(err => { failed++; results.push(`FAIL  crashed: ${err.stack}`); })
    .finally(() => {
        console.log(results.join('\n'));
        console.log(`\n${passed} passed, ${failed} failed, ${warned} warnings`);
        console.log('\nNot covered here (check by hand if you like): the logAllTerminals and logRetentionMinutes settings, Workspace Trust, and cleanup after a restart.');
        fs.rmSync(tmp, { recursive: true, force: true });
        process.exit(failed ? 1 : 0);
    });
