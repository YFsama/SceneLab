# SceneLab

AI-first 3D CAD/CAM — Web-first + Tauri desktop shell.

An Autodesk Fusion 360–like parametric CAD tool where AI is a first-class citizen, not a sidebar plugin. Users drive modeling, constraints, and toolpath generation with natural language.

## Tech Stack

| Layer | Choice |
|-------|--------|
| UI | React 19 + TypeScript (strict) |
| Build | Vite 8 |
| Styling | TailwindCSS 3 + CSS variables |
| State | Zustand |
| Desktop | Tauri 2 |
| 3D Rendering | Three.js r170+ (WebGL) |
| Icons | lucide-react |

## Key Features

- **Recent tools in the right-click menu**: the empty-space viewport menu leads
  with your most recently used commands (palette, views, paste, measure…),
  one click to re-run — Fusion-style.
- **Ground shadows**: bodies cast a soft PCF shadow onto the plane below the
  grid (status-bar toggle), matching the Fusion/SolidWorks viewport look.
- **Click-to-edit sketch dimensions**: the length/radius labels drawn on sketch
  entities are interactive — click one in the select tool and type an exact
  value; lines rescale about their midpoint and circles/arc radii update in
  place (Fusion-style driving dimensions).
- **Live section analysis** (X): a global clip plane slices the 3D view along
  X/Y/Z with an offset slider (range fit to the model) and a flip toggle —
  view-only inspection, geometry is never modified (Fusion's section
  analysis).
- **Paste in place** (Ctrl+Shift+V): clipboard copies land at the originals'
  exact positions instead of the cascading paste offset (SolidWorks).
- **Beginner parts library** (B): a searchable, categorized gallery of 25
  parametric parts — practical-size basics, mechanical hardware (hex nut,
  washer, bushing, flange, L/U brackets, gear, knob), M3–M8 hole cutters and
  fun starter shapes — one click drops each on a staggered plate position
  (TinkerCAD-style). Also reachable from the command palette and the AI
  (`insert_library_part` / `load_sample_project` tools).
- **Drag-to-move bodies**: grab any body with the left mouse button and slide
  it across its height plane with live grid snapping (Ctrl = free), a Δ mm
  readout, one undo step per drag and Esc to cancel the whole drag.
- **Fusion-style bottom timeline**: the feature tree rendered as chips in
  build order with parameter summaries — click selects the produced body,
  double-click edits the feature, right-click suppresses/deletes.
- **Welcome guide + starter projects**: an empty scene shows a first-run card
  (quick actions, four one-click samples — phone stand, pen cup, gear set,
  nameplate — and a persisted getting-started checklist that ticks off
  insert → move → AI → save); reopen it from the command palette.
- **Perspective/orthographic projection toggle** (Shift+P)
- **Sketch constraints**: 12 solver constraint types (tangent, symmetric included). Single-entity ones
  (horizontal / vertical / fixed / radius) apply from the right-click menu or
  shortcuts; select **two** entities (Ctrl/Shift+click) and the menu offers
  parallel / perpendicular / equal / concentric / coincident (nearest endpoints)
  / distance.
- **Interactive 3D ViewCube** with 26 orientations (faces/edges/corners)
- **Box selection** (left-drag rectangle, middle-button orbit)
- **Face selection** (Ctrl+click on body faces) and **edge selection** (Alt+click,
  scopes fillet/chamfer to the picked edges)
- **Construction geometry** (centerlines excluded from extrude/revolve)
- **Polyline tool** (Shift+L, click-to-chain line segments)
- **Persistent measurement annotations** (saved with project)
- **Non-uniform scaling** (per-axis X/Y/Z)
- **Rectangle width/height editing** (detect and resize)
- **Multi-plane sketch support** (XY, XZ, YZ planes)
- **Section views** in the drawing workspace (X/Y/Z mid-plane cut, hatched
  cross-sections) and **PDF export**
- **Sweep & loft features**: twisted sweeps along 3D paths, multi-section
  lofts between sketch features (Fusion-style timeline entries)
- **Editable drawing dimensions**: click a red dimension on the drawing and
  type a new value — tree bodies gain a driving `scale` feature that re-fits
  upstream changes to the same target; direct bodies resize in place
- **STEP import**: exact OCCT kernel (lazy WASM) for curved geometry with a
  faceted fast path and automatic fallback; **3MF round-trip**
- **Feature-tree undo/redo** (snapshots carry the timeline), sketch corner
  fillets, tangent/symmetric constraints
