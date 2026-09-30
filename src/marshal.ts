// src/marshal.ts
import { randomUUID } from 'node:crypto';
import { callbackRegistry, objectCallbacks, pinProxy } from './state.js';

// Brand placed on primitive-callable wrappers (see proxy.ts) so we can
// distinguish them from genuine JS callbacks when marshalling args — both
// are `typeof === 'function'`.
export const PRIMITIVE_BRAND: unique symbol = Symbol.for('node-with-jxa.primitive');

export function wrapArg(arg: any, ownerObjectId?: string): any {
    if (arg === null || arg === undefined) return { type: 'null' };
    if (arg.__ref) return { type: 'ref', id: arg.__ref };

    if (arg instanceof Uint8Array) {
        return { type: 'uint8array', value: Array.from(arg) };
    }

    if (typeof arg === 'function') {
        // Unwrap primitive-callable wrappers back to their underlying value
        // so `obj.setTitle(str.length)` sends 'primitive', not 'callback'.
        const branded = (arg as any)[PRIMITIVE_BRAND];
        if (branded !== undefined) return { type: 'primitive', value: branded };

        const cbId = `cb_${randomUUID()}`;
        callbackRegistry.set(cbId, arg);
        if (ownerObjectId) {
            if (!objectCallbacks.has(ownerObjectId)) objectCallbacks.set(ownerObjectId, []);
            objectCallbacks.get(ownerObjectId)!.push(cbId);
            pinProxy(ownerObjectId);
        }
        // Sync vs async is decided by the ObjC method's *return type*, not by
        // whether the JS function happens to be declared `async`.  ObjC
        // subclasses (registerSubclass) tag each implementation with
        // __nwjxa_async based on its `types[0]`: void → fire-and-forget (no
        // nested run loop), anything else → synchronous round-trip so the
        // return value reaches ObjC.  This is the ground truth for "does this
        // callback need to block?" — a void method never returns a value, so a
        // nested loop would only buy a deadlock against re-entrant modal panels.
        const tagged = (arg as any).__nwjxa_async;
        const isAsync = tagged !== undefined
            ? tagged
            : arg.constructor?.name === 'AsyncFunction';
        const descriptor: any = { type: 'callback', callbackId: cbId, async: isAsync };
        if ((arg as any).__syncReturn !== undefined) {
            descriptor.syncReturn = (arg as any).__syncReturn;
        }
        if ((arg as any).__blockArgIndices !== undefined) {
            descriptor.blockArgIndices = (arg as any).__blockArgIndices;
        }
        if ((arg as any).__blockArgValues !== undefined) {
            descriptor.blockArgValues = (arg as any).__blockArgValues;
        }
        return descriptor;
    }

    if (Array.isArray(arg)) return { type: 'array', value: arg.map(a => wrapArg(a, ownerObjectId)) };

    if (typeof arg === 'object') {
        const plainObj: any = {};
        for (let k in arg) plainObj[k] = wrapArg(arg[k], ownerObjectId);
        return { type: 'object', value: plainObj };
    }

    return { type: 'primitive', value: arg };
}
