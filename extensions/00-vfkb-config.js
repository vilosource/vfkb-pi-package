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

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  if (process.env.VFKB_MCP_CONFIG) return; // (1) respect an explicit setting

  const brain = findBrain(process.cwd());
  if (!brain) return; // not a vfkb project — leave the bridge inert, correctly

  const override = join(brain, 'mcp.json');
  if (existsSync(override)) {
    process.env.VFKB_MCP_CONFIG = override; // (2) consumer override
    return;
  }

  // (3) Point the bridge at the MCP server vendored INSIDE this package. This is what
  // makes `pi install` self-sufficient: no $VFKB_BUNDLE_DIR, no consumer file.
  const server = join(HERE, '..', 'bundles', 'vfkb-mcp.mjs');
  if (!existsSync(server)) return; // a broken/partial install: stay silent, break nothing

  // The bridge takes a PATH, so the synthesized config has to live on disk. A temp file
  // keeps it out of the consumer's repo — it is derived state, not wiring to commit.
  const cfg = {
    mcpServers: {
      vfkb: {
        command: process.execPath,
        args: [server],
        env: { VFKB_DATA_DIR: brain, VFKB_PROJECT: process.env.VFKB_PROJECT || '' },
      },
    },
  };
  const dir = mkdtempSync(join(tmpdir(), 'vfkb-pi-'));
  const path = join(dir, 'mcp.json');
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  process.env.VFKB_MCP_CONFIG = path;
}
