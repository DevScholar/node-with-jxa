import { initialize } from './lifecycle.js';
import { startPolling, addPostDrainHook, removePostDrainHook } from './poll.js';
import { createProxy } from './proxy.js';
import {
    getIpc, callbackRegistry, objectCallbacks, proxyCache, releaseQueue,
    rootCache, unpinProxy,
} from './state.js';
import { wrapArg } from './marshal.js';
import type { JxaRef } from './types.js';

export { callbackRegistry } from './state.js';
export { addPostDrainHook, removePostDrainHook } from './poll.js';
export type { JxaRef, JxaProxy } from './types.js';

export function init(): void {
    initialize();
}

/** Load an Objective-C framework so its classes appear on `$`.
 *  Equivalent to JXA's `ObjC.import('AppKit')`. */
export function importFramework(name: string): void {
    initialize();
    getIpc()!.send({ action: 'LoadFramework', name });
}

/** Evaluate a raw JXA expression in the host process and return the result.
 *  Useful for ObjC.registerSubclass(), C struct constructors (NSMakeRect, ...),
 *  and other patterns that don't fit the Get/Invoke proxy model. */
export function evalJxa<T = any>(source: string): T {
    initialize();
    const res = getIpc()!.send({ action: 'Eval', source });
    return createProxy(res) as T;
}

export function releaseObject(proxy: JxaRef): void {
    const id = proxy?.__ref;
    if (!id || !getIpc()) return;
    proxyCache.delete(id);
    unpinProxy(id);
    try { getIpc()!.send({ action: 'Release', targetId: id }); } catch {}
    const cbs = objectCallbacks.get(id);
    if (cbs) {
        for (const cbId of cbs) callbackRegistry.delete(cbId);
        objectCallbacks.delete(id);
    }
}

export function startEventDrain(): void {
    initialize();
    startPolling();
}

export function drainCallbacks(): void {
    const ipc = getIpc();
    if (!ipc) return;
    if (releaseQueue.length > 0) {
        for (const id of releaseQueue.splice(0)) {
            try { ipc.send({ action: 'Release', targetId: id }); } catch {}
        }
    }
    ipc.drainEvents();
}

/** Print to the host's stderr (visible in the parent terminal). Convenience for debugging. */
export function hostLog(...args: any[]): void {
    initialize();
    getIpc()!.send({ action: 'Print', args: args.map(a => wrapArg(a)) });
}

/** Recursively convert an ObjC value (NSString, NSNumber, NSArray, NSDictionary, ...)
 *  into the equivalent plain JavaScript value.  Equivalent to JXA's
 *  `ObjC.deepUnwrap(value)`.  Returns `value` unchanged if it isn't a JxaRef. */
export function unwrap<T = any>(value: any): T {
    // A JxaRef is a Proxy wrapping a function stub, so typeof is 'function'.
    // Check for __ref directly rather than typeof, otherwise function-shaped
    // proxies (which every JXA ref is) slip through.
    if (value === null || value === undefined) return value as T;
    const t = typeof value;
    if (t !== 'object' && t !== 'function') return value as T;
    const id = (value as any).__ref;
    if (!id) return value as T;
    initialize();
    const res = getIpc()!.send({ action: 'Unwrap', targetId: id });
    return createProxy(res) as T;
}

/** Hand control to a Cocoa application object whose `-run` method should be
 *  invoked on the host's main thread (e.g. `$.NSApplication.sharedApplication`).
 *  Returns immediately; Node.js stays alive until the app terminates and the
 *  JXA host exits, at which point any post-`runApp` code in your script also
 *  finishes. */
export function runApp(target: JxaRef): void {
    initialize();
    const id = target?.__ref;
    if (!id) throw new Error('runApp: argument has no __ref');
    const res = getIpc()!.send({ action: 'StartApp', targetId: id });
    if (res?.type === 'run_started') {
        getIpc()!.refForApp();
        startPolling();
    }
}

/** Root proxy: every property access returns the corresponding `$.<Class>` ref.
 *  Usage:
 *      importFramework('AppKit');
 *      const alert = $.NSAlert.alloc().init();
 *      alert.setMessageText('Hello');
 *      alert.runModal();
 */
export const $: any = new Proxy({} as any, {
    get(_t, prop: string | symbol) {
        if (typeof prop !== 'string') return undefined;
        if (rootCache.has(prop)) return rootCache.get(prop);
        initialize();
        const res = getIpc()!.send({ action: 'LoadClass', name: prop });
        const proxy = createProxy(res);
        // A JxaRef proxy has typeof === 'function'; cache it either way as
        // long as it's an object-like value with a __ref.
        if (proxy && (typeof proxy === 'object' || typeof proxy === 'function') && (proxy as any).__ref) {
            rootCache.set(prop, proxy as JxaRef);
        }
        return proxy;
    }
});
