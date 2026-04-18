// scripts/host.js — JXA host bridge for node-with-jxa
//
// Runs under: osascript -l JavaScript host.js
// Communicates with the Node.js parent over inherited pipes:
//   fd 3 — Node writes commands  → JXA reads
//   fd 4 — JXA  writes responses → Node reads
//
// Threading model:
//   * Single-threaded (main thread only) — JXA's JS context is not safe
//     to share across threads, so we stick to NSRunLoop + NSFileHandle's
//     readInBackgroundAndNotify pattern (notifications fire on the run loop
//     where readInBackgroundAndNotify was called, i.e. main thread).
//   * Sync nested commands (triggered by JS callbacks fired from ObjC)
//     pump the main run loop until a complete line arrives, then dispatch.

'use strict';

ObjC.import('Foundation');

var fdReader = $.NSFileHandle.alloc.initWithFileDescriptor(3);
var fdWriter = $.NSFileHandle.alloc.initWithFileDescriptor(4);
var stderrFh = $.NSFileHandle.fileHandleWithStandardError;

// ---------- low-level I/O ----------

function writeRaw(s) {
    var nsStr = $.NSString.alloc.initWithUTF8String(s + '\n');
    var data = nsStr.dataUsingEncoding($.NSUTF8StringEncoding);
    fdWriter.writeData(data);
}

function debugLog(s) {
    var nsStr = $.NSString.alloc.initWithUTF8String('[jxa-host] ' + s + '\n');
    stderrFh.writeData(nsStr.dataUsingEncoding($.NSUTF8StringEncoding));
}

// ---------- shared line buffer ----------

var pendingBuf = '';
var inNestedRead = false; // when true, the observer must NOT drain — the
                          // currently-running processNestedCommands() will.

function appendNSData(nsData) {
    if (!nsData) {
        $.exit(0);
        return;
    }
    var len = nsData.length;
    // ObjC's NSUInteger comes back as a Number in JXA; treat 0 as EOF.
    if (!len || len === 0) {
        $.exit(0);
        return;
    }
    var nsStr = $.NSString.alloc.initWithDataEncoding(nsData, $.NSUTF8StringEncoding);
    pendingBuf += ObjC.unwrap(nsStr);
}

function takeLine() {
    var nl = pendingBuf.indexOf('\n');
    if (nl < 0) return null;
    var line = pendingBuf.substring(0, nl);
    pendingBuf = pendingBuf.substring(nl + 1);
    return line;
}

// ---------- object store / protocol ----------

var objectStore = {};            // id → ObjC object (or class, function)
var objectIdMap = new WeakMap(); // ObjC object → id (dedup, when possible)
var nextObjectId = 1;

// Stable handle for the JXA root namespace: `$`.
objectStore['__root__'] = $;

function storeObject(v) {
    // WeakMap keys must be objects; primitives are filtered earlier.
    try {
        if (objectIdMap.has(v)) {
            var existing = objectIdMap.get(v);
            if (objectStore[existing] !== undefined) return existing;
        }
    } catch (e) {}
    var id = 'jxa_' + (nextObjectId++);
    objectStore[id] = v;
    try { objectIdMap.set(v, id); } catch (e) {}
    return id;
}

function ConvertToProtocol(v) {
    if (v === null || v === undefined) return { type: 'null' };
    var t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') {
        return { type: 'primitive', value: v };
    }
    if (Array.isArray(v)) {
        return { type: 'array', value: v.map(ConvertToProtocol) };
    }
    // Everything else (ObjC instances, classes, methods, structs) → ref.
    var id = storeObject(v);
    return { type: 'ref', id: id };
}

