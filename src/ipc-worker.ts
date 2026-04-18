// src/ipc-worker.ts
// Runs in a dedicated Worker thread.  Blocks in readSync() on fdRead and
// forwards every line from the JXA host to the main thread via MessagePort.
// This keeps the Node.js main thread's event loop alive while JXA runs.
import { workerData } from 'worker_threads';
import type { MessagePort } from 'worker_threads';
import * as fs from 'node:fs';

const port: MessagePort = workerData.port;
const fdRead: number = workerData.fdRead;

let pending = Buffer.alloc(0);

function readLine(): string | null {
    while (true) {
        const nl = pending.indexOf(10);
        if (nl !== -1) {
            const line = pending.subarray(0, nl).toString('utf8');
            pending = pending.subarray(nl + 1);
            return line;
        }
        const chunk = Buffer.alloc(8192);
        let n = 0;
        try {
            n = fs.readSync(fdRead, chunk, 0, 8192, null);
        } catch {
            return null;
        }
        if (n === 0) return null;
        pending = Buffer.concat([pending, chunk.subarray(0, n)]);
    }
}

while (true) {
    const line = readLine();
    if (line === null) {
        port.postMessage({ kind: 'eof' });
        break;
    }
    if (!line.trim()) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { continue; }
    const kind = msg.type === 'event' ? 'event' : msg.type === 'async_event' ? 'async_event' : 'response';
    port.postMessage({ kind, data: msg });
}
