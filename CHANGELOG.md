# Changelog

All notable changes to SceneLab are documented here. Dates are YYYY-MM-DD.

## [0.8.0] — 2026-09-19

Theme: **AI 面拾取闭环 + 视口性能清扫** — 补上 todo 中最后一个遗留项
（VLM 面拾取），并由并行审计清掉四个真实渲染热点。

### AI 与操作 (AI & interaction)

- **AI 面拾取闭环 (VLM face-picking)** — 此前 AI 只能"看"不能"点"：现在
  视口截图发给模型后，模型估计目标面上的坐标 (0..1)，调用新工具
  `select_face_at_viewport` → `scenelab:pick-face` 事件 → 视口用真实相机
  射线拾取并设置面选集（与 Ctrl+点击同路径），再链式调用 shell/fillet。
  裁剪区域截图的坐标自动映射回全视口；系统提示词指导"先拾取后修改"
  （面 id 每次重建后会变）。另加 `select_face`（按 id 直选）、
  `clear_face_selection`、`select_body` 三个选区控制工具。
- **数值表达式输入 (Fusion/SolidWorks 式)** — 所有数值对话框（共享
  NumericPrompt、拉伸、特征编辑）现在支持算术：输入 `20/2`、`(30-6)/3`、
  `2*pi*5` 提交计算值；非法输入红框提示且禁止提交；表达式实时预览结果
  （`= 10`）。手写递归下降解析器，零 eval/Function。
- **命令面板模糊搜索** — 从纯子串升级为市场标准模糊匹配：词边界加权、
  子序列匹配（`zmsl` → Zoom to selection）、多 token AND（`zoom sel`）、
  label > id > category 权重分层。
- **浏览树过滤框 (Fusion 式)** — 实体/参考几何/特征历史按名称实时过
  滤，显示 `n/total` 匹配计数，Esc 清空。
- **缩放命令入面板** — `view.fitAll` / `view.fitSelection` 注册进命令面
  板（F / Shift+F 原快捷键不变）。

### 性能 (Performance)

- **去掉 preserveDrawingBuffer** — 新的视口捕获服务在截图/AI 视觉/PNG
  导出前强制渲染一帧，省掉逐帧保留帧缓冲的 GPU 带宽开销。
- **相机事件门控** — `viewport-camera-update` 仅在相机真正移动时派发，
  悬停变色/草图预览不再触发 ViewCube 无效重渲染与逐帧事件分配。
- **草图预览零分配化** — 橡皮筋预览的材质（按尺寸缓存）与尺寸标签
  （LiveTextSprite 原地重绘单张 canvas）全部复用：鼠标移动不再创建
  canvas/CanvasTexture/GPU 上传。
- **resize 早退** — ResizeObserver 尺寸/DPR 未变时直接返回，不再重复
  重分配 drawing buffer。

## [0.7.0] — 2026-09-14

Theme: **对标主流 CAD 的深度打磨** — 补齐 Fusion 360 时间轴拖拽重排这一
标志性交互，并把视口两个真实性能热点做掉（拖拽逐帧重建、阴影逐帧重绘）。

### 操作 (Interaction)

- **时间轴拖拽重排 (Timeline drag-reorder)** — 底部时间轴的 Feature 芯片
  现在可以直接拖拽排序（Fusion 360 标志性交互）：拖拽时显示蓝色插入指
  示条，非法位置（跨越依赖关系）显示系统"禁止"光标并拒绝放置；合法移
  动即时重算。依赖规则：特征必须保持在其父特征之后、其消费者之前。
  键盘无障碍：聚焦芯片后 **Alt+←/→** 单步移动。一次拖拽 = 一条撤销记
  录；非法/原地放置不产生空撤销条目。
- **箭头微调步长修饰键** — ←↑→↓/PgUp/PgDn 微移所选：Shift = 10mm 粗步，
  **Alt = 0.1mm 细步**（新增），默认 1mm；草图内微移同步支持（乘网格
  步长）。与 Fusion 的修饰键分级一致。

### 性能 (Performance)

- **拖拽移动改预览变换 (Preview-transform drag)** — 之前每次 pointermove
  都重映射全部顶点/面/边并重建 mesh + 法线 + **BVH**，大模型拖拽必掉
  帧。现在拖拽期间只把偏移累积到 `dragOffset` 并施加为 `mesh.position`
  纯变换（零几何重建、零 GPU 重上传），松手时一次性烘焙成单条可撤销
  平移；Esc 取消只是丢弃预览（几何从未被碰过）。特征树实体照旧不动
  （设计如此），只有真正会移动的直接体参与预览。
- **阴影贴图按需重绘 (On-demand shadow map)** — `shadowMap.autoUpdate`
  关闭：只有几何增删/重建、可见性变化、拖拽预览移动或阴影开关时才重
  渲染阴影贴图，静止帧不再每帧重绘 2048² 深度图。