function ResolveArg(arg) {
    if (!arg || arg.type === 'null') return null;
    if (arg.type === 'primitive') return arg.value;
    if (arg.type === 'uint8array') {
        // Pass as NSData so ObjC methods expecting NSData work; users wanting
        // a JS array can call .bytes / iterate via the ObjC bridge instead.
        var bytes = arg.value;
        var nsData = $.NSMutableData.dataWithCapacity(bytes.length);
        // Build an NSString of bytes, then get its data; not the most efficient
        // but avoids needing C buffer marshalling. Fine for small payloads.
        for (var i = 0; i < bytes.length; i++) {
            var b = $.NSData.dataWithBytesLength([bytes[i]], 1); // fallback
            nsData.appendData(b);
        }
        return nsData;
    }
    if (arg.type === 'ref') return objectStore[arg.id];
    if (arg.type === 'array') return arg.value.map(ResolveArg);
    if (arg.type === 'object') {
        var obj = {};
        for (var k in arg.value) obj[k] = ResolveArg(arg.value[k]);
        return obj;
    }
    if (arg.type === 'callback') {
        var cbId = arg.callbackId;
        var syncReturnValue = arg.syncReturn !== undefined ? arg.syncReturn : null;
        if (arg.async) {
            return function() {
                var cbArgs = [];
                for (var i = 0; i < arguments.length; i++) cbArgs.push(ConvertToProtocol(arguments[i]));
                writeRaw(JSON.stringify({ type: 'async_event', callbackId: cbId, args: cbArgs }));
                return syncReturnValue;
            };
        }
        return function() {
            var cbArgs = [];
            for (var i = 0; i < arguments.length; i++) cbArgs.push(ConvertToProtocol(arguments[i]));
            writeRaw(JSON.stringify({ type: 'event', callbackId: cbId, args: cbArgs }));
            var res = processNestedCommands();
            if (res && res.result && res.result.type === 'primitive') return res.result.value;
            return null;
        };
    }
    return null;
}

// ---------- command dispatch ----------

var appStarted = false;
var appTarget = null;

// JXA's ObjC bound methods are `typeof === 'function'` but don't always expose
// Function.prototype.apply/call, so we can't rely on `fn.apply(thisArg, args)`.
// Use direct invocation; fall back to Function.prototype.apply.call for the
// rare case a real JS function is stored in the object map.
function callCallable(fn, thisArg, args) {
    try {
        switch (args.length) {
            case 0: return fn();
            case 1: return fn(args[0]);
            case 2: return fn(args[0], args[1]);
            case 3: return fn(args[0], args[1], args[2]);
            case 4: return fn(args[0], args[1], args[2], args[3]);
            case 5: return fn(args[0], args[1], args[2], args[3], args[4]);
            case 6: return fn(args[0], args[1], args[2], args[3], args[4], args[5]);
            case 7: return fn(args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
            case 8: return fn(args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7]);
            default: return Function.prototype.apply.call(fn, thisArg, args);
        }
    } catch (e) {
        // Last resort: a real JS function whose prototype chain does support .apply.
        return Function.prototype.apply.call(fn, thisArg, args);
    }
}

