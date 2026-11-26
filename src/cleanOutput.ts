// CSI sequences, OSC sequences (terminated by BEL or ST), and other two-byte escapes
export const ANSI_PATTERN = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

// Keep at most this much of a command's output in its result file (the end is kept)
const MAX_OUTPUT_CHARS = 50_000;

// A command's own output: on Windows the terminal often repaints the screen before the output,
// so old lines and the echoed command come first. Everything up to the last echo of the command is cut.
export function cleanOutput(raw: string, command: string): string {
    const text = raw.replace(ANSI_PATTERN, '').replace(/\r\n/g, '\n').replace(/\r/g, '');

    // The echo may wrap across lines, so search with the line breaks taken out
    const kept: number[] = [];
    let flat = '';
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '\n') {
            kept.push(i);
            flat += text[i];
        }
    }

    let out = text;
    const head = command.slice(0, 40);
    const at = head ? flat.lastIndexOf(head) : -1;
    if (at >= 0) {
        const echoEnd = flat.startsWith(command, at) ? at + command.length : at + head.length;
        const lineEnd = text.indexOf('\n', kept[Math.min(echoEnd, kept.length) - 1]);
        out = lineEnd >= 0 ? text.slice(lineEnd + 1) : '';
    }

    out = out.replace(/^\n+/, '').replace(/\s+$/, '');
    return out.length > MAX_OUTPUT_CHARS ? `…${out.slice(-MAX_OUTPUT_CHARS)}` : out;
}
