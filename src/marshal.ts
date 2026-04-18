// src/marshal.ts
import { randomUUID } from 'node:crypto';
import { callbackRegistry, objectCallbacks, pinProxy } from './state.js';

export function wrapArg(arg: any, ownerObjectId?: string): any {
    if (arg === null || arg === undefined) return { type: 'null' };
    if (arg.__ref) return { type: 'ref', id: arg.__ref };

    if (arg instanceof Uint8Array) {
        return { type: 'uint8array', value: Array.from(arg) };
    }

    if (typeof arg === 'function') {
        const cbId = `cb_${randomUUID()}`;
        callbackRegistry.set(cbId, arg);
        if (ownerObjectId) {
            if (!objectCallbacks.has(ownerObjectId)) objectCallbacks.set(ownerObjectId, []);
            objectCallbacks.get(ownerObjectId)!.push(cbId);
            pinProxy(ownerObjectId);
        }
        const isAsync = arg.constructor?.name === 'AsyncFunction';
        const descriptor: any = { type: 'callback', callbackId: cbId, async: isAsync };
        if ((arg as any).__syncReturn !== undefined) {
            descriptor.syncReturn = (arg as any).__syncReturn;
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
