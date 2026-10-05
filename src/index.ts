import { randomUUID } from 'node:crypto';
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

/** @internal Evaluate a raw JXA expression in the host process and return the
 *  result.  Used internally by the JXA globals below (Application, Path, …).
 *  Not part of the public API — falling back to raw source strings defeats
 *  the purpose of the proxy bridge and is functionally equivalent to invoking
 *  `osascript -l JavaScript` yourself.  Use the typed helpers instead. */
function internalEval<T = any>(source: string): T {
    initialize();
    const res = getIpc()!.send({ action: 'Eval', source });
    return createProxy(res) as T;
}

/** Scripting bridge to a macOS application, identified by its process name or
 *  bundle id.  Mirrors JXA's built-in `Application(name)`:
 *
 *      const finder = Application('Finder');
 *      finder.activate();
 *      finder.open(Path('/Users/me'));
 */
export function Application(name: string): any {
    return internalEval(`Application(${JSON.stringify(name)})`);
}

/** POSIX file-path literal understood by every scripting-bridge method.
 *  Mirrors JXA's built-in `Path(posix)`. */
export function Path(posixPath: string): any {
    return internalEval(`Path(${JSON.stringify(posixPath)})`);
}

/** Sleep for `seconds` on the JXA host thread.  Mirrors JXA's built-in
 *  `delay(seconds)`.  Blocks Node's IPC round-trip until the host wakes up. */
export function delay(seconds: number): void {
    internalEval(`delay(${Number(seconds)})`);
}

/** Allocate a JXA out-parameter holder (JXA's built-in `Ref()`).  Pass to a
 *  scripting method that writes into a reference argument, then read back
 *  the populated value with `.value` or `[0]`. */
export function Ref(): any {
    return internalEval(`Ref()`);
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

/**
 * Register a WKURLSchemeHandler whose start callback runs inline in the JXA
 * host process (extracting url/method/body without any Node IPC) and pushes a
 * single async_event to `callback` with `(url, method, body, taskId)`.
 *
 * This is the low-level transport used by node-with-window's macOS backend to
 * make `nww://` requests fast: the per-request path drops from ~15 FIFO
 * round-trips (one per ObjC property access through the proxy) to two.
 *
 * Returns the handler ref, which the caller passes to
 * `config.setURLSchemeHandlerForURLScheme(handler, 'nww')`.
 */
export function registerNwwSchemeHandler(
    name: string,
    callback: (url: string, method: string, body: string | null, taskId: string) => void,
): any {
    initialize();
    const cbId = `cb_${randomUUID()}`;
    callbackRegistry.set(cbId, callback as unknown as Function);
    const res = getIpc()!.send({ action: 'RegisterNwwSchemeHandler', callbackId: cbId, name });
    return createProxy(res);
}

/**
 * Complete an nww:// scheme task started by a registerNwwSchemeHandler
 * callback.  Constructs the HTTP response inline in the host process.
 * `result` is either `{ status, mimeType, body }` or `{ error }`.
 */
export function completeNwwSchemeTask(
    taskId: string,
    result: { status?: number; mimeType?: string; body?: string } | { error: string },
): void {
    const ipc = getIpc();
    if (!ipc) return;
    ipc.send({ action: 'NwwSchemeResponse', taskId, ...(result as object) });
}

export function drainCallbacks(): void {
    const ipc = getIpc();
    if (!ipc) return;
    // Process one ID at a time so a send() failure (host died) doesn't
    // silently drop every remaining ID in the queue. If send throws, push
    // the unsent IDs back so a future attempt can retry — but if the host
    // is exited, just discard (the host process is gone, the GC is moot).
    while (releaseQueue.length > 0) {
        const id = releaseQueue.shift()!;
        try {
            ipc.send({ action: 'Release', targetId: id });
        } catch {
            if (ipc.isExited) {
                releaseQueue.length = 0;
                break;
            }
            // Transient failure — put it back at the front and stop draining
            // this tick so we don't busy-loop on a broken pipe.
            releaseQueue.unshift(id);
            break;
        }
    }
    ipc.drainEvents();
}

/** @internal Hand control to a Cocoa application object whose `-run` method
 *  should be invoked on the host's main thread. Not part of the public API —
 *  standard JXA calls `app.run()` directly; the library is responsible for
 *  wiring that call to this helper (see host.js / proxy.ts). */
function runApp(target: JxaRef): void {
    initialize();
    const id = target?.__ref;
    if (!id) throw new Error('runApp: argument has no __ref');
    const res = getIpc()!.send({ action: 'StartApp', targetId: id });
    if (res?.type === 'run_started') {
        getIpc()!.refForApp();
        startPolling();
    }
}
void runApp;

function sendUnwrap(action: 'ObjCUnwrap' | 'ObjCDeepUnwrap', value: any): any {
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t !== 'object' && t !== 'function') return value;
    const id = (value as any).__ref;
    if (!id) return value;
    initialize();
    const res = getIpc()!.send({ action, targetId: id });
    return createProxy(res);
}

