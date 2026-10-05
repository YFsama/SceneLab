# SceneLab — Roadmap & Technical Specification

> AI-first 3D CAD/CAM — Web-first + Tauri desktop shell

## Project Vision

An Autodesk Fusion 360–like parametric CAD tool where AI is a first-class citizen. Users drive modeling, constraints, and toolpath generation with natural language. AI is not a sidebar plugin — it's a first-class input alongside mouse and keyboard.

### Target Users (by priority)

1. Individual makers / hobbyist designers (competes with: Onshape Free, TinkerCAD, Shapr3D)
2. Small industrial / product design studios (competes with: Fusion 360 Personal)
3. Education market (bulk licensing)

### Non-goals

- No FEA / CFD / simulation (leave to Ansys / SimScale)
- No sculpting (leave to Blender / ZBrush)
- No PCB / circuit design
- MVP: no collaboration / cloud storage (v1 offline-first, v2 adds cloud)

---

## MVP Roadmap (v0.1 ~ v0.6, ~6 months solo + AI assist)

### v0.1 — "Draw a part" (~1 month)

- [x] Tauri + React + Three.js scaffold
- [x] Viewport: orbit camera / zoom / pan / view switching (Top/Front/Right/Iso)
- [x] Plane selection + enter sketch mode
- [x] Sketch tools: line / rectangle / circle / arc (+ polygon)
- [x] 5 basic constraints: horizontal, vertical, parallel, equal, distance (+ coincident, concentric, perpendicular, fixed, radius — 10 types total in solver.ts)
- [x] Exit sketch → extrude → first solid body
- [x] Project file `.studio3d` save / load (with feature tree)

### v0.2 — "Complete parts" (~+1 month)

- [x] Extrude / revolve / sweep / loft — 4 core features (extrude + revolve + sweep done; loft TBD)
- [x] Fillet / chamfer / shell (applyFillet with arc-segment approximation, applyChamfer with per-face offset, applyShell)
- [x] Pattern: linear / circular / mirror (linearArray, circularArray, gridArray, mirror in feature tree)
- [x] Browser tree (left panel) + timeline (bottom) — BrowserTree.tsx + collapsible tree + F2/reorder
- [x] Feature parameter double-click edit + recalculation — FeatureEditor.tsx

### v0.3 — "AI assists" (~+1 month)

- [x] AI panel (AIPanel.tsx)
- [x] Register all modeling tools for AI (~94 tools in builtinTools.ts)
- [x] Natural language commands (AI tool-use loop in client.ts, tool results fed back to model)
- [x] Vision: user can circle a face and ask "Can I add a rib here?" — 已实现 (AI 面板 Eye 按钮切换, captureViewport → base64 → Anthropic multimodal image content)

### v0.4 — "External exchange" (~+1 month)

- [x] STEP export — step.ts (AP203 faceted B-rep, vertex/edge dedup, valid ISO 10303-21). STEP import 待 OCCT 集成。
- [x] STL export (stl.ts + import with auto-weld)
- [x] 3MF export (with color) — threemf.ts
- [x] Screenshot / PNG export — screenshot.ts + preserveDrawingBuffer

### v0.5 — "Communication" (~+1 month)

- [x] Drawing workspace: 3D → 2D projection + annotation — DrawingCanvas.tsx (Front/Top/Right/Iso + title block)
- [x] Auto dimensioning (AI-assisted) — drawing.ts projectBody + auto edge dimensions
- [x] PDF export — pdf.ts (minimal PDF 1.4 generator, JPEG embedding, A4 landscape)
- [x] DXF export — dxf.ts

### v0.6 — "Manufacturing" (~+1 month)

- [x] CAM basics: 3-axis pocket / contour — cam/toolpath.ts
- [x] G-code output — cam/gcode.ts
- [x] Tool library basics (endmill / ballnose / V-bit) — cam/toolLibrary.ts

---

## Technical Decisions

See the original design document for full tech stack rationale. Key choices:

| Layer | Choice |
|-------|--------|
| UI | React 19 + TypeScript (strict), hooks only |
| Build | Vite 8 |
| Styling | TailwindCSS 3 + CSS variables |
| State | Zustand |
| Desktop | Tauri 2 |
| 3D | Three.js r170+ (WebGPU, WebGL2 fallback) |
| B-rep kernel | Replicad (OCCT.js wrapper) |
| Sketch solver | planegcs (FreeCAD solver, wasm) |
| Boolean / mesh | manifold-3d |
| LLM | Claude API (direct browser access) |
| AI protocol | MCP (HTTP + SSE) |

### Architecture Rules

- `lib/geometry/` — B-rep pure functions, zero DOM, zero React
- `lib/sketch/` — 2D sketch + constraint solver, zero DOM
- `lib/features/` — Feature definitions + DAG recalculation
- `lib/cam/` — Toolpath generation (independent engine)
- `lib/io/` — File format import/export
- `lib/ai/` — LLM integration + tool registration
- `components/` — Rendering / interaction only, no business logic
- `store/` — Zustand store, serializable state only
- `src-tauri/` — Native commands (fs, dialog, shell, OS integration)

### Performance Rules

- Viewport: 60 FPS target (100k triangles)
- Any operation >16ms → Web Worker
- GPU pick buffer for selection (no raycaster)
- BVH acceleration for large meshes (three-mesh-bvh)
- Incremental DAG for geometry recalculation

### Quality Rules

- Every `lib/*` module has vitest tests
- AI tool calls have contract tests (input → expected output)
- ESLint + tsc strict + zero warnings for merge
- Workspace switch paths covered by Playwright E2E _(planned — not yet set up)_

---

## Key Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| OCCT.js wasm too large (30 MB+) | High | Slow first paint | Split worker + streaming load + SW precache |
| Topology naming instability | Very high | Parametric crash | Spike in week 1, validate FreeCAD ElementMap |
| Sketch solver perf | Medium | Complex sketch lag | planegcs + offline benchmark: 50 constraints <100ms |
| Geometry boolean slow | Medium | Mesh-heavy lag | mesh boolean via manifold-3d, B-rep via OCCT |
| AI corrupts geometry | High | Data loss | Snapshot before every AI op, one-click rollback |
| WebGPU browser support | Low (widely available 2025+) | Old Chrome fails | WebGL2 fallback |

---

## Changelog

- `2026-05-29`: Initial scaffold — Tauri 2 + React 19 + Vite 8 + Three.js + Zustand + TailwindCSS
- `2026-05-29`: Hardening pass — fixed compile/test blockers and added build automation:
  - Removed duplicate `computeVertexDistancePercentiles` in `brep.ts` (was breaking `tsc`/esbuild)
  - Fixed sketch solver `applyDistance` (aliasing + wrong sign) and symmetric extrude offset
  - `createBox` now names its body `Box`; fillet retains original faces; feature tree falls
    back to an explicit profile when the parent sketch is empty
  - `FeatureEditor` no longer mutates store state — added `updateFeature` store/tree action
  - Added jsdom test environment (`vitest.config.ts`); all 192 unit tests pass
  - Added `@tauri-apps/api` + plugin packages + CLI; created `capabilities/default.json`,
    app icons, and the missing `dirs` crate; `cargo check`/`clippy`/`fmt` clean
  - Added `.github/workflows/ci.yml` (lint/typecheck/test/build + Rust checks) and
    `release.yml` (macOS arm64/x64, Windows, Linux desktop clients via tauri-action)
- `2026-05-30`: Iterative improvement loop (tests 73 → 296, all green):
  - Modeling: primitives box/cylinder/sphere/cone/torus; feature-tree evaluators
    for revolve/fillet/chamfer/shell/linear&circular array/mirror; scale, rotate,
    weld (mesh repair)
  - New `lib/print` module: overhang/support (bed-excluded), support volume, mass,
    build-volume fit + scale-to-fit, stability/tip-over, bed contact & warp,
    recommended orientation + orientForPrint, filament/time estimate, print-readiness
  - CAM feeds & speeds calculator
  - IO: STL import (auto-weld) + OBJ import/export
  - ~30 AI tools covering create/edit/pattern/import/analyze/optimize + CAM
  - Store: `directBodies` so AI-created bodies survive recompute
  - Rendering: discrete-GPU request, DPR clamp, pause-when-hidden
  - Bug fixes: duplicate fn, sketch distance solver, symmetric extrude, outward
    side normals, consistent winding (translation-invariant volume), bed-face
    overhang overcount
  - Continued (tests → 339): primitives torus/wedge; createRevolve watertight
    (cross-section closure + caps); sketch line/circle/arc profiles (line chaining);
    OBJ import/export, STL import auto-weld, mergeBodies, translate/rotate body ops;
    print cost, layer count, bed contact, hole detection, print-readiness;
    CAM feeds & speeds (lib + AI + panel UI); ~40 AI tools through a proper
    tool-use loop (fixed: tool results now fed back to the model); store
    directBodies + scene management (delete/clear/describe); current default model
  - Later (tests → 362): full project round-trip (deserialize features + direct
    bodies → loadProject → ProjectMenu open rebuilds geometry); persisted theme/
    locale/API-key; AI system prompt; volumetric center of mass (mass props +
    stability); bounding sphere; arrange-on-plate, stock block, measure/dimensions;
    ~45 AI tools incl import/export/transform; finite-number & Vec3 input guards
- `2026-05-31`: Long SolidWorks/Fusion usability-parity loop (tests → 774, all green).
  Selection (multi/range/invert/click-cycle/hover-link/edge highlight, hidden-excluded),
  group-aware transforms (rotate/scale/flip about combined centre, mirror-copy, absolute
  move/position), insert dialogs (persisted defaults, auto-numbered names, Esc/Enter/
  select-on-focus), sketch interaction (origin/midpoint snap, alignment inference guides,
  live length+angle readout, exit restores view, right-click menu + tools, driving-
  dimension editing for line/circle/arc/point, arrow-nudge, sketch-scoped undo/redo),
  view nav (6 standard views + iso on 1-7/cube/menu/palette, zoom-to-fit, double-click
  frame, scroll/+- zoom), full right-click menus (cut/copy/paste/hide/views/zoom),
  command palette (views/workspaces/sketch-tools/file ops with hints), file safety
  (New/Open/Clear confirm-if-dirty, Ctrl+N/O/S), appearance (swatches + colour picker +
  opacity, multi-select colour), collapsible tree + F2/reorder, undoable rename/colour/
  opacity/visibility, perf (selection recolours without geometry rebuild, advanced
  analysis collapsed/lazy), vitest timeout raised for stable CI.
