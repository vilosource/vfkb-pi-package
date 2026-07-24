#!/usr/bin/env node
// ============================================================================
// install-path — the DELIVERY proof for the vfkb pi package (vfkb ADR-0066 D4,
// ADR-0051). Answers the only question that matters at publish: can a consumer
// INSTALL this package through the real path and get a working capability?
// ----------------------------------------------------------------------------
// THREE ARMS, exactly as ratified in ADR-0066 D4:
//
//   fresh    (positive) — `pi install git:<repo>@main` into a clean HOME; a real
//                         agent must use kb_add and the write must land.
//   upgrade  (positive) — install the pre-capability baseline (resolver removed →
//                         zero kb_* tools), observe the capability ABSENT, then
//                         REMOVE + REINSTALL from main and observe it PRESENT.
//                         WHAT THIS ARM DOES AND DOES NOT CLAIM: it proves a
//                         remove+reinstall delivers the new capability. It does
//                         NOT claim `pi update` would — that is demonstrably
//                         FALSE on pi 0.73.1 and was found by this arm going MISS
//                         on its first run (brain gotcha 7bbdf89f39f7): pi clones
//                         to a path keyed by REPO not ref, so neither
//                         `pi install <other-ref>` nor `pi update` moves an
//                         existing clone off the branch it was first cloned at.
//                         Both print success. Only remove (which deletes the
//                         clone dir) then install re-resolves.
//   contrast (contrast) — the can-fail arm, and deliberately NOT "nothing":
//                         `vfkb init` writes AGENTS.md and pi genuinely loads it
//                         (resource-loader.js:31 reads AGENTS.md/CLAUDE.md), so
//                         vfkb must be shown to beat its own COLD FLOOR, not to
//                         beat an empty repo.
//
// THE PREDICATE DESIGN IS LOAD-BEARING. Three constraints, each learned by an
// earlier contrast arm REFUSING TO FAIL (vfkb brain gotcha 04099d65ed41):
//
//   1. WRITE-SHAPED, not read-shaped. The package ships TWO extensions and they
//      fail independently: injection still works with zero tools, so any
//      "can the agent answer?" predicate is satisfied by injection alone and
//      passes with the bridge dead. Only a WRITE proves the tools live.
//   2. STRUCTURAL, not substring. Tier-B capture records the ATTEMPTED tool input,
//      so the sentinel string appears in the brain even when the write never
//      happened. Every line is parsed and the entry's text must EQUAL the
//      sentinel.
//   3. RESTRICTED TOOLSET. Given exec/file tools the agent simply hand-writes
//      JSONL into the brain (vfkb issue #151) and the contrast arm passes. But
//      over-restricting kills the positive arm, because pi's --tools is a
//      by-name allowlist and the MCP tools are named mcp__vfkb__kb_*. The one
//      configuration that discriminates is read + the kb_* pair.
//
// Every arm that has vfkb installed loads BOTH extensions (resolver + bridge) —
// the configuration a real install produces, which no earlier pi proof covered.
//
// Env: DEEPSEEK_TOKEN (required). VFKB_IP_TRIALS (default 3).
// ============================================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;

const TRIALS = Math.max(1, parseInt(process.env.VFKB_IP_TRIALS || '3', 10));
const MODEL = process.env.VFKB_IP_MODEL || 'deepseek-v4-pro';
const PROVIDER = process.env.VFKB_IP_PROVIDER || 'deepseek';
const TIMEOUT = parseInt(process.env.VFKB_IP_TIMEOUT || '300000', 10);
const SETUP_TIMEOUT = parseInt(process.env.VFKB_IP_SETUP_TIMEOUT || '300000', 10);

const SOURCE = 'git:github.com/vilosource/vfkb-pi-package';
const BASELINE_REF = `${SOURCE}@baseline/pre-capability`;
const VFKB_CLI = process.env.VFKB_CLI || join(REPO, '..', 'vfkb', 'dist', 'cli.js');
// read + the kb_* pair: exec/file tools would let the agent route around a dead
// bridge; omitting the kb_* names would disable the very capability under test.
const TOOLS = 'read,mcp__vfkb__kb_add,mcp__vfkb__kb_search';

