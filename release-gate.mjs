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
      const r = read(path);
      if (r.verdict !== 'DEMONSTRATED') {
        problems.push(`${path} verdict is "${r.verdict}", not DEMONSTRATED`);
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
