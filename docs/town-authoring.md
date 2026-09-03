# Design your Quest Engineering town in Tiled

The production town starts as a blank grass scaffold. Tiled owns the visual
layout; Quest Engineering owns factual Members, work, interaction behavior, and
Product windows.

You do not need to edit TypeScript or JSON to move the town.

# Browsing the Sunnyside library

The complete imported Sunnyside vocabulary is an **authoring library**, not a
promise that every image is loaded by Quest Engineering. Open these generated,
non-production maps in separate Tiled tabs:

```text
client/src/world/maps/reference/sunnyside-asset-catalog.tmj
client/src/world/maps/reference/sunnyside-character-catalog.tmj
```

The asset catalog has predictable labeled grids for Buildings, Furniture,
Workshop, Nature (including crops), Animals, Effects, Props, and UI. The
character catalog contains every legacy Human action and compositing layer,
alongside Goblin and Skeleton strips. Select a tile object, copy it with `⌘C`,
switch to `town.tmj`, select an appropriate **object layer**, and paste with
`⌘V`. The source filename remains in the tile's `source` property when you need
to find it again.

The Tilesets panel is the placement palette; the catalog map is the visual
index. The generated collection tilesets are named `Sunnyside — Animals`,
`Buildings`, `Furniture`, `Workshop`, `Nature`, `Props`, `Effects`, `Characters`,
and `Ui`. The existing `sunnyside-world` and `sunnyside-forest` sheets are the
terrain palettes. Tiled shows tilesets attached to the map currently open, so
keep a catalog tab open while browsing rather than attaching thousands of
unused tilesets to production `town.tmj`.

- **Buildings:** use `sunnyside-world` for tile-built walls, roofs, doors, and
  paths; inspect the Buildings catalog for freestanding well/chimney/windmill
  pieces.
- **Animals and effects:** inspect their catalog grids and their `animated`
  property. PNG strips are browseable/placeable source art; the normalized
  runtime metadata lives in `client/src/world/sunnyside-animation-manifest.ts`.
- **UI:** the UI collection includes frames, nine-slice pieces, cursors, arrows,
  buttons, bars, tools, emotes, and indicators. It is available for future UI
  work; it does not restyle the app today.
- **Characters:** the legacy Human base, six hair styles, tools, and all action
  strips are present. The newer Human v1.0 Aseprite master is retained under
  `client/src/assets/sunnyside/source/human-v1.0/`. No compatible CLI was
  available during import, so its directional PNG export is deliberately still
  pending rather than fabricated.

## Tile painting versus object placement

Use **tile layers** and the Stamp/Terrain brush for terrain, paths, water,
building surfaces, walls, roofs, and other grid-aligned construction. Use a
**tile object on an object layer** for barrels, tables, animals, windmills,
signs, trees, special props, and other freestanding art. This distinction makes
it easier to move a prop later without repainting nearby terrain.

The importer is safe to run again; it owns only
`assets/sunnyside/imported/`, `assets/sunnyside/source/human-v1.0/`, generated
collection `.tsj` files, generated catalog maps, and its manifests. It never
deletes `assets/sunnyside/custom/` or edits `town.tmj`.

```sh
bun run --cwd client import:sunnyside-assets
bun run --cwd client validate:sunnyside-assets
# Once you have installed/configured Aseprite or LibreSprite yourself:
ASEPRITE_BIN=/path/to/aseprite bun run --cwd client export:sunnyside-human-v1
# Conventional macOS Aseprite app executable:
ASEPRITE_BIN=/Applications/Aseprite.app/Contents/MacOS/aseprite bun run --cwd client export:sunnyside-human-v1
```

# Adding crew movement to the town

Crew markers describe presentation only. They do not schedule Members, change a
Tactic, or delay Runtime work. A visible crew Member always comes from a Step
whose current projection has `state = running` and a named Member.

The production map remains valid in legacy compatibility mode until all three
crew object layers are added. Add the three layers together when you are ready:

1. In the **Layers** panel, create/select the object layer **Crew Entrances**.
2. Use **Insert Point**, set the object type to `crew_spawn`, and place it at the
   existing visual entrance where active crew should enter. Give it a unique,
   stable name such as `crew-entrance-main`. Add more entrances if desired;
   there is no fixed count.
3. Create/select the object layer **Crew Navigation**. Use **Insert Polyline**
   and draw `crew_route` objects along paths that are visibly safe to walk.
   Add a vertex at turns and junctions. Route vertices connect only when they
   coincide within **1 authored world pixel**; lines that merely look nearby do
   not connect. Give every route a unique stable name.
4. Create/select the object layer **Crew Activity Zones**. Place a point or draw
   a rectangle over an existing work scene, set its type to `crew_activity`,
   and set `qeActivity` to one of:
   `general`, `crafting`, `research`, `mining`, `woodcutting`, or `digging`.