- **Type-ahead sketch dimensions**: while drawing, type digits + Enter to
  commit an exact line length / rect WxH / circle radius; every numeric edit
  goes through the in-app prompt dialog (no browser prompt())
- **Web Worker geometry offload** for voxel fallback kernels; **Tauri native
  save/open dialogs and autosave** on desktop

### Geometry / Solver

| Module | Choice |
|--------|--------|
| Mesh B-rep | Hand-rolled poly-solid kernel (`lib/geometry/brep.ts`) |
| Exact booleans | **Manifold** (WASM) with a voxel fallback (`booleanOp`) |
| Sketch solver | Hand-rolled relaxation, 12 constraint types (`lib/sketch/solver.ts`), sketch corner fillets |
| Picking | Raycaster accelerated by **three-mesh-bvh** |

The exact WASM engine warms up at app start; until it is ready — or for inputs
it cannot convert — booleans transparently fall back to the voxel approximation
(32³ occupancy grid, blocky results).

### AI Integration

| Module | Choice |
|--------|--------|
| LLM | Claude API (direct browser access) |
| Vision | Viewport screenshot → model |
| Tool calling | Every modeling op registered as a tool |

## Project Structure

```
src/
├── components/
│   ├── panels/       # AIPanel, BrowserTree, CAMPanel, FeatureEditor, PartsLibrary, PropertiesPanel, TimelineBar
│   ├── toolbar/      # Toolbar, SketchToolbar
│   ├── ui/           # ConfirmDialog, ExtrudeDialog, StatusBar, ToastHost, SkipLink, ProjectMenu
│   └── viewport/     # ViewportCanvas, ViewCube, DrawingCanvas
├── lib/
│   ├── ai/           # LLM client, tool registry, ~30 built-in tools, validation
│   ├── cam/          # Toolpaths, G-code, tool library, feeds & speeds
│   ├── features/     # Feature tree + evaluators (extrude/revolve/sweep/loft/fillet/chamfer/shell/scale/array/mirror)
│   ├── geometry/     # B-rep primitives & mesh ops (pure functions, zero DOM)
│   ├── hooks/        # useEscapeClose, useFocusRestore, useKeyboardShortcuts
│   ├── io/           # Import/export: studio3d, STEP (OCCT exact + faceted), STL, OBJ, DXF, 3MF, drawing SVG/PDF, screenshot
│   ├── library/      # Parts library catalog + starter sample projects (pure builders)
│   ├── print/        # 3D-print analysis & optimization (pure functions, zero DOM)
│   └── sketch/       # 2D sketch engine + constraint solver (zero DOM)
├── store/            # Zustand store (serializable state only)
└── styles/           # Global CSS + Tailwind
```

## Capabilities

### Modeling

- **Primitives**: box, cylinder, sphere, cone/frustum, torus, wedge — all with
  analytic outward normals and consistent winding (correct, translation-invariant
  volumes; watertightness is asserted in tests).
- **Feature tree**: sketch → extrude / revolve / sweep (straight path + twist),
  plus fillet (arc-segment approximation), chamfer (per-face offset), shell,
  linear & circular arrays, and mirror — created from the body context menu and
  evaluated as a DAG. On tree-produced bodies these are **parametric**: the
  operation joins the timeline and replays on recompute; on AI-created/imported
  bodies they apply as undoable direct edits. Consuming ops replace their parent
  so the output stays a single solid. Sketch profiles support lines (chained
  into an ordered loop), polylines, rectangles, circles and arcs. Construction
  geometry (centerlines) excluded from profiles.
- **Loft / sweep geometry**: multi-section skinning with per-arc-length
  resampling and ring alignment (`createLoftSections`); loft is a feature-tree
  type (multi-sketch UI pending — use explicit sections or the AI tool today).
- **Body ops**: translate, rotate (Rodrigues), uniform & per-axis scale, mirror,
  merge bodies, exact WASM booleans (union / difference / intersect, voxel
  fallback), weld near-coincident vertices (mesh repair), bounding-box stock
  block, and arrange-on-plate packing.
- **Mass properties**: volume-weighted center of mass, bounding sphere.

### 3D-print analysis & optimization (`lib/print`)

Overhang/support detection (bed faces excluded), support-material volume, mass
for common materials, build-volume fit + scale-to-fit, static stability
(tip-over margin), first-layer bed contact & warp tallness, recommended build
orientation + apply (`orientForPrint`), filament length / mass / time / layer
count, print **cost** (material + machine time), boundary-loop (hole) detection,
and a one-call **print-readiness** assessment.

