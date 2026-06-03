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
- [ ] 5 basic constraints: horizontal, vertical, parallel, equal, distance _(only H/V inference + direct driving-dimension edits; no real solver/constraints yet — see Remaining #5)_
- [x] Exit sketch → extrude → first solid body
- [x] Project file `.studio3d` save / load (with feature tree)

### v0.2 — "Complete parts" (~+1 month)

- [ ] Extrude / revolve / sweep / loft — 4 core features
- [ ] Fillet / chamfer / shell
- [ ] Pattern: linear / circular / mirror
- [ ] Browser tree (left panel) + timeline (bottom)
- [ ] Feature parameter double-click edit + recalculation

### v0.3 — "AI assists" (~+1 month)

- [ ] AI panel (reuse Vector Studio implementation)
- [ ] Register all modeling tools for AI
- [ ] Natural language commands:
  - "Draw a 100×50×20 block, drill a ⌀30 hole on the top face" → direct part output
  - "Add 2mm fillet to all outer edges" → auto-select edges and fillet
  - "What's the total mass? Use ABS density" → call measure tool
- [ ] Vision: user can circle a face and ask "Can I add a rib here?"

### v0.4 — "External exchange" (~+1 month)

- [ ] STEP import / export
- [ ] STL export
- [ ] 3MF export (with color)
- [ ] Screenshot / PNG export

### v0.5 — "Communication" (~+1 month)

- [ ] Drawing workspace: 3D → 2D projection + annotation
- [ ] Auto dimensioning (AI-assisted)
- [ ] PDF export
- [ ] DXF export

### v0.6 — "Manufacturing" (~+1 month)

- [ ] CAM basics: 3-axis pocket / contour
- [ ] G-code output (reuse Vector Studio `plotter.ts` approach)
- [ ] Tool library basics (endmill / ballnose / V-bit)

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

---

## Remaining Usability Work (TODO) — as of 2026-06-03

对标 SolidWorks / Autodesk Fusion 仍未完成的项。每轮一个小目标；改完 `tsc -b` +
eslint + vitest + cargo check 全绿后单独 commit 并 push 到 main。

> 现状说明：上面 v0.1/v0.2 清单里的“sketch tools / exit→extrude / save-load /
> pattern / tree edit / feature param edit”等大多**已实现**（见上方 changelog），
> 但内核类项（真 fillet/chamfer、真布尔、约束求解器、STEP）仍是占位或缺失。

### P0 — 高价值、明显缺口
1. **框选 / 矩形拖拽多选** — ✅ 已完成 (中键旋转 + 左键拖矩形框选 + body 中心投影包含测试 + Shift/Ctrl 追加选择)。
2. **子实体选择（面/边）** — ✅ 基本完成 (`triFaceIds` 映射 + vertexColors + Ctrl+click 面选择 + 面高亮)。
   边选择尚未实现（需 edge ID 映射）。

### P1 — 真正的建模内核（当前近似/占位）
3. **圆角/倒角 Fillet/Chamfer** — ✅ 已改进 (Fillet: 8 段圆弧近似混合面; Chamfer: 按面法向偏移 4 点菱形面)。
   仍非真 B-rep（保留原始面，边界处非流形），但视觉效果大幅提升。
4. **布尔运算是体素的（块状）** — 已改进但仍为体素方法 (分辨率 32, 保留原始实现)。
   真网格布尔需集成 manifold-3d WASM 或 OCCT — 长期内核工程。
5. **草图约束系统** — ✅ 基本完成 (求解器已支持全部 10 种约束类型 + 右键菜单/快捷键约束 UI + undo)。
   多实体约束(平行/垂直/等长/重合/距离)需双选实体 UI；切线/对称约束尚未暴露 UI。
6. **多基准面草图** — ✅ 已完成 (`SKETCH_PLANE_FRAMES` + 法向求交 + 局部 2D 变换 + 相机/渲染/预览一致)。

### P2 — 中等价值、独立可做
7. **透视/正交切换** — ✅ 已完成 (`ProjectionMode` + `OrthographicCamera` + 视锥自动匹配 + Shift+P/按钮/右键菜单/命令面板/AI 工具)。
8. **完整视图立方** — ✅ 已完成 (InteractiveViewCube: 26 朝向面/边/角, 拖拽旋转, 悬停高亮, 实时同步主相机, 事件通信)。
9. **测量/标注持久化** — ✅ 已完成 (`AnnotationDefinition` + 保存按钮 + 项目序列化/反序列化 + 视口渲染 + 右键菜单删除)。
10. **工程图(Drawing)工作区**：基本占位。3视图投影/剖视/标注/标题栏。**独立大模块。**
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
