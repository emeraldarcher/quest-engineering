# Tiled reference maps

These maps are authoring aids. The archipelago fixtures are available only to
architecture tests and explicitly requested development fixture worlds; normal
runtime never uses them as production Project art.

- `town-reference-v0.14b.tmj` preserves the previous coding-agent-authored town.
  Use it to inspect or recover runtime markers and old pipeline wiring. Its
  `town-reference-v0.14b.tsj` object collection is also reference-only.
- `sunnyside-construction-reference.tmj` contains small Sunnyside construction
  examples. Use it to learn/copy terrain, building pieces, props, and clusters;
  it shares the reference-only object collection.
- `project-island-fixture.tmj` and `project-expansion-fixture.tmj` prove
  region-local rendering, crew semantics, deterministic instancing, sockets,
  and route composition. They are not production island designs.
- `sunnyside-example-world.tmj` is the full artist-authored Sunnyside World v2.1
  GameMaker `Room1` import. Regenerate it with `bun run --cwd client
  import:sunnyside-example`; its tile mapping is recorded beside it.

The production Home map is `../town.tmj`, and the production reusable Project
template is `../project-island.tmj`. Reference maps and their supporting object
collection set `questEngineeringReference`.
