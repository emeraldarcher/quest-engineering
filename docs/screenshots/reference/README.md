# Sunnyside example import proof

`sunnyside-example-world-side-by-side.png` compares the left Tiled conversion to
Sunnyside World Asset Pack v2.1's bundled `Sunnyside_World_ExampleScene.png` on
the right. It is generated with:

```sh
bun run --cwd client import:sunnyside-example
bun run --cwd client screenshots:sunnyside-example
```

The conversion resolves the GameMaker room's saved tiles. Animated asset-layer
sprites use their saved representative frame, so smoke, animals, glints, and
other animation frames may differ from the bundled render.