### AI (`lib/ai`)

~96 operations are registered as Claude tools and run through a proper tool-use
loop (the model is system-prompted with role + units, sees each tool's result,
and can chain steps). The assistant can create primitives, sketch/extrude/
revolve/sweep, edit & pattern bodies, move/rotate/scale/orient them, arrange
on the plate, import/export meshes (STL/OBJ/STEP text), repair & inspect,
manage the scene (delete/clear/describe), measure, apply constraints, set
materials, and answer print questions. **Vision**: toggle the Eye icon to
attach a viewport screenshot to the next message (Claude multimodal).

### CAM (`lib/cam`)

3-axis pocket/contour/drill/face toolpaths, ISO G-code, a tool library, and a
feeds & speeds calculator (surfaced in the CAM panel and as an AI tool).

### Persistence

Projects save/load as `.studio3d` round-tripping the full parametric feature
tree **and** direct (AI-created/imported) bodies. Theme, locale and the AI API
key persist across reloads.

### IO (`lib/io`)

studio3d (JSON project) · STL (import auto-welds vertices / export) ·
OBJ (import/export, polygon-preserving) · 3MF (export) · STEP (AP203 faceted
export; true B-rep import awaits an OCCT integration) · DXF · PDF · PNG · SVG.

## Scripts

```bash
npm run dev          # Start dev server (web)
npm run build        # tsc + vite build
npm run lint         # ESLint
npm run test         # vitest (watch)
npm run test:run     # vitest (single run, CI)
npm run preview      # Preview production build
npm run tauri dev    # Run the desktop app (Tauri shell)
npm run tauri build  # Build a desktop installer for the current OS
```

## Desktop builds & CI

Two GitHub Actions workflows live in `.github/workflows/`:

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `ci.yml` | push to `main`, every PR | Frontend lint + typecheck + vitest + build, and Tauri `fmt`/`clippy`/`check` |
| `release.yml` | push tag `v*`, or manual dispatch | Builds desktop clients for **macOS (arm64 + x64), Windows, and Linux** |

`release.yml` uses [`tauri-action`](https://github.com/tauri-apps/tauri-action):

- **Tag push** (`git tag v0.1.0 && git push --tags`) → installers are attached to a
  draft GitHub Release for that tag.
- **Manual run** (Actions tab → *Release* → *Run workflow*) → installers are uploaded
  as downloadable workflow artifacts (no release is created).

Output bundles per platform: `.dmg`/`.app` (macOS), `.msi`/`.exe` (Windows),
`.AppImage`/`.deb`/`.rpm` (Linux).

> Code signing is not configured. To sign/notarize, add the relevant secrets
> (`APPLE_*`, `TAURI_SIGNING_*`, Windows cert) and pass them to `tauri-action`.

Desktop icons are generated from `src-tauri/icon-source.svg` via
`npm run tauri icon src-tauri/icon-source.svg`.

## Architecture Principles

- **lib/geometry/** — B-rep pure functions, zero DOM, zero React
- **lib/sketch/** — 2D sketch + constraint solver, zero DOM
- **lib/features/** — Feature definitions + DAG recalculation
- **lib/cam/** — Toolpath generation (independent engine)
- **lib/io/** — File format import/export
- **lib/ai/** — LLM integration + tool registration
- **components/** — Rendering / interaction only, no business logic
- **store/** — Zustand store, serializable state only
- **src-tauri/** — Native commands (fs, dialog, shell, OS integration)

## Performance

- Viewport renders at 60 FPS (target: 100k triangles)
- BVH-accelerated raycasting for body/face picking (three-mesh-bvh)
- Incremental mesh rebuild: only changed bodies re-upload to the GPU
- Exact booleans run in WASM (Manifold) instead of JS voxel sampling
- Slow voxel kernels (hollow, boolean fallback) run in a **Web Worker** — exact
  WASM results stay on the main thread, occupancy sampling does not block the UI

## Quality

- Every `lib/*` module has vitest tests (1695+ tests, 112 files) plus Rust unit tests
- AI tool calls have contract tests (input → expected output)
- Geometry verified with analytic checks: volumes vs closed-form formulas,
  translation invariance, and watertightness (no boundary loops); exact booleans
  verified to closed-form volumes (e.g. 875 mm³ cube difference)
- ESLint + tsc strict + zero warnings required for merge
- CI runs lint + typecheck + tests + build, plus Rust fmt/clippy/check

- **Playwright E2E** smoke flows (app boot, insert via context menu) — `npm run test:e2e`

## License

Private — all rights reserved.
