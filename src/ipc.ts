// src/ipc.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker, MessageChannel, receiveMessageOnPort } from 'worker_threads';
import type { MessagePort } from 'worker_threads';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class IpcWorker {
    private worker: Worker;
    private port: MessagePort;
    private exited = false;
    private seqCounter = 0;
    private stash = new Map<number, any>();
    // Notification slot: worker stores Atomics.notify after every postMessage.
    // Main thread Atomics.wait()s on it, avoiding a 100% CPU spin in readOne.
    private notify: Int32Array;
    // Cap to prevent unbounded growth if a low _seq response is permanently
    // missing (host bug). Bigger than any plausible legitimate burst.
    private static readonly MAX_STASH = 4096;

    constructor(
        private fdRead: number,
        private fdWrite: number,
        private onEvent: (msg: any) => any
    ) {
        const { port1, port2 } = new MessageChannel();
        this.port = port1;
        // Unref the port so it doesn't keep Node's event loop alive when nothing
        // else is running (e.g. after a non-GUI script finishes).  The worker is
        // also unref'd below for the same reason.  refForApp() re-refs the worker
        // when an app run loop is active.
        (port1 as any).unref?.();

        // Shared notification slot — worker bumps this and Atomics.notify()s
        // after every postMessage so readOne() can Atomics.wait() instead of
        // spinning on receiveMessageOnPort.
        const notifyBuf = new SharedArrayBuffer(4);
        this.notify = new Int32Array(notifyBuf);

        const workerPath = path.join(__dirname, 'ipc-worker.js');
        this.worker = new Worker(workerPath, {
            workerData: { fdRead, port: port2, notify: notifyBuf },
            transferList: [port2]
        });
        this.worker.unref();
        this.worker.on('error', (e) =>
            console.error('[node-with-jxa] IPC worker error:', e)
        );
    }

    private readOne(): { kind: string; data?: any } {
        let msg: ReturnType<typeof receiveMessageOnPort>;
        // Drain anything already queued without blocking first.
        if ((msg = receiveMessageOnPort(this.port))) return msg.message;
        // Block on the worker's notification slot. Atomics.wait yields the
        // thread (no CPU spin); the worker calls Atomics.notify after every
        // post. Re-check after each wake because notifications can be
        // coalesced across multiple posts.
        while (true) {
            const seen = Atomics.load(this.notify, 0);
            if ((msg = receiveMessageOnPort(this.port))) return msg.message;
            // 'timed-out' here just means we should re-check the port; this
            // gives us a periodic safety wake without burning CPU.
            Atomics.wait(this.notify, 0, seen, 1000);
        }
    }

    private handleAsyncEvent(eventData: any) {
        try { this.onEvent(eventData); }
        catch (e) { console.error('[node-with-jxa] Async callback error:', e); }
    }

    private handleEvent(eventData: any) {
        let result: any = null;
        let errorMessage: string | null = null;
        try {
            result = this.onEvent(eventData);
        } catch (e: any) {
            errorMessage = (e && (e.stack || e.message)) || String(e);
            console.error('[node-with-jxa] Callback error:', e);
        }
        const reply = errorMessage !== null
            ? { type: 'reply', error: errorMessage }
            : { type: 'reply', result };
        try {
            fs.writeSync(this.fdWrite, JSON.stringify(reply) + '\n');
        } catch (e) {
            // The host died (or the pipe was closed mid-callback). Mark exited
            // so the next send() throws clearly instead of hanging in
            // waitResponse.
            this.exited = true;
            console.error('[node-with-jxa] Failed to send callback reply (pipe closed):', e);
        }
    }

    private waitResponse(expectedSeq: number): any {
        while (true) {
            if (this.stash.has(expectedSeq)) {
                const res = this.stash.get(expectedSeq)!;
                this.stash.delete(expectedSeq);
                if (res.type === 'error') throw new Error(`JXA Host Error: ${res.message}`);
                return res;
            }
            const msg = this.readOne();
            if (msg.kind === 'eof') {
                this.exited = true;
                throw new Error('JXA host exited unexpectedly (likely a JXA crash). The last call probably triggered an internal JXA bug — try a different API.');
            }
            if (msg.kind === 'event') { this.handleEvent(msg.data); continue; }
            if (msg.kind === 'async_event') { this.handleAsyncEvent(msg.data); continue; }
            const res = msg.data;
            if (res._seq !== expectedSeq) {
                if (this.stash.size >= IpcWorker.MAX_STASH) {
                    throw new Error(`JXA IPC stash overflow (>${IpcWorker.MAX_STASH} pending out-of-order responses; expected _seq=${expectedSeq}). This indicates a host protocol bug.`);
                }
                this.stash.set(res._seq, res);
                continue;
            }
            if (res.type === 'error') throw new Error(`JXA Host Error: ${res.message}`);
            return res;
        }
    }

    send(cmd: any): any {
        if (this.exited) throw new Error('JXA host has exited; cannot send further commands.');
        const seq = ++this.seqCounter;
        cmd._seq = seq;
        try { fs.writeSync(this.fdWrite, JSON.stringify(cmd) + '\n'); }
        catch (e: any) {
            this.exited = true;
            throw new Error(`JXA IPC pipe write failed (host likely exited): ${e?.message || e}`);
        }
        return this.waitResponse(seq);
    }

    drainEvents() {
        if (this.exited) return;
        let msg: ReturnType<typeof receiveMessageOnPort>;
        while ((msg = receiveMessageOnPort(this.port))) {
            const { kind, data } = msg.message;
            if (kind === 'event') this.handleEvent(data);
            else if (kind === 'async_event') this.handleAsyncEvent(data);
            else if (kind === 'eof') { this.exited = true; break; }
        }
    }

    /** Re-ref the worker when a run loop (NSApp.run / runUntilDate) is started,
     *  so Node.js stays alive until JXA exits and the worker receives EOF. */
    refForApp() { this.worker.ref(); this.appRunning = true; }

    /** True once an app event loop has been handed control to JXA via runApp. */
    appRunning = false;

    get isExited(): boolean { return this.exited; }

    close() {
        this.exited = true;
        this.worker.terminate();
        try { fs.closeSync(this.fdRead); } catch {}
        try { fs.closeSync(this.fdWrite); } catch {}
    }
}
