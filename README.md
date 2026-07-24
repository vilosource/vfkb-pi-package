# vfkb-pi-package

[ViloForge KnowledgeBase (vfkb)](https://github.com/vilosource/vfkb) for the
[pi coding agent](https://pi.dev) — per-project memory that a pi session runs on
automatically: session-start injection, a per-turn knowledge delta, tool capture,
brain-write gating, and the nine `kb_*` MCP tools.

The pi counterpart of
[vfkb-claude-plugin](https://github.com/vilosource/vfkb-claude-plugin). Same engine,
different harness face (vfkb ADR-0015).

> ## ✅ Delivery is proven (2026-07-24, v0.1.0)
>
> `scenarios/install-path.mjs` DEMONSTRATED it **3/3**. A real `deepseek-v4-pro` agent
> installed this package through `pi install git:` into a clean `HOME` and used `kb_add`
> to write to the project brain; the **upgrade** arm observed the capability ABSENT on a
> pre-capability baseline and PRESENT after remove+reinstall; the **can-fail contrast**
> arm — `vfkb init`'s AGENTS.md cold floor with the package absent — wrote nothing 3/3.
>
> The committed `scenarios/records/install-path.json` is what flips
> `DELIVERY-STATUS.json` to `proven`, and the gate **derives** that by recomputing the
> verdict from per-trial observations — it never reads a verdict field.
>
> **Scope, stated rather than implied.** The upgrade arm proves a **remove+reinstall**
> delivers the new capability. It does **not** claim `pi update` would: pi clones to a
> path keyed by repo, not ref, so neither `pi install <other-ref>` nor `pi update` moves
> an existing clone — both print success and change nothing. If you pin a ref, you are
> pinned until you `pi remove` first. The upgrade baseline is a real tree exercised
> through the real install path, but its provenance is **constructed** (this package has
> never shipped a prior release), and the record says so.
>
> Staying proven is per-release work: the record is version-bound, so a release that
> ships without re-running the proof reverts the gate to `unproven`.

## Install

```bash
pi install git:github.com/vilosource/vfkb-pi-package -l
```

`-l` writes to the project's `.pi/settings.json`, which is team-shareable — pi
auto-installs missing packages at startup, so a teammate's clone wires itself.
`vfkb init` (in the vfkb repo) writes that entry for you.

The package is **self-sufficient**: it vendors its own engine bundles, so there is
no `$VFKB_BUNDLE_DIR` to set and no config file to write.

## What it loads, and why the order is not cosmetic

`package.json`'s `pi.extensions` lists three entries **in a load-bearing order**:

| # | file | role |
|---|------|------|
| 1 | `extensions/00-vfkb-config.js` | points the bridge at an MCP server |
| 2 | `bundles/vfkb-pi.mjs` | injection, capture, brain-write gating |
| 3 | `bundles/vfkb-pi-bridge.mjs` | registers the nine `kb_*` tools |

**(1) must precede (3).** The bridge reads `$VFKB_MCP_CONFIG` at *module top level*,
and pi cannot set environment variables — its settings schema has no `env` key, and an
`env` block there is silently ignored (observed on pi 0.73.1). pi loads extensions
sequentially, so `00-vfkb-config.js` sets the variable in time; listed after the
bridge it is indistinguishable from not shipping it at all, and you get session
injection with **zero tools and no error**.

`vfkb doctor` checks this ordering.

### Config resolution

First hit wins:

1. `$VFKB_MCP_CONFIG` — already set (a harness, or a power user)
2. `<repo>/.vfkb/mcp.json` — an optional consumer override
3. this package's own `bundles/vfkb-mcp.mjs` — the normal case, zero config

## Requirements

- pi `0.73.1` (the version the contract was verified against)
- Node 20+
- A vfkb project — i.e. a `.vfkb/` directory, found by walking up from the cwd

## License

MIT
