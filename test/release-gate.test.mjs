// The release gate's verdict must be DERIVED from per-trial observations, never
// read from a field the record asserts about itself.
//
// This exists because the gate previously did the opposite: it checked
// `r.verdict !== 'DEMONSTRATED'`, which a three-line hand-written file satisfied —
// while the file's own header claimed "the verdict is DERIVED from the evidence …
// editing it by hand goes red". The claim was false, and it mattered most exactly
// at publish, the moment `delivery` flips to `proven`.
//
// Every case below is paired with the state that must NOT produce it, so a guard
// that stops guarding fails instead of quietly passing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdict } from '../release-gate.mjs';

/** A minimal well-formed v2 record: one positive arm, one contrast arm, 3 trials. */
const good = () => ({
  recordVersion: 2,
  trials: 3,
  arms: {
    fresh: { role: 'positive', predicate: ['present'], trials: [{ present: true }, { present: true }, { present: true }] },
    contrast: { role: 'contrast', predicate: ['present'], trials: [{ present: false }, { present: false }, { present: false }] },
  },
});

test('a well-formed record with hitting arms is DEMONSTRATED', () => {
  const v = verdict(good());
  assert.equal(v.ok, true, v.reasons.join('; '));
});

test('THE REGRESSION: a hand-written record asserting its own verdict is REJECTED', () => {
  // Exactly the three-line file that used to flip delivery to "proven".
  const forged = { verdict: 'DEMONSTRATED', packageVersion: '0.1.0' };
  const v = verdict(forged);
  assert.equal(v.ok, false, 'a self-asserted verdict must not satisfy the gate');
  assert.match(v.reasons.join(' '), /recordVersion/);
});

test('a record with no contrast arm is REJECTED — a proof that cannot fail proves nothing', () => {
  const r = good();
  delete r.arms.contrast;
  const v = verdict(r);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /no contrast arm/);
});

test('a contrast arm that leaked on every trial is REJECTED', () => {
  const r = good();
  r.arms.contrast.trials = [{ present: true }, { present: true }, { present: true }];
  const v = verdict(r);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /contrast arm .* leaked 3\/3/);
});

test('a positive arm below 2/3 is REJECTED', () => {
  const r = good();
  r.arms.fresh.trials = [{ present: true }, { present: false }, { present: false }];
  const v = verdict(r);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /positive arm .* hit 1\/3/);
});

test('2 of 3 on a positive arm still passes (ADR-0022 >=2/3)', () => {
  const r = good();
  r.arms.fresh.trials = [{ present: true }, { present: true }, { present: false }];
  assert.equal(verdict(r).ok, true);
});

test('ANTI-VACUITY: a predicate naming a field no trial carries is REJECTED', () => {
  // Without this, `hits` is 0 for every trial, so a contrast arm that leaked on
  // all three still "holds" — the proof failing to be able to fail on its own
  // terms. This is the class that produced vfkb issue #150's false RED.
  const r = good();
  r.arms.contrast.predicate = ['fieldNobodyRecords'];
  const v = verdict(r);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /pass vacuously/);
});

test('fewer than 3 trials is REJECTED (ADR-0022 §5)', () => {
  const r = good();
  r.trials = 1;
  for (const a of Object.values(r.arms)) a.trials = a.trials.slice(0, 1);
  const v = verdict(r);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /requires N>=3/);
});

test('an arm whose trial count disagrees with the record is REJECTED', () => {
  const r = good();
  r.arms.fresh.trials = r.arms.fresh.trials.slice(0, 2);
  const v = verdict(r);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /carries 2 trials but the record declares 3/);
});

// ---------------------------------------------------------------------------
// INTEGRATION — the unit tests above prove verdict() is correct, but NOT that the
// gate uses it. Reverting the call site to `r.verdict !== 'DEMONSTRATED'` left all
// of them green (observed). So this runs the REAL script against a fixture repo
// carrying a forged record, and asserts it exits non-zero.
// ---------------------------------------------------------------------------
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));

/** A throwaway copy of the package with `status`/`record` planted. */
function fixture({ record, deliveryStatus }) {
  const dir = mkdtempSync(join(tmpdir(), 'vfkb-pi-gate-'));
  for (const f of ['release-gate.mjs', 'package.json', 'README.md', 'extensions', 'bundles']) {
    cpSync(join(PKG, f), join(dir, f), { recursive: true });
  }
  mkdirSync(join(dir, 'scenarios', 'records'), { recursive: true });
  writeFileSync(join(dir, 'DELIVERY-STATUS.json'), JSON.stringify(deliveryStatus, null, 2));
  if (record) writeFileSync(join(dir, 'scenarios', 'records', 'install-path.json'), JSON.stringify(record, null, 2));
  return dir;
}

const runGate = (dir) => spawnSync(process.execPath, [join(dir, 'release-gate.mjs')], { encoding: 'utf8' });

test('INTEGRATION: the gate REJECTS a forged record claiming proven', () => {
  const dir = fixture({
    deliveryStatus: { delivery: 'proven', proofRecord: 'install-path' },
    record: { verdict: 'DEMONSTRATED', packageVersion: '0.1.0' }, // the three-line forgery
  });
  try {
    const r = runGate(dir);
    assert.notEqual(r.status, 0, `gate PASSED a forged record:\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr + r.stdout, /recordVersion/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: the gate ACCEPTS a genuine record (the contrast — else the test above proves nothing)', () => {
  const pkgVersion = JSON.parse(execFileSync('node', ['-p', 'JSON.stringify(require("./package.json"))'], { cwd: PKG, encoding: 'utf8' })).version;
  const real = { ...good(), scenario: 'install-path', packageVersion: pkgVersion };
  const dir = fixture({ deliveryStatus: { delivery: 'proven', proofRecord: 'install-path' }, record: real });
  try {
    const r = runGate(dir);
    assert.equal(r.status, 0, `gate REJECTED a genuine record:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /delivery: proven/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
