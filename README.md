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

- **Perspective/orthographic projection toggle** (Shift+P)
- **Sketch constraints**: 10 solver constraint types. Single-entity ones
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

### Geometry / Solver

| Module | Choice |
|--------|--------|
| Mesh B-rep | Hand-rolled poly-solid kernel (`lib/geometry/brep.ts`) |
| Exact booleans | **Manifold** (WASM) with a voxel fallback (`booleanOp`) |
| Sketch solver | Hand-rolled relaxation, 10 constraint types (`lib/sketch/solver.ts`) |
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
│   ├── panels/       # AIPanel, BrowserTree, CAMPanel, FeatureEditor, PropertiesPanel
│   ├── toolbar/      # Toolbar, SketchToolbar
│   ├── ui/           # ConfirmDialog, ExtrudeDialog, StatusBar, ToastHost, SkipLink, ProjectMenu
│   └── viewport/     # ViewportCanvas, ViewCube, DrawingCanvas
├── lib/
│   ├── ai/           # LLM client, tool registry, ~30 built-in tools, validation
│   ├── cam/          # Toolpaths, G-code, tool library, feeds & speeds
│   ├── features/     # Feature tree + evaluators (extrude/revolve/fillet/chamfer/shell/array/mirror)
│   ├── geometry/     # B-rep primitives & mesh ops (pure functions, zero DOM)
│   ├── hooks/        # useEscapeClose, useFocusRestore, useKeyboardShortcuts
│   ├── io/           # Import/export: studio3d, STL, OBJ, DXF, 3MF, screenshot
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

- Every `lib/*` module has vitest tests (1657+ tests, 110 files) plus Rust unit tests
- AI tool calls have contract tests (input → expected output)
- Geometry verified with analytic checks: volumes vs closed-form formulas,
  translation invariance, and watertightness (no boundary loops); exact booleans
  verified to closed-form volumes (e.g. 875 mm³ cube difference)
- ESLint + tsc strict + zero warnings required for merge
- CI runs lint + typecheck + tests + build, plus Rust fmt/clippy/check

> Playwright E2E for workspace flows is planned but not yet set up.

## License

Private — all rights reserved.