5. Add at least one `general` activity destination. It is the truthful fallback
   for custom or unmatched Steps. Specialized destinations are optional and
   should exist only where the visible scene supports them.
6. Ensure every entrance and activity point/rectangle comes within **8 authored
   world pixels** of the connected route network. Routes themselves must form
   one connected network.
7. Save and run:

   ```sh
   bun run --cwd client validate:town
   ```

8. Start the development client with `?debugMap=1`. The overlay shows crew
   entrances, route polylines, activity areas, graph status, and normalized
   active crew facts. Legacy workstations and Member homes are labeled as
   legacy metadata.

Do not edit TypeScript coordinates. To add a Mine, first author or identify the
mine scene, then add a `crew_activity` point/rectangle over it with
`qeActivity = mining` and connect that area to a `crew_route`.

The object defaults are tracked in
`client/src/world/maps/object-types.json`. A complete non-production example is
`client/src/world/maps/reference/crew-authoring-fixture.tmj`.

Members no longer require individual `member_home` points, and old
`workstation` counts do not set active-crew capacity. Existing markers may stay
in a legacy map until the human author chooses to remove or repurpose them.

# Your first five minutes

1. Install Tiled from <https://www.mapeditor.org/>. On macOS you may instead run
   `brew install --cask tiled`. Tiled 1.12.2 was detected and used to verify all
   three tracked maps during this task.
2. Open:
   `client/src/world/maps/quest-engineering.tiled-project`
3. In Tiled, open `town.tmj`.
4. In the **Layers** panel, click `Ground Detail`, `Paths`, or another tile
   layer.
5. In the **Tilesets** panel, select a tile or choose a Terrain/Wang brush.
6. Paint on the map.
7. Save with **File → Save** or `⌘S`.
8. Refresh Quest Engineering if Vite does not reload automatically.

Tiled is a development tool only. Quest Engineering has no runtime dependency
on it, and this task installed no system software.

## What you see in `town.tmj`

The production map intentionally contains only:

- plain grass;
- a yellow `functional-town-bounds` design region;
- a right-edge **AUTHORING MARKERS** staging area; and
- editor-only instructions on `Authoring Notes`.

There are no roads, buildings, ponds, fences, districts, decorative trees, or
finished yards. You create those visually.

The staging markers keep the application valid before the town is designed.
Drag them into each district as you build it. Their colors and notes exist only
inside Tiled; normal Quest Engineering rendering does not show marker boxes or
names.

# Tiled basics

## The three parts of the editor

- **Map canvas:** the large area where you paint tiles and move objects.
- **Layers panel:** controls what you are editing and what appears above or
  below other art.
- **Tilesets panel:** shows Sunnyside tiles and named terrain brushes.

If an action seems to do nothing, first check that the intended layer is
selected and unlocked.

## Painting and erasing tiles

1. Select a tile layer such as `Paths`.
2. Select the **Stamp Brush** (`B`) or a Terrain/Wang brush.
3. Click or drag on the map.
4. Use the eraser (`E`) to remove tiles from the selected layer.
5. Use `⌘Z` and `⇧⌘Z` for undo and redo.

Never paint runtime objects onto tile layers. Tiles are visual art; colored
points and rectangles live on object layers.

## Selecting and moving objects

Choose the **Insert/Select Objects** tool, click an object, and drag it.
The object's stable name appears in Tiled's Properties panel.

Normally:

### Move only

- blue `location` points;
- yellow `camera_anchor` points;
- orange `workstation` points;
- purple `member_home` points;
- red `status_anchor` points.

### Move and resize

- green `interaction_region` rectangles or polygons;
- cyan `ambient_zone` rectangles;
- gray `reserved_site` rectangles;
- yellow `functional-town-bounds`.

### Edit points or shape

- light-blue `animal_route` polylines;
- polygon interaction regions.

Avoid renaming objects or changing `qeLocation`. Those values connect the map
to application behavior. If you accidentally delete plumbing, undo it or copy
the matching object from the old-town reference map.

## Showing and hiding object layers

Use the eye icon beside a layer to hide categories while painting. A useful
beginner workflow is:

1. hide all colored object layers;
2. paint one district;
3. show `Locations`, `Interaction Regions`, and `Camera Anchors`;
4. drag that district's three matching objects into place;
5. hide the marker layers again.

`Authoring Notes` never renders in Quest Engineering.

# Tiles and terrain brushes

The project already configures tile size, image paths, spacing, and external
JSON tilesets. Do not re-import the PNGs.

