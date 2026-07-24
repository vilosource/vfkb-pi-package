#!/usr/bin/env node
// Delivery-honesty Brake (vfkb ADR-0051 clause 2).
//
// ADR-0051's founding lesson is that a prose rule with no Brake gets skipped — that is
// why ADR-0050 exists at all. So the disclosure is enforced mechanically, not promised:
//
//   delivery = "unproven"  -> README MUST carry the disclosure string, and no
//                             proofRecord may be claimed.
//   delivery = "proven"    -> the named record MUST exist, be DEMONSTRATED, and be
//                             version-bound to this package.json version.
//
// The verdict is DERIVED from the evidence; DELIVERY-STATUS.json's own field is a claim
// the gate checks, never the source of truth. Editing it by hand goes red.
//
// Usage: node release-gate.mjs   (exit 0 = pass, 1 = fail)

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const problems = [];
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const status = read('DELIVERY-STATUS.json');
const pkg = read('package.json');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

// ---------------------------------------------------------------------------
// ADR-0022:72 recomputed. Ported verbatim in behaviour from vfkb-claude-plugin's
// release-gate.mjs so the two gates cannot drift — a record is DEMONSTRATED when
// every positive arm hits and no contrast arm leaks, derived from the per-trial
// observations. It NEVER reads a `verdict` / `demonstrated` / `passed` field.
//
// This replaced a check that did exactly that (`r.verdict !== 'DEMONSTRATED'`),
// which a three-line hand-written file satisfied — while this file's own header
// claimed "the verdict is DERIVED from the evidence … editing it by hand goes
// red". That claim was false, and it mattered most precisely at publish, which is
// the moment `delivery` flips to `proven`. A Brake that can be waved through is
// prose (vfkb ADR-0050).
// ---------------------------------------------------------------------------
const MIN_TRIALS = 3;

const threshold = (role, trials) =>
  role === 'positive'
    ? { min: Math.ceil((2 * trials) / 3) }
    : { max: Math.floor(trials / 3) };

/** Trials in an arm satisfying EVERY observed predicate. */
const hits = (arm) => arm.trials.filter((t) => arm.predicate.every((p) => t[p] === true)).length;

/** Recompute a record's verdict from its observations. { ok, reasons }. */
export function verdict(rec) {
  const reasons = [];
  if (rec.recordVersion !== 2) {
    reasons.push(
      `record declares recordVersion ${JSON.stringify(rec.recordVersion)}; this gate reads v2 ` +
        `(per-arm {role, predicate, trials[]}) so the verdict can be recomputed`,
    );
    return { ok: false, reasons };
  }
  if (!Number.isInteger(rec.trials) || rec.trials < MIN_TRIALS) {
    reasons.push(`record declares trials=${rec.trials}; ADR-0022 §5 requires N>=${MIN_TRIALS}`);
  }
  const arms = Object.entries(rec.arms ?? {});
  if (arms.length === 0) reasons.push('record declares no arms');
  let sawPositive = false;
  let sawContrast = false;

  for (const [name, arm] of arms) {
    if (!['positive', 'contrast'].includes(arm.role)) {
      reasons.push(`arm "${name}" has unknown role ${JSON.stringify(arm.role)}`);
      continue;
    }
    if (!Array.isArray(arm.predicate) || arm.predicate.length === 0) {
      reasons.push(`arm "${name}" declares no predicate — nothing to observe`);
      continue;
    }
    if (!Array.isArray(arm.trials) || arm.trials.length !== rec.trials) {
      reasons.push(`arm "${name}" carries ${arm.trials?.length ?? 0} trials but the record declares ${rec.trials}`);
      continue;
    }
    // Anti-vacuity: a predicate naming a field no trial carries scores 0 hits on
    // every trial, so a contrast arm that leaked on all three still "holds" —
    // the proof failing to be able to fail, on its own terms (ADR-0029).
    const missing = arm.predicate.filter((p) => arm.trials.some((t) => typeof t[p] !== 'boolean'));
    if (missing.length) {
      reasons.push(
        `arm "${name}" scores on [${missing}], which is not a boolean on every trial — ` +
          `the predicate cannot be evaluated, so the arm would pass vacuously`,
      );
      continue;
    }
    const n = hits(arm);
    const t = threshold(arm.role, rec.trials);
    if (arm.role === 'positive') {
      sawPositive = true;
      if (n < t.min) reasons.push(`positive arm "${name}" hit ${n}/${rec.trials} on [${arm.predicate}], needs >=${t.min}`);
    } else {
      sawContrast = true;
      if (n > t.max) reasons.push(`contrast arm "${name}" leaked ${n}/${rec.trials} on [${arm.predicate}], allows <=${t.max}`);
    }
  }
  // A proof that cannot fail proves nothing (ADR-0029).
  if (arms.length && !sawPositive) reasons.push('record has no positive arm');
  if (arms.length && !sawContrast) reasons.push('record has no contrast arm — the proof cannot fail');

  return { ok: reasons.length === 0, reasons };
}

