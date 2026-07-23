# vfkb-pi-package

[ViloForge KnowledgeBase (vfkb)](https://github.com/vilosource/vfkb) for the
[pi coding agent](https://pi.dev) — per-project memory that a pi session runs on
automatically: session-start injection, a per-turn knowledge delta, tool capture,
brain-write gating, and the nine `kb_*` MCP tools.

The pi counterpart of
[vfkb-claude-plugin](https://github.com/vilosource/vfkb-claude-plugin). Same engine,
different harness face (vfkb ADR-0015).

> ## ⚠️ Delivery is unproven
>
> The extensions have been observed working — under `pi -e`, and under a local
> `pi install` where a real agent used `kb_add` to write to the brain while a
> wrapper-less contrast arm wrote nothing. **That is capability, not delivery.**
>
> No `scenarios/records/install-path.json` exists yet: a real `pi install git:` into
> a clean `HOME`, and an upgrade from an older release, have **not** been
> demonstrated. Per vfkb ADR-0051 clause 1, `-e <path>` and a local-path install both
> bypass the resolution this package would really be delivered through, so neither
> can stand in for that proof.
>
> Until that record lands, this notice stays, and so does
> `DELIVERY-STATUS.json: "delivery": "unproven"`.

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
