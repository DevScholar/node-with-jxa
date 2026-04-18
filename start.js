#!/usr/bin/env node
// start.js — build & run a TypeScript example against the local source tree.
//
// Usage:  node start.js <path/to/example.ts>
//
// 1. Builds node-with-jxa via `npx tsc` (only when sources are newer than dist).
// 2. Compiles the example via tsc to a temp .js file.
// 3. Runs the .js with the current node executable.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const target = process.argv[2];
if (!target) {
    console.error('Usage: node start.js <example.ts>');
    process.exit(2);
}

function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
    if (r.status !== 0) process.exit(r.status ?? 1);
}

// Build the library (incremental — tsc handles it).
run('npx', ['tsc'], { cwd: __dirname });

// Compile the example with the same tsconfig but emit alongside dist/.
const absTarget = path.resolve(target);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nwjxa-example-'));
const tsconfig = {
    compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        outDir: tmpDir,
        esModuleInterop: true,
        skipLibCheck: true,
        allowSyntheticDefaultImports: true,
    },
    include: [absTarget],
};
const tsconfigPath = path.join(tmpDir, 'tsconfig.json');
fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

run('npx', ['tsc', '-p', tsconfigPath], { cwd: __dirname });

const outFile = path.join(tmpDir, path.basename(absTarget).replace(/\.ts$/, '.js'));
run(process.execPath, [outFile]);
