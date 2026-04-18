import { getIpc, proxyCache, gcRegistry } from './state.js';
import { wrapArg } from './marshal.js';
import { startPolling } from './poll.js';
import type { JxaProxy, JxaRef } from './types.js';

export type { JxaProxy } from './types.js';

// Normalize an objcjs-types-style selector (using `$` to separate ObjC
// selector parts, e.g. `initWithContentRect$styleMask$backing$defer$`) into
// the JXA camelCase form (`initWithContentRectStyleMaskBackingDefer`) that
// the host actually dispatches.  Names without `$` pass through unchanged so
// plain JXA code ($.NSString.stringWithUTF8String) keeps working.
function normalizeSelector(name: string): string {
    if (name.indexOf('$') < 0) return name;
    const parts = name.split('$').filter(p => p.length > 0);
    if (parts.length === 0) return name;
    let out = parts[0];
    for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        out += p.charAt(0).toUpperCase() + p.slice(1);
    }
    return out;
}

// "Invoke-aware" wrapper: returned when a property access resolves to an
// ObjC ref (instance, class, or bound method).  It remembers parent + name
// so that subsequent invocations dispatch via Invoke(parentId, propName, args)
// — the only form that always works in JXA, regardless of whether the bound
// method JXA returned is callable standalone.
//
//   • Property access (.foo) is delegated to the resolved ref proxy.
//   • Apply uses Invoke(parentId, propName, args) — correct ObjC dispatch.
//   • __ref returns the resolved id so the wrapper can be passed as an arg.
function makeInvokeProxy(parentId: string, propName: string, resolvedProxy: any): any {
    const stub = function() {};
    return new Proxy(stub, {
        get(_t, sub: string | symbol) {
            if (sub === '__ref') {
                if (resolvedProxy === null || resolvedProxy === undefined) return undefined;
                return (resolvedProxy as any).__ref;
            }
            if (typeof sub !== 'string') return undefined;
            return (resolvedProxy as any)?.[sub];
        },
        set(_t, sub: string | symbol, value: any) {
            // Delegate to the resolved ref proxy so that
            //   $.NSApplication.sharedApplication.delegate = d
            // becomes Set(targetId=sharedAppId, property='delegate', value=d),
            // which the host translates to `[sharedApp setDelegate:d]`.
            // Forwarding to (resolvedProxy as any)[sub] = value reuses the
            // ref-proxy set trap below.
            if (typeof sub !== 'string') return false;
            if (resolvedProxy && (typeof resolvedProxy === 'object' || typeof resolvedProxy === 'function')) {
                (resolvedProxy as any)[sub] = value;
                return true;
            }
            return false;
        },
        apply(_t, _this, args) {
            const netArgs = args.map(a => wrapArg(a, parentId));
            const res = getIpc()!.send({
                action: 'Invoke', targetId: parentId, methodName: propName, args: netArgs
            });
            if (res?.type === 'run_started') { getIpc()!.refForApp(); startPolling(); return undefined; }
            return createProxy(res);
        }
    });
}

// AllocProxy: returned when the user accesses `.alloc` on a class ref.
// We do NOT actually invoke +alloc here, because that would expose the
// class-cluster placeholder (e.g. NSPlaceholderString) to the Node side, and
// any subsequent IPC Get on it ("Did you forget to nest alloc and init?")
// crashes JXA's bridge.  Instead, we capture the next access — typically
// `.init` (zero-arg auto-invoke) or `.initWithXxx(args)` (call) — and emit a
// single AllocInit IPC that evaluates `cls.alloc.initXxx(...)` atomically on
// the JXA side, mirroring how standalone JXA chains alloc + init in one
// expression.
function createAllocProxy(classId: string): any {
    return new Proxy(function() {}, {
        get(_t, prop: string | symbol) {
            if (typeof prop !== 'string') return undefined;
            // Bare `.init` (no parens) — JXA's classic zero-arg auto-invoke.
            // Eagerly send AllocInit with no args and return the resulting
            // instance proxy.
            if (prop === 'init') {
                const res = getIpc()!.send({
                    action: 'AllocInit', classId, initMethod: 'init', args: []
                });
                return createProxy(res);
            }
            // Multi-arg initializers — return a callable that forwards the
            // arguments to AllocInit when invoked.  Other selectors after
            // alloc (rare in practice) reach this branch too; if the user
            // calls them, the host-side eval will surface a JXA error.
            return new Proxy(function() {}, {
                apply(_t2, _this, args) {
                    const netArgs = args.map(a => wrapArg(a));
                    const res = getIpc()!.send({
                        action: 'AllocInit', classId, initMethod: prop,
                        args: netArgs
                    });
                    return createProxy(res);
                }
            });
        }
    });
}

// Base ref proxy: created from {type:'ref', id} metadata.
// Get eagerly fetches the value (so primitives come back directly), then wraps
// non-primitive results in an invoke-aware proxy.
function createRefProxy<T extends object = object>(id: string): JxaProxy<T> {
    const cached = proxyCache.get(id);
    if (cached) {
        const existing = cached.deref();
        if (existing) return existing as JxaProxy<T>;
    }

    const stub = function() {};

    const proxy = new Proxy(stub, {
        get: (_t, prop: string | symbol) => {
            if (prop === '__ref') return id;
            if (typeof prop !== 'string') return undefined;

            // Intercept `.alloc` BEFORE issuing IPC.  Returning a placeholder
            // ref to Node and then doing a separate Get for `.initWithXxx`
            // crashes JXA (-length on NSPlaceholderString).  See AllocProxy.
            if (prop === 'alloc') return createAllocProxy(id);

            // Eagerly Get so primitives (numbers, strings, bools) are returned
            // as native JS values rather than as proxies the user has to unwrap.
            const val = getIpc()!.send({ action: 'Get', targetId: id, property: prop });
            const resolved = createProxy(val);

            // Primitives, null, arrays of primitives, Uint8Arrays — return directly.
            if (resolved === null || resolved === undefined) return resolved;
            const t = typeof resolved;
            if (t === 'number' || t === 'string' || t === 'boolean') return resolved;
            if (resolved instanceof Uint8Array) return resolved;
            if (Array.isArray(resolved)) return resolved;

            // Non-primitive (ObjC ref) — return an invoke-aware proxy that uses
            // Invoke(id, prop, args) for method calls and delegates property
            // access to the resolved ref proxy.
            return makeInvokeProxy(id, prop, resolved);
        },
        set: (_t, prop: string | symbol, value: any) => {
            if (typeof prop !== 'string') return false;
            getIpc()!.send({ action: 'Set', targetId: id, property: prop, value: wrapArg(value, id) });
            return true;
        },
        apply: (_t, _thisArg, args) => {
            // Direct ref invocation (rare — InvokeRef is the only path).
            const netArgs = args.map(a => wrapArg(a, id));
            const res = getIpc()!.send({ action: 'InvokeRef', targetId: id, args: netArgs });
            if (res?.type === 'run_started') { getIpc()!.refForApp(); startPolling(); return undefined; }
            return createProxy(res);
        }
    }) as JxaProxy<T>;

    proxyCache.set(id, new WeakRef(proxy as unknown as JxaRef));
    gcRegistry.register(proxy, id);
    return proxy;
}

export function createProxy<T extends object = object>(meta: any): any {
    if (!meta || meta.type === 'null') return null;
    if (meta.type === 'primitive') return meta.value;
    if (meta.type === 'uint8array') return new Uint8Array(meta.value);
    if (meta.type === 'array') return meta.value.map((item: any) => createProxy(item));
    if (meta.type !== 'ref') return undefined;
    return createRefProxy<T>(meta.id!);
}
