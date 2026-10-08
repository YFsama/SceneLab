# SceneLab — Roadmap & Working Queue

> AI-first 3D CAD/CAM — Web-first + Tauri desktop shell
> **当前版本 v0.26.0** · 详见 [CHANGELOG.md](CHANGELOG.md)（用户向历史）与 git log（技术细节）。

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
- v1 offline-first; cloud/collaboration is a v2 question

---

## Status Snapshot — v0.26.0 (2026-10-09)

| 维度 | 状态 |
|------|------|
| 测试 | **2733 vitest / 158 文件**；**E2E 30/30**（+canvas-resize ×2、responsive ×3）；cargo 6；浏览器走查（IAB 输入派发受限，事件级验证 + E2E 补位） |
| 版本 | v0.18.0 → v0.26.0 共 9 个版本，32 个开发轮次（pass #1–#32） |
| 可靠性 | 全局错误捕获（errorLog 环形 100/持久 30）+ ErrorBoundary + 诊断对话框（复制/保存/预填 issue 反馈）+ 错误 toast 复制 |
| 平台 | getOS/getPlatform 检测；⌘/⌥ 快捷键显示；⌘+点击修复；视口三画布 DPR 变更响应；工程图画布补 resize |
| 布局 | <960px compact：侧面板渲染层抑制（持久化偏好不动）；800×600 无横向溢出、视口 ≥400px（E2E 固化） |
| 安装/启动 | NSIS 每用户 + 中英双语 + 语言选择器（conf 级验证，**待 CI 出包实拍**）；启动 splash；窗口居中；save_text_file；shell.open 白名单 github.com |
| AI | ~121 个注册工具（含 undo/特征管理/文件交付）；maxIterations 16/32；诚实失败协议 |
| 几何内核 | Manifold 精确布尔（预热后）；**真 Manifold 圆角/倒角/抽壳**（90° 圆角 +0.26%、水密）；Face 溯源标记；自适应细分；参数化往返漂移实测为零 |
| 互操作 | STEP 导出 OCCT 可读（FreeCAD 级）；解析圆柱面（同体 16.4MB→115KB）；STL/OBJ/3MF/DXF(sheet)/SVG/PDF |
| CAM | XZ 平面规划正确轴向；真轮廓+刀具补偿；grbl/LinuxCNC 双轮廓；机床仿真；工序随参数化编辑存活 |
| 性能 | 体素路径 AABB 缓存（~12×）；邻接 Map 索引（39×）；主 chunk gzip −49%；指纹 memo；自动保存跳过无变更 |
| 方法 | 三层验证文化：金测试 → 独立审查（可运行验证）→ 真实浏览器走查；连续三轮拦截规格级错误 |

### Tech Stack（现状，非最初规划）

| Layer | 实际使用 |
|-------|--------|
| UI | React 19 + TypeScript strict, hooks only |
| Build | Vite 8（manualChunks 分包：io/three/react/icons） |
| Styling | TailwindCSS 3 + CSS variables |
| State | Zustand（app.ts 单店 + viewBookmarks 独立店） |
| Desktop | Tauri 2（原生保存/打开对话框 + Rust 侧自动保存） |
| 3D | Three.js r170（WebGL2、three-mesh-bvh 拾取、按需阴影） |
| 精确几何 | manifold-3d WASM（布尔/圆角/抽壳/分割）+ 体素回退（Web Worker） |
| 草图 | 自研引擎 + 松弛求解器（12 种约束） |
| STEP | 自研 AP203 写出（OCCT 验证）+ occt-import-js（曲面导入） |
| LLM | Claude API 直连（浏览器）；tool-use 循环 |

### Architecture Rules（仍然有效）

- `lib/geometry/` B-rep 纯函数；`lib/sketch/` 2D + 求解器；`lib/features/` DAG 重算（memo 按特征对象身份）；`lib/cam/` 独立刀路引擎；`lib/io/` 导入导出；`lib/ai/` LLM + 工具注册——全部零 DOM 零 React
- `components/` 只做渲染交互；`store/` 可序列化状态 + HistorySnapshot（含草图会话与 CAM setup）
- 任何 >16ms 的操作进 Worker；拾取走 BVH；编辑走增量 DAG

### Quality Rules

