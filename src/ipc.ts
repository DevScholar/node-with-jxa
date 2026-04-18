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

        const workerPath = path.join(__dirname, 'ipc-worker.js');
        this.worker = new Worker(workerPath, {
            workerData: { fdRead, port: port2 },
            transferList: [port2]
        });
        this.worker.unref();
        this.worker.on('error', (e) =>
            console.error('[node-with-jxa] IPC worker error:', e)
        );
    }

    private readOne(): { kind: string; data?: any } {
        let msg: ReturnType<typeof receiveMessageOnPort>;
        while (!(msg = receiveMessageOnPort(this.port))) {}
        return msg.message;
    }

    private handleAsyncEvent(eventData: any) {
        try { this.onEvent(eventData); }
        catch (e) { console.error('[node-with-jxa] Async callback error:', e); }
    }

    private handleEvent(eventData: any) {
        let result: any = null;
        try { result = this.onEvent(eventData); }
        catch (e) { console.error('[node-with-jxa] Callback error:', e); }
        try {
            fs.writeSync(this.fdWrite, JSON.stringify({ type: 'reply', result }) + '\n');
        } catch {}
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
                return { type: 'exit' };
            }
            if (msg.kind === 'event') { this.handleEvent(msg.data); continue; }
            if (msg.kind === 'async_event') { this.handleAsyncEvent(msg.data); continue; }
            const res = msg.data;
            if (res._seq !== expectedSeq) {
                this.stash.set(res._seq, res);
                continue;
            }
            if (res.type === 'error') throw new Error(`JXA Host Error: ${res.message}`);
            return res;
        }
    }

    send(cmd: any): any {
        if (this.exited) return { type: 'exit' };
        const seq = ++this.seqCounter;
        cmd._seq = seq;
        try { fs.writeSync(this.fdWrite, JSON.stringify(cmd) + '\n'); }
        catch { throw new Error('Pipe closed (Write failed)'); }
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
