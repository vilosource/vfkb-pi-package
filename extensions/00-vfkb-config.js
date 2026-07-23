// vfkb pi package — config resolver (vfkb ADR-0066).
//
// WHY THIS FILE EXISTS AT ALL, because it looks like a no-op and is not:
//
// `pi-mcp-bridge` is configured by $VFKB_MCP_CONFIG. pi CANNOT set environment
// variables — its settings schema has no `env` key, there is no dotenv, and an `env`
// block in settings.json is silently ignored (observed live on pi 0.73.1; vfkb brain
// gotcha 0f1441f9bff2). Without this file an install therefore delivers session
// injection and ZERO kb_* tools, with nothing anywhere reporting it — the silent
// partial install vfkb ADR-0051 exists to catch.
//
// ORDER IS LOAD-BEARING. The bridge resolves its config at MODULE TOP LEVEL
// (`const DEFS = await discover()`), not in its default export. pi loads extensions
// sequentially — importing and invoking each before importing the next — so this file
// MUST be listed before the bridge in package.json's `pi.extensions`. Listed after, it
// is indistinguishable at runtime from not shipping it at all. The `00-` prefix is a
// reminder; the manifest ORDER is what actually binds (pi honours manifest array order,
// not alphabetical — verified by reversing it).
//
// Resolution order, first hit wins:
//   1. $VFKB_MCP_CONFIG           — already set (the L4 harness, or a power user)
//   2. <repo>/.vfkb/mcp.json      — an explicit consumer override, if they wrote one
//   3. this package's own bundle  — the normal case: zero config, no env var needed

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Walk up for the brain. pi may be started from a subdirectory, so anchoring on cwd
// alone would silently miss it and hand the agent an empty, wrong-place brain.
function findBrain(from) {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, '.vfkb');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export default function (pi) {
  const brain = findBrain(process.cwd());
  if (!brain) return; // not a vfkb project — leave the bridge inert, correctly

  // THE TWO EXTENSIONS MUST AGREE ON THE BRAIN, and they resolve it by different means.
  // The bridge's server gets its brain from the spec below; the injection/capture
  // extension (vfkb-pi.mjs) runs IN-PROCESS and calls storage.ts's brainDir(), which
  // reads $VFKB_DATA_DIR and otherwise falls back to ~/.vfkb. Setting only the bridge's
  // config therefore produced a SPLIT BRAIN: kb_* wrote <repo>/.vfkb while session
  // injection and Tier-B capture read ~/.vfkb — an empty knowledge map for a repo full
  // of knowledge, and capture cross-contaminating every project, with nothing erroring.
  //
  // Every earlier pi proof masked this because the L4 image sets VFKB_DIR externally
  // (scenarios/docker/pi.Dockerfile). It appeared the first time the two extensions were
  // co-loaded on a real install — exactly the failure ADR-0066 §4 predicted.
  //
  // `??=` so an explicit outer VFKB_DATA_DIR always wins (the harness, a power user).
  process.env.VFKB_DATA_DIR ??= brain;

  if (process.env.VFKB_MCP_CONFIG) return; // (1) respect an explicit setting

  const override = join(brain, 'mcp.json');
  if (existsSync(override)) {
    process.env.VFKB_MCP_CONFIG = override; // (2) consumer override
    return;
  }

  // (3) Point the bridge at the MCP server vendored INSIDE this package. This is what
  // makes `pi install` self-sufficient: no $VFKB_BUNDLE_DIR, no consumer file.
  const server = join(HERE, '..', 'bundles', 'vfkb-mcp.mjs');
  if (!existsSync(server)) {
    // A partial/corrupt install. Staying silent here would BE the silent partial install
    // this file exists to prevent: pi would start, injection would work, and the agent
    // would simply have no kb_* tools — exit 0, no error, capability absent, which is
    // the quiet-success shape vfkb ADR-0051 clause 3 forbids. The bridge itself already
    // warns on a failed connect, so a warning here is the consistent behaviour.
    process.stderr.write(
      `vfkb: MCP server missing at ${server} — the kb_* tools will NOT be available. ` +
        'Reinstall the package (`pi install git:github.com/vilosource/vfkb-pi-package`).\n',
    );
    return;
  }

  // The bridge takes a PATH, so the synthesized config has to live on disk. It goes to a
  // temp dir rather than the repo — derived state, not wiring to commit.
  //
  // The path is DETERMINISTIC (a hash of brain + server), not mkdtemp: one directory per
  // project that is rewritten rather than accumulated. mkdtemp leaked a new directory on
  // every pi start, growing without bound. Rewriting is safe under concurrent sessions
  // because the content is a pure function of the same two inputs.
  const cfg = {
    mcpServers: {
      vfkb: {
        command: process.execPath,
        args: [server],
        env: { VFKB_DATA_DIR: brain, VFKB_PROJECT: process.env.VFKB_PROJECT || '' },
      },
    },
  };
  const key = createHash('sha256').update(brain).update('\0').update(server).digest('hex').slice(0, 16);
  const dir = join(tmpdir(), `vfkb-pi-${key}`);
  const path = join(dir, 'mcp.json');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(cfg, null, 2));
  } catch (e) {
    // Unwritable temp dir: say so rather than leave the bridge mysteriously toolless.
    process.stderr.write(`vfkb: could not write the MCP config at ${path} (${e.message}) — kb_* tools unavailable.\n`);
    return;
  }
  process.env.VFKB_MCP_CONFIG = path;
}