if (status.delivery === 'unproven') {
  if (!/delivery is unproven/i.test(readme)) {
    problems.push('DELIVERY-STATUS says "unproven" but README.md does not carry the disclosure "delivery is unproven"');
  }
  if (status.proofRecord) {
    problems.push(`DELIVERY-STATUS says "unproven" yet names proofRecord "${status.proofRecord}"`);
  }
} else if (status.delivery === 'proven') {
  const rec = status.proofRecord;
  if (!rec) {
    problems.push('DELIVERY-STATUS says "proven" but names no proofRecord');
  } else {
    const path = `scenarios/records/${rec}.json`;
    if (!existsSync(join(ROOT, path))) {
      problems.push(`DELIVERY-STATUS claims proof "${rec}" but ${path} does not exist`);
    } else {
      // A proven release must not still carry the unproven banner. The gate
      // enforced the disclosure's PRESENCE while unproven but never its ABSENCE
      // once proven, so a proven release could ship a README contradicting its own
      // status — the disclosure rule half-applied.
      if (/delivery is unproven/i.test(readme)) {
        problems.push(
          'DELIVERY-STATUS says "proven" but README.md still carries the "delivery is unproven" ' +
            'disclosure — update the README, or the release ships contradicting itself',
        );
      }
      const r = read(path);
      // DERIVED, never read. See verdict() above for why this is not `r.verdict`.
      const v = verdict(r);
      if (!v.ok) {
        for (const reason of v.reasons) problems.push(`${path}: ${reason}`);
      }
      // Version-bound: a release that ships new bytes without re-pinning its proof is
      // claiming evidence it does not have. This is what flips the status back.
      if (r.packageVersion !== pkg.version) {
        problems.push(
          `${path} is pinned to packageVersion "${r.packageVersion}" but this package is ${pkg.version} — re-run the proof and re-pin it`,
        );
      }
    }
  }
} else {
  problems.push(`DELIVERY-STATUS.delivery must be "proven" or "unproven", got ${JSON.stringify(status.delivery)}`);
}

// The manifest ORDER contract: the config resolver must precede the bridge, or an
// install ships session injection with zero kb_* tools and nothing reports it.
const exts = pkg.pi?.extensions ?? [];
const resolver = exts.findIndex((e) => /vfkb-config/.test(e));
const bridge = exts.findIndex((e) => /vfkb-pi-bridge|pi-mcp-bridge/.test(e));
if (bridge < 0) problems.push('package.json pi.extensions lists no MCP bridge');
if (resolver < 0) problems.push('package.json pi.extensions lists no vfkb-config resolver');
if (resolver >= 0 && bridge >= 0 && resolver > bridge) {
  problems.push(
    `pi.extensions lists the resolver (index ${resolver}) AFTER the bridge (index ${bridge}); pi loads extensions in array order and the bridge resolves its config at import, so this ships ZERO kb_* tools, silently`,
  );
}

// Every declared extension must actually be in the tarball.
for (const e of exts) {
  if (!existsSync(join(ROOT, e))) problems.push(`pi.extensions declares "${e}" but that file does not exist`);
}

if (problems.length) {
  console.error('release gate FAILED:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log(`release gate PASSED (delivery: ${status.delivery}, ${exts.length} extensions, order ok)`);