- **草图求解器性能护栏** — 新增基准测试：50 条约束的链式草图必须在
  100ms 内解完（规划文档中的指标终于有测试看守，防 O(n²) 回归）。

## [0.6.0] — 2026-09-04

Theme: **beginner-friendly, learned from the market leaders** — three deep UX
rounds that borrow the signature interactions of TinkerCAD, Fusion 360,
SolidWorks and Blender, plus the release hardening around them.

###建模与操作逻辑 (Modeling & interaction)

- **视口拖拽移动 (Drag bodies to move)** — 左键抓住实体在地面平面上滑动，
  网格自动吸附（Ctrl 自由移动），拖拽时实时显示 `Δ x, z mm` 位移读数；
  整次拖拽只占一条撤销记录，Esc 一键整体取消；抓取未选中的实体时会先
  选中它，整组一起移动。
- **草图尺寸点击编辑 (Click-to-edit sketch dimensions)** — 草图上的长度/
  半径标签现在可以直接点击，输入精确数值即可驱动图形：线段绕中点双向
  伸缩、圆/圆弧改半径且圆心不动。
- **实时剖切分析 (Live section analysis, X 键)** — 全局裁剪平面沿 X/Y/Z
  实时剖开视图：轴切换、贴合模型包围盒的偏移滑杆、翻转保留侧。纯视图
  检查，不改动几何。
- **原位粘贴 (Paste in place, Ctrl+Shift+V)** — 副本落在原始精确位置而非
  级联偏移，适合对位复制。
- **右键“最近使用”工具 (Recent tools in the right-click menu)** — 空白处
  右键菜单顶部显示最近执行过的命令，一键重跑（Fusion 式）。
- **缩放跟随光标 (Zoom-to-cursor)** — 滚轮缩放朝光标所指方向推进，而
  非屏幕中心（Fusion / Blender 行为）。
- **E 键拉伸、Ctrl+I 隔离** — 草图模式下按 E 直接打开拉伸；Ctrl+I 隔离
  所选实体。
- **撤销保留拖拽语义** — 拖拽/粘贴/微移统一为单步撤销；无位移的按下不
    产生空撤销记录。

### 新手体验 (Beginner experience)

- **快速零件库 (Parts library, B 键)** — 25 个参数化常用件的可搜索素材
  库：基础形状（实用尺寸）、机械件（M8 六角螺母、垫圈、轴套、法兰、
  L/U 型支架、z12 齿轮、旋钮）、M3–M8 孔铣刀、趣味件（五角星、金字
  塔、拱门、台阶）。点击插入并自动错位摆放；支持中英文搜索、分类筛
  选、最近使用；命令面板与 AI（`insert_library_part` /
  `load_sample_project` 工具）同源。
- **欢迎引导 (Welcome guide)** — 空场景时显示首启卡片：快捷动作（插入
  长方体 / 打开零件库 / 从草图开始 / 问 AI）、四个一键示例项目（手机
  支架、笔筒、齿轮组、铭牌）、跨会话持久化的 4 步新手任务清单（插入
  → 移动 → AI → 保存），由真实操作自动打勾。
- **Fusion 式底部时间轴** — 特征树以芯片形式按构建顺序展示（类型图标
  + 参数摘要）；单击选中产出实体、双击编辑、右键抑制/删除；空树自动
  隐藏。

### 视口与界面 (Viewport & UI)

- **地面阴影 (Ground shadows)** — 实体在网格下方投射柔和阴影（PCF 软
  阴影），视口观感对齐 Fusion/SolidWorks；状态栏一键开关并持久化。
- 状态栏提示扩展：子实体选择（Alt+边 / Ctrl+面）、拖拽移动、绘制时
  直接输入尺寸。
- 全部新功能提供中英双语文案与快捷键帮助条目。

### 质量与工程 (Quality)

- 单元测试 1695 → **1760**（122 个文件），新增覆盖：零件目录（体积/
  包围盒/贴合台面/双语命名）、示例项目、时间轴摘要与选中解析、剖切
  平面数学、拖拽撤销语义、零件库 store 动作、欢迎卡可见性规则、命令
  历史。
- E2E 冒烟套件 4/4：启动、右键插入、OCCT 曲面 STEP 导入、拖拽移动 +
  单步撤销回归。
- lint / tsc / vitest / build 全绿；版本号同步 package.json /
  Cargo.toml / tauri.conf.json。

## [0.5.0] — 2026-09-01

Deep-completion passes #1–#7: exact Manifold booleans + Web Worker offload,
parametric sweep/loft, feature-tree undo/redo, face-scoped shell, driving
drawing dimensions, type-ahead sketch dimensions, in-app numeric prompts,
drawing section views with PDF export, STEP/3MF round-trip, Tauri native
dialogs + autosave, Playwright E2E smoke suite. (Details in `todo.md`.)

## [0.4.0] — 2026-08-31

Comprehensive edge-case testing and QA pass across geometry, solver, booleans
and arrays.

## Earlier

See `todo.md` for the full engineering changelog.
