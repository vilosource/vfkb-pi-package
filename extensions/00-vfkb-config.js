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

import { existsSync, openSync, writeSync, closeSync, fchmodSync, constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  // An explicit outer setting ALWAYS wins, and both spellings count: storage.ts resolves
  // `VFKB_DATA_DIR || VFKB_DIR || ~/.vfkb`, so honouring only the canonical name silently
  // discarded a user's (ADR-0032-supported) VFKB_DIR — and would have silently bypassed
  // the L4 image's own `ENV VFKB_DIR=/brain`, invalidating the very proof this package
  // needs. Discovery is the FALLBACK, never an override.
  const brain = process.env.VFKB_DATA_DIR || process.env.VFKB_DIR || findBrain(process.cwd());
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
  // `brain` already accounts for an outer setting, so this is an assignment, not an
  // override — and the MCP spec below MUST be built from this same value. Building the
  // spec from a separately-derived path is how the split brain survived its first fix:
  // the in-process face used the outer env while the MCP face used the discovered dir.
  process.env.VFKB_DATA_DIR = brain;

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

  // The bridge takes a PATH, so the synthesized config must live on disk — and WHERE
  // matters more than it looks, because pi SPAWNS `command`+`args` out of this file.
  //
  // It lived in /tmp under two designs, both wrong. `mkdtempSync` leaked a directory per
  // pi start. Replacing it with a deterministic `/tmp/vfkb-pi-<sha>` fixed the leak and
  // introduced a worse bug: the path became PREDICTABLE, and neither defence held —
  // `mkdirSync({mode:0o700})` does NOT chmod a directory that already exists (verified),
  // and `writeFileSync` follows a planted symlink. On a shared /tmp an attacker who can
  // guess the repo path pre-creates the directory world-writable, then rewrites
  // mcp.json's `command` — arbitrary code execution as the victim.
  //
  // So it goes in the BRAIN DIR: already user-owned, already present, already gitignored
  // below, and not in a world-writable namespace. Dot-prefixed as derived state.
  const cfg = {
    mcpServers: {
      vfkb: {
        command: process.execPath,
        args: [server],
        // Same `brain` the in-process face was just pointed at — see above.
        env: { VFKB_DATA_DIR: brain, VFKB_PROJECT: process.env.VFKB_PROJECT || '' },
      },
    },
  };
  // O_NOFOLLOW + an explicit fchmod, NOT writeFileSync(path, …, {mode}).
  //
  // `{mode}` applies only when the file is CREATED, and the write follows a symlink —
  // the identical semantics that made the previous /tmp design exploitable. The residual
  // risk here is much lower (the brain dir is user-owned, not a shared namespace), but
  // this file's `command`/`args` are SPAWNED BY pi, so it is worth closing properly on a
  // group-writable checkout: O_NOFOLLOW makes open fail rather than traverse a planted
  // symlink, and fchmod pins 0600 on a pre-existing file instead of trusting creation.
  const path = join(brain, '.pi-mcp.json');
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    writeSync(fd, JSON.stringify(cfg, null, 2));
  } catch (e) {
    // ELOOP = the path is a symlink; anything else = unwritable. Either way, say so
    // rather than leave the bridge mysteriously toolless.
    process.stderr.write(`vfkb: could not write the MCP config at ${path} (${e.message}) — kb_* tools unavailable.\n`);
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  process.env.VFKB_MCP_CONFIG = path;
}
