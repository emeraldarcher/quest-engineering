# Sunnyside runtime assets

Minimal original PNG subset shared by the v0.14b visual spike, Tiled authoring
project, and authored-town runtime. Runtime provenance and frame metadata live
in `client/src/world/runtime/sunnyside-assets.ts`; Tiled references these same
canonical files without duplication.

Human v1 runtime sheets are deterministically generated from the repository
Aseprite source with:

```sh
ASEPRITE_BIN="/path/to/aseprite" bun run --cwd client export:sunnyside-human-v1
bun run --cwd client validate:sunnyside-human-v1
```

The runtime loads only generated PNG compositing layers and JSON metadata; it
does not load the `.aseprite` source or depend on a local Steam path. See
[`SOURCE.md`](SOURCE.md) and [`LICENSE-SUMMARY.md`](LICENSE-SUMMARY.md).
