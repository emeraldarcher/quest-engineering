# Tiled reference maps

These maps are authoring aids and are never loaded by Quest Engineering.

- `town-reference-v0.14b.tmj` preserves the previous coding-agent-authored town.
  Use it to inspect or recover runtime markers and old pipeline wiring. Its
  `town-reference-v0.14b.tsj` object collection is also reference-only.
- `sunnyside-construction-reference.tmj` contains small Sunnyside construction
  examples. Use it to learn/copy terrain, building pieces, props, and clusters;
  it shares the reference-only object collection.
- `sunnyside-example-world.tmj` is the full artist-authored Sunnyside World v2.1
  GameMaker `Room1` import. Regenerate it with `bun run --cwd client
  import:sunnyside-example`; its tile mapping is recorded beside it.

The production map is `../town.tmj`. Reference maps and their supporting
object collection set `questEngineeringReference`; runtime code never loads
them.
