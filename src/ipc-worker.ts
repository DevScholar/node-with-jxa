// src/ipc-worker.ts
// Runs in a dedicated Worker thread.  Blocks in readSync() on fdRead and
// forwards every line from the JXA host to the main thread via MessagePort.
// This keeps the Node.js main thread's event loop alive while JXA runs.
import { workerData } from 'worker_threads';
import type { MessagePort } from 'worker_threads';
import * as fs from 'node:fs';

const port: MessagePort = workerData.port;
// Under Deno, worker_threads isolates have separate resource tables, so the
// fdRead from the main thread is unusable here.  If fdReadPath is supplied,
// open the FIFO locally in this worker's context instead.
// TODO: remove fdReadPath branch once denoland/deno#33039 ships in a stable release.
const fdRead: number = workerData.fdReadPath
    ? fs.openSync(workerData.fdReadPath as string, fs.constants.O_RDONLY)
    : workerData.fdRead;
// SharedArrayBuffer slot the main thread Atomics.wait()s on. We bump and
// notify after every postMessage so the main thread wakes promptly without
// having to spin on receiveMessageOnPort.
const notify = new Int32Array(workerData.notify as SharedArrayBuffer);

function postAndNotify(msg: any) {
    port.postMessage(msg);
    Atomics.add(notify, 0, 1);
    Atomics.notify(notify, 0);
}

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
        postAndNotify({ kind: 'eof' });
        break;
    }
    if (!line.trim()) continue;
    let msg: any;
    try {
        msg = JSON.parse(line);
    } catch (e: any) {
        // Malformed line from the host — almost always indicates a host bug
        // (interleaved stderr writeRaw, partial flush, etc.). Log it so it
        // isn't swallowed silently; the host's framing is broken either way.
        console.error('[node-with-jxa] host sent invalid JSON:', e?.message || e, '— line:', line.slice(0, 200));
        continue;
    }
    const kind = msg.type === 'event' ? 'event' : msg.type === 'async_event' ? 'async_event' : 'response';
    postAndNotify({ kind, data: msg });
}
