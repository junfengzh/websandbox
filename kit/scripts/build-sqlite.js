#!/usr/bin/env node
'use strict';
// Rebuild better-sqlite3 from source with SQLITE_USE_URI=1 so the kit can open
// base.db as `file:...?nolock=1` (overlay mode: every tenant on the same file,
// no file locks). Idempotent; runs as the kit's postinstall. Needs gcc/g++/make/python3.
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const pkg = path.dirname(require.resolve('better-sqlite3/package.json', { paths: [root] }));

function uriWorks() {
  const probe = path.join(require('node:os').tmpdir(), `wsb-uri-probe-${process.pid}.db`);
  try {
    execSync(`${JSON.stringify(process.execPath)} -e "const D=require('better-sqlite3');new D(process.argv[1]).close();new D('file:'+process.argv[1]+'?nolock=1',{fileMustExist:true}).close()" ${JSON.stringify(probe)}`, { cwd: root, stdio: 'pipe' });
    return true;
  } catch { return false; } finally { fs.rmSync(probe, { force: true }); }
}

if (uriWorks()) { console.log('build-sqlite: better-sqlite3 already has URI filenames'); process.exit(0); }
const defs = path.join(pkg, 'deps', 'defines.gypi');
const src = fs.readFileSync(defs, 'utf8');
if (src.includes("'SQLITE_USE_URI=0'")) fs.writeFileSync(defs, src.replace("'SQLITE_USE_URI=0'", "'SQLITE_USE_URI=1'"));
console.log('build-sqlite: rebuilding better-sqlite3 with SQLITE_USE_URI=1 (1-3 min)...');
execSync('npm rebuild better-sqlite3 --build-from-source', { cwd: root, stdio: 'inherit' });
if (!uriWorks()) { console.error('build-sqlite: rebuild done but URI filenames still fail'); process.exit(1); }
console.log('build-sqlite: ok');