| Tileset | Use |
|---|---|
| `sunnyside-world` | grass, paths, river/water, walls, roofs, fences, building pieces |
| `sunnyside-forest` | 32px forest terrain |
| `sunnyside-objects` | freestanding facades, props, and trees |

Named Terrain/Wang sets are ready for:

- `Land`;
- `Path 01`, `Path 02`, and `Path 03`;
- `River`;
- `Building 01` and `Building 02`;
- `Inner Walls`; and
- `Forest`.

A Terrain/Wang brush chooses the saved corners and edges while you paint. The
resolved tiles are saved directly in `town.tmj`; Quest Engineering does not run
a procedural autotiler.

# Layer order

## Tile and visual-object layers

Bottom to top:

1. `Ground`
2. `Ground Detail`
3. `Water`
4. `Paths`
5. `Building Base`
6. `Building Walls`
7. `Building Roofs`
8. `Building Detail`
9. `Fences`
10. `Props Below Members`
11. `Static Objects Below Members`
12. `Foreground Canopy`

`Ground` already contains the grass fill. Paint editable building pieces on the
four Building layers. Put ordinary props below Members; put only art that must
overlap characters, such as tree crowns, on `Foreground Canopy`.

## Runtime-marker layers

| Layer | Editor color | Purpose |
|---|---|---|
| `Locations` | blue | functional Product locations |
| `Interaction Regions` | green | clickable rectangle/polygon |
| `Camera Anchors` | yellow | location focus points and Town bounds |
| `Workstations` | orange | legacy work positions; not active-crew capacity |
| `Member Homes` | purple | legacy metadata; not runtime Member slots |
| `Crew Entrances` | teal | active-crew spawn points |
| `Crew Navigation` | teal | connected safe walking polylines |
| `Crew Activity Zones` | magenta | presentation-only activity points/rectangles |
| `Ambient Zones` | cyan | optional presentation-only areas |
| `Animal Routes` | light blue | optional presentation-only polylines |
| `Status Anchors` | red | lifecycle/status glyph positions |
| `Reserved Sites` | gray | future noninteractive area |
| `Authoring Notes` | white | Tiled-only instructions |

Tiled object-type definitions also include short descriptions and property
defaults in `object-types.json`.

# The authoring-marker staging area

The right edge of the blank map contains the real required runtime objects.
They are not fake placeholders and do not need later renaming.

## Functional locations

| Stable name | Display label |
|---|---|
| `gatehouse` | Projects |
| `guild` | Guild Hall |
| `blacksmith` | Forge |
| `tavern` | Tavern |
| `quest-board` | Quest Board |
| `work-area` | Work Yard |

Each location already has:

- one point on `Locations`;
- one green shape on `Interaction Regions`; and
- one point on `Camera Anchors`.

The Quest Board also has `quest-board-status` on `Status Anchors`.

## Workstations and Member homes

Older maps may contain ten neutral workstations and twelve generic
`member-home-01` through `member-home-12` points. They are retained only as
legacy/reference metadata. They no longer determine whether a Member can be
shown and do not cap active crew population. Do not add more homes or
workstations for new Members; author Crew Entrances, Crew Navigation, and Crew
Activity Zones instead.

## Optional ambience

`Ambient Zones` and `Animal Routes` start empty. The runtime does not require
ambient design. Add them later if wanted:

- draw a rectangle with type `ambient_zone` and a presentation `qeVariant`;
- draw a polyline with type `animal_route` and the same variant.

No pathfinding is required.

## Town bounds

The yellow `functional-town-bounds` rectangle covers the central blank design
canvas and excludes the staging strip. `Town` camera mode fits only this
rectangle, not every temporary marker.

Resize it as your functional town grows.

# Design your first district: Town Square / Quest Board

This walkthrough teaches the tools without prescribing the final design.

1. Select `Paths` and paint a small intersection somewhere inside
   `functional-town-bounds`.
2. Add a few optional tiles or image objects on `Ground Detail`,
   `Props Below Members`, or `Static Objects Below Members`.
3. Build or place a small Quest Board visual. Copy an example from the
   construction reference if helpful.
4. Show `Locations` and drag the blue `quest-board` point to the board's logical
   center.
5. Show `Interaction Regions`. Drag and resize the green
   `quest-board-interaction` around the board and its usable area.
6. Show `Camera Anchors` and move the yellow Quest Board anchor to the point the
   camera should emphasize.
7. Show `Status Anchors` and move `quest-board-status` to a clear glyph position.
8. Resize `functional-town-bounds` only if the new district lies outside it.
9. Save.
10. Open Quest Engineering and click the board. Add `&debugMap=1` if you need to
    inspect the runtime shapes.

Repeat the same location → interaction region → camera anchor sequence for each
later district.

# Learning from the reference maps