- 每个 lib/* 模块 vitest 覆盖；几何黄金测试对照**解析公式**（非实现回声）
- ESLint + tsc strict 零告警；发布前对**提交树**全门禁（清 tsbuildinfo——旧教训）
- 三层验证：金测试 → 独立审查（新鲜上下文、可运行验证）→ 真实浏览器走查

---

## 工作队列（合并去重，按优先级）

> 这是唯一的待办清单。各轮遗留的 "Remaining open" 已全部并入此处；
> 完成后移入下方历史表。

### A. 几何内核（内核审计路线图剩余）

- [ ] **锥面/沉头孔溯源**：Face.source 目前仅圆柱（`kind:'cylinder'`）；加 `'cone'`（countersink）并在 tree.ts 创建侧直接打标（比输出分类更稳）
- [ ] **环形（多环）cap 面**：孔穿透的平面 cap 目前保持刻面内边界——Face 模型支持多环后，⌀ 孔的 STEP 才能完全收缩（当前孤立带 11.6×、共享轮辋仍刻面）
- [ ] **凹边精确圆角**：选到 reflex 边时精确路径整体拒绝→覆盖层回退（减材刀具无法加材）；需要加材侧补偿或真 rolling-ball
- [ ] **非凸抽壳 Worker 化**：同步 res-40 体素内部体 ~0.2s（签名约束为同步）
- [ ] **隐藏线消除**（工程图审计 B5，L）：深度分类投影段 + 虚线隐藏样式——圆柱/剖切的线汤可读性
- [ ] maxFilletRadius 浅二面角 caveat（圆柱接缝切向伸展 ~10r→修正后 ~0.1r 已缓解，重推精确界）
- [ ] 圆角后精确路径边 id 再生 vs 视口子选择按 id 失效（改按几何键解析）
- [ ] 8-facet 壁按外接半径标记（识别偏 7.65%，有意取舍——记录）

### B. 工程图

- [ ] **尺寸箭头 + 公差字段**（spec 3 剩余）：延伸线/文本已就位；实心箭头（DXF SOLID 已有）补 canvas/SVG；公差 +/- 双字段与存储化覆盖
- [ ] 比例字段 px/mm 语义 UX（"2:1" 可能让小件更小——tooltip 已披露，考虑按当前适配比预填）
- [ ] 书签恢复后状态栏视图标签陈旧（外观）
- [ ] 书签重命名 UI（store 已支持自定义名）
- [ ] 真 DIMENSION/DIMSTYLE DXF 实体（R12 深坑，当前 LINE+TEXT 务实替代——记录）

### C. AI 接管

- [ ] `loft` 工具（store 的 performLoftFromSketches 已有）；`read_model_file`（Tauri fs 读 STEP/STL 供 import_mesh——当前工具只收文本内容）
- [ ] 工程图 detail/section 的 AI 工具（set_workspace 已有；add_drawing_detail/set_section 缺）
- [ ] 循环中视觉刷新（多轮视觉精修在单次发送内无法重新定向——截图仅随用户消息附带）
- [ ] 模型选择器（AIConfig.model 字段已存在未使用；DEFAULT_MODEL 硬编码）

### D. UX（历轮审计立项未做）

- [ ] **草图转换实体**（Convert Entities：把体边投影到草图平面为参考线——审计高分项，M）
- [ ] **浏览器树文件夹/分组**（assembly-lite，M-L）
- [ ] 样条草图实体（SketchEntity 联合类型加曲线——求解器/拾取/链化全链路，L）
- [ ] 孔点击定位的面法向钻孔在直接体上的工程图标注（feature 派生 by design——至少文档说明）

### E. 基础设施 / 流程

- [ ] **NSIS 安装器实机验证**（pass #32）：currentUser/SimpChinese+English/语言选择器仅 conf 级（cargo check 编译期校验）——下次 release CI 出包后人工确认安装界面与每用户安装行为
- [ ] **工程图导出分辨率随窗口**（pass #32 行为升级）：DrawingCanvas 背衬跟随容器（原固定 800 逻辑分辨率）——小窗导出可低于旧分辨率；如需稳定输出可加导出最小分辨率钳制
- [ ] **"外部观察者回写"现象**：3 个 Agent 跨 2 轮报告文件被回退到秒级前快照（最终态均已复验）——未归因；候选：并发 Agent 的 git 操作/测试运行重建
- [ ] **启动冒烟门禁**：任何 pass 落地前 page-loads+#viewport-canvas 挂载检查（QA 审计建议——单测绿但模块图断曾让 dev 无法启动）
- [ ] 2000-edit 长浸泡 + GPU 侧内存盲区（renderer.info 生产构建不可达）
- [ ] E2E 端口 5174 被僵尸进程占据（环境问题，E2E_PORT 可绕）；vite watcher 已忽略 src-tauri/target（EBUSY 曾杀死 dev server，pass #32 根治）

---

## 方法备忘（多 Agent 开发循环）

1. **审计先行**：实测型审计（性能数字 / UI 点击数 / 工具走查），发现按 file:line 核实
2. **并行实现**：严格文件所有权 + 预置 i18n 键（单写入人）+ 锁定跨 Agent 契约（签名写入双方简报）
3. **集成**：主 Agent 修 tsc/跨文件缝隙/一行项；诊断预存红测（先复现→根因→语义修复而非改测试，测试仅在新几何现实下现实化并注释缘由）
4. **三层验证**：全门禁（lint/tsc 干净 tsbuildinfo/vitest/E2E）→ 独立审查（新鲜上下文，头条声明以运行代码验证）→ 浏览器走查（真实 UI 全流程 + 破坏性游荡）
5. **发布**：四清单版本同步（Cargo.lock 走 cargo update）、CHANGELOG、feat+release 两提交、**对提交树**最终验证

教训库（各轮沉淀）：斜切缺 1/cos 缩放、切线腿符号翻转、OCCT 混合轮辋撕壳——**规格本身可能错，实现者要推导验证而非照抄**；测试断言解析真值而非实现回声；vitest 不查类型（tsc -b 是独立门禁）。

---

## 历史一览（pass #1–#31）

> 用户向明细见 CHANGELOG.md；每轮技术细节见 `git log --format=%B`（feat 提交信息）。

| Pass | 日期 | 主题 | 版本 |
|------|------|------|------|
| #1–#8 | 05-29 ~ 06-16 | 脚手架→四大特征→AI→IO→工程图→CAM→加固→审计 | v0.1–v0.4 |
| #9–#13 | 08-30 ~ 09-19 | 深度补全：精确布尔/参数化修改/扫掠放样/性能/UX 平价 | v0.5–v0.8 |
| #14–#17 | 09-19 ~ 09-21 | 环偏移/keymap/工程图详图注释/AI 选面 | v0.9–v0.11 |
| #18–#20 | 09-20 ~ 09-21 | 工程图持久化/裁剪延伸/圆弧裁剪/AI 草图编辑 | v0.12–v0.14 |
| #21–#23 | 09-21 ~ 09-22 | 测量角度面积/E2E 扩张/数据安全+脏点保真/孔特征 | v0.15–v0.17 |
| #24 | 09-22 | 参数表面板/沉头锥沉孔/启动性能 | v0.18.0 |
| #25 | 10-03 | 正确性清扫/AI 诚实性/参数化阵列 UI/测试真实性 | v0.19.0 |
| #26 | 10-03 | 性能实测修复/平面感知特征/AI 接管（undo/特征管理/树感知） | v0.20.0 |
| #27 | 10-03 | 孔点击定位/孔中心编辑/AI 文件交付 | v0.21.0 |
| #28 | 10-03 | 拉伸 Cut/草图镜像/面法向孔/圆角限值 | v0.22.0 |
| #29 | 10-03 | CAM 核心重写（轴向/轮廓/M2）/工程图中心标记标注/书签 | v0.23.0 |
| #30 | 10-03 | 最深轮：STEP OCCT P0/几何诚实（凹体积/圆角停止间隙）/CAM 仿真/三审计 | v0.24.0 |
| #31 | 10-03 | 真 Manifold 圆角倒角抽壳/Face 溯源→解析 STEP 圆柱/每视图工程图 | v0.25.0 |
| #32 | 10-09 | 平台适配/DPR 变更/响应式布局/帮助美化/安装启动/错误记录复制上报 | v0.26.0 |