// --- preconditions, before anything metered runs ----------------------------
if (!process.env.DEEPSEEK_TOKEN) {
  console.error(
    'DEEPSEEK_TOKEN is not set — the pi arm cannot authenticate.\n' +
      'Refusing to run: an empty token yields a model auth error that would be scored as\n' +
      'a scenario result, reporting a verdict for a run in which no agent executed.',
  );
  process.exit(2);
}
if (!existsSync(VFKB_CLI)) {
  console.error(`vfkb CLI not found at ${VFKB_CLI} — set $VFKB_CLI (needs \`npm run build\` in vfkb)`);
  process.exit(2);
}
const HOST_MODELS = join(homedir(), '.pi', 'agent', 'models.json');
if (!existsSync(HOST_MODELS)) {
  console.error(`no ${HOST_MODELS} — the sandbox HOME needs a provider config to copy`);
  process.exit(2);
}

const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', timeout: TIMEOUT, ...opts });

/** A sandbox: isolated HOME with the deepseek provider, plus a vfkb-init'ed project. */
function sandbox(tag) {
  const home = mkdtempSync(join(tmpdir(), `vfkb-ip-home-${tag}-`));
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  writeFileSync(join(home, '.pi', 'agent', 'models.json'), readFileSync(HOST_MODELS));

  const proj = mkdtempSync(join(tmpdir(), `vfkb-ip-proj-${tag}-`));
  execFileSync('git', ['init', '-q'], { cwd: proj });
  execFileSync('git', ['config', 'user.email', 'l4@vfkb'], { cwd: proj });
  execFileSync('git', ['config', 'user.name', 'l4'], { cwd: proj });
  // `vfkb init` writes the brain AND AGENTS.md — the cold floor the contrast arm
  // must beat — AND .pi/settings.json declaring the package.
  execFileSync('node', [VFKB_CLI, 'init', 'l4demo'], { cwd: proj, stdio: 'ignore' });
  return { home, proj, brain: join(proj, '.vfkb', 'entries.jsonl') };
}

/** Point .pi/settings.json at a specific ref, or remove the package entirely. */
function setPackage(proj, source) {
  const p = join(proj, '.pi', 'settings.json');
  const j = JSON.parse(readFileSync(p, 'utf8'));
  j.packages = source ? [source] : [];
  writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
}

/** Remove a package — deletes the clone dir, which is what allows a ref change. */
function remove(home, proj, source) {
  return sh('pi', ['remove', source, '-l'], { cwd: proj, env: { ...process.env, HOME: home }, timeout: SETUP_TIMEOUT });
}

/** Install the declared package into the sandbox HOME (pi also auto-installs at startup). */
function install(home, proj, source) {
  return sh('pi', ['install', source, '-l'], { cwd: proj, env: { ...process.env, HOME: home }, timeout: SETUP_TIMEOUT });
}

/**
 * STRUCTURAL predicate. Parse every JSONL line; require an entry whose text EQUALS
 * the sentinel. A substring search over the file matches Tier-B capture's record of
 * the ATTEMPTED input and scores a write that never happened.
 */
function sentinelWritten(brain, sentinel) {
  if (!existsSync(brain)) return false;
  for (const line of readFileSync(brain, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (typeof e.text === 'string' && e.text.trim() === sentinel) return true;
  }
  return false;
}

/** Run one agent turn asking for a WRITE. Returns {bridged, wrote, out}. */
function askToWrite(home, proj, brain, sentinel) {
  const r = sh(
    'pi',
    ['-p', '--no-session', '--provider', PROVIDER, '--model', MODEL, '--tools', TOOLS,
     `Use the kb_add tool to store a fact whose text is exactly: ${sentinel} . Then reply done.`],
    { cwd: proj, env: { ...process.env, HOME: home } },
  );
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return {
    bridged: /vfkb-pi-bridge: bridged 'vfkb' \(\d+ tools\)/.test(out),
    wrote: sentinelWritten(brain, sentinel),
    out,
  };
}

const trim = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 110);
const arms = {
  fresh: { role: 'positive', predicate: ['toolsBridged', 'sentinelWritten'], trials: [] },
  upgrade: { role: 'positive', predicate: ['absentBefore', 'presentAfter'], trials: [] },
  contrast: { role: 'contrast', predicate: ['sentinelWritten'], trials: [] },
};

