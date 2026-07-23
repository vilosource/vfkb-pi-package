// Tests for extensions/00-vfkb-config.js — the config resolver.
//
// This file is the whole reason the package delivers tools at all, and three of its
// behaviours have already been wrong in review:
//   - it pointed the two faces at DIFFERENT brains (split brain), twice;
//   - it stayed silent on a partial install, which IS the failure it exists to prevent;
//   - it wrote its config to a predictable /tmp path an attacker could pre-create.
//
// Run: node --test test/
//
// Each case asserts the state that must NOT occur as well as the one that must, so a
// guard that stops guarding fails instead of quietly passing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, renameSync, chmodSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESOLVER = join(HERE, '..', 'extensions', '00-vfkb-config.js');
const SERVER = join(HERE, '..', 'bundles', 'vfkb-mcp.mjs');

// The resolver mutates process.env, so each case runs it in a child process and reports
// the resulting state as JSON. That also keeps the cases independent of each other.
function run({ cwd, env = {} }) {
  const script = `
    process.chdir(${JSON.stringify(cwd)});
    const res = (await import(${JSON.stringify(RESOLVER)})).default;
    let stderr = '';
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { stderr += s; return true; };
    res({});
    process.stderr.write = orig;
    const cfgPath = process.env.VFKB_MCP_CONFIG;
    const fs = await import('node:fs');
    const cfg = cfgPath && fs.existsSync(cfgPath)
      ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : null;
    process.stdout.write(JSON.stringify({
      dataDir: process.env.VFKB_DATA_DIR || null,
      cfgPath: cfgPath || null,
      serverBrain: cfg?.mcpServers?.vfkb?.env?.VFKB_DATA_DIR ?? null,
      stderr,
    }));
  `;
  const clean = { ...process.env };
  delete clean.VFKB_DATA_DIR;
  delete clean.VFKB_DIR;
  delete clean.VFKB_MCP_CONFIG;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...clean, ...env },
  });
  return JSON.parse(out);
}

function project() {
  const root = mkdtempSync(join(tmpdir(), 'vfkb-pkg-test-'));
  mkdirSync(join(root, '.vfkb'), { recursive: true });
  writeFileSync(join(root, '.vfkb', 'entries.jsonl'), '');
  return root;
}

test('BOTH faces get the SAME brain — the split-brain defect', () => {
  const root = project();
  try {
    const r = run({ cwd: root });
    assert.equal(r.dataDir, join(root, '.vfkb'), 'in-process face (injection/capture)');
    assert.equal(r.serverBrain, join(root, '.vfkb'), 'MCP face (the kb_* tools)');
    assert.equal(r.dataDir, r.serverBrain, 'the two faces MUST agree');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit outer VFKB_DATA_DIR wins, and BOTH faces honour it', () => {
  const root = project();
  const outer = mkdtempSync(join(tmpdir(), 'vfkb-outer-'));
  try {
    const r = run({ cwd: root, env: { VFKB_DATA_DIR: outer } });
    assert.equal(r.dataDir, outer);
    assert.equal(r.serverBrain, outer, 'the MCP spec must be built from the SAME resolved brain');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outer, { recursive: true, force: true });
  }
});

test('VFKB_DIR (the ADR-0032 alias) is honoured too, not silently shadowed', () => {
  // The L4 image sets exactly this (`ENV VFKB_DIR=/brain`). Shadowing it would have
  // silently bypassed the harness brain and invalidated the install-path proof.
  const root = project();
  const outer = mkdtempSync(join(tmpdir(), 'vfkb-alias-'));
  try {
    const r = run({ cwd: root, env: { VFKB_DIR: outer } });
    assert.equal(r.dataDir, outer);
    assert.equal(r.serverBrain, outer);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outer, { recursive: true, force: true });
  }
});

