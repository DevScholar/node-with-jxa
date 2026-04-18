import { getIpc, proxyCache, gcRegistry } from './state.js';
import { wrapArg } from './marshal.js';
import { startPolling } from './poll.js';
import type { JxaProxy, JxaRef } from './types.js';

export type { JxaProxy } from './types.js';

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
            if (typeof sub !== 'string') return false;
            getIpc()!.send({
                action: 'Set', targetId: parentId, property: propName,
                value: wrapArg(value, parentId)
            });
            return true;
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
