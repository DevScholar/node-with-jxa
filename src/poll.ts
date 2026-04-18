// src/poll.ts
import { getIpc, getPollInterval, setPollInterval, releaseQueue } from './state.js';

const POLL_INTERVAL_MS = 16;

const postDrainHooks = new Set<() => void>();

export function addPostDrainHook(fn: () => void): void { postDrainHooks.add(fn); }
export function removePostDrainHook(fn: () => void): void { postDrainHooks.delete(fn); }

function drainEvents() {
    const ipc = getIpc();
    if (!ipc) return;
    if (releaseQueue.length > 0) {
        for (const id of releaseQueue.splice(0)) {
            try { ipc.send({ action: 'Release', targetId: id }); } catch {}
        }
    }
    ipc.drainEvents();
    if (ipc.isExited) {
        const pi = getPollInterval();
        if (pi) { clearInterval(pi); setPollInterval(null); }
        return;
    }
    if (postDrainHooks.size > 0) {
        for (const hook of postDrainHooks) {
            try { hook(); } catch (e) { console.error('[node-with-jxa] Post-drain hook error:', e); }
        }
    }
}

export function startPolling() {
    if (getPollInterval()) return;
    const pi = setInterval(drainEvents, POLL_INTERVAL_MS);
    (pi as any).unref?.();
    setPollInterval(pi);
}
