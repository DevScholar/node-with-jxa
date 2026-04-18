// src/lifecycle.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { IpcWorker } from './ipc.js';
import {
    getIpc, getProc, getInitialized, getReqPath, getResPath, getPollInterval,
    setIpc, setProc, setInitialized, setReqPath, setResPath, setPollInterval,
    callbackRegistry,
} from './state.js';
import { wrapArg } from './marshal.js';
import { createProxy } from './proxy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function cleanup() {
    if (!getInitialized()) return;
    setInitialized(false);

    const pi = getPollInterval();
    if (pi) { clearInterval(pi); setPollInterval(null); }
    // Kill osascript FIRST so the worker's blocking readSync on fd 4 unblocks
    // with EOF; otherwise ipc.close() → worker.terminate() deadlocks waiting
    // for the worker to finish its read.
    const proc = getProc();
    if (proc && !proc.killed) try { proc.kill('SIGKILL'); } catch {}
    const ipc = getIpc();
    if (ipc) try { ipc.close(); } catch {}
    const reqPath = getReqPath();
    const resPath = getResPath();
    if (reqPath && fs.existsSync(reqPath)) try { fs.unlinkSync(reqPath); } catch {}
    if (resPath && fs.existsSync(resPath)) try { fs.unlinkSync(resPath); } catch {}

    setProc(null);
    setIpc(null);
}

function findOsascriptPath(): string {
    try {
        return cp.execFileSync('which', ['osascript'], { encoding: 'utf-8' }).trim() || '/usr/bin/osascript';
    } catch {
        return '/usr/bin/osascript';
    }
}

export function initialize() {
    if (getInitialized()) return;

    if (process.platform !== 'darwin') {
        throw new Error('node-with-jxa only runs on macOS (process.platform === "darwin")');
    }

    const token = `${process.pid}-${Date.now()}`;
    const reqPath = path.join(os.tmpdir(), `jxa-req-${token}.pipe`);
    const resPath = path.join(os.tmpdir(), `jxa-res-${token}.pipe`);
    setReqPath(reqPath);
    setResPath(resPath);

    try {
        cp.execFileSync('mkfifo', [reqPath, resPath]);
    } catch {
        console.error('Failed to create Unix FIFOs');
        process.exit(1);
    }

    const scriptPath = path.join(__dirname, '..', 'scripts', 'host.js');
    const osascriptPath = findOsascriptPath();

    // Three-step open of FIFOs without deadlock (see node-with-gjs for full notes).
    const O_RDONLY_NB = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;

    const fdReqTmp   = fs.openSync(reqPath, O_RDONLY_NB);
    const fdReqWrite = fs.openSync(reqPath, 'w');
    const fdReqRead  = fs.openSync(reqPath, 'r');
    fs.closeSync(fdReqTmp);

    const fdResTmp   = fs.openSync(resPath, O_RDONLY_NB);
    const fdResWrite = fs.openSync(resPath, 'w');
    const fdResRead  = fs.openSync(resPath, 'r');
    fs.closeSync(fdResTmp);

    // osascript inherits fds 3 and 4 just like any other child process —
    // JXA reads/writes them via NSFileHandle.alloc.initWithFileDescriptor(fd).
    // stdin is set to 'ignore' (not 'inherit') because 'inherit' on macOS keeps
    // the parent's TTY stdin handle ref'd, preventing Node from exiting after
    // the user script finishes.  stdout/stderr stay inherited so the host's
    // own logging (and `hostLog`) goes to the parent terminal.
    const proc = cp.spawn(osascriptPath, ['-l', 'JavaScript', scriptPath], {
        stdio: ['ignore', 'inherit', 'inherit', fdReqRead, fdResWrite],
        env: process.env,
    });

    fs.closeSync(fdReqRead);
    fs.closeSync(fdResWrite);

    setProc(proc);
    proc.unref();

    process.on('beforeExit', () => { cleanup(); process.exit(0); });
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    process.on('uncaughtException', (err) => {
        console.error('Node.js Exception:', err);
        cleanup();
        process.exit(1);
    });

    const ipc = new IpcWorker(fdResRead, fdReqWrite, (res: any) => {
        const cb = callbackRegistry.get(res.callbackId!);
        if (cb) {
            const wrappedArgs = (res.args || []).map((arg: any) => createProxy(arg));
            const result = cb(...wrappedArgs);
            return wrapArg(result);
        }
        return { type: 'null' };
    });

    setIpc(ipc);
    setInitialized(true);

    // macOS: process.stdout / process.stderr are TTYWrap handles that stay
    // ref'd by default (Linux unrefs them when idle).  Without this, a plain
    // non-GUI script never lets the event loop drain → beforeExit never fires.
    // Writes will transiently re-ref, which is fine; idle they stay unref'd.
    (process.stdout as any).unref?.();
    (process.stderr as any).unref?.();

    // Auto-exit watchdog: macOS keeps the worker thread and other handles
    // ref'd in ways that prevent 'beforeExit' from firing naturally, so we
    // poll and exit once the script has no app run loop active and the event
    // loop has no pending user work.  refForApp() sets appRunning=true, which
    // disables the watchdog for GUI scripts.
    let stableTicks = 0;
    let lastSnapshot = '';
    const watchdog = setInterval(() => {
        if (!getInitialized()) { clearInterval(watchdog); return; }
        const curIpc = getIpc();
        if (curIpc && (curIpc as any).appRunning) { clearInterval(watchdog); return; }
        // Drain any pending JXA events before deciding to exit.
        try { curIpc?.drainEvents(); } catch {}
        const info = (process as any).getActiveResourcesInfo?.() as string[] | undefined;
        const filtered = (info || []).filter(t => t !== 'Timeout' && t !== 'Immediate');
        const snapshot = filtered.slice().sort().join(',');
        if (snapshot === lastSnapshot) {
            if (++stableTicks >= 2) {
                clearInterval(watchdog);
                cleanup();
                process.exit(0);
            }
        } else {
            lastSnapshot = snapshot;
            stableTicks = 0;
        }
    }, 150);
}
