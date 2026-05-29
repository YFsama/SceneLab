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
| 3D Rendering | Three.js r170+ (WebGPU, WebGL2 fallback) |
| Icons | lucide-react |

### Geometry / Solver

| Module | Choice |
|--------|--------|
| B-rep kernel | Replicad (OCCT.js wrapper) |
| Sketch solver | planegcs (FreeCAD solver, wasm) |
| Boolean / mesh | manifold-3d |
| Topology naming | Custom + FreeCAD 0.21 ElementMap reference |

### AI Integration

| Module | Choice |
|--------|--------|
| LLM | Claude API (direct browser access) |
| Protocol | MCP (HTTP + SSE) |
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
- **Feature tree**: sketch → extrude / revolve, plus fillet, chamfer, shell,
  linear & circular arrays, and mirror, evaluated as a DAG. Consuming ops replace
  their parent so the output stays a single solid. Sketch profiles support lines
  (chained into an ordered loop), rectangles, circles and arcs.
- **Body ops**: translate, rotate (Rodrigues), uniform scale, mirror, merge
  bodies, and weld near-coincident vertices (mesh repair).

### 3D-print analysis & optimization (`lib/print`)

Overhang/support detection (bed faces excluded), support-material volume, mass
for common materials, build-volume fit + scale-to-fit, static stability
(tip-over margin), first-layer bed contact & warp tallness, recommended build
orientation + apply (`orientForPrint`), filament length / mass / time / layer
count, print **cost** (material + machine time), boundary-loop (hole) detection,
and a one-call **print-readiness** assessment.

### AI (`lib/ai`)

~40 operations are registered as Claude tools and run through a proper tool-use
loop (the model sees each tool's result and can chain steps). The assistant can
create primitives, sketch/extrude/revolve, edit & pattern bodies, move/rotate/
scale/orient them, import meshes (STL/OBJ text), repair & inspect them, manage
the scene (delete/clear/describe), and answer print questions ("how much
filament?", "will it tip?", "is it ready to print?", "best orientation?",
"feeds & speeds for this tool?").

### CAM (`lib/cam`)

3-axis pocket/contour/drill/face toolpaths, ISO G-code, a tool library, and a
feeds & speeds calculator (surfaced in the CAM panel and as an AI tool).

### IO (`lib/io`)

studio3d (JSON project) · STL (import auto-welds vertices / export) ·
OBJ (import/export, polygon-preserving) · 3MF · DXF · PNG · SVG.

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
- Any operation >16ms offloaded to Web Worker
- GPU pick buffer for selection highlights (no raycaster)
- BVH acceleration for large meshes (three-mesh-bvh)
- Incremental DAG for geometry recalculation

## Quality

- Every `lib/*` module has vitest tests (300+ tests)
- AI tool calls have contract tests (input → expected output)
- Geometry verified with analytic checks: volumes vs closed-form formulas,
  translation invariance, and watertightness (no boundary loops)
- ESLint + tsc strict + zero warnings required for merge
- CI runs lint + typecheck + tests + build, plus Rust fmt/clippy/check

> Playwright E2E for workspace flows is planned but not yet set up.

## License

Private — all rights reserved.