test('the brain is found by walking UP — pi may start in a subdirectory', () => {
  const root = project();
  const deep = join(root, 'a', 'b');
  mkdirSync(deep, { recursive: true });
  try {
    assert.equal(run({ cwd: deep }).dataDir, join(root, '.vfkb'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a consumer .vfkb/mcp.json override is honoured over the bundled server', () => {
  const root = project();
  try {
    const override = join(root, '.vfkb', 'mcp.json');
    writeFileSync(override, JSON.stringify({ mcpServers: { vfkb: { command: 'custom' } } }));
    const r = run({ cwd: root });
    assert.equal(r.cfgPath, override);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the config is written INSIDE the brain, not a predictable /tmp path', () => {
  // It lived at /tmp/vfkb-pi-<sha256>. pi SPAWNS command+args out of this file, and
  // mkdirSync({mode}) does not chmod an existing directory — so an attacker who could
  // guess the repo path pre-created it world-writable and got code execution.
  const root = project();
  try {
    const r = run({ cwd: root });
    assert.equal(r.cfgPath, join(root, '.vfkb', '.pi-mcp.json'));
    // The specific regression: a shared, guessable /tmp/vfkb-pi-<hash> directory.
    // (The test project itself lives under tmpdir(), so "not under /tmp" is not the
    // assertion — "inside the user-owned brain dir, not a shared namespace" is.)
    assert.ok(!/vfkb-pi-[0-9a-f]{16}/.test(r.cfgPath), 'must not use the guessable shared-/tmp path');
    assert.ok(r.cfgPath.startsWith(join(root, '.vfkb')), 'must live inside the brain dir');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the config is 0600 even when the file ALREADY exists', () => {
  // writeFileSync(path, …, {mode}) applies the mode only at CREATION, so a
  // pre-existing world-readable file kept its mode. pi spawns command+args out of this
  // file, so the permission has to be pinned on every write, not just the first.
  const root = project();
  try {
    const p = join(root, '.vfkb', '.pi-mcp.json');
    writeFileSync(p, 'stale', { mode: 0o666 });
    chmodSync(p, 0o666);
    run({ cwd: root });
    assert.equal(statSync(p).mode & 0o777, 0o600, 'mode must be pinned on an existing file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a symlinked config path is REFUSED, not followed', () => {
  // The arbitrary-overwrite primitive: without O_NOFOLLOW the write traverses a planted
  // symlink and clobbers whatever it points at, as the victim.
  const root = project();
  const victim = join(root, 'victim.txt');
  try {
    writeFileSync(victim, 'ORIGINAL');
    symlinkSync(victim, join(root, '.vfkb', '.pi-mcp.json'));
    const r = run({ cwd: root });
    assert.equal(readFileSync(victim, 'utf8'), 'ORIGINAL', 'must NOT follow the symlink');
    assert.match(r.stderr, /could not write the MCP config/, 'and must say so');
    assert.equal(r.cfgPath, null, 'and must not point the bridge at it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a partial install WARNS instead of silently delivering zero tools', () => {
  const root = project();
  const moved = SERVER + '.moved';
  try {
    renameSync(SERVER, moved);
    const r = run({ cwd: root });
    assert.match(r.stderr, /MCP server missing/, 'must not fail silently — ADR-0051 clause 3');
    assert.equal(r.cfgPath, null, 'and must not point the bridge at a nonexistent server');
    // The in-process face is still wired, so injection keeps working.
    assert.equal(r.dataDir, join(root, '.vfkb'));
  } finally {
    if (existsSync(moved)) renameSync(moved, SERVER);
    rmSync(root, { recursive: true, force: true });
  }
});

test('outside a vfkb project the resolver does nothing at all', () => {
  const bare = mkdtempSync(join(tmpdir(), 'vfkb-none-'));
  try {
    const r = run({ cwd: bare });
    assert.equal(r.cfgPath, null);
    assert.equal(r.dataDir, null);
    assert.equal(r.stderr, '', 'not a vfkb repo is not an error — stay quiet');
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test('the manifest lists the resolver BEFORE the bridge', () => {
  // The runtime contract the whole package depends on: pi loads extensions in manifest
  // order, and the bridge resolves its config at module top level.
  const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
  const exts = pkg.pi.extensions;
  const resolver = exts.findIndex((e) => /vfkb-config/.test(e));
  const bridge = exts.findIndex((e) => /vfkb-pi-bridge/.test(e));
  assert.ok(resolver >= 0 && bridge >= 0);
  assert.ok(resolver < bridge, 'resolver must precede the bridge or the install ships zero tools');
  for (const e of exts) assert.ok(existsSync(join(HERE, '..', e)), `declared extension exists: ${e}`);
});
