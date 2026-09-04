# Changelog

All notable changes to SceneLab are documented here. Dates are YYYY-MM-DD.

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