export interface ObjCMethodSpec {
    /** ObjC type-encoding tuple: [returnType, [argTypes...]].
     *  E.g. `['void', ['id']]` for `-(void)click:(id)sender`. */
    types: [string, string[]];
    /** JS implementation. Called with the ObjC args (minus `self`, which is
     *  bound as `this` inside the function on the host side). */
    implementation: (...args: any[]) => any;
}

export interface ObjCSubclassSpec {
    name: string;
    superclass?: string;
    protocols?: string[];
    properties?: Record<string, string>;
    methods?: Record<string, ObjCMethodSpec>;
}

/** Mirror of standard JXA's `ObjC` namespace.  Provides the entry points you'd
 *  use in a standalone `osascript -l JavaScript` script:
 *
 *      ObjC.import('AppKit');
 *      const js = ObjC.unwrap(nsString);
 *      const obj = ObjC.deepUnwrap(nsDictionary);
 *      ObjC.registerSubclass({ name, superclass, methods: { 'click:': {...} } });
 */
export const ObjC = {
    /** Load an Objective-C framework so its classes appear on `$`. */
    import(name: string): void {
        initialize();
        getIpc()!.send({ action: 'LoadFramework', name });
    },

    /** Single-level unwrap: NSString → JS string, NSNumber → number, etc.
     *  Container elements (NSArray items, NSDictionary values) stay as refs.
     *  Returns `value` unchanged if it isn't a JxaRef. */
    unwrap<T = any>(value: any): T {
        return sendUnwrap('ObjCUnwrap', value) as T;
    },

    /** Recursive unwrap: also unwraps container elements.  WARNING: crashes
     *  on class-cluster placeholders (e.g. the object returned by
     *  `[NSString alloc]` before `-initWith...` runs). */
    deepUnwrap<T = any>(value: any): T {
        return sendUnwrap('ObjCDeepUnwrap', value) as T;
    },

    /** Register a new ObjC subclass whose method implementations are JS
     *  functions running in this Node.js process.  When the method is invoked
     *  from ObjC (e.g. a Cocoa target-action fires), the host pushes a sync
     *  event to Node, runs the JS implementation, and sends the return value
     *  back so the ObjC caller sees a normal method return.
     *
     *  Example (button target-action):
     *
     *      ObjC.registerSubclass({
     *          name: 'MyHandler',
     *          superclass: 'NSObject',
     *          methods: {
     *              'click:': {
     *                  types: ['void', ['id']],
     *                  implementation: (sender) => console.log('clicked', sender),
     *              },
     *          },
     *      });
     *      const handler = $.MyHandler.alloc.init;
     *      button.setTarget(handler);
     *      button.setAction('click:');
     */
    registerSubclass(spec: ObjCSubclassSpec): void {
        initialize();
        // Decide each method's dispatch mode from its ObjC return type (the
        // `types[0]` tuple — standard JXA).  `void` methods are the overwhelming
        // majority: they never return a value to ObjC, so they can fire-and-forget
        // instead of pumping a nested run loop waiting for Node's reply.  That
        // nested loop is exactly what poisons a re-entrant modal panel (e.g. a
        // renderer IPC callback that opens NSOpenPanel), so keeping it only for
        // the rare non-void methods (e.g. applicationShouldTerminateAfterLast
        // WindowClosed: → bool) is both simpler and correct.  The user still
        // writes plain JXA — no `async` keyword, no tagging.
        if (spec.methods) {
            for (const method of Object.values(spec.methods)) {
                const ret = method.types?.[0];
                (method.implementation as any).__nwjxa_async =
                    ret === 'void' || ret === 'v';
            }
        }
        getIpc()!.send({ action: 'RegisterSubclass', spec: wrapArg(spec) });
    },
};

/** Root proxy: every property access returns the corresponding `$.<Class>` ref.
 *  Usage:
 *      ObjC.import('AppKit');
 *      const alert = $.NSAlert.alloc.init;
 *      alert.setMessageText('Hello');
 *      alert.runModal;
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
