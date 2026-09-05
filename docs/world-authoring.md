# Quest Engineering world-region authoring

Quest Engineering composes an archipelago from human-authored reusable Tiled
regions. The human designs places; runtime instantiates and transforms them.
World layout is presentation state only and never delays or changes execution.

```text
Home Island (town.tmj)
+ one reusable Project-island instance per active Product Project
+ optional authored expansion instances
```

Normal runtime instantiates the human-authored production template:

```text
client/src/world/maps/project-island.tmj
```

The reference island files remain intentionally plain architecture fixtures,
not production level designs. They are used by tests or an explicitly requested
development fixture world only:

```text
client/src/world/maps/reference/project-island-fixture.tmj
client/src/world/maps/reference/project-expansion-fixture.tmj
```

## Region templates and instances

A `WorldRegionTemplate` is one Tiled map parsed once in local coordinates. A
`WorldRegionInstance` references that template and supplies an instance ID,
kind, world origin, local bounds, world bounds, optional Project identity, and
optional parent region. Instantiation never edits or duplicates the `.tmj`.

```text
world position = authored local position + region world origin
```

Multiple instances share the parsed template and texture resources. Each
instance keeps its own Pixi root so authored layer order, foreground, activity,
and interaction depth remain region-scoped. A distant root is viewport-culled;
its ambient animation updates are skipped. This is the extension point for
future near/far LOD and an archipelago overview without requiring every island
to remain a full-detail active scene.

## Validation profiles

Set the map-level string property `questEngineeringRegionProfile`:

| Profile | Purpose | Required semantics |
|---|---|---|
| `home` | `town.tmj` management space | existing Product locations, interactions, camera anchors, status anchor |
| `project_island` | reusable Project base | crew entrance, connected route graph, general activity district |
| `project_expansion` | attachable authored chunk/islet | inbound socket, route/activity layers |
| `reference` | parser/reference material | only semantics intentionally demonstrated |

All maps use `questEngineeringMapVersion = 1`, finite orthogonal geometry, and
16×16 logical tiles. Project/expansion templates include the visual layers
`Ground`, `Paths`, `Props Below Members`, and `Foreground Canopy`; more authored
visual layers may be added and retain their authored order.

The Home Island is not crew-enabled. Do not add `crew_spawn`, `crew_route`,
`crew_activity`, or `island_socket` objects to `town.tmj`.

## Project-island crew semantics

Validate the production template with:

```sh
bun run --cwd client validate:project-island
```

All coordinates below are local to the reusable Project template. Every
`crew_spawn`, `crew_route` vertex, exact `crew_activity` point, and generated
district position denotes the actor's **foot/ground contact point**. It never
denotes sprite center, frame bottom, head position, or a separate logical
marker. The CrewActor root, shadow center, route position, activity arrival,
and depth-sort Y all use that same point; Human frame artwork extends upward
from it.

1. Add object layer **Crew Entrances**.
2. Add one or more uniquely named point objects of type `crew_spawn` at a
   visually valid entrance/dock.
3. Add object layer **Crew Navigation**.
4. Draw uniquely named `crew_route` polylines only over visibly safe walking
   paths. Vertices connect within **1 local pixel**.
5. Add object layer **Crew Activity Zones**.
6. Add uniquely named point or rectangle `crew_activity` objects with
   `qeActivity` equal to `general`, `crafting`, `research`, `mining`,
   `woodcutting`, or `digging`.
7. Exact point-shaped activities may optionally set `qeFacing` to `north`,
   `south`, `east`, or `west`. It is authoritative presentation metadata while
   working. Do not set it on rectangle districts.
8. Provide at least one large `general` district.
9. Keep entrances and activity geometry within **8 local pixels** of the route
   graph.

A rectangle is a shared district. Runtime derives ephemeral positions from its
physical dimensions and minimum actor spacing; positions are claimed only while
needed and immediately released. It is not a persisted or execution capacity.
A point is an exact, normally exclusive interaction anchor such as an anvil,
chair, desk, tree, or mine face. Allocation preference is exact same-category
point, same-category district, another compatible authored expansion, general,
then graceful generic visual degradation. Lack of a visual spot never blocks a
Step or Run.

Multiple same-category zones are normal. Future allocation ranks correct
Project first, then category, availability, occupancy, distance, and a soft Run
work-group clustering preference. A Run work group is temporary presentation
metadata grouping activities from one Run; it is not Product or Runtime state.
Project determines island, Run determines temporary grouping, Squad determines
a stable presentation-only accent, and Class/Step determines activity.

## Expansion sockets

Add object layer **Expansion Sockets** and point objects of type
`island_socket`. Each uniquely named socket uses:

```text
qeSocketRole         inbound | outbound
qeSocketEdge         compatibility token, for example footbridge
qeSocketOrientation  north | east | south | west
qeSocketCategory     optional compatibility tag
```

A base outbound socket matches an expansion inbound socket only when edge and
optional category are compatible and orientations oppose. Each socket lies on
the map edge named by its orientation and coincides with an authored
`crew_route` vertex within **1 local pixel**. Runtime translates the expansion
so the two socket/route nodes coincide. It does not synthesize
terrain, beaches, bridges, buildings, or routes. Expansion route endpoints must
meet their socket; after attachment, matching base/expansion route vertices
form one Project-local graph. There is no ocean graph and no cross-Project
walking.

The fixture proves one east-facing base socket plus one west-facing inbound
expansion. Future authored expansions may expose additional outbound sockets,
but assembly remains deterministic and constrained rather than arbitrary
procedural generation.

## Deterministic placement and visual demand