Open maps in separate Tiled tabs with **File → Open**.

## Previous generated town

```text
client/src/world/maps/reference/town-reference-v0.14b.tmj
```

Purpose: inspect how the previous coding-agent-authored map wired locations,
workstations, homes, status anchors, ambient zones, and props. It is never
loaded by production.

## Sunnyside construction reference

```text
client/src/world/maps/reference/sunnyside-construction-reference.tmj
```

Purpose: inspect/copy small terrain, path, wall, facade, prop, and tree examples.
It is separate from the old-town wiring snapshot.

To copy an example:

1. open the reference and `town.tmj` in two tabs;
2. select tiles or objects in the reference;
3. copy with `⌘C`;
4. switch to `town.tmj`, select the corresponding layer, and paste with `⌘V`;
5. reposition before saving.

Tiled's Stamp Brush can capture a multi-tile selection for repeated use. The
tracked reference map is the portable source; no custom prefab system is
required.

# Learning from the Sunnyside example

Open these two maps in separate Tiled tabs:

```text
client/src/world/maps/town.tmj
client/src/world/maps/reference/sunnyside-example-world.tmj
```

The second map is a deterministic import of the artist-authored Sunnyside World
v2.1 GameMaker `Room1`, not a coding-agent reconstruction. It has no Quest
Engineering locations, workstations, homes, camera anchors, or runtime schema.

1. Open `town.tmj`, then open `reference/sunnyside-example-world.tmj` in another tab.
2. Use the Layers panel to toggle `land`, `paths`, `shadows`, `building`,
   `walls`, `forest`, `Assets_1`, and `clouds_01`. This reveals the artist's
   construction order without labels on the scene.
3. Select a useful path, building, fence, pond edge, or tree construction on a
   tile layer, copy it, switch to `town.tmj`, select the matching visual layer,
   and paste it.
4. Modify the pasted art for your town. Keep Quest Engineering's colored runtime
   markers on their own object layers; do not copy those from a reference map.
5. Save and preview the production town as usual.

Ordinary rectangular selection copies the active Tiled layer. For a multi-layer
building, copy each corresponding layer in order (for example: ground detail,
paths, building base, walls, roofs, then foreground), or use Tiled's **Stamp
Brush** to retain a reusable multi-layer selection. The imported `Assets_1` and
`Assets_2` sprites use the existing `sunnyside-objects.tsj`, so props can be
pasted into `Static Objects Below Members` without a broken tileset reference.

These maps have deliberately different roles:

```text
town.tmj
  → your production town; the user-owned blank canvas and the only runtime map

town-reference-v0.14b.tmj
  → old coding-agent Quest Engineering map, useful only for prior runtime wiring

crew-authoring-fixture.tmj
  → non-production parser/navigation example with connected crew semantics

sunnyside-construction-reference.tmj
  → curated small construction examples

sunnyside-example-world.tmj
  → full artist-authored original Sunnyside example imported from GameMaker Room1
```

The full imported map is the primary learning source. No native Stamp Brush
presets or templates are committed: designers can make a small local Stamp
Brush selection directly from the actual imported construction when one proves
useful.

# Preview and validation

Start the client:

```sh
bun run --cwd client dev
```

Useful URLs:

```text
http://127.0.0.1:1420/?fixture=idle&camera=town
http://127.0.0.1:1420/?fixture=density&camera=town
http://127.0.0.1:1420/?fixture=density&camera=town&debugMap=1
```

Saving `town.tmj` or a `.tsj` is watched by Vite. A normal browser refresh is
acceptable if the current page does not update automatically. No atlas rebuild,
backend restart, or source conversion is needed.

Validate before committing:

```sh
bun run --cwd client validate:town
```

The validator checks schema version, required Product-location layers, stable
IDs, companion interaction/camera/status objects, bounds, tileset paths, and
image files. Legacy workstation/home layers are optional. Once any crew layer
is added, validation also requires the complete three-layer crew schema, a
connected route graph, reachable entrances/activity areas, known `qeActivity`
values, and a general fallback.

# Coordinate rules

- Map/runtime coordinates are unscaled logical pixels.
- Base tiles are 16×16.
- Legacy workstations and Member homes are point coordinates only; active crew do not consume them.
- Crew route vertices use authored world coordinates and connect within 1 pixel.
- Crew entrances and activity areas connect to their nearest route within 8 pixels.
- Rectangle coordinates are top-left.
- Polygon/polyline points are relative to their object origin.
- Camera anchors are world focal points, never screen coordinates.
- Runtime camera scaling remains integer-only.
- The map property `questEngineeringMapVersion` must remain `1`.

Do not put Product state, Member identity, Class, Loadout, Squad, Quest, Tactic,
Run, or Step semantics into Tiled.
