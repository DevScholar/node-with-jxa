// src/state.ts
import type { IpcWorker } from './ipc.js';
import type * as cp from 'node:child_process';
import type { JxaRef } from './types.js';

export const callbackRegistry = new Map<string, Function>();
export const objectCallbacks = new Map<string, string[]>();
export const releaseQueue: string[] = [];

export const proxyCache = new Map<string, WeakRef<JxaRef>>();

// Strong references to proxies that have active callbacks.
// Prevents V8 GC from collecting a proxy whose JXA-side ObjC object is still
// alive (e.g. an NSButton whose action target is a JS callback).
export const connectedProxies = new Map<string, JxaRef>();

export function pinProxy(id: string): void {
    if (connectedProxies.has(id)) return;
    const weak = proxyCache.get(id);
    const ref = weak?.deref();
    if (ref) connectedProxies.set(id, ref);
}

export function unpinProxy(id: string): void {
    connectedProxies.delete(id);
}

export const gcRegistry = new FinalizationRegistry((id: string) => {
    proxyCache.delete(id);
    releaseQueue.push(id);
    const cbs = objectCallbacks.get(id);
    if (cbs) {
        for (const cbId of cbs) callbackRegistry.delete(cbId);
        objectCallbacks.delete(id);
    }
    connectedProxies.delete(id);
});

// Cache loaded frameworks / root symbols so repeated `imports('AppKit')` or `$.NSWindow`
// returns the same proxy without round-tripping to JXA.
export const rootCache = new Map<string, JxaRef>();

let _ipc: IpcWorker | null = null;
let _proc: cp.ChildProcess | null = null;
let _initialized = false;
let _reqPath = '';
let _resPath = '';
let _pollInterval: ReturnType<typeof setInterval> | null = null;

export function getIpc() { return _ipc; }
export function getProc() { return _proc; }
export function getInitialized() { return _initialized; }
export function getReqPath() { return _reqPath; }
export function getResPath() { return _resPath; }
export function getPollInterval() { return _pollInterval; }

export function setIpc(val: IpcWorker | null) { _ipc = val; }
export function setProc(val: cp.ChildProcess | null) { _proc = val; }
export function setInitialized(val: boolean) { _initialized = val; }
export function setReqPath(val: string) { _reqPath = val; }
export function setResPath(val: string) { _resPath = val; }
export function setPollInterval(val: ReturnType<typeof setInterval> | null) { _pollInterval = val; }