console.log(`vfkb-pi-package install-path L4  (model=${MODEL}, trials=${TRIALS}, v${PKG_VERSION})`);
console.log(`source = ${SOURCE}   baseline = ${BASELINE_REF}`);
console.log('predicate: WRITE-shaped + STRUCTURAL (text equality) + restricted toolset\n');

for (let i = 1; i <= TRIALS; i++) {
  // ---- fresh -------------------------------------------------------------
  {
    const { home, proj, brain } = sandbox(`fresh${i}`);
    try {
      const sentinel = `VFKB-IP-FRESH-${i}-${PKG_VERSION.replace(/\./g, '')}`;
      setPackage(proj, SOURCE);
      install(home, proj, SOURCE);
      const r = askToWrite(home, proj, brain, sentinel);
      arms.fresh.trials.push({ toolsBridged: r.bridged, sentinelWritten: r.wrote, out: trim(r.out) });
      console.log(`  trial ${i}  fresh    … ${r.bridged && r.wrote ? 'HIT ' : 'MISS'}  bridged=${r.bridged} wrote=${r.wrote}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  }

  // ---- upgrade -----------------------------------------------------------
  {
    const { home, proj, brain } = sandbox(`upg${i}`);
    try {
      const before = `VFKB-IP-BEFORE-${i}-${PKG_VERSION.replace(/\./g, '')}`;
      const after = `VFKB-IP-AFTER-${i}-${PKG_VERSION.replace(/\./g, '')}`;
      // BEFORE: the constructed pre-capability baseline — resolver removed, so the
      // bridge has no config and registers zero kb_* tools.
      setPackage(proj, BASELINE_REF);
      install(home, proj, BASELINE_REF);
      const b = askToWrite(home, proj, brain, before);
      // AFTER: re-resolve to main through the same real install path.
      // REMOVE first — the only mechanism that re-resolves (gotcha 7bbdf89f39f7).
      // `pi install <main>` or `pi update` here would print success and change
      // nothing, and the arm would report a false MISS while pi reported "Updated".
      remove(home, proj, SOURCE);
      setPackage(proj, SOURCE);
      install(home, proj, SOURCE);
      const a = askToWrite(home, proj, brain, after);
      arms.upgrade.trials.push({ absentBefore: !b.wrote, presentAfter: a.wrote, out: trim(a.out) });
      console.log(`  trial ${i}  upgrade  … ${!b.wrote && a.wrote ? 'HIT ' : 'MISS'}  absentBefore=${!b.wrote} presentAfter=${a.wrote}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  }

  // ---- contrast: AGENTS.md cold floor, package NOT installed --------------
  {
    const { home, proj, brain } = sandbox(`ctr${i}`);
    try {
      const sentinel = `VFKB-IP-CONTRAST-${i}-${PKG_VERSION.replace(/\./g, '')}`;
      setPackage(proj, null); // vfkb init's AGENTS.md remains — the cold floor
      const r = askToWrite(home, proj, brain, sentinel);
      arms.contrast.trials.push({ sentinelWritten: r.wrote, out: trim(r.out) });
      console.log(`  trial ${i}  contrast … ${r.wrote ? 'LEAK' : 'clean'}  wrote=${r.wrote}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  }
}

const record = {
  scenario: 'install-path',
  recordVersion: 2,
  packageVersion: PKG_VERSION,
  outerModel: MODEL,
  trials: TRIALS,
  generated: new Date().toISOString(),
  source: SOURCE,
  upgradeFrom: BASELINE_REF,
  // Stated in the record, not only in a commit message: the baseline is a real tree
  // exercised through the real install path, but the package has never shipped a
  // release, so its provenance is constructed rather than historical.
  upgradeBaselineIsConstructed: true,
  // Scoped claim: this arm proves REMOVE+REINSTALL delivers the new capability.
  // `pi update` demonstrably does NOT re-resolve a ref (gotcha 7bbdf89f39f7).
  upgradeMechanism: 'pi remove + pi install (pi update does not re-resolve a ref)',
  toolset: TOOLS,
  arms,
};
mkdirSync(join(REPO, 'scenarios', 'records'), { recursive: true });
writeFileSync(join(REPO, 'scenarios', 'records', 'install-path.json'), JSON.stringify(record, null, 2) + '\n');
console.log(`\nrecord → scenarios/records/install-path.json (packageVersion=${PKG_VERSION})`);
console.log('verdict is recomputed by release-gate.mjs from these observations — not asserted here.');
