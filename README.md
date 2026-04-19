# @devscholar/node-with-jxa

> ⚠️ Alpha — expect breaking changes.

Node.js IPC bridge for **JXA** (JavaScript for Automation) on macOS. Drive
Cocoa / AppKit / Foundation from a regular Node.js process by spawning
`osascript -l JavaScript` in the background and proxying every property read,
property write, and method call across a pair of Unix FIFOs.

> **Status:** experimental (0.0.x). Modeled directly on
> [`@devscholar/node-with-gjs`](https://www.npmjs.com/package/@devscholar/node-with-gjs)
> — same architecture, different ObjC-flavoured runtime on the other side.

## Requirements

- macOS 10.10 or later (`osascript -l JavaScript` is built in).
- Node.js 18+.

## Quick start

```ts
import { $, ObjC, runApp } from '@devscholar/node-with-jxa';

ObjC.import('AppKit');

const app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyRegular);

const alert = $.NSAlert.alloc.init;
alert.setMessageText('Hello from Node.js');
alert.runModal;
```

## Public API

| Export | Purpose |
| --- | --- |
| `$` | Root proxy. `$.NSWindow`, `$.NSString`, … resolve to ObjC class refs. |
| `ObjC.import(name)` | Load an Objective-C framework. |
| `ObjC.unwrap(ref)` | NSString/NSNumber → JS value (single-level). |
| `ObjC.deepUnwrap(ref)` | NSArray/NSDictionary → JS value, recursively. |
| `ObjC.registerSubclass(spec)` | Define a new ObjC class whose methods are JS functions. |
| `Application(name)` | JXA scripting bridge to a macOS app (Finder, Safari, …). |
| `Path(posix)` | JXA file-path literal for scripting methods. |
| `delay(seconds)` | Sleep on the JXA host thread (JXA's built-in `delay`). |
| `Ref()` | Allocate a JXA out-parameter holder. |
| `runApp(target)` | Pre-replies to Node, then calls `target.run()` on the JXA main thread. Use for `NSApplication.sharedApplication`. |
| `hostLog(...args)` | Print to the host's stderr. |
| `releaseObject(ref)` | Drop a ref proactively (otherwise V8 GC handles it). |
| `init()` | Force-spawn the host (rarely needed; called lazily on first `$` access). |

`$`, `ObjC`, `Application`, `Path`, `delay`, and `Ref` match standard JXA 1:1 —
code that works in a standalone `osascript -l JavaScript` script reads the same
under node-with-jxa. Everything else (`runApp`, `hostLog`) is node-with-jxa-specific plumbing.

### Calling-convention notes

Standard JXA lets you write a zero-arg ObjC method either as bare property
access (`arr.count`, `$.NSAlert.alloc.init`) or with parens (`arr.count()`,
`$.NSAlert.alloc().init()`).  Both forms are supported here.

One divergence: property reads that return a primitive (number/string/boolean)
come back as a *callable wrapper* so `arr.count()` works too — arithmetic,
string concat, template interpolation, `JSON.stringify`, and `console.log`
all still show the underlying value (via `Symbol.toPrimitive` / `valueOf` /
`toJSON` / custom inspect), but `typeof arr.count === 'function'`, not
`'number'`.  If you need the primitive kind, use `Number(x)` / `String(x)` /
`Boolean(x)` or call it (`x()`).

## Architecture

```
 Node.js main thread          IPC worker thread        osascript (JXA) main thread
 ─────────────────────        ────────────────         ──────────────────────────
   $ proxy            ──────► fdWrite (FIFO)  ──────► fd 3  →  NSFileHandle
                                                                  │
                                                                  ▼
                                                             readInBackgroundAndNotify
                                                              → executeCommand →
                                                                 Get / Set / Invoke /
                                                                 LoadFramework / Eval / …
                                                                  │
   waitResponse() ◄────────── fdRead  (FIFO) ◄────────── fd 4  ◄  writeData
```

- Sync nested commands (Cocoa → JS callback → more IPC) work the same way they
  do in `node-with-gjs`: the JXA host pumps its main run loop until a `{type:
  'reply'}` arrives, and `inNestedRead` makes the notification observer back
  off so the nested loop owns the buffer.
- Async callbacks bypass the round-trip: the host writes an `async_event`
  straight to fd 4, and Node's IPC worker thread forwards it to the main
  thread via `MessagePort`.

## Build

```sh
npm install
npm run build      # tsc → dist/ + types/
```

## Examples

See [`node-with-jxa-examples`](https://github.com/DevScholar/node-with-jxa-examples):

- `src/finder-open-home.ts` — pure JXA style: `Application('Finder')` opens your home folder.
- `src/foundation-hello.ts` — pure Foundation, no GUI.
- `src/alert.ts` — modal `NSAlert`.
- `src/window.ts` — `NSWindow` + `NSApplication.run()`.

```sh
cd node-with-jxa-examples
node start.js src/window.ts
```

## License

MIT