function executeCommand(cmd) {
    if (cmd.action === 'LoadFramework') {
        ObjC.import(cmd.name);
        return { type: 'void' };
    }
    if (cmd.action === 'LoadClass') {
        var cls = $[cmd.name];
        if (cls === undefined || cls === null) {
            throw new Error("Class not found on $: " + cmd.name);
        }
        return ConvertToProtocol(cls);
    }
    if (cmd.action === 'Get') {
        var target = objectStore[cmd.targetId];
        var val;
        try { val = target[cmd.property]; }
        catch (e) { return { type: 'null' }; }
        // JXA auto-invokes ObjC *properties* (declared @property) on bare
        // access — so `proc.hostName` already returns an NSString — but it
        // does NOT auto-invoke plain zero-arg *methods* (like +alloc, -init,
        // -count, -runModal).  Replicate the ergonomic "classic JXA" pattern
        // `$.NSArray.alloc.init` by invoking zero-arg callables ourselves.
        //
        // Heuristic: `typeof === 'function'` && `.length === 0`.  Methods that
        // take arguments keep length >= 1 and are returned as refs for the
        // Node proxy to Invoke via Invoke(parentId, propName, args).
        if (typeof val === 'function' && val.length === 0) {
            try {
                var invoked;
                try { invoked = val.call(target); }
                catch (_e) { invoked = val(); }
                val = invoked;
            } catch (_e) {
                // Not actually invocable — leave as-is.
            }
        }
        return ConvertToProtocol(val);
    }
    if (cmd.action === 'Set') {
        var target2 = objectStore[cmd.targetId];
        target2[cmd.property] = ResolveArg(cmd.value);
        return { type: 'void' };
    }
    if (cmd.action === 'Invoke') {
        var target3 = objectStore[cmd.targetId];
        var methodName = cmd.methodName;
        var args = (cmd.args || []).map(ResolveArg);
        if (target3 === undefined || target3 === null) {
            throw new Error("Invoke target missing: " + cmd.targetId);
        }
        if (target3[methodName] === undefined || target3[methodName] === null) {
            throw new Error("Method not found: " + methodName);
        }
        // Direct property dispatch — equivalent to writing
        // `target.method(arg1, arg2, ...)` in JXA.  This is the only form
        // that always preserves ObjC's `self` binding; storing the bound
        // method and calling it standalone (`fn(arg)`) silently fails for
        // mutators like -addObject:, because JXA's bound method wrappers
        // don't carry receiver context across detachment.
        var res;
        switch (args.length) {
            case 0: res = target3[methodName](); break;
            case 1: res = target3[methodName](args[0]); break;
            case 2: res = target3[methodName](args[0], args[1]); break;
            case 3: res = target3[methodName](args[0], args[1], args[2]); break;
            case 4: res = target3[methodName](args[0], args[1], args[2], args[3]); break;
            case 5: res = target3[methodName](args[0], args[1], args[2], args[3], args[4]); break;
            case 6: res = target3[methodName](args[0], args[1], args[2], args[3], args[4], args[5]); break;
            case 7: res = target3[methodName](args[0], args[1], args[2], args[3], args[4], args[5], args[6]); break;
            case 8: res = target3[methodName](args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7]); break;
            default:
                try { res = target3[methodName].apply(target3, args); }
                catch (_e) { res = Function.prototype.apply.call(target3[methodName], target3, args); }
                break;
        }
        return ConvertToProtocol(res);
    }
    if (cmd.action === 'InvokeRef') {
        // Call a function/method ref stored from a prior Get.
        var target4 = objectStore[cmd.targetId];
        var args2 = (cmd.args || []).map(ResolveArg);
        if (typeof target4 !== 'function') {
            // Not callable (e.g. an NSString ref the user mistakenly invoked):
            // passthrough so the chain survives.
            return ConvertToProtocol(target4);
        }
        return ConvertToProtocol(callCallable(target4, null, args2));
    }
    if (cmd.action === 'Release') {
        var obj = objectStore[cmd.targetId];
        delete objectStore[cmd.targetId];
        try { if (obj && objectIdMap.get(obj) === cmd.targetId) objectIdMap.delete(obj); } catch (e) {}
        return { type: 'void' };
    }
    if (cmd.action === 'Print') {
        var parts = (cmd.args || []).map(ResolveArg);
        var line = parts.map(function(p) {
            if (p === null || p === undefined) return String(p);
            if (typeof p === 'object') { try { return JSON.stringify(p); } catch (e) { return String(p); } }
            return String(p);
        }).join(' ');
        debugLog(line);
        return { type: 'void' };
    }
    if (cmd.action === 'Eval') {
        // eslint-disable-next-line no-eval
        var v = eval('(' + cmd.source + ')');
        return ConvertToProtocol(v);
    }
    if (cmd.action === 'Unwrap') {
        var target5 = objectStore[cmd.targetId];
        var unwrapped;
        try { unwrapped = ObjC.deepUnwrap(target5); }
        catch (e) {
            // Fallback for objects deepUnwrap can't handle: try .description.
            try { unwrapped = ObjC.unwrap(target5.description); }
            catch (e2) { unwrapped = String(target5); }
        }
        return ConvertToProtocol(unwrapped);
    }
    if (cmd.action === 'StartApp') {
        // Defer the actual run() until after we send run_started + return from
        // the current dispatch frame, to avoid re-entering the run loop while
        // an observer notification is on the stack.
        var t = objectStore[cmd.targetId];
        if (!t) throw new Error("StartApp: unknown targetId");
        appStarted = true;
        appTarget = t;
        return { type: 'run_started' };
    }
    throw new Error("Unknown action: " + cmd.action);
}

