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
│   ├── ai/           # LLM client, tool registry, built-in tools, validation
│   ├── cam/          # Toolpath generation, G-code output, tool library
│   ├── features/     # Feature tree, DAG recalculation
│   ├── geometry/     # B-rep operations, mesh operations (pure functions, zero DOM)
│   ├── hooks/        # useEscapeClose, useFocusRestore, useKeyboardShortcuts
│   ├── io/           # File format import/export (studio3d, STL, DXF, 3MF, screenshot)
│   └── sketch/       # 2D sketch engine + constraint solver (zero DOM)
├── store/            # Zustand store (serializable state only)
└── styles/           # Global CSS + Tailwind
```

## Scripts

```bash
npm run dev          # Start dev server (web)
npm run build        # tsc + vite build
npm run lint         # ESLint
npm run test         # vitest (watch)
npm run test:run     # vitest (single run, CI)
npm run test:e2e     # Playwright
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

- Every `lib/*` module has vitest tests
- Workspace switch paths covered by Playwright E2E
- AI tool calls have contract tests (input → expected output)
- Geometry operations have golden file comparisons
- ESLint + tsc strict + zero warnings required for merge

## License

Private — all rights reserved.