Project identity comes from the stable Product Workspace ID/key. Its hash
chooses one of eight nearby first-ring slots around reserved Home slot zero.
Deterministic probing fills free positions in the current square-spiral ring
before expanding into another lazy, unbounded ring. Registration and Quest/Run
order have no effect; only a colliding probe chain can affect a later identity.
There is no finite island-slot pool or Product-visible layout maximum.

Placement uses actual composed Project bounds, including a composed expansion
when that template is registered. The first ring hugs the full authored Home
map boundary without overlapping it. Its eight slots are paired along the top,
right, bottom, and left edges, rather than occupying distant diagonal cells, so
early islands appear in the initial Home view. The map's existing outer water
remains useful visual separation and does not need to be removed. Project
footprints retain a 64-pixel ocean gutter from each other. Later rings add one
Project footprint plus that gutter, not a Home-sized sparse grid cell. No
coordinates are persisted.

Comfortable visual capacity is measured from exact points plus rectangle-derived
positions. It may later inform expansion presentation only. The architecture
provides a parameterized high/low sustained-demand hysteresis policy and stable
attachment ordinal; production thresholds and retirement durations intentionally
wait for real authored templates and hands-on tuning. Geography must not pulse
with short-lived worker-count changes.

## Camera and debugging

World bounds are the padded union of instantiated region bounds; Home-only mode
retains the original Home bounds exactly. The initial Home overview and
`focusHome()` frame the authored functional town together with occupied
first-ring islands, making the first Project discoverable without using the
selector. Normal integer zoom, panel-aware Home building focus,
keyboard/pointer panning, `focusProject(projectId)`, and the Project-island
selector operate in world space. No minimap is implemented.

Use `?debugMap=1&focusProject=first` to inspect the production region
bounds/kind/template, Project identity, local/world origins, sockets, route
graphs, activity counts, expansions, active actors, and active Runs. Each actor
reports authoritative-running separately from presentation state, facing and
its source, animation, route, lane offset, target/departure target, claim,
presentation age, minimum-work remainder, and Squad accent. World diagnostics
include placement slot, Home-relative distance, footprint, and the repeating
ocean bounds/tile statistics. Add
`&worldFixture=expansion` only together with `&worldTemplate=fixture` to inspect
the plain reference expansion. The reference expansion is never registered in
the normal production world.

## Active crew presentation

Only authoritative bound running Steps create CrewActors. A new actor appears
at its Project island `crew_spawn`, follows that island's shortest authored
route, and then plays an exported Human v1 work action at a temporary claim.
Exact points are exclusive; rectangles generate comfortably spaced positions,
and general district overflow remains presentation-only.

The actor's route position is its canonical world ground point. The root,
neutral shadow, restrained Squad-color rim, activity arrival, and depth-sort Y
all use it directly. Human v1 frames are fixed 96×64 source cells whose base
layer has a stable last opaque row at y=38. Runtime metadata therefore anchors
the foot/contact point at source `(48, 39)`. The former generic bottom-center
anchor `(0.5, 1)` placed that contact point 25 pixels above the root; no
animation-specific offsets are applied. All base, hair, and tool layers share
the same parent transform and calibrated frame anchor.

When semantic work ends, Product/HUD activity becomes inactive immediately.
A spawned actor nevertheless completes its committed presentation sequence:
travel to the selected activity, perform a readable work beat, briefly idle,
then walk a bounded route segment toward the nearest authored spawn. This is a
visual reenactment, not active execution. The path-aware tail budget includes
remaining travel, remaining minimum work, wrap-up, and a distance-derived exit
allowance, clamped to 14 seconds. A long exit is communicated for 0.9–1.8
seconds rather than requiring the full route.

Presentation values live in `crew-presentation-timing.ts`: 36 world pixels per
second, 3 seconds minimum work, 400ms wrap-up, and the bounded departure above.
The previous 22px/s made ordinary island travel tedious; 36px/s remains readable
at integer zoom while allowing short work to reach its destination sooner.
After correcting foot anchoring, grounded comparisons at 2.0s, 2.5s, 3.0s, and
3.5s selected 3.0s as the shortest beat that remains unmistakably readable in
the real short-Quest choreography.
Consecutive work for the same Run+Member cancels the tail and reuses the actor
at its current position. Presentation never delays execution.

Movement facing is derived only from actual non-zero Pixi route motion, where
positive y means south. Effectively zero movement preserves facing. Horizontal
roads retain the previous upper/lower diagonal until vertical slope exceeds a
hysteresis threshold, preventing NE/SE flips and preserving northward or
southward continuity. Exact `qeFacing` overrides work facing; otherwise the
final approach is retained, with south as the deterministic last fallback. The
Human work tags are non-directional and their source art visibly faces
screen-east, so west-facing actions mirror the shared base/hair/tool parent
composite without fabricated strips.

Activity interpretation is centralized in
`client/src/world/crew/crew-activity-policy.ts`. Project comes from the Run's
LaunchSnapshot Workspace, Run provides soft allocation affinity, Squad provides
a subtle stable ground accent, and Squad key plus Member key selects a stable
Human v1 hair layer. None of this data is persisted.

Development-only deterministic review states use `crewDemo` and
`crewDemoTime`, for example:

```text
?crewDemo=entering&crewDemoTime=1000&focusProject=crew-demo-a
?crewDemo=short-500&crewDemoTime=8000&focusProject=crew-demo-a
?crewDemo=parallel-tail&crewDemoTime=7200&focusProject=crew-demo-a
?worldDemoProjects=1&facingSheet=1&focusProject=archipelago-demo-0
```

Run `bun run --cwd client screenshots:crew-choreography-ux` with the Vite
server available to regenerate eight-direction facing, exact work-facing,
500ms/1.5s/5s/long timelines, handoff, continuation, and final-removal
checkpoints. These demo facts never replace authoritative activity outside
explicit development queries.