function dispatchCommandLine(line) {
    var cmd;
    try { cmd = JSON.parse(line); }
    catch (e) {
        writeRaw(JSON.stringify({ type: 'error', message: 'Invalid JSON: ' + e.toString() }));
        return;
    }
    var response;
    try { response = executeCommand(cmd); }
    catch (e) { response = { type: 'error', message: e.toString() }; }
    if (cmd._seq !== undefined) response._seq = cmd._seq;
    writeRaw(JSON.stringify(response));
}

function drainAndExecute() {
    if (inNestedRead) return; // processNestedCommands() owns the buffer.
    var line;
    while ((line = takeLine()) !== null) {
        dispatchCommandLine(line);
    }
}

// processNestedCommands: blocks the current main-thread call stack until a
// {type:'reply'} arrives, executing any interleaved commands the parent sends.
// Pumps the run loop so the readInBackgroundAndNotify observer can fire and
// append data to pendingBuf — but with inNestedRead=true, the observer skips
// dispatching, so we do it here instead.
function processNestedCommands() {
    inNestedRead = true;
    try {
        while (true) {
            // Wait for at least one full line.
            while (pendingBuf.indexOf('\n') < 0) {
                $.NSRunLoop.currentRunLoop.runModeBeforeDate(
                    $.NSDefaultRunLoopMode,
                    $.NSDate.dateWithTimeIntervalSinceNow(60)
                );
            }
            var line = takeLine();
            var cmd;
            try { cmd = JSON.parse(line); }
            catch (e) {
                writeRaw(JSON.stringify({ type: 'error', message: 'Invalid JSON: ' + e.toString() }));
                continue;
            }
            if (cmd.type === 'reply') return cmd;
            var response;
            try { response = executeCommand(cmd); }
            catch (e) { response = { type: 'error', message: e.toString() }; }
            if (cmd._seq !== undefined) response._seq = cmd._seq;
            writeRaw(JSON.stringify(response));
        }
    } finally {
        inNestedRead = false;
    }
}

// ---------- stdin observer (readInBackgroundAndNotify) ----------

ObjC.registerSubclass({
    name: 'NwjxaIPCObserver',
    superclass: 'NSObject',
    methods: {
        'handleData:': {
            types: ['void', ['id']],
            implementation: function(notification) {
                var info = notification.userInfo;
                var nsData = info.objectForKey($.NSFileHandleNotificationDataItem);
                appendNSData(nsData);
                // Re-arm BEFORE dispatching so back-to-back chunks aren't dropped.
                // JXA auto-invokes zero-arg ObjC methods on property access — adding
                // parens would call the `undefined` return value of the invocation.
                fdReader.readInBackgroundAndNotify;
                drainAndExecute();
            }
        }
    }
});

var observer = $.NwjxaIPCObserver.alloc.init;
$.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(
    observer,
    'handleData:',
    $.NSFileHandleReadCompletionNotification,
    fdReader
);
fdReader.readInBackgroundAndNotify;

// ---------- main loop ----------
//
// Pump the main run loop until either:
//   * StartApp was processed → break out and call appTarget.run()
//   * EOF on fd 3 → appendNSData() calls $.exit(0)

while (!appStarted) {
    $.NSRunLoop.currentRunLoop.runModeBeforeDate(
        $.NSDefaultRunLoopMode,
        $.NSDate.distantFuture
    );
}

// Hand control to the user-supplied app object.  This blocks until the app
// terminates (e.g. all windows closed and quit policy fires).
// JXA auto-invokes zero-arg ObjC methods on property access, so `.run` is
// equivalent to `[app run]`.
appTarget.run;

$.exit(0);