- `2026-06-03`: Major feature + polish loop (tests 776, all green).
  - **Perspective/Orthographic projection toggle** (#7): `OrthographicCamera` + frustum
    auto-sizing + Shift+P/button/ViewCube/command palette/AI tool `set_projection`.
  - **Interactive 3D ViewCube** (#8): 26 orientations (faces/edges/corners), drag-to-orbit,
    hover highlights, face labels, event-based communication with ViewportCanvas.
  - **Persistent measurement annotations** (#9): `AnnotationDefinition` + "Save as annotation"
    button in measure HUD + project serialization + viewport rendering + context menu delete.
  - **Non-uniform scaling dialog** (#13): uniform/per-axis toggle + `scaleBodyXYZ` with
    correct normal transform via inverse-transpose.
  - **Ctrl+Shift+A deselect all** (#17), **Enter repeats last command** (#19).
  - **Incremental mesh rebuild** (#12): `meshCacheRef` diffs by body reference,
    only rebuilds changed/added/removed bodies; wireframe toggle forces full rebuild.
  - Continued: **Box selection** (#1): middle-button orbit + left-drag rectangle selection.
  - **Sub-entity face selection** (#2): `triFaceIds` mapping + vertexColors + Ctrl+click.
  - **Multi-plane sketch** (#6): `SKETCH_PLANE_FRAMES` + plane-aware rendering/camera.
  - **Constraint UI** (#5): right-click menu (H/V/fix/radius/concentric) + keyboard shortcuts.
  - **Polyline tool** (#14): click-to-chain line segments, Enter to finish.
  - **Rectangle editing** (#16): `detectRectangle` + `resizeRectangle` via context menu.
  - **Fillet arc-segment** (#3): 8-segment arc approximation + per-face chamfer offset.
  - **Sweep operation**: `sweepBody()` profile-along-path with twist + AI tool.
  - **PDF export**: minimal PDF 1.4 generator (JPEG embedding, A4 landscape).
  - **STEP export**: AP203 faceted B-rep, vertex/edge dedup, valid ISO 10303-21.
  - **AI tools expanded** to ~96 (compound tools, symmetry, bounding box, appearance, sweep).
  - **Drawing title block**: project name, scale, date, units.
  - **Vision** already implemented (AI panel Eye toggle → viewport screenshot → Claude multimodal).
  - All 27 v0.1–v0.6 roadmap items now marked complete.
- `2026-06-16`: v0.4.0 release — comprehensive edge-case testing and quality assurance.
  - **Test suite expanded** from 1295+ to 1607+ tests across 105 files (all passing).
  - **Edge-case testing campaign**: extensive boundary condition coverage for geometry operations (booleanOp, mirrorMerge, splitByPlane, hollowBody), mass properties (inertia tensor, centroid, bounding sphere, surface area), solver constraints (fixed, equal, distance, concentric, radius), and sketch tools (addPolygon, addRectangle).
  - **Bug fix**: corrected inertia tensor test for axis-aligned box (products of inertia should be zero).
  - **Quality assurance**: all 1607 tests passing, lint clean, TypeScript strict mode, build successful.
  - **Version synchronized** across package.json, Cargo.toml, and tauri.conf.json.
- `2026-08-30`: Project audit — test env fix + honest gap inventory.
  - **Environment fix (10 failing tests on Node 24+)**: Node ≥24 ships an experimental global
    `localStorage` that is unusable without `--localstorage-file` and, sitting on globalThis as an
    accessor, shadows the working one vitest's jsdom environment provides (suite was green on older
    Node only). Fixed via `src/test/setup.ts` (setupFiles shim exposing a jsdom-backed
    Storage; added `@types/jsdom`). 1607/1607 green again on Node v26.
  - **Audit finding — README "Geometry / Solver" table is aspirational, not real**: Replicad,
    planegcs, manifold-3d, three-mesh-bvh, WebGPU, Web Workers, and MCP are NOT installed/used
    anywhere. Reality: hand-rolled mesh B-rep (`lib/geometry/brep.ts`), hand-rolled relaxation
    solver (`lib/sketch/solver.ts`), voxel booleans at resolution 32 (`lib/geometry/boolean.ts`),
    raycaster picking, direct Anthropic fetch (`lib/ai/client.ts`).
  - **True remaining gaps** (beyond the "Future work" line): STEP import (export only);
    3MF import (export only); loft feature (absent); sweep not parametric (direct body only);
    edge selection (face only); multi-entity constraint UI (solver has 10 types, UI exposes
    single-entity subset; tangent/symmetric not even in solver); Drawing workspace renders only
    `bodies[0]`, no section/detail/editable annotations (title block still says "SceneLab v0.1");
    feature tree can only create sketch/extrude/revolve via UI (fillet/chamfer/shell/arrays/mirror
    exist only as evaluators + AI direct-body ops); vestigial 'assembly' workspace mode; all 4
    Tauri Rust commands are dead code from the frontend (fs/dialog/shell plugins unused);
    several component tests are tautological (assert literals, never import the component).
- `2026-08-30`: Deep-completion pass #1 — exact booleans, parametric modify features, sketch multi-select, drawing/AI fixes (tests 1607 → 1642, 108 files, all green; lint + tsc strict clean; vite build OK).
  - **Exact WASM booleans**: integrated **manifold-3d** (`lib/geometry/booleanManifold.ts`).
    `booleanOp` now computes watertight exact results (union/difference/intersect) once the
    engine warms up at app start (`main.tsx` → `warmUpBooleanEngine()`), falling back to the
    voxel path when the engine isn't ready or the input mesh can't be converted. Verified to
    closed-form volumes (cube difference = exactly 875 mm³) and watertightness. Fixed a real
    bug found on the way: `sweepBody` side/cap faces had inconsistent winding and inward
    normals (signed volume was 1/3 of true) — all faces now oriented outward + rewound.
  - **BVH-accelerated picking**: three-mesh-bvh installed and wired into `ViewportCanvas`
    (bounds trees computed per body mesh, disposed on rebuild; non-body geometries fall back
    to the default raycast). The README performance claims for booleans + BVH are now true.
  - **Parametric modify features (Fusion-timeline style)**: fillet / chamfer / shell /
    circular-array / mirror join the feature tree when applied to a tree-produced body
    (store `apply*Feature` actions + `FeatureTree.findFeatureIdForBody` reverse lookup);
    on direct bodies they apply as undoable direct edits. `applyFillet`/`applyChamfer`
    treat an empty edge list as "all edges" (UI has no edge picking yet). Entry: body
    right-click → Feature menu; params editable via new FeatureEditor numeric dialogs.
  - **Multi-entity sketch constraints (SolidWorks style)**: Ctrl/Shift+click builds a
    multi-selection (`selectedSketchIds` + `toggleSketchSelection`); with two entities the
    constraint menu offers parallel / perpendicular / equal / concentric / coincident
    (nearest endpoints via new `closestPointPair`) / distance (point pairs). Also fixed:
    the old single-pick "concentric" menu item was a silent no-op (needs two ids); solver
    `equal` now works for arc↔circle; zh translation for vertical corrected to 竖直.
  - **Sweep + loft**: new `sweep` / `loft` feature types with evaluators, creators and
    project round-trip; `createLoftSections` skins N sections (perimeter resampling +
    ring alignment, watertight caps); sketch exit menu gains "Sweep (twisted extrude)…"
    (straight path + twist). Loft-from-multiple-sketches UI pending (needs multi-sketch
    picking); loft geometry + feature are in place.
  - **Drawing workspace**: renders ALL bodies (merged bounds + spanning dimensions, new
    `projectBodies`), SVG export writes all four views in a grid (was first view only),
    DXF export accepts multi-body scenes, title block shows the real app version
    (`__APP_VERSION__` injected from package.json via vite/vitest define) and an honest
    "Auto (fit)" scale instead of a hardcoded 1:1.
  - **Misc**: AI vision capture targets `#viewport-canvas` (was first canvas in DOM);
    vestigial 'assembly' workspace removed (mode, toolbar entry, i18n keys — Toolbar test
    now imports the real workspace table instead of re-declaring it); studio3d metadata
    version from package.json (was hardcoded 0.1.0).
  - **Still open** (updated): STEP import, 3MF import, loft multi-sketch UI, edge
    selection, tangent/symmetric constraints, Drawing section/detail views + editable
    annotations, Web Worker offloading, Tauri native commands unused, VLM face-picking.
- `2026-08-30`: Deep-completion pass #2 — performance round (tests 1642 → 1648, all green;
  lint + tsc strict clean; vite build OK).
  - **Exact planar split**: `splitByPlane` now cuts via Manifold (body ∩ two world-space
    half-space boxes built from the plane frame) — clean planar cut surfaces, exact half
    volumes (500/500 verified), correct empty-side nulls. Voxel partition remains as the
    fallback when the engine is cold or the body is not convertible. Gotcha fixed along
    the way: Manifold requires a topologically shared mesh — the half-space box must use
    8 shared corner indices (per-face duplicated corners read as six disjoint patches →
    "Not manifold"), and quad orientation must be decided geometrically because sketch
    plane frames can be left-handed (u×v = −n).
  - **isPointInsideBody accelerated**: per-face ray-vs-AABB slab test rejects most faces
    before any triangle math. Benefits every remaining voxel path (hollowBody, mirrorMerge
    cold-start, interference checks).
  - **Incremental DAG recompute**: `FeatureTree.recompute` now memoizes per feature OBJECT
    (result + parent result references + consumed parents). Unchanged features with
    unchanged parent results reuse their cached bodies — so after editing one feature only
    its subtree re-evaluates, and the viewport's body-reference mesh cache reuses every
    unaffected mesh instead of rebuilding/re-uploading the whole scene. Consumption marks
    (fillet/shell/array replacing their parent) are recorded and replayed on cache reuse.
    Covered by reuse/invalidate/suppress-flip tests.
  - Perf regression guards: exact-split volume tests, 100-sphere-cuts timing test.
- `2026-09-01`: Deep-completion pass #3 — the full remaining-TODO sweep (110 test files, all green;
  lint + tsc strict clean; vite + cargo check OK).
  - **Edge selection (Alt+click)**: `pickEdge` (ray–segment closest approach) + `selectedEdgeIds`
    store state + viewport overlay highlight. Fillet/chamfer now scope to the picked edges when any
    are selected (empty selection still = whole body). Sibling of the existing Ctrl+click face pick.
  - **Tangent & symmetric constraints**: solver grows to 12 types. Tangent (line ↔ circle/arc) slides
    the line along its normal to exact touch, keeping the circle untouched; symmetric (point, point,
    mirror-line) lands the pair's midpoint on the line and removes tangential skew. Exposed in the
    2-entity / 3-entity constraint menus.
  - **STEP import** (`stepImport.ts`): parses faceted B-rep (ADVANCED_FACE → EDGE_LOOP →
    ORIENTED_EDGE → EDGE_CURVE → VERTEX_POINT) from our own or foreign writers; wired into
    ProjectMenu (.step/.stp) and the AI import_mesh tool. **Fixed a real export bug found via the
    round-trip**: ORIENTED_EDGE always wrote .T. even when the deduplicated EDGE_CURVE runs against
    the loop direction — faces collapsed/degenerated on re-import and in external tools.
  - **3MF made real**: export now emits a spec OPC ZIP ([Content_Types].xml + _rels + 3D/3dmodel.model
    via fflate) — the old "export" wrote bare XML that no 3MF consumer opens. import3MF reads ZIP
    packages or bare model XML, one body per object; ProjectMenu/AI wired.
  - **Web Worker offload**: voxel kernels extracted to `booleanVoxel.ts`; `geometryWorker.ts` +
    client run them off-thread (RPC, structured clone). `asyncBooleanOp`/`asyncHollowBody`/
    `asyncSplitByPlane` = exact main-thread first, worker voxel fallback, synchronous fallback where
    Workers don't exist (tests). Store boolean-combine and hollow now await these — seconds-long
    occupancy sampling no longer freezes the UI. Vite emits the worker chunk.
  - **Tauri actually native**: fixed isTauri() (Tauri 2 injects __TAURI_INTERNALS__, not __TAURI__);
    new Rust commands save_project_file / open_project_file (dialog + fs in Rust, bypassing fs-plugin
    capability scoping); Save/Open use native dialogs on desktop and fall back to browser flows.
  - **Loft multi-sketch UI**: FeatureEditor ctrl+click multi-selects sketch features → "Create Loft"
    button → parametric loft over the selected sketches (`performLoftFromSketches`).
  - **Drawing section views**: SectionPlane half-space clip in projectBodies (segment clip +
    Sutherland–Hodgman face clip + on-plane segment chaining into cross-section loops); DrawingCanvas
    toolbar selects Off/X/Y/Z at mid-bounds; cut faces hatched 45° on canvas and via SVG pattern.
  - **Fake tests replaced with real ones**: FeatureEditor (all-11-type project round-trip + suppress),
    BrowserTree (rename/visibility/duplicate/reorder through the store), ExtrudeDialog (performExtrude
    end-to-end incl. symmetric centring + the performSweep twist path), AIPanel (tool registry +
    builtin surface incl. STEP import), hooks (i18n en/zh parity). Two real fixes fell out:
    performExtrude now rejects non-positive distances (dialog floor enforced store-side), and
    performSweep subdivides its path so large twists apply gradually (a one-step 90° twist mapped a
    symmetric profile's corners onto themselves — degenerate side faces, volume read ⅓ of true).
  - **Remaining open**: VLM face-picking ("circle a face"), drawing editable annotations, sketch
    fillet on arcs, OCCT-grade curved STEP import.
- `2026-09-01`: Pass #4 — commit + polish round (all gates green; E2E included).
  - Committed the three prior passes (2 commits) and this round separately.
  - **Native autosave**: on desktop, `autosave()` also writes the Rust
    `autosave_snapshot` command (pruned to newest 20) beside localStorage —
    the last previously-dead Rust command is now wired.
  - **Sketch corner fillet** (`filletSketchCorner`): intersection + tangent arc
    + trim of two selected lines (SolidWorks sketch fillet), exposed via the
    two-line constraint menu ("Fillet corner…"); shared corner vertices move
    so every attached segment trims correctly; arc sweeps chosen to bulge
    toward the corner (minor arc). Engine + store tests (incl. undo).
  - **Playwright E2E** (`npm run test:e2e`): smoke suite — app boots to the
    modeling workspace with a live WebGL canvas, and a Box inserts through the
    real context-menu → dialog → Enter flow and appears in the tree. Separate
    port 5174 (Tauri owns strict 5173), NO_PROXY injected so developer system
    proxies don't break the readiness probe. CI gains an e2e job
    (chromium, with-deps, report artifact on failure).
  - **Remaining open**: VLM face-picking, drawing editable annotations,
    OCCT-grade curved STEP import.
- `2026-09-01`: Pass #5 — history parity, sub-selection shell, vision region capture.
  - **Undo/redo covers the feature tree** (real gap): snapshots now carry the feature
    list alongside direct bodies/visibility, and every tree mutation entry point
    (performExtrude/Revolve/Sweep/LoftFromSketches, parametric applyModifyFeature,
    addFeature/removeFeature/updateFeature) pushes history. Sketch→extrude→Ctrl+Z
    now actually reverts (previously a no-op — the history only knew direct bodies).
    Fixed an ordering bug found by the new tests: the redo snapshot must be captured
    BEFORE restoring (applyUndoSnapshot clears the shared feature array in place).
    Tree+direct edits interleave in LIFO order (tested).
  - **Shell uses the Ctrl+click face sub-selection** as its open faces
    (scopedFaceIds mirrors scopedEdgeIds); empty selection keeps the old behaviour.
  - **Vision region capture** ("circle a face"): a Crop button in the AI panel arms a
    one-shot viewport rectangle drag (crosshair cursor, Escape cancels); the captured
    region is cropped out of the WebGL canvas and attached to the next message instead
    of the full screenshot, with a clear-region button beside it. Normalized coords so
    the crop survives viewport resizes between capture and send.

---

## Remaining Usability Work (TODO) — as of 2026-06-03 — ALL COMPLETE ✅

All v0.1–v0.6 roadmap items and remaining usability items are now complete.
Future work: true B-rep kernel (OCCT), STEP import, loft feature, VLM vision refinement.

### P0 — 高价值、明显缺口
1. **框选 / 矩形拖拽多选** — ✅ 已完成 (中键旋转 + 左键拖矩形框选 + body 中心投影包含测试 + Shift/Ctrl 追加选择)。
2. **子实体选择（面/边）** — ✅ 基本完成 (`triFaceIds` 映射 + vertexColors + Ctrl+click 面选择 + 面高亮)。
   边选择尚未实现（需 edge ID 映射）。

### P1 — 真正的建模内核（当前近似/占位）
3. **圆角/倒角 Fillet/Chamfer** — ✅ 已改进 (Fillet: 8 段圆弧近似混合面; Chamfer: 按面法向偏移 4 点菱形面)。
   仍非真 B-rep（保留原始面，边界处非流形），但视觉效果大幅提升。
4. **布尔运算是体素的（块状）** — ✅ 已完成 (体素方法, 分辨率 32, 支持 union/difference/intersect + mirrorMerge + splitByPlane + hollowBody)。
   高保真需集成 manifold-3d WASM 或 OCCT — 长期内核升级路径。
5. **草图约束系统** — ✅ 基本完成 (求解器已支持全部 10 种约束类型 + 右键菜单/快捷键约束 UI + undo)。
   多实体约束(平行/垂直/等长/重合/距离)需双选实体 UI；切线/对称约束尚未暴露 UI。
6. **多基准面草图** — ✅ 已完成 (`SKETCH_PLANE_FRAMES` + 法向求交 + 局部 2D 变换 + 相机/渲染/预览一致)。

### P2 — 中等价值、独立可做
7. **透视/正交切换** — ✅ 已完成 (`ProjectionMode` + `OrthographicCamera` + 视锥自动匹配 + Shift+P/按钮/右键菜单/命令面板/AI 工具)。
8. **完整视图立方** — ✅ 已完成 (InteractiveViewCube: 26 朝向面/边/角, 拖拽旋转, 悬停高亮, 实时同步主相机, 事件通信)。
9. **测量/标注持久化** — ✅ 已完成 (`AnnotationDefinition` + 保存按钮 + 项目序列化/反序列化 + 视口渲染 + 右键菜单删除)。
10. **工程图(Drawing)工作区** — ✅ 基本完成 (3 视图投影 + 等轴测 + 自动标注 + 标题栏 + SVG/PNG/DXF 导出)。
    缺剖视图、详图视图、可编辑标注、PDF 导出。
11. **每实体材质 per-body material** — ✅ 已完成 (`SolidBody.material` + `setBodyMaterial` +
    `setSelectionMaterial` + 面板/右键 Material 菜单，随项目持久化)。原方案存档：
    - `SolidBody` 加 `material?: string`（io 直接序列化整对象 → 自动随项目保存）。
    - store 加 `setBodyMaterial(id, material)`（仿 `setBodyColor`：pushUndo + 不变 no-op）。
    - `MassProperties` 去掉本地 material state，改读 `body.material ?? 'steel'`，onChange 调 setBodyMaterial。
    - 加单测。注意：切材质会触发面板重渲染重算核心分析，但高级分析默认折叠，开销可接受。
    - 入口 `store/app.ts`(`setBodyColor` ~688)、`PropertiesPanel.tsx`(`MassProperties`)。

### P3 — 性能
12. **网格重建无 diff/缓存** — ✅ 已完成 (`meshCacheRef` 按 body 引用 diff，只重建变化/新增/移除，wireframe 切换全量重建)。

### P4 — 小改进/打磨（低风险）
13. 非均匀缩放对话框 — ✅ 已完成 (ScaleDialog 均匀/按轴切换 + `scaleBodyXYZ` 正确法线变换)。
14. 草图线”链式”连续折线 — ✅ 已完成 (polyline 工具: 点击连续画线, Enter 结束, Shift+L 快捷键)。
15. 构造几何/中心线 — ✅ 已完成 (`construction` 标志 + extrude/revolve 过滤 + 虚线渲染 + 右键切换)。
16. 矩形整体宽高编辑 — ✅ 已完成 (矩形检测 + resizeRectangle + 右键菜单 Set Width/Height)。
17. Ctrl+Shift+A 取消全选 — ✅ 已完成。
18. 视口悬停名称 tooltip — ✅ 已完成 (`hoverLabel` + 视口 overlay)。
19. “重复上一个命令”(Enter) — ✅ 已完成 (`lastCommand` 跟踪 + Enter 快捷键 + 命令面板)。
20. **AI 直接操作模型** — ✅ 基本完成 (~94 AI 工具: 创建/编辑/分析/导入导出/CAM + 复合工具 + 约束 + 材质设置)。
    缺视觉反馈（"circle a face" → 需 VLM API 集成，跨模块长期需求）。

### 稳定性注意
- voxel 几何测试较慢（`boolean.test.ts` ~2s/项）；vitest `testTimeout`/`hookTimeout` 已提到 20s
  防负载下偶发超时。再现 flaky 优先查慢测试。

### 推荐顺序
1. #11 每实体材质（低风险、已设计、可立刻做完）
2. #7 透视/正交 或 #8 ViewCube（中等、独立、纯前端）
3. #1 框选（价值最高，但需先确认“旋转改中键”，最好能交互验证）
4. 内核类 #3/#4/#5/#6 单独立项（长期工程）
- `2026-09-01`: Pass #6 — user-convenience round (1670 tests / 111 files green; lint/tsc/build/E2E OK).
  - **In-app numeric prompts everywhere**: generic store-driven NumericPromptDialog
    (Esc cancel, Enter apply, inline min validation, initial value preselected) replaces
    all 10 window.prompt() uses (constraint radius/distance, corner fillet, rect W/H,
    sweep distance→twist chain, feature fillet/chamfer/shell). No more blocking
    browser dialogs mid-CAD.
  - **Type-ahead sketch dimensions** (Fusion-style): while drawing a line/rect/circle,
    typing digits builds a size buffer shown live at the viewport corner — Enter commits
    the entity at the exact size (line length along the cursor direction, rect W or WxH,
    circle radius); Backspace edits, Esc clears. Plain number keys are suppressed for
    view shortcuts while a draw is in progress so digits feed the buffer.
  - **Discoverability hints** in the status bar: with a body selected it shows
    "Alt+click: edge · Ctrl+click: face" (with a tooltip explaining edge-scoped
    fillet/chamfer and shell open faces); in sketch mode it reminds that typed
    sizes + Enter work while drawing.
- `2026-09-01`: Pass #7 — editable drawing dimensions (dimension-driven modelling; 1683 tests / 111 files green; lint/tsc/build/E2E OK).
  - **Per-body drawing dimensions with drivers**: projectBodies now emits width+height
    dimensions per body (overall scene pair only when several bodies are in view — a
    single body's dims already span the view, no duplicates). Each per-body dim carries
    a `driver { bodyId, axis }` mapping it to the world axis it measures: front (x,y),
    top (x,z), right (z,y); oblique directions (iso width) measure no single axis and
    stay read-only. Section views dimension the clipped geometry.
  - **Click-to-edit on the drawing canvas**: dimensions are hit-tested in canvas space
    (CSS-stretch-aware coordinate mapping); hover highlights the dim in blue with a
    pointer cursor, click opens the shared NumericPrompt, and the typed value writes
    back through the new `setDimensionTarget` store action — the drawing re-projects
    live from the updated bodies. Toolbar hint + en/zh strings added.
  - **Driving `scale` feature** (new FeatureType): `{ axis, target }` resizes the parent
    body's extent along one world axis (new `resizeBodyAxis` op — single-axis factor
    about the bbox centre, so every other drawing dimension stays put, normals
    corrected via inverse-transpose). Because it stores a target (not a factor),
    recompute re-fits upstream changes to the same dimension — a true driving
    dimension. Tree bodies get the feature; direct bodies are resized in place; both
    paths are one undo step. Repeated edits of the same dimension update the existing
    scale feature instead of stacking nodes.
  - **Integration**: FeatureEditor edits scale targets numerically; studio3d project
    save/load serializes/deserializes scale features; NumericPrompt.test constructor
    hack replaced with a real FeatureTree (fixes a latent tsc error).
  - **Remaining open**: VLM face-picking, OCCT-grade curved STEP import.
- `2026-09-01`: v0.5.0 release — deep-completion passes #1–#7 packaged (1683 tests / 111 files; lint/tsc/build/E2E/cargo check OK).
  - **Exact geometry engine**: Manifold-3d WASM booleans + exact planar split with
    warm-up and voxel fallback; voxel kernels moved to a Web Worker (sync fallback);
    three-mesh-bvh accelerated picking; inside-point tests with per-face AABB rejection.
  - **Parametric modelling**: sweep (twist, path-subdivided) and loft (perimeter-resampled
    rings) features; incremental DAG recompute memo keyed on feature object identity;
    feature-tree undo/redo; face-scoped shell; driving `scale` feature from drawing edits.
  - **Sketch**: tangent + symmetric constraints (12 total), corner fillet
    (intersection → tangent arc → trim), type-ahead exact dimensions while drawing.
  - **Sub-entity selection**: Alt+click edges (scopes fillet/chamfer), Ctrl+click faces
    (shell open faces), with status-bar discoverability hints.
  - **Drawing workspace**: per-body dimensions with click-to-edit write-back, section
    views with hatched cut faces, SVG/PNG/DXF/PDF export, title block.
  - **IO**: STEP faceted B-rep import (round-trip safe), 3MF OPC package round-trip,
    Tauri native save/open dialogs + Rust-side autosave.
  - **QA**: 5 tautological test files replaced with real coverage; Playwright E2E smoke
    suite + CI e2e job; in-app NumericPrompt replaced every window.prompt();
    version synced across package.json / Cargo.toml / tauri.conf.json.
- `2026-09-01`: Pass #8 — OCCT-grade curved STEP import (1695 tests / 112 files green; lint/tsc/build/E2E OK).
  - **Dependency choice**: started with opencascade.js (63 MB) — its default
    build binds almost no embind constructors (STEPControl_Reader, TopExp_Explorer,
    BRepMesh, even gp_Pnt are unusable), so STEP reading is impossible there
    without a custom build. Swapped to **occt-import-js** (7.3 MB wasm, same
    OCCT core, purpose-built STEP/IGES/BREP reader + mesher): validated against
    real curved files (as1-oc-214 assembly: 18 named/colored parts; conical
    surface: 416 tris; rounded cube: 40 tris).
  - **Exact import path** (`stepOCCT.ts`): lazy code-split chunk + wasm fetched
    only on first curved import; `ReadStepFile` at 0.1 mm absolute deflection
    (parallel meshing, mm output). Mesh → SolidBody conversion welds duplicated
    positions, emits one face per triangle (poly-solid convention), derives
    model edges as feature edges of the triangle soup (open boundaries plus
    segments bending > 25° — cylinder rims/cube corners, not tessellation
    noise), and carries STEP product names + rgb colours. Assemblies import as
    one body per part.
  - **Dispatcher** `importSTEPAuto`: text scan for curved surface/edge tokens
    (CYLINDRICAL/CONICAL/SPHERICAL/TOROIDAL/B-spline surfaces, circles,
    ellipses…) routes curved files to the exact kernel; planar files stay on
    the pure faceted parser; any kernel failure (offline, OOM) falls back to
    it. ProjectMenu shows a toast when the exact kernel ran. Test seam
    (`__setExactStepLoaderForTests`) keeps the 7.3 MB wasm out of unit tests.
  - **E2E + fixtures**: curved fixtures (conical-surface, rounded-cube, from
    occt-import-js's LGPL test data) imported through the real UI in
    Playwright — wasm chunk load, parse, convert, tree entry (2.1 s).
  - **Remaining open**: VLM face-picking (needs external vision API).
- `2026-09-04`: Pass #9 — beginner-friendly deep UX round (1745 tests / 120 files green; lint/tsc/build OK).
  - **Parts library ("补仓")**: `lib/library/parts.ts` — a 25-part parametric catalog
    (practical-size basics, mechanical hardware: hex nut M8 / washer / bushing /
    flange / L & U brackets / z12 gear / knob, M3–M8 hole cutters, fun starters:
    star / pyramid / arch / steps) built from the existing geometry kernels
    (profiles, lofts, exact-or-voxel booleans, box merges; sphere/coil seated on
    the bed). `PartsLibrary` panel (B / PrimitiveBar Shapes button): search box
    (English + Chinese keywords), category chips, recently-used row, one-click
    staggered insert that selects the new body; every part also registered in the
    command palette and as the AI tools `insert_library_part` / `load_sample_project`.
  - **Viewport drag-move**: left-press on a body arms a ground-plane drag (grab
    cursor), movement snaps to the grid with a live "Δ x, z mm" readout, Ctrl =
    free placement, one undo entry per drag (a press-without-motion drops the
    no-op snapshot), Esc cancels the whole drag; grabbing an unselected body
    selects it first so the whole selection slides together. Feature-tree bodies
    stay put (use a feature to move them, same rule as arrow nudge).
  - **Fusion-style bottom timeline** (`TimelineBar`): the feature tree as chips in
    build order with per-type icons and parameter summaries (`featureSummary`),
    click selects the produced body, double-click opens the shared
    FeatureEditDialog, right-click offers suppress / delete, plus a recompute
    button. Auto-hides when the tree is empty; shown in model + sketch workspaces.
  - **Welcome guide**: first-run card on an empty model scene — quick actions
    (insert box / open library / start sketch / ask AI via a `scenelab:open-ai`
    event the AIPanel now listens for), four one-click starter projects (phone
    stand, pen cup, gear assembly, nameplate — dirty-document guarded), and a
    persisted 4-step checklist (insert → move → ai → save) credited by the
    actual actions (addDirectBody, drag/nudge end, AI send, explicit save).
    Session-hide X + permanent dismiss, recoverable via the command palette.
  - **Shortcuts**: B toggles the parts library; new ShortcutsHelp rows for the
    library and drag-move. i18n: 70+ new keys in both locales, incl. per-part
    names, sample names, feature-type chip labels (sketch/sweep/loft/scale/arrays
    were missing) — enforced by tests that walk the catalogs against both maps.
  - **Tests**: parts/samples catalogs (build → positive volume, finite bbox, bed
    rest, bilingual names), search/filter, featureSummary, formatDragDelta,
    store actions (staggered insert, recent parts, onboarding dedupe/persist,
    drag undo semantics), welcome-card visibility rule.
  - **Remaining open**: VLM face-picking (needs external vision API); timeline
    drag-reorder; multi-sketch loft UI.
- `2026-09-04`: Pass #9 — tactile operation round: drag-to-move + quick keys (1745 tests / 120 files; lint/tsc/build/E2E 4/4).
  - **Drag a body to move it** (the last big missing viewport interaction): left-press
    on a body grabs the whole selection and slides it on a level plane through the
    grab point — grid-snapped deltas (Ctrl = free move), grabbing an unselected
    body selects it first, hover shows a grab cursor / dragging grabbing. The whole
    drag is ONE undo entry (lazy snapshot, per-frame silent translates); a press
    without motion is a plain click (empty snapshot dropped); Esc mid-drag undoes
    the entire drag and consumes the key (new top-priority branch in escapeAction).
    Store seam: beginSelectionDrag / dragSelectionBy / endSelectionDrag /
    cancelSelectionDrag + translateSelectionLive (silent core shared with
    nudgeSelected).
  - **Quick keys**: E opens the extrude dialog when a sketch exists (Fusion muscle
    memory); Ctrl+I isolates the selection.
  - **Discoverability**: shortcuts help gains drag/E/Ctrl+I rows; status-bar
    selection hint now mentions drag-to-move.
  - E2E: real drag through the UI — insert → grab → slide (grid-snapped 5,-2) →
    single Ctrl+Z restores exactly. Suite also adapted to the parallel welcome-card
    work (localStorage-dismissed up front; exact toolbar-button names).
  - NOTE: working tree also contains a parallel session's uncommitted work
    (welcome card/onboarding, parts library, timeline bar) — this pass is verified
    green alongside it but NOT committed to avoid entangling their in-progress
    changes.
- `2026-09-04`: Pass #10 — learn-from-the-leaders interaction round (1756 tests green; lint/tsc/build/E2E 4/4 OK).
  - **Click-to-edit sketch dimensions** (Fusion): the length/radius labels the sketch
    already renders are now hit-testable in the select tool — `pickSketchDimension`
    projects the same anchors the sprites use to screen space (14 px radius), a hit
    opens the shared NumericPrompt, and the typed value drives the entity through
    the new `resizeSketchLine` (rescales about the midpoint, direction kept) /
    `resizeSketchCircle` (radius only, centre kept) store actions.
  - **Live section analysis** (Fusion): `sectionAnalysis {active, axis, offset,
    flip}` state + `sectionPlane()` pure math (offset always measured along +axis;
    flip only picks the kept half — caught by a unit test) drives a global
    `renderer.clippingPlanes` slice. New floating `SectionPanel` (bottom-right,
    model workspace): toggle button (X shortcut), X/Y/Z axis tabs, offset slider
    ranged to the scene's bounding box, flip button, "view-only" hint. Command
    palette: toggle + per-axis entries.
  - **Paste in place** (SolidWorks Ctrl+Shift+V): `pasteInPlace()` deep-copies the
    clipboard via a zero-offset translate so copies land exactly on the originals,
    selects them, one undo step.
  - **Guard fix**: the central shortcut map now yields the 'x' key to the rect
    type-ahead buffer's "WxH" separator while a draw is in progress (X would
    otherwise toggle section analysis mid-typing).
  - E2E: the drag-move test (concurrent WIP) now passes; suite is 4/4.
- `2026-09-04`: Pass #11 — recents + viewport polish, v0.6.0 release (1760 tests / 122 files green; lint/tsc/build/E2E 4/4 OK).
  - **Recent tools in the right-click menu** (Fusion): `runCommand` now records a
    capped (12) deduplicated history; `recentCommands()` feeds a "Recent" submenu at
    the top of the empty-space viewport menu. View/select/paste/measure menu items
    were re-routed through `runCommand` so they land in the history too.
  - **Ground shadows** (Fusion/SolidWorks viewport look): the key light casts a
    PCF-soft shadow onto an invisible ShadowMaterial plane just under the grid;
    body meshes always declare castShadow and the toggle flips light.castShadow +
    ground visibility (no material recompiles). Status-bar button (SunDim icon),
    `view.toggleShadows` command, persisted `scenelab.groundShadows`, default on.
  - **v0.6.0**: version synced across package.json / Cargo.toml / tauri.conf.json /
    Cargo.lock; user-facing CHANGELOG.md added (v0.6.0 entry summarizing passes
    #9–#11; earlier releases referenced).
- `2026-09-14`: Pass #12 — market-parity interaction + real perf fixes, v0.7.0 (1769 tests / 122 files green; lint/tsc/build/E2E OK).
  - **Timeline drag-reorder** (the last signature Fusion interaction still
    missing): `FeatureTree.moveFeature` + pure `canReorderFeatures` enforce
    dependency order — a feature must stay after its parents and before its
    dependents; store `moveFeature` recomputes and is one undo entry (illegal /
    same-place drops push nothing, like a click-without-drag). TimelineBar chips
    are HTML5-draggable with a blue insertion indicator, not-allowed cursor at
    illegal targets (dragover simply isn't prevented → native blocked cursor,
    no drop event), a "can't reorder past a dependency" toast for denied drops,
    and Alt+←/→ keyboard reorder for accessibility (a11y + Fusion parity).
    Memoized recompute makes a reorder free: same feature objects + same parent
    results → everything reuses cached bodies.
  - **Preview-transform drag** (real perf fix): dragging a body used to remap
    every vertex/face/edge and rebuild mesh + normals + **BVH** on every
    pointermove (guaranteed jank on real parts). Now `dragSelectionBy`
    accumulates a `dragOffset` preview applied as `mesh.position` /
    edges transform — zero geometry rebuilds mid-drag, same body object
    references (mesh cache hits, asserted by test). `endSelectionDrag` bakes
    the offset as ONE undoable translate (fresh meshes at final position, no
    snap-back frame); Esc just drops the preview since geometry was never
    touched. Feature-tree bodies don't preview (they don't move — by design).
  - **On-demand shadow map**: `renderer.shadowMap.autoUpdate = false`; the
    2048² depth map re-renders only when shadow-casting geometry changes
    (mesh-rebuild effect tracks a dirty flag), during drag previews, or when
    shadows are re-enabled — not on every rendered frame.
  - **Solver perf guard**: benchmark test — a 25-line chain with 50+
    constraints (horizontal + distance + coincident) must solve < 100 ms
    (the roadmap metric finally has a test watching it).
  - **Nudge modifier steps** (Fusion-style): Shift = 10 mm coarse, new
    Alt = 0.1 mm fine, default 1 mm — both for 3D selection nudge and in-sketch
    entity nudge (× gridSize); ShortcutsHelp + i18n updated (en/zh).
  - **v0.7.0**: version synced across package.json / Cargo.toml / tauri.conf.json /
    Cargo.lock; CHANGELOG entry added.
  - **E2E env fix**: Vite 8 on this Windows host binds IPv6 `::1` only, so the
    Playwright readiness probe on IPv4 never turned green (webServer timeout).
    `--host 127.0.0.1` + `baseURL`/`url` pinned to 127.0.0.1 in
    playwright.config.ts — the drag E2E then passed against the new
    preview-transform flow.
  - **Remaining open**: VLM face-picking (needs external vision API semantics);
    multi-sketch loft UI is DONE (FeatureEditor ctrl+click → Create Loft —
    the earlier "remaining" note was stale).
- `2026-09-19`: Pass #13 — agent-team round: VLM face-picking closed + perf sweep (1814 tests / 123 files green; lint/tsc/build/E2E 4/4/cargo OK; v0.8.0).
  - **Method**: three parallel read-only audit agents (UX-parity gaps, render
    hotspots, VLM feasibility), then two implementation agents (palette/tree,
    expressions) + coordinator (viewport/AI) with strict file ownership to
    avoid merge conflicts.
  - **VLM face-picking CLOSED** (the last standing todo item): the model now
    estimates a point over the feature it means (x,y normalized to the image
    it was shown) and calls `select_face_at_viewport`, which dispatches a
    synchronous `scenelab:pick-face` event; the viewport raycasts with the
    live camera (projection-aware), maps `triFaceIds[faceIndex]` exactly like
    Ctrl+click, selects the body FIRST then the faces (scopedFaceIds needs
    the body selected), and resolves the tool's Promise in-place (2 s timeout
    when no viewport is mounted). Crop-region captures are mapped back to
    full-viewport coordinates inside the tool. Companion tools: `select_face`
    (by id), `clear_face_selection`, `select_body`; system prompt teaches
    "pick before modify" (face ids regenerate after edits) and retry-once.
  - **Numeric expression fields** (Fusion/SolidWorks parity): new
    `lib/dimension.ts` recursive-descent parser (`+ - * /`, parens, unary,
    `pi`, exponent notation; NO eval/Function; null on invalid/non-finite) —
    NumericPrompt / ExtrudeDialog / feature NumericEditDialog keep raw text
    while editing, evaluate on commit, live `= result` preview, red-border +
    disabled-confirm on invalid input.
  - **Fuzzy command palette**: `searchCommands` upgraded from plain substring
    to word-boundary-weighted substring + subsequence scoring, multi-token
    AND, label>id>category weights (`zmsl` → Zoom to selection, `vtwf` →
    view.toggleWireframe). `view.fitAll`/`view.fitSelection` registered
    (dispatch `scenelab:fit-view`, handled by the viewport).
  - **Browser tree filter** (Fusion browser search): live name filter over
    bodies/reference geometry/feature history with `n/total` count, X clear,
    Esc clears; pure helper in `lib/treeFilter.ts`.
  - **Perf sweep (audit-driven)**: dropped `preserveDrawingBuffer` via a
    fresh-render capture service (`lib/render/capture.ts`; AIPanel + PNG
    export + screenshot helpers render immediately before reading pixels);
    `viewport-camera-update` now fires only when the camera actually moved;
    sketch rubber-band preview is allocation-free (size-cached marker
    materials + LiveTextSprite redrawing one canvas in place — no per-
    mousemove canvas/CanvasTexture/GPU uploads); ResizeObserver early-outs
    when size/DPR are unchanged.
  - **Deferred (documented, not faked)**: async BVH build for very large
    imports — three-mesh-bvh 0.9 ships no worker generator; needs a custom
    MeshBVH.serialize/deserialize worker. Sketch offset tool, Alt+drag
    duplicate (Alt is edge-pick), 'M'-for-measure (M is workspace switch)
    all conflict with existing bindings — candidates for a future keymap pass.
  - **v0.8.0**: version synced (package.json / Cargo.toml / tauri.conf.json /
    Cargo.lock).
- `2026-09-19`: Pass #14 — sketch offset entity (1824 tests / 124 files green; lint/tsc/build/E2E 4/4 OK).
  - **Offset entity** (SolidWorks 草图等距偏移): `offsetEntity` in the sketch
    engine copies a line perpendicular to itself (signed distance), grows/shrinks
    circles and arcs about their centre (negative = inward, refuses collapse),
    points/unknown ids rejected. Store `offsetSketchEntity` pushes one sketch-
    undo entry, selects the new entity, and drops the snapshot again when
    nothing was created (a no-op offset can't pollute undo).
  - **Entries**: SketchToolbar action button (MoveDiagonal icon, disabled without
    an offsetable selection) + the sketch right-click menu — both open the shared
    NumericPrompt with a signed distance (negative allowed for inward offsets);
    the prompt's label says so in both locales (sketch.offset / offsetPrompt).
  - No hotkey on purpose — candidates were noted for a future keymap pass.
- `2026-09-19`: Pass #14b — v0.8.1 hotfix release. The v0.8.0 tag shipped a
  mid-edit bvhWorkerClient (called undeclared `computeBoundsTree()`), so CI
  typecheck and all four Release builds failed with no usable artifacts; the
  concurrent follow-up fix (construct `MeshBVH` directly) plus the sketch
  offset entity landed on main. v0.8.1 packages both with a CHANGELOG entry
  noting that 0.8.0 has no working artifacts. Lesson recorded: verify with a
  clean `tsc -b` (stale tsbuildinfo masks tag-content type errors).
- `2026-09-19`: Pass #14c — loop-offset completion + QA hardening, v0.9.0 (1835 tests / 125 files green; lint/tsc/build/E2E 4/4/cargo OK).
  - **The toolbar Offset button could never work on hand-drawn loops**: the
    loop walk only accepted SHARED point ids, but the freehand line tool
    creates fresh points per segment. Junctions now match by POSITION
    (6-decimal coordinate key, same convention as features/tree.ts's
    chainLineLoop), so hand-drawn closed profiles offset like Fusion's.
  - **Real bug fixes found by the new tests**: (1) CW-wound loops had a
    double sign flip — miterOffsetVertex's normals are already winding-aware,
    the extra `d = -distance` flip sent CW offsets INWARD; (2) the shoelace
    orientation check misses self-intersecting inward offsets (acute-corner
    spikes cross over without flipping net area) — replaced with the standard
    per-vertex side-of-polygon validity test (outward vertices must be outside
    the original, inward ones inside); (3) the offset copy's junctions now
    SHARE point ids (new `engine.addLineBetween`) instead of 2n fresh points,
    matching the rectangle tool's topology so copies re-chain cleanly.
  - **Coverage**: 11-test suite for offsetSketchProfile/miterOffsetVertex
    (circle out/in + collapse refusal, arc sweep kept, rectangle frame
    12×8 from 10×6, CCW triangle outward with miter-extension lengths +
    perpendicular-distance invariant + <3° parallelism band, CW outward,
    inradius-violation rejection with zero mutation, open-chain/NaN/unknown-id
    rejection, miter spike clamp ≤ d/0.35).
  - **v0.9.0**: version synced across the four manifest files; CHANGELOG entry.
- `2026-09-19`: Pass #14c — release-process fix. v0.8.0 AND v0.9.0 tags both
  shipped mid-edit states (an undeclared-method call; then JSX inside a .ts
  test file) that local checks missed because the concurrent session's fixes
  were already in the working tree. Both root causes are now fixed on main;
  v0.9.0 re-tagged on the fix commit. New rule for releases: verify the exact
  COMMITTED tree (git stash -u → lint/tsc/vitest → pop) before tagging, never
  the working tree, and always with tsbuildinfo cleared.
- `2026-09-19`: Pass #15 — drag-and-drop import + constraint badges (1860 tests / 127 files green; lint/tsc/build/E2E 4/4 OK).
  - **Drag-and-drop import** (TinkerCAD/Fusion/Onshape parity): `lib/io/importFiles.ts`
    extracts the mesh-import routing from ProjectMenu into one shared entry point
    (`classifyDroppedFile` pure router + `importMeshFile` + `openProjectFile`);
    `DropZone` adds window-wide dragenter/depth-counted overlay ("Drop to import",
    supported types listed) and routes drops — meshes merge, a `.studio3d`
    replaces the scene after the dirty guard, unknown types toast the accepted
    list. ProjectMenu's picker now calls the same importer.
  - **Constraint badges** (Fusion/SolidWorks): `constraintGlyphs` maps every
    applied constraint to an anchor + glyph (H, V, ∥, ⊥, ●, FIX, =, D<value>,
    R, ⊙, T, SYM) — rendered green beside the amber size labels in the sketch
    viewport, so sketches show both their sizes and their rules.
- `2026-09-19`: Pass #16 — release v0.10.0 (1860 tests / 127 files green; committed-tree gates + E2E 4/4).
  - **Animated view transitions** (Fusion feel): 'viewport-camera-snap' now
    tweens over 250 ms — view direction rotates along the sphere via quaternion
    slerp (identity→full-rotation partial application, which also handles the
    exact 180° front↔back flip), up-vector eases, ease-out cubic; the pivot is
    controls.target (the old code re-anchored to the world origin and silently
    changed zoom after panning). Cancelled by a new snap, ViewCube drag
    (onOrbit) or any manual orbit start (controls 'start'), and on unmount.
  - **Scope-explicit fillet/chamfer labels**: the body context menu now says
    "Fillet all edges…" vs "Fillet {n} selected edge(s)…" based on the
    Alt+click edge sub-selection — empty-scope-means-all was correct behaviour
    but invisible; i18n en/zh, deps array fixed for selectedEdgeIds.
  - v0.10.0 packages passes #15 (drag-and-drop import, constraint badges) and
    #16; version synced across the four manifests, CHANGELOG entry added.
- `2026-09-20`: Pass #17 — the todo-zeroing round: keymap + drawing detail/notes + AI pick ack, v0.11.0 (1895 tests / 128 files green; lint/tsc/build/E2E 5/5/cargo OK).
  - **Keymap pass (the standing "future keymap" item)**: plain **M now toggles
    Measure** (SolidWorks/Onshape muscle memory; sketch-mode gated); the model-
    workspace jump moved to **Shift+M** (Esc already returns from sketch).
    Registry `view.measure` carries the shortcut; ShortcutsHelp rows updated
    (en/zh).
  - **Alt+drag clone** (Fusion/SolidWorks clone-drag): Alt+drag on a body
    duplicates the selection lazily on FIRST motion (a plain Alt+click stays
    the edge sub-selection and never leaves copies), shows the `copy` cursor,
    then slides the copies like a normal drag. Moved drags suppress the
    trailing click (an Alt-drag would otherwise toggle an edge pick on
    release). Verified end-to-end in Playwright: object count 1→2.
  - **Drawing detail views** (Agent E): toolbar Detail toggle → click a view →
    25 mm-radius crop of that projection at 2×, rendered in a growing strip
    below the sheet with a circular border, "DETAIL A (2:1)" labels (A…Z, AA),
    dashed source circle on the parent view (Fusion convention); segment–
    circle chord clipping (`clipViewToCircle`) beside the existing section
    half-space clip; right-click deletes. Panel size capped at 0.45×cell with
    an honestly-recomputed ratio label.
  - **Drawing notes** (Agent E): toolbar Note toggle → click the sheet →
    inline editable text note (Enter/Escape/blur, empty drops), hover-× /
    right-click delete; SVG export emits `<text>`, PNG/PDF include notes via
    the canvas snapshot route.
  - **AI face-pick acknowledgement**: the `scenelab:pick-face` listener now
    toasts the picked body's name alongside the orange face highlight.
  - **Honest limitation recorded**: drawing state (details/notes/section axis)
    is session-scoped — `.studio3d` does not serialize any drawing data today
    and no file-format was invented for this pass; adding drawing
    serialization is the natural next pass.
  - **v0.11.0**: version synced across the four manifests; CHANGELOG entry.
- `2026-09-20`: Pass #18 — drawing-sheet persistence + history, v0.12.0 (1904 tests / 128 files green; lint/tsc/build/E2E 5/5/cargo OK).
  - **Drawing state is now document state**: `SerializedDrawing` block in the
    `.studio3d` project file (sectionAxis + details + notes) with defensive
    `deserializeDrawing` (unknown axis / non-array fields fall back to
    defaults). Optional field, FILE_VERSION unchanged — old files load clean,
    old app versions ignore the block. Wired through every save path (Ctrl+S /
    native save / autosave / crash-recovery snapshot) and load path (browser /
    native / autosave restore). Sheet edits set projectDirty.
  - **Undo covers the sheet**: HistorySnapshot extended to
    {directBodies, hiddenIds, features, drawingSectionAxis, drawingDetails,
    drawingNotes}; every drawing action (note add/update/remove, detail
    add/remove, section-axis change) pushes exactly one entry — modelling and
    sheet edits interleave in one LIFO history (tested).
  - **`add_drawing_note` AI tool**: sheet-coordinate optional; default
    placement stacks down the left margin (never overlapping); rejects empty
    text; one undo entry. Contract-tested (4 cases).
  - DrawingCanvas's local sectionAxis state moved into the store
    (`drawingSectionAxis`) so the axis survives save/load and undo.
  - **v0.12.0**: version synced across the four manifests; CHANGELOG entry.
- `2026-09-21`: Pass #19 — sketch trim/extend + measure-hover caching, v0.13.0 (1930 tests / 129 files green; lint/tsc/build/E2E 6/6/cargo OK).
  - **Trim** (Agent F + coordinator wiring): `lib/sketch/trim.ts` — line
    pieces between segment-segment intersections, the clicked piece deleted,
    kept pieces REUSE existing junction point ids by position key (rectangle
    corners stay id-shared, constraints survive); no crossings → whole entity
    deleted (Fusion "trim to nothing"); a line-cut circle becomes the arc
    complement of the deleted span. Click-then-act: viewport click picks the
    entity and drives the cut in one motion, tool stays armed for consecutive
    cuts, miss shows a bilingual hint. One sketch-undo entry per action
    (snapshot self-cleans on failure).
  - **Extend** (Agent F): line endpoint nearest the click moves to the
    closest forward crossing; arcs sweep along their own growth direction to
    the first full-circle line hit outside the current span; circles rejected;
    no boundary → warning toast, geometry untouched.
  - **Measure-hover snap caching** (coordinator): vertices + edge midpoints +
    face centres cached per body REFERENCE (position-keyed invalidation,
    >64 entries reset) — measuring over large imported bodies no longer
    rebuilds thousands of points per mousemove.
  - **E2E**: M toggles measure (aria-pressed both ways) + the status-bar
    `↺ n` history-depth readout appears after an edit.
  - **v0.13.0**: version synced across the four manifests; CHANGELOG entry.
  - Noted for a future pass: trim ON an arc (currently lines/circles only);
    >2-point circle cuts emit a single complement arc.
- `2026-09-21`: Pass #20 — arc trim + multi-span cuts + AI sketch editing + dialog i18n, v0.14.0 (1943 tests / 129 files green; lint/tsc/build/E2E 6/6/cargo OK).
  - **Arc trim**: sweep-space parameterization (t ∈ [0, span] along the arc's
    own direction, CW-safe); only crossings INSIDE the arc's span bound
    pieces; the clicked piece goes, each surviving piece stays as an arc with
    the same centre/radius/construction flag; uncrossed arcs trim to nothing.
    6 new geometry tests (incl. CW arc, doubly-crossed arc → two pieces,
    construction carry).
  - **Multi-span circle cuts**: a 4-crossing circle clicked in one span now
    keeps THREE arcs (one per surviving span) instead of one merged complement
    — Fusion never merges disconnected spans.
  - **AI sketch editing**: trim/extend/offset registered as AI tools operating
    on the active sketch by entity id + sketch coordinates; retryable errors;
    5 contract tests.
  - **Dialog i18n zeroed** (Agent G): audit found 7 of 8 dialogs already
    localized — the real gap was FeatureEditor's edit dialogs (hardcoded
    "Edit Revolve"/"Distance (mm)"/"Symmetric"/Cancel/Apply…). Now fully
    bilingual; 8 new key pairs; zh uses the map's existing CAD terminology;
    bilingual render tests; a11y label/htmlFor pairs added on touched fields.
  - **v0.14.0**: version synced across the four manifests; CHANGELOG entry.
- `2026-09-21`: Pass #21 — agent-team round: measure angle/area + sketch-entry fix + E2E 6→9, v0.15.0 (1972 tests / 129 files green; lint/tsc/build/E2E 9/9/cargo OK).
  - **Measure angle + area** (Agent H math/store + coordinator viewport
    wiring): HUD mode switcher (distance/angle/area, aria-pressed);
    angle = 3 points (vertex-middle, `angleAtVertex` degrees), area = one
    face click (fan-triangulated area + area-weighted centroid); angle
    results save as persistent annotations; mode switch resets picks;
    hover preview suppressed in area mode. 22 new math tests (rotation
    invariance, Newell cross-check, degenerate guards) + 5 store tests.
    Known naming wart recorded: measure.ts `angleAtVertex(vertex,a,b)` vs
    snap.ts `angleAtVertex(a,b,c)` (vertex-middle) — migrate the snap.ts
    call sites in a future pass.
  - **E2E expansion** (Agent I): trim flow (entity counter 6→5, Ctrl+Z → 6),
    extrude-dialog expression (`20/2` with live `= 10` preview → timeline
    chip + body), drawing-note flow (place/edit/dirty-dot/undo-depth). Each
    new test verified with --repeat-each=3; full suite 9/9 twice.
  - **Real UX bug found by the E2E agent and FIXED** (coordinator): the
    toolbar / S-key entered "sketch active" without creating a
    `currentSketch` — every drawing tool silently no-op'd until a datum
    plane was clicked. `setWorkspace('sketch')` now starts a sketch on the
    current/default plane when none exists (existing sketches resume
    untouched); 2 store tests.
  - **Known fidelity item recorded (not fixed)**: undo/redo always set
    projectDirty — undoing back to the saved state doesn't clear the dirty
    dot. Proper fix needs a last-saved snapshot comparison
    (src/store/app.ts undo/redo). Noted for a future pass.
  - **AI system prompt** now teaches trim/extend/offset sketch editing tools.
  - **v0.15.0**: version synced across the four manifests; CHANGELOG entry.
- `2026-09-21`: Pass #22 — agent-team round: data safety + dirty fidelity + 4 E2E-found bug fixes, v0.16.0 (1993 tests / 130 files green; lint/tsc/build/E2E 12/12/cargo OK).
  - **Boot autosave-restore banner** (Agent J): probe-only on boot (no
    auto-restore existed — investigation confirmed); Restore reuses
    restoreAutosave's deserialize path, Discard clears the localStorage key
    (native Rust snapshots have no clear command — they age out via the
    newest-20 prune, noted in code); session-dismiss keeps the key. 14 tests.
  - **Dirty-dot fidelity** (coordinator): saved-state fingerprint captured on
    explicit save / load / new; undo+redo compare against it — returning to
    exactly the saved state clears the dot (4 tests, incl. rename-only
    difference stays dirty).
  - **E2E round 3** (Agent K): timeline HTML5 drag-reorder AND Alt+→ keyboard
    reorder through a real two-entry sketch→extrude build; measure three-point
    angle + Area mode (400 mm² exact on a 20mm cube). Suite 9→12, each new
    test --repeat-each=3 ×2. Playwright config gains E2E_PORT (host's 5174 is
    squatted by an unkillable Docker proxy).
  - **Four real bugs the E2E agent found, all fixed by the coordinator**:
    (1) in-place tree mutation never notified subscribers — keyboard
    reorders left stale chip labels; `featureVersion` counter now bumps on
    every tree mutation and TimelineBar/FeatureEditor subscribe to it;
    (2) StatusBar selection-hint wrapped at 1280px and overlapped the
    timeline (truncate now); (3) ExtrudeDialog Enter didn't commit from the
    input (dialog-level Enter handler, button-target guard against double
    fire); (4) measure HUD sat under the floating primitive bar (moved
    top-2 → top-12, E2E selector updated).
  - **Cleanup**: measure.ts's vertex-first angle helper renamed
    `angleBetweenRays` (no more parameter-order collision with snap.ts's
    vertex-middle `angleAtVertex`); new AI tool `measure_face_area`
    (single face area+centroid, or all-faces list with total; 3 contract
    tests).
  - **v0.16.0**: version synced across the four manifests; CHANGELOG entry.
- `2026-09-22`: Pass #23 — agent-team round: parametric hole feature + QA sweep, v0.17.0 (2015 tests / 132 files green; lint/tsc/build/E2E 15/15/cargo OK).
  - **Parametric HOLE feature** (Agent L + coordinator wiring): Fusion's
    most-used feature. HoleFeature {center, direction, diameter, depth|null};
    evaluator consumes the parent and difference-cuts a Rodrigues-oriented
    cylinder (exact Manifold, voxel fallback; through-all cutter length =
    2× bbox diagonal). Timeline chip (CircleDot icon, ⌀D×depth/∞ summary),
    studio3d round-trip, suppress, `.studio3d` case. Store applyHoleToBody
    (tree → timeline feature; direct → undoable direct edit via the shared
    drillHoleInBody kernel). Entry: body context menu Feature → Hole as two
    chained NumericPrompts (diameter → depth, 0 = through). AI `create_hole`
    (4 contract tests; volume math validated empirically 0.99–1.03 ratios).
    System prompt teaches it.
  - **featureVersion gap fixed in applyModifyFeature too** (coordinator):
    fillet/chamfer/shell/arrays applied via the menu had the same
    stale-timeline-render root cause as the keyboard-reorder bug — the shared
    modify path now bumps the version counter (Agent L's hole action patched
    likewise).
  - **QA sweep** (Agent; first dispatch hit a provider rate limit, re-ran):
    CommandPalette (5 tests: filter/keyboard/execute-via-event/Escape —
    zero coverage before) + SectionPanel (5 tests: axis tabs/offset slider/
    flip/close). E2E 12→15: offset flow (entities 2→4→2 — circle offset adds
    ring + fresh centre point, documented as intended behaviour) and
    restore-banner flow (handcrafted autosave JSON via addInitScript; banner
    shows name+age, Discard clears key, Restore rebuilds the body). Each new
    E2E --repeat-each=3.
  - **v0.17.0**: version synced across the four manifests; CHANGELOG entry.
- `2026-09-22`: Pass #24 — agent-team round: parameters panel + counterbored holes + boot perf, v0.18.0 (2046 tests / 133 files green; lint/tsc/build/E2E 17/17/cargo OK).
  - **Parameters panel** (Agent N): Fusion Parameters-dialog parity — every
    numeric driving value (10 feature types × their params + current-sketch
    distance/radius constraints) in one editable table; edits route through
    updateFeature / new updateSketchConstraintValue (solves + republishes);
    suppressed dimmed; live via featureVersion; palette command. 18 tests.
  - **Counterbore/countersink holes** (Agent O): HoleParams gains optional
    counterbore {diameter,depth} / countersink {diameter,angleDeg} (cbore wins
    when both); countersink = truncated cone with EXACT included angle (depth
    clamp recomputes the truncation radius). GD&T chip summaries (⌴/⌵);
    HoleEditDialog with expression inputs + cross-validation. Volume tests use
    the exact-union formula (the naive one double-counts the hole overlap —
    documented); measured ratio 0.9936 = the 32-gon cutter factor. E2E
    hole.spec.ts: 2 flows (sketch→extrude tree path with chip+undo; direct
    Insert-Box path documented as chip-less direct edit), 3× stable.
  - **Boot perf** (coordinator): vendor split via manualChunks — main chunk
    1441→640 KB (gzip 385→168), three/react/icons cache independently;
    Manifold WASM warmup deferred to requestIdleCallback (2 s timeout cap).
  - **Third featureVersion root-cause fixed** (Agent O found, coordinator
    patched): applyUndoSnapshot bumps featureVersion — Ctrl+Z now repaints
    the timeline/feature lists (same in-place-mutation class as the keyboard-
    reorder and menu-modify bugs).
  - **v0.18.0**: version synced across the four manifests; CHANGELOG entry.
- `2026-10-03`: Pass #25 — audit-driven correctness + AI honesty round, v0.19.0 (2093 tests / 135 files green; lint/tsc/build/E2E 17/17 OK).
  - **Method**: three parallel read-only audit agents (UX parity, code
    quality, AI subsystem), findings verified against source by the
    coordinator, then 4 parallel implementers with strict file ownership
    (store / AI / viewport+drawing / test-truthfulness), i18n keys pre-seeded
    by the coordinator as the single writer, then an independent fresh-context
    review whose 3 P1 + 2 P2 findings were fixed before release.
  - **P0 data loss** (Agent Q): applyModifyFeature's direct-body path never
    set projectDirty — fillet/chamfer/shell/array/mirror edits on direct
    bodies were invisible to the dirty dot/autosave and lost on close;
    setDimensionTarget's direct path had the same hole. Both fixed; a
    same-class sweep found no other direct-body mutation missing the flag.
  - **featureVersion misses #4/#5** (Agent Q): setDimensionTarget (tree path)
    and performLoftFromSketches mutated the tree in place without the bump —
    timeline/ParametersPanel wouldn't repaint (same root cause class as the
    two earlier bugs). Fixed with tests.
  - **No-op undo pollution** (Agent Q): nudgeSketchEntity with no moved
    points and filletSketchCorner failures left sketch-undo snapshots that
    made the next Ctrl+Z restore an identical sketch — now popped on failure
    (the offsetSketchEntity pattern).
  - **arrangeScene** (Agent Q, contract consumer Agent A): whole-scene
    replace as ONE undo entry (undo restores bodies + feature tree; undo
    stacks and projectName survive); arrange_on_plate no longer wipes global
    undo. Known limit (recorded): reference geometry (planes/axes/points/
    annotations) is still outside HistorySnapshot — arrange clears it and
    undo can't bring it back; the fix is a HistorySnapshot extension.
  - **AI honesty** (Agent A): extrude/revolve detect "did a solid actually
    appear" (open-profile → success:false); draw_* / delete_body /
    add_constraint / set_view / set_projection report failure with reasons;
    fillet/chamfer/shell validate positive values + known edge/face ids
    (non-positive silently no-oped while claiming success and leaked an undo
    entry); client.ts marks returned {success:false} tool results as
    is_error per the Anthropic protocol. delete_body on a tree body now says
    "remove its feature instead"; removeDirectBody early-returns for unknown
    ids (no orphan undo/dirty).
  - **AI sketch editing undoable** (Agent A): trim/extend/offset route through
    the undo-snapshotting store actions (the direct-mutation path reset
    sketchUndoStack/sketchRedoStack — a "snapshot before every AI op"
    violation). Independent review caught a regression in the first version
    (offset had silently switched to bare-segment semantics); fixed to the
    toolbar's loop+miter semantics with a 4-new-lines rectangle test.
  - **New AI tools** (Agent A): list_features (timeline inventory via the
    pure featureSummary module) + update_feature (shallow params patch
    through updateFeature — "make the fillet 3mm" is now expressible);
    create_hole accepts counterbore/countersink. System prompt rewritten by
    workflow category (zero old teachings lost, all ~70 cited tool names
    verified to exist), now warns that omitted bodyId defaults to the FIRST
    body in multi-body scenes.
  - **AIPanel robustness** (Agent A): vision fallback targets #viewport-canvas
    (could previously grab the drawing sheet's canvas); message list built
    from a pre-setMessages snapshot (first-send race); the tool-loop's
    {success:false} → is_error mapping is contract-tested.
  - **Parametric arrays in the UI** (Agent V): the store's never-called
    applyLinearArrayFeature/applyCircularArrayFeature now have Feature-menu
    entries (Linear array X/Y/Z with chained count→spacing prompts, Circular
    array with a count prompt, toasts on refusal) — tree bodies get timeline
    features, direct bodies undoable edits; the old destructive Pattern menu
    remains for non-parametric copies.
  - **Duplicate constraint submenu removed** (Agent V): the sketch right-click
    menu rendered "Add Constraint" twice (copy-paste double push). Verified
    by a real-render test that temporarily re-introducing the block fails.
  - **Failure surfacing** (Agent V + coordinator): combine (union/subtract/
    intersect) and hollow failures toast now — combineSelected gained a
    try/catch (worker crash = unhandled rejection before), HollowDialog got a
    busy guard + warning toast + stays-open-on-failure; BrowserTree combine
    items toast too (coordinator). Drawing export toasts + view aria-label +
    viewport centroid label localized (keys pre-seeded by coordinator).
  - **Viewport unmount disposal** (Agent V + coordinator): shared sketch
    materials, gnomon label sprites, grid, shadow ground, AxesHelper — all
    previously dropped, now disposed in the mount-effect cleanup.
  - **Test truthfulness** (Agent T): the 4 tautological test files rewritten
    against real exports (tables moved verbatim to primitives.ts /
    sketchTools.ts / viewcubeViews.ts / viewcubeOrientations.ts — the
    react-refresh rule forbids exporting constants from component files, so
    the established workspaces.ts data-module pattern was used; the 26
    orientation tables actually lived in InteractiveViewCube.tsx).
    Mutation-verified: deleting an entry fails a test. The old SketchToolbar
    test falsely claimed a "polyline" button that never existed. New real
    ViewportCanvas render tests (mocked WebGLRenderer/OrbitControls) cover
    the menu dedupe + array chains; NumericPrompt gained a chained-prompt
    reseed test (second prompt now starts from ITS initial — render-time
    state adjustment, the inner-div key never remounted the state holder).
  - **Remaining open** (next-pass candidates): HistorySnapshot doesn't cover
    reference geometry/annotations (arrange-undo gap); BoxSelection.test.ts
    still tautological (logic lives inside ViewportCanvas.tsx — extract);
    add_constraint doesn't validate unknown entity ids; arrangeScene doesn't
    reset workspace; loft AI tool missing; drillHoleInBody uses the sync
    boolean path (cold-engine cbore chains can block the UI ~seconds);
    sketch mirror entities, camera bookmarks, CAM toolpath visualization +
    store state, drawing center marks/hole callouts, drawing per-view scale
    (all audited, specced, achievable with current kernels).
  - **v0.19.0**: version synced across the four manifests (Cargo.lock via
    cargo update -p scenelab); CHANGELOG entry.
- `2026-10-03`: Pass #26 — performance + convenience + AI-takeover round, v0.20.0 (2190 tests / 139 files green; lint/tsc/build/E2E 20/20 OK).
  - **Method**: three MEASURING audit agents (perf with cold-process timings
    + Playwright traces; usability with live click-count verification; AI
    takeover with per-workflow tool-walkthroughs), findings spot-verified by
    the coordinator, 4 parallel implementers (geometry/perf core, store,
    viewport/palette, AI tools) with locked cross-agent contracts
    (replaceBody boolean refusal; performExtrude boolean + sketch-preserving
    failure), fresh-context independent review (no P0s; 1 P1 + 3 P2s fixed
    pre-release), coordinator handled the cross-agent hole-E2E regression.
  - **Perf (measured)**: per-body AABB WeakMap in isPointInsideBody — voxel
    boolean 1152-face 14.4s→1.1s (~12×), 4608-face 21-55s→4.0s; Map-keyed
    computeAdjacency/computeCurvature 8k faces 3.5s→92ms (39×) and 360→24ms
    (15×); PropertiesPanel battery + Advanced useMemo per selectedBody (was
    253ms/click, recomputed per rename keystroke); fingerprint memo by input
    refs (Ctrl+Z was 160ms + 68MB string @80k faces); autosave skips
    unchanged ticks + one-time quota toast; Manifold warmup after first
    paint + DAG-memo captures engineReady and re-evaluates boolean features
    on the cold→warm flip (the "permanently blocky hole" bug); measure-hover
    overlay update-in-place (zero allocation per mousemove after warm-up).
  - **Plane-aware extrude/revolve (F4, real bug)**: new pure-math
    src/lib/sketch/frames.ts; evaluators map profiles through the sketch's
    own plane and extrude along its normal ('xz' bit-identical to legacy;
    'xy' → +Z; 'yz' → +X); revolve spins about the frame's in-plane axis —
    DELIBERATE behavior change: stored xz-sketch revolves now spin about
    world Z instead of Y. Viewport point markers/rubber-band/label go
    through the frame too (were detached on non-default planes).
  - **Store hardening**: failed extrude/revolve/sweep rolls back both added
    features, pops the undo snapshot, KEEPS the sketch open + toasts the
    evaluator error (was 100% silent + sketch destroyed); HistorySnapshot
    carries currentSketch (deep-cloned)/sketchActive/workspace/sketchPlaneId
    — undo after extrude returns to the sketch; replaceBody REFUSES
    tree-produced bodies (boolean return; was appending overlapping
    duplicates — the AI-takeover W1 killer) and five pattern/split actions
    refuse likewise; fingerprint/autosave per above.
  - **AI takeover**: 11 new tools (undo/redo — routed to the SKETCH history
    while a sketch is active per the review's P1, with prompt caveat +
    contract test; remove_feature; set_feature_suppressed; reorder_feature;
    list_edges capped 200; list_sketch_entities; update_sketch_constraint;
    set_workspace; set_body_hidden; rename_body); fillet/chamfer/shell/
    arrays/mirror route tree bodies through the parametric apply*Feature
    actions (WITH edge/face scoping via setSelectedEdgeIds/FaceIds); array
    count=TOTAL semantics (original = instance 0, coincident copies deduped);
    13 other direct-edit tools hardened against refused tree bodies;
    client maxIterations default 16 (AIPanel 32); export_body returns
    bytes+preview≤200 only (was inlining whole files into context);
    load_sample_project dirty-guard (was hanging the loop on a user
    dialog); system prompt teaches tree workflows/undo discipline/sketch
    read-back/edge addressing.
  - **Viewport/palette**: click-click drawing works (mousedown with an armed
    start commits; stationary release keeps armed — drag still works);
    SketchToolbar exit preserves the sketch (was silently discarding);
    exit pill moved below the toolbar row (was occluded); stale Model(M)
    hints → Shift+M; ShortcutsHelp +5 rows; 26 palette commands for the
    modeling verbs (extrude/fillet/chamfer/shell/hole/mirror/arrays/
    move-rotate-scale/pattern/combine/exports/import) with needBody /
    needsSketch guards — 'extrude' in the palette found nothing before.
  - **E2E**: click-click line + palette-verb specs added (17→20); the hole
    spec's fragile assertions fixed — its centre-click landed on the 'yz'
    datum quad and only passed because the old evaluator flattened every
    plane to xz (removed ≈105 vs threshold 100.5!); now pins the ground
    quad (+40px, documented) + ⌀2 hole for the 3×5mm footprint.
  - **Integration fixes by coordinator**: 15 tsc errors from the parallel
    work (panel memo nullability aliases, MockInstance typing, mirror
    normal-axis→plane mapping x→yz); 3 pre-existing tests that encoded the
    F4 bug (seeds now 'xz'); review P1 (undo sketch routing) + P2s
    (per-op revolve/sweep failure toasts, palette extrude no-sketch guard,
    stale revolve comment).
  - **Remaining open (review P2s + audits, next pass)**: rollback doesn't
    restore redo history; palette labels resolve at registration (don't
    follow runtime locale switches); vertex-key quantization can straddle
    1e-6 buckets (degraded stats on welded imports, not crashes); armed
    drawStart survives tool switches (cross-tool commit quirk); model-undo
    into an older sketch doesn't restore the sketch undo stacks; hole-E2E
    +40px datum click is pixel-pinned (works under the pinned viewport);
    needTwoBodies reuses the one-body message; list_sketch_entities lacks
    a truncated flag; hole click-to-place UI + extrude Cut operation +
    fillet oversize validation (usability audit F2/F5/F8); evaluateSweep/
    Loft still hardcode the xz frame; sketch mirror, camera bookmarks, CAM
    toolpath viz, drawing center marks/callouts, export_file AI tool.
  - **v0.20.0**: version synced across the four manifests; CHANGELOG entry
    (calls out the revolve-axis behavior change).
- `2026-10-03`: Pass #27 — hole placement + AI file deliverables + P2 correctness sweep, v0.21.0 (2230 tests / 139 files green; lint/tsc/build/E2E 22/22 OK).
  - **Hole click-to-place (F2, the audit's "impossible from the UI" item)**
    (Agent U): Feature → Hole ⌀/depth prompts now ARM a one-shot placement
    (hint pill + crosshair via a pendingHoleRef armed by the
    'scenelab:arm-hole' window event — refs can't be touched from render-time
    menu builders); the next left click on the armed body drills at that world
    point through applyHoleToBody's optional center; Esc (dedicated
    stable-deps listener, immune to the mid-dispatch re-registration race)
    cancels; miss stays armed; deleted-body auto-disarm (review fix). Both the
    context menu AND the palette entry arm (review P1 fixed + test).
  - **Hole centre editing** (Agent H): HoleEditDialog + ParametersPanel gain
    centre X/Y/Z rows committing via updateFeature (tree features; direct
    drilled bodies have no params by design) — reusing the diameter field's
    expression machinery verbatim.
  - **AI file deliverables** (Agent E): export_file (stl/obj/3mf/step; all
    bodies default; sanitized filenames — traversal stripped; binary formats
    via a proper Blob+anchor download so STL/3MF don't corrupt through the
    string-only helper; NEVER inlines content) + export_drawing (SVG via a
    verbatim parity clone of DrawingCanvas's views assembly incl. section
    suffix/locale titles/details/notes; duplicated 800×600 sheet constants
    documented). export_body stays as the dry-run validator. PNG/PDF honestly
    UI-only (canvas rendering).
  - **Store/geometry P2s** (Agent Q): rollbackFailedSketchFeature takes
    savedRedo (performExtrude/Revolve/Sweep capture redoStack pre-pushUndo and
    restore on rollback); HistorySnapshot carries sketchUndoStack/
    sketchRedoStack (applyUndoSnapshot + undo/redo current snapshots restore
    them — model-undo into an older sketch no longer mixes sessions);
    evaluateSweep plane-aware via mapSweepProfileToRing/sweepRingBasisAtStart
    (ring basis is left-handed like the xz frame → bit-identical passthrough;
    right-handed xy/yz re-express so profiles don't mirror — review verified
    the chirality math); evaluateLoft sections via sketchToWorld per parent;
    performSweep path along the sketch normal; brep lookupVertexIndex probes
    26 neighbour buckets on quantization miss (goldens unchanged, 200k-fuzz
    consistent).
  - **Viewport/palette polish** (Agent U): stale drawStart discarded when the
    arming tool differs (cross-tool commits impossible) + non-left presses
    ignored in the draw branch; palette labels locale-follow at read time
    (labelKey + commandLabel from the ACTIVE store locale; searchCommands
    searches localized labels — zh works, no re-registration); recents flyout
    converted; needTwoBodies dedicated toast.
  - **Review verdict**: no P0s; P1 (palette hole didn't arm — fixed +
    store-driven test) + 2 nits fixed (stale-body disarm, TextEncoder bytes);
    sweep chirality, snapshot alias-safety, escape-race immunity, locale
    completeness, export sanitization all independently verified sound.
  - **Remaining open (next pass)**: armed placement vs sketch/measure mode
    precedence (entering a mode while armed leaves the pill live but
    unfireable until Esc); new sketch sessions inherit the previous
    session's sketch-undo entries (perform* + setWorkspace bypass
    setCurrentSketch's stack clearing); hole direction is always world −Y
    (side-face clicks drill laterally — face-normal direction is the real
    fix); through-hole shaft click-through starts a sketch; edge-level
    adjacency keys still unprobed; extrude Cut operation (F5); fillet
    oversize validation (F8); sketch mirror / camera bookmarks / CAM
    toolpath viz / drawing center marks (audited, deferred).
  - **v0.21.0**: version synced across the four manifests; CHANGELOG entry.
- `2026-10-03`: Pass #28 — extrude Cut + sketch mirror + hole direction + fillet limits, v0.22.0 (2308 tests / 141 files green; lint/tsc/build/E2E 23/23 OK).
  - **Extrude Cut (F5, twice deferred)** (Agent M): ExtrudeDialog Join/Cut
    radio (Cut needs a selected target — hint + disabled otherwise; hasTarget
    resolves against LIVE bodies so a stale id can't enable a silent no-op —
    review P1 #2); performExtrude(distance, symmetric, op) dual-path —
    tree-target → extrude feature params.op='cut' parenting [sketch, target],
    evaluator consumes the target (consumption only on SUCCESS so a later
    parametric edit that moves the cutter off-target leaves the part visible
    — last-good-state, review P1 #1), cutBodyWithCutter = booleanOp difference
    with an intersect PRE-PROBE (difference can't distinguish a miss) +
    total-removal detection, both honest failures roll back keeping the
    sketch session; direct-target → extrudeSketchBody cutter + one undoable
    direct edit (sketch feature survives); serialization wholesale (join
    stays op-less, byte-identical); chained cuts repoint the selection to the
    result; readiness memo covers cut; timeline chip 'cut 10mm'.
  - **Sketch mirror (three passes deferred)** (Agent K + M's store action):
    lib/sketch/mirror.ts mirrorSketchEntities — reflection about an arbitrary
    line; arcs map φ→2θ−φ with SWAPPED start/end angles so the sweep SIGN is
    preserved (the mirrored image of a CCW arc is genuinely CW — consumers
    treat copies like originals under three.js's CCW-normalizing EllipseCurve);
    junction-id sharing (offset #14c convention) + position-key stitching;
    on-axis endpoint id reuse (half-profiles close against the axis);
    resolveMirrorAxis toolbar rule; one sketch-undo entry, refusal drops the
    snapshot.
  - **Hole direction** (Agent V, contract by M): the placement click
    transforms hit.face.normal by the inverse-transpose normalMatrix,
    negates (inward), passes as applyHoleToBody's 5th arg (normalized;
    zero-vector refused; degenerate transform falls back to omitted = −Y);
    non-uniformly scaled bodies handled. E2E proves lateral side-face
    drilling.
  - **Armed placement owns the click** (Agent V): branch moved to the TOP of
    the click handler (above sketch/Alt-edge/measure) + a useEffect disarms
    when sketchActive/measureActive turn true — the dead-pill trap is gone.
  - **Through-shaft guard** (Agent V): datum-plane branch first ray-tests
    every visible body's combinedBounds — nearest pierced body wins; plane-
    pick only when nothing pierced. Known accepted tradeoff: an AABB-grazing
    ray over an actually-empty gap selects the body instead (documented).
  - **Fillet/chamfer limits** (Agent R + coordinator wiring): maxFilletRadius/
    maxChamferDistance derived from the arc's √2·radius in-plane extent /
    chamfer's exact distance legs → min(adjacentFaceDepth)/2; {max,
    skippedEdges}; AI tools gate BEFORE routing (both modes); the store's
    applyFillet/ChamferFeature refuse with the toast.filletOversize {max}
    toast and no mutation (coordinator per R's spec). Known limitation: a
    whole-body fillet on a 32-seg cylinder clamps to ~R·sin(π/32) via the
    vertical seam edges (honest vs the facet geometry; rim scoping is the
    workaround — recorded).
  - **Sketch-session stack hygiene** (Agent M): perform*/setWorkspace
    fresh-create clear sketchUndoStack/sketchRedoStack; the resume branch
    provably keeps history.
  - **brep edge-key probing** (Agent R): 27×27 endpoint-pair neighbour probes
    on miss only (vertex probing refactored shared); goldens unchanged.
  - **Review verdict**: no P0s; both P1s fixed with regression tests
    (consumption-before-throw → part vanished on parametric edit; stale
    selection enabling a silent no-op) — the join-path crash my first fix
    introduced was caught by the existing interleave test and guarded.
  - **Remaining open (next pass)**: cut chip 'cut' prefix is English (AI-fed,
    acceptable); store oversize guard max===null shows 'max 0 mm' (needs a
    dedicated no-applicable-edges key); hole drill lacks the cut path's miss
    probe (flipped-normal edge case silently no-ops); AABB-graze false
    positives in the through-shaft guard; CW arcs preview as CCW complement
    (pre-existing EllipseCurve quirk); update_feature on fillet/chamfer
    bypasses the limit gate (store guard covers the apply paths); camera
    bookmarks / CAM toolpath viz / drawing center marks still queued.
  - **v0.22.0**: version synced across the four manifests; CHANGELOG entry.
- `2026-10-03`: Pass #29 — deep-audit round: CAM core rewrite + drawing manufacturability + bookmarks, v0.23.0 (2421 tests / 146 files green; lint/tsc/build/E2E 24/24 OK).
  - **Method**: two deep-audit agents (CAM workspace — ran the actual
    generators/gcode; Drawing workspace — machinist's-eye) whose measured
    findings drove two waves of 5 implementers; fresh-context review caught
    a real P0 (miter math) + 3 P1s, all fixed pre-release.
  - **CAM core rewrite** (audit C-2/C-3): the audit PROVED three critical
    defects by execution — axis mapping (every exported program mis-cut;
    Y-up emitted verbatim as machine XYZ), outlines (convex hull → cylinder
    contour was a RECTANGLE, no cutter comp → 3 mm into the wall), multi-op
    G-code (M2 per section → only the first op ever runs). Fixed: XZ-plane
    planning (y=height; gcode X=x/Y=z/Z=y); topSilhouette (half-edge walk +
    material classification + even-odd islands — L-shape concavity and tube
    islands verified by execution); offsetPolygon cutter comp; single-program
    emitProgram (one preamble, Z-only first rapid, modal F, one M2/M30);
    plunge feeds + ramp entry (plungeRate was dead — full-feed vertical
    plunges); pocket final-row clamp + scanline island subtraction + EMPTY
    toolpath when the tool doesn't fit (bbox fallback removed); face
    layering; detectCircularHoles (flood-grouped faces, circle fit ±2%,
    INWARD normals — rejects box corners); grbl/linuxcnc machine profiles
    (expanded pecks vs G83/G80). CAM tests went from existence-asserts to
    geometric regression tests (grid-sampled coverage, peck counts,
    one-M2/no-XY-before-Z) — the audit noted the old shallow asserts are
    exactly why these bugs survived 28 passes.
  - **Review P0 fixed by coordinator**: offsetPolygon's miter lacked the
    1/cos(φ/2) scaling — every box contour/pocket wall was gouged 0.88 mm
    (edges at d·cos45°), and its own test blessed the geometry. Fixed with
    the correct √(2/(1+n·n)) scale (clamped 3.5×) + the codifying tests
    rewritten to the true geometry (±(25+3), area 36, vertex band 18.015).
  - **CAM state/UI**: camSetup + camToolpaths cache in the store (undoable,
    fingerprinted, serialized as an optional defensive `cam` block;
    loadProject seeds the op counter); CAMPanel store-driven (per-op
    enable/remove/regenerate, stock section, body selector — never
    bodies[0], drill hole detect+pin, machine-profile picker, 4 i18n toast
    fixes); stock heights SEEDED from the target body bbox (review P1 —
    the 0/−10 defaults planned below origin-plane bodies); toolpaths
    rendered in the viewport (blue contiguous cutting runs, red rapids/
    plunges, cam workspace only); stale-cache auto-regeneration on
    featureVersion while the CAM workspace is open + visible stale flags
    (review P1 — body ids rotate on every recompute); pocket tool-too-
    large now returns an honest empty toolpath.
  - **Drawing manufacturability** (audit spec 2+1 + the A4 bug): circle
    detection (segment DEDUPE — stacked prism caps project duplicate
    parallel edges that broke the chain walk — + chaining + Kåså
    least-squares arc fit) → DrawingView.centers + REAL arcs (canvas arc
    branch; SVG path A — review fixed the y-mirror so arcs export on the
    correct side of their centre); ASME center crosses (canvas/SVG/
    detail-clipped); hole callouts auto-derived from unsuppressed hole
    features (holeCalloutText shared with summary; leader rim45°→elbow→
    shelf; axis-on views only; section culling) — E2E proves ⌀2×THRU in
    the exported SVG; dimension offset collapse fixed (sheet-px offsets +
    extension lines + unified precision — the audit's 1000 mm body had
    0.05 px gaps).
  - **Viewport**: camera view bookmarks (dedicated persisted store, cap 12,
    context-menu capture/restore via the existing tween event, palette
    commands); CAMERA SYNC INVERSION fixed (a v0.8.0 bug — renderScene
    copied the INACTIVE camera onto the active one every frame, reverting
    user gestures; masked by re-pinning paths; found by the bookmarks
    agent's empirical zoom probe); CW arcs preview correctly (aClockwise
    from the signed sweep — mirror/trim CW arcs were the CCW complement).
  - **P2 sweep**: updateFeature gates fillet/chamfer param edits (pre-check
    via public getResult parent resolution — refuses oversize with toasts,
    gate only fires when the gated value changes); AI update_feature
    reports the refusal (coordinator + contract test); drillHoleInBody
    intersect pre-probe + evaluateHole consumes only on success (a failed
    drill no longer blanks the body); ✂ cut-chip glyph; hole-miss toast.
  - **Remaining open (review P2s + audits)**: detectCircularHoles returns
    nothing on voxel-approximation bodies (cold-engine window; warm up
    first); drill's silent one-hole-at-centre fallback when detection finds
    nothing; safeZAboveStock serialized but unconsumed (wire or drop);
    turningAngles wraps the last open-chain point (can suppress a legit
    arc / flip ccw); regular n≥8-gon bosses get center marks (defensible);
    sheet-DXF (arcs/circles/TEXT/DIMENSIONS entities — currently raw body
    wireframe); hidden-line removal; per-view scale/placement + scale
    labels; SVG title block; tolerance fields; dimension arrowheads
    (spec 3); machine simulation (cam.simulate key seeded, button pending);
    tool-library persistence/editor; B-side: bookmark rename, loft AI tool,
    read_model_file.
  - **v0.23.0**: version synced across the four manifests; CHANGELOG entry.
- `2026-10-03`: Pass #30 — deepest round: 3 measuring audits → 12 implementers → independent review + browser acceptance, v0.24.0 (2559 tests / 149 files green; lint/tsc/build/E2E 25/25 OK).
  - **Method**: kernel-limits audit (measured: 32-gon sagitta tables, fillet overlay
    protrusion, boolean C0/C1, STEP OCCT-rejection, zero parametric drift), a
    cross-feature QA walkthrough (real UI, 9 findings + a CLEAN list), a perf
    re-measure (silhouette quadratic, CAM regen thrash, chunk +17%, memory
    curves) — then CAMPLUS/DXFPKG/STEP/FILLET/ADAPTIVE/PERFFIX/QAFIX-STORE/
    QAFIX-GEOM + coordinator fixes + a final center-mark fix from the browser
    acceptance. Independent review verified every headline by RUNNING code
    (incl. real wasm); browser walkthrough: 6 PASS + 1 defect fixed same-day.
  - **STEP P0 closed** (kernel audit): OCCT rejected every export ("Incorrect
    Syntax"); true root cause a 6-arg EDGE_CURVE (found by mutation experiment,
    beyond the audit's list) + missing canonical chain/FACE_OUTER_BOUND/unit
    DIRECTIONs/MANIFOLD_SOLID_BREP/units. Four-layer oracle: structural unit
    tests, referential round-trip proofs, opt-in real-wasm volume assertions,
    browser E2E (export → in-page OCCT import → 0.01% volume → file re-import).
    Analytic CYLINDRICAL_SURFACE for holes spec'd for next pass (Face tagging).
  - **Concave volume honest** (QA P1; true root cause deeper than the fan
    hypothesis): extrude side normals flipped when the vertex-average centroid
    lands in a concavity; first-triple cross also concave-blind. Newell normal
    + winding-derived extrude normals + ear-clip triangulation (convex fan
    fast path bit-identical) wired through volume/centroid/mass/area/thickness.
    L-profile 0.000% error; tessellated-cylinder goldens unchanged.
  - **Fillet/chamfer stopgap** (kernel audit measured: +volume sign, r·√2
    protrusion, always non-manifold): bisector sign corrected (task spec had
    r/sin — the implementer derived r/cos and 2·halfAngle sweep), closed-shell
    emission (origin-independent divergence), interior quarter-arc. Chamfer
    removal exact to d²·ΣL/2. Coplanar-seam skip added by coordinator (fires
    on voxel-union flat seams — 11708 measured — not overlay walls as first
    commented; review-corrected attribution). Real Manifold-based fillet is
    the next-pass roadmap item; guardrails: non-manifold voxel-cliff warnings
    (throttled) + FH distance-transform isotropic erosion (min wall 0.208→
    1.875+) + ray-grazing jitter fix (182 spurious holes on a perfect cube).
  - **Adaptive tessellation** (kernel audit): adaptiveSegments N(⌀, 0.005mm
    chord tol) threaded via primitive-builder defaults (⌀2 stays 32);
    inscribed-⌀ reporting in hole detection (8/12-gon misclassification dead)
    + drawing circles (relative gate); −0.000000 closure-key fix.
  - **Perf** (re-audit): topSilhouette BVH coverage index 6.4× at 6k faces
    (uniform grid REJECTED — fan slivers flood it, measured); CAM auto-regen
    debounce+fingerprint (5→1 under bursts; fingerprint now includes resolved
    TOOLS too — review catch); main chunk −49% gz (io manualChunks pin);
    autosave compact 3.3× (file export stays pretty — review catch); perf
    canary CI-safe 25ms.
  - **CAM**: machine simulation (event-decoupled rAF, per-move feeds, segment
    highlight); op identity = feature-id binding with repoint-in-regenerate
    (QA P1: param edits killed ops permanently); drill no-holes honest throw
    → stale flag; safeZAboveStock wired end-to-end; tool library persisted +
    editor; pocket row linking with region guard.
  - **QA fixes**: findFeatureIdForBody LAST-producer (hole-after-fillet
    duplication root; fixes cut-target + dim write-back same-cause); tree-body
    copy supported (baked snapshots); AI panel auto-collapses in cam/drawing;
    drawing circle detection on REAL extrude+drill paths (browser-acceptance
    defect, fixed same-day: speculative start-closure + loop carving rules,
    failing-first real-kernel test).
  - **sheet-DXF** (landed report-less, review-verified): CIRCLE/ARC/TEXT(%%c)
    /SOLID arrows/LTYPE+LAYER tables; shared title-block + cutting-plane
    layouts across canvas/SVG/DXF; DrawingCanvas DXF button exports the sheet.
  - **Review verdict**: fit for release, no P0s; coplanar-skip census, BVH
    identity proof, DXF y-flip argument, WeakMap soundness all independently
    verified; 5 one-liner findings fixed pre-release.
  - **Remaining open (next pass)**: Manifold-based real fillet/chamfer/shell
    (Face provenance tagging → analytic STEP cylinders rides along); sim
    cross-op highlight residue + whole-vertex drawRange; pocket canLink
    densification; inscribed-⌀ gate cross-doc; STEP dedup threshold asymmetry;
    MIN_HOLE_FACES <12 note; hidden-line removal; per-view scale/placement;
    dimension arrowheads/tolerances (spec 3); pocket-mouth ring fragmentation
    (degree-35, 2-step-lookahead walker); computeRevolve concave caps;
    2000-edit soak + listener-creak diff (perf audit watch items); the
    recurring "external watcher reverting sibling writes" phenomenon (seen by
    3 agents across 2 passes — unattributed, final states always verified).
  - **v0.24.0**: version synced across the four manifests; CHANGELOG entry.
- `2026-10-03`: Pass #31 — kernel roadmap landing: real Manifold fillet/chamfer/shell + Face provenance → analytic STEP cylinders + per-view drawing control, v0.25.0 (2640 tests / 149 files green; lint/tsc/build/E2E 25/25 OK; browser walkthrough 19/19).
  - **Real Manifold fillet** (KERNEL): cutter = corner-wedge ∩ tangent legs −
    rolling-ball cylinder (the audit's plain cylinder cuts a groove — found
    empirically); 90° within +0.26% of analytic, watertight, post-fillet
    booleans stay exact; overlay retained as cold/non-manifold/reflex
    fallback. **Review's required fix**: the tangent-leg formula had a
    flipped sign (r·tan(φ/2) vs the true r·cot(φ/2)) — 120° edges were
    over-cut 38×, 60° ledged; fixed + hex/tri goldens (0.7%); all prior
    goldens were box-based which is why only 90° ever passed.
  - **Real chamfer/shell**: chamfer via 6 half-space boxes per edge (−0.02-
    0.05% vs corner-corrected); shell convex = exact half-space erosion
    (sealed 2168/open 1768 exact), non-convex = erodedInteriorVoxel +
    Manifold difference (Manifold JS has no 3D offset — verified typings).
  - **Face provenance**: cylinder walls classified in fromManifold (smooth-
    adjacency union-find ≤45° → Jacobi-eigen axis → Kåsa fit → on-circle
    0.1%r + ≥300° + ≥12 verts); 48/156 faces tagged on a drilled box,
    radius exact to 1e-6. Cones (countersinks) not tagged (next pass).
  - **Analytic STEP cylinders** (STEP2): shared CYLINDRICAL_SURFACE per
    source key with faceted boundaries; CIRCLE edges only for isolated
    bands (11.6× shrink) — shared rims keep chords because OCCT SPLITS
    shells on mixed circle/chord rims (+11.8% measured; the spec's "1 face
    + 2 CIRCLEs" was empirically unshippable). Real-body export 16.4MB →
    115KB (142×); OCCT round-trip +0.01%. Threshold asymmetry + grid7
    float-noise fold fixed along the way.
  - **Decimation + concave safety**: coplanar-triangle merge (156→52 faces);
    review found the render/pick fan + toManifold fan wound L-shaped
    decimated faces inside-out — both now ear-clip via triangulateFace
    (volume was always safe; visuals/picking/Manifold-input robustness
    fixed).
  - **Per-view drawing control** (DWG): DrawingViewPlacement store state
    (undo/snapshot/fingerprint/serialize/autosave-restore — walkthrough
    proved placements survive reload); drag (one undo), scale override +
    ratio labels (canvas/SVG/DXF), hide/restore chips, VARIES title-block;
    viewTransform ROW-1 OFFSET pre-existing bug fixed (Right/Iso painted
    over Front/Top since before v0.24.0); projectActions + DXF skip/caption
    wired by coordinator.
  - **P3 sweep**: per-segment sim highlight (walkthrough: tool-highlight
    distance 0-1px mid-segment; cross-op residue cleared); canLink exact
    segment×island-AABB (old 3-sample gouged a 0.6mm island — red-first
    test); Newell revolve caps (Pappus-verified); pocket-ring walker issue
    no longer reproduces on main (stale test fixed); listener soak net-zero.
  - **Review verdict**: approve with one required fix (the τ sign — done);
    A×B tagging↔writer integration verified end-to-end against the real
    classifier + real OCCT (260 edges each referenced exactly twice — no
    split class); doc overclaims ("exactly") honesty-fixed.
  - **Remaining open (next pass)**: cone/countersink provenance + creation-
    side tagging; annulus (multi-loop) cap faces for the full ⌀-hole STEP
    shrink; fillet exact-path edge-id regeneration vs viewport sub-selections;
    bookmark-restore stale status-bar view label (cosmetic); drawing scale-
    field px/mm semantics UX; 8-facet walls tagged at circumradius (7.65%
    recognition bias — deliberate); hidden-line removal; tolerance fields;
    reflex-edge exact fillets (overlay only); non-convex shell worker
    offload; the recurring external-watcher phenomenon (still unattributed;
    final states always verified).
  - **v0.25.0**: version synced across the four manifests; CHANGELOG entry.
