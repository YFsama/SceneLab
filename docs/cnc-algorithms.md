# SceneLab CAM 进阶算法深研：Trochoidal/Adaptive · V-Carving · Rest Machining

> 2026-10-12 · 面向 pass #35+ 的实现级技术方案（本轮调研 Agent 产物，唯一写入文件）。
> 方法：WebSearch + 直接读取开源实现源码（FreeCAD Adaptive、matmill、easy_cam、F-Engrave、
> Kiri:Moto grid-apps），结合 SceneLab v0.27.0 `src/lib/cam/` 现状给出落地建议。
> 来源链接见每节末尾；凡标注「未直接核验」的条目为检索摘要结论，引用前请再确认。

---

## 0. SceneLab 现状约束（本方案的代码事实基线）

写方案前先固定与实现直接相关的现状（读自 `src/lib/cam/`、`src/lib/sketch/`、`src/lib/geometry/`）：

| 事实 | 位置 | 对新算法的影响 |
|------|------|----------------|
| 刀路 = `ToolpathPoint[]` 折线（x, y=高度, z=平面 V），无原生圆弧段 | `cam/types.ts` | trochoid 圆弧可先出折线，再走现有 `fitArcs` 拟合成 G2/G3（扫描角上限 120°，正好一个 orbit 拆多段） |
| G2/G3 后处理已就绪：`fitArcs` + IJ 增量、4–5 位小数、模态 F | `cam/arcFit.ts`、`cam/gcode.ts` | trochoid/biarc 输出不需要动 post；但弧密度高时注意点数与 look-ahead |
| pocket = 光栅 zigzag：`topSilhouette`（外环+岛屿）→ `offsetPolygon`（单环 miter 内缩）→ `scanlineIntervals` + `subtractIntervals`（1D 布尔裁剪行区间） | `cam/silhouette.ts`、`cam/toolpath.ts` | 已有"多边形→行区间"管线可复用于 rest machining 的残料掩膜裁剪 |
| `offsetPolygon` 只支持单环、无弧、miter 尖角 | `cam/silhouette.ts` | **trochoidal/adaptive 的最大前置缺口**：需要稳健的多环（岛屿）offset，建议引入 Clipper 系库 |
| 轮廓工序已有 climb/conventional、tabs、spring pass、ramp | `cam/toolpath.ts` | adaptive 的方向语义可复用同一约定（注意：M3 下 climb=材料在右=外轮廓 CW、内腔 CCW——v0.28.0 已按此翻正，勿沿用旧注释） |
| Web Worker 几何管线已有（geometryWorker/bvhWorker） | `src/lib/workers/` | 高度图/trochoid 计算按同一模式 off-thread |
| 刀具类型含 `vbit`（60°/90° 预设），但 `ToolDefinition` **无 tipAngle/tipFlat 字段**（角度藏在名字里） | `cam/toolLibrary.ts`、`cam/types.ts` | V-carving 第一步就是补刀具几何字段 |
| 草图实体：line/circle/arc/rectangle | `sketch/types.ts` | engrave「沿草图线」天然可用 |

---

## 1. Trochoidal / Adaptive 清根粗加工

### 1.1 原理与数学

**恒定啮合角（constant engagement angle）**：铣刀每瞬时参与切削的圆周角。传统 zigzag
pocket 在转行、角落处啮合角会从正常值跳到 180°（满槽）甚至瞬时 360°（角落全包），导致
切屑载荷突变 → 让刀、崩刃、振纹。Adaptive 的目标：把啮合角（或等价的"单位距离切屑面积"）
钳制在一个恒定小值（典型 10°–30°），换取：

- 径向力小、热量低 → 可以**加大切深 ap**（常为普通粗加工 2–4×）；
- 切屑薄而一致（chip thinning：啮合弧 φ 上的平均切屑厚度 hm ≈ fz·(1−cosφ)/φ，
  全槽 φ=π 时 hm ≈ 0.64·fz；φ=60° 时 hm ≈ 0.48·fz；φ=23° 时 hm ≈ 0.28·fz）
  → 需按目标 hm 反算提高进给；
- 小刀硬料场景（铝/钛/工具钢）安全性高。

**啮合角 ↔ stepover 的闭式关系**（本节公式为可直接写进代码的精确几何，假设平底刀半径 R、
径向啮合 ae）：

1. 平行偏置刀路（上一刀边界近似直线，刀具只切两刀之间的新月形余量）：

   ```
   φ_engage = 2·arcsin(ae / (2R))          ae = 2R·sin(φ/2)
   ```

   | ae（% D） | 5% | 10% | 20% | 25% | 50% | 100%（全槽） |
   |-----------|-----|------|------|------|------|------|
   | φ         | 5.7° | 11.5° | 23.1° | 29.0° | 60° | 180° |

2. 刀具扎进"原生平行直壁"（角落冲击、首刀进荒料）的接触弧（贯入模型）：

   ```
   φ_penetrate = 2·arccos(1 − ae/R)   （ae=R → 180°，ae=2R → 360°）
   ```

   角落处的真实啮合介于两者之间——这正是需要专门角落处理的原因。

3. **两圆新月（trochoid 啮合的数值核）**：刀具圆（半径 R，圆心 P_now）与上一圈扫掠边界
   （半径 R，圆心距 ae）相减的新月形，其径向深度与角跨度都可由两圆交精确算出。
   matmill 的 `get_ted(prev_r, this_r, tool_r)` 就是用两圆交的 X 坐标算啮合深度（ted），
   `Calc_reverse_spacing` 再用二分反解"给定目标 ted 求允许的圈距"——这是实现级最稳妥的
   路线：**啮合不必闭式推导，用圆-圆/圆-线布尔数值求**。

**Trochoid 参数化**（槽铣/摆线下刀的核心曲线）：

```
C(t) = ( e·t/(2π) + b·sin t ,  −b·cos t )
       e = 每转前进量（pitch），b = 轨道半径（orbit radius）
```

- 槽宽 W = 2(b + R)（刀心轨道 ± b 加刀半径）；给定槽宽反解 b = (W − 2R)/2。
- 每圈前进量 e ≈ 目标径向啮合 ae（工程初值），啮合角峰值出现在轨道两极端（t=0, π，
  切向速度 |C′| = a ± b 最大处）；精确峰值用两圆新月数值评估，或按 Zhou 2023 的椭圆
  压缩比 trochoid（引入压缩比直接控制啮合角，学术可引用）。
- **最小回转半径**：b 太小 → 每圈弧太短、G2/G3 段过密（GRBL look-ahead 压力、文件膨胀）、
  机床加减速抖振；太大 → 空行程多。经验下限 `b ≥ max(0.5 mm, 0.15·D)`，槽铣时由槽宽
  唯一确定。刀柄约束：平底刀 orbit 本身让刀柄永远不接触荒料（这正是 trochoid 相比直扎的
  安全点），无需额外刀柄锥角检查（那是 3D 型腔粗加工的事）。

### 1.2 算法路线对比

| 路线 | 核心思想 | 优点 | 缺点/成本 | 代表 |
|------|----------|------|-----------|------|
| **a) 参考刀路偏移法**（offset reference + 局部 trochoid） | 先生成普通 contour-parallel 偏置刀路，行走时预测前方啮合，超限处插入局部回转/摆线环 | 复用现有 offset 基建；直线段速度快（无环）；实现可增量 | 啮合预测需要清料区跟踪；参数交互多 | Fusion Adaptive、Mastercam Dynamic、Vortex（Vertex/Vero）、Choy & Chan 2003 corner-looping |
| **b) 直接摆线法**（guide + trochoid） | 中线/引导路径上摆线推进：每转前进 e，orbit 半径 b | 几何最简、槽铣天然形态；恒啮合最容易保证 | 开阔区全是环 → 空行程与弧段密度高；需与直线切换 | easy_cam、bCNC 插件、多数槽铣功能 |
| **c) Voronoi / 中轴法** | 采样边界点建 Voronoi → 中轴树，每个中轴点带最大内切圆半径；刀路沿中轴"切片"+球间螺旋连接 | 天然处理窄区/角落/分叉；一次建树多次用 | Voronoi 实现与数值稳定性坑多；采样密度敏感 | matmill（CamBam 插件）、OpenCAMLib 实验性 medial pocketing |
| **d) 啮合角直接转向法**（engagement-steered greedy） | 不显式生成 trochoid：刀心按"单位距离切削面积 = stepover×满槽面积"的目标迭代搜索偏转角，边界行走器推进啮合点 | 刀路形态最接近商业 adaptive（大弧+角落小环）；无需中轴 | 每步做 Clipper 布尔，计算重；调参（容差/步长）敏感 | FreeCAD CAM Adaptive（kreso-t） |
| **e) 商业黑盒**（资料层面） | —— | Fusion 3D Adaptive（原 Adaptive Clearing）、Mastercam Dynamic、Vortex、VoluMill | 专利/商业秘密；VoluMill 2012 年口径 patent-pending，2024-05 被 ModuleWorks 收购；未检索到可直接照抄的公开专利全文 | 见参考资料 |

**Kiri:Moto 负结论**（读了 `grid-apps/src/kiri/mode/cam/` 源码）：其 CAM 的 clear/trace/
rough 均为 contour-parallel 偏置（ClipperLib，圆角 join、`arc:250`、`cleanDist:10`、
trace 模式 dogbone），**没有 trochoidal/adaptive，也没有恒啮合控制**。它可作为"Clipper
偏置工程实践"的参考（join 类型、弧输出、最近邻区域排序 `printPoint`），不能作为摆线参考。

### 1.3 开源实现详读（实现思路提取）

**FreeCAD CAM Adaptive（kreso-t/FreeCAD_Mod_Adaptive_Path，Python + Pyclipper）**——最完整
的可读实现，路线 d：

- 目标函数：`optimalCutAreaPerDist = stepOver × fullSlotAreaPerDist`（满槽每单位距离切屑
  面积 = 刀圆平移扫掠，用 Clipper 差集求）。
- 主循环：对当前刀心位，迭代搜索偏转角（`Interpolation.getNextAngle`，用最近 10 个偏转角
  的历史均值预测初值，最多 12 次迭代），使 `error = tryCuttingAreaPerDist − target ≤
  MAX_ERROR = 40/stepScaled + 2`；步长随曲率自适应 `step = 4.0/deflectionAngle`，钳在
  `[2·tolerance, R/2]`。
- 刀形缓存：刀具扫掠形状按"移动向量离散化 key"缓存（命中率即性能指标）。
- 啮合点行走器 `EngagementPoint`：沿未切边界前进到 `1.5×optimal` 的切屑阈值再开下一刀；
  接近边界时目标面积线性衰减到 `minCutAreaPerDist`（`targetArea = relDist·(opt−min)+min`），
  实现壁边光顺收尾。
- 过切保护：`cuttingArea > 3×cutAreaPerDist+10` 连续 5 次则报错终止（调 tolerance/stepover）。
- 连接：跳刀扫掠形状与未切料做布尔，`collisionArea>0` 则抬刀（`jumpType=2`）。
- 最后跑一圈精修：`of.Execute2(-toolRadiusScaled)` 取含起点的轮廓闭合。
- 入刀：Helix（角度/锥角/直径上限/可选 G2 圆弧输出），先预挖 helix 半径圆。

**matmill（jkmnt/matmill，C# CamBam 插件）**——路线 c+b 的教科书组合：

- 中轴：边界采样点 → Fortune Voronoi → 区域内边过滤 → `Segpool`（端点哈希）→ 分支树
  （根 = 最大内切圆端点；"足够长"的分支才保留）。Voronoi 对最底部输入点敏感，作者加了
  一个"最低点下方偏移半宽"的哨兵点规避。
- 摆线 = **Archimedean 螺旋**：r = a·θ + c，a = spacing/2π；每圈 6 段 biarc（12 段圆弧）
  G1 拟合输出——与 SceneLab `fitArcs`（120° 扫描角上限）思路同源。
- 啮合带控制：`Max_ted = D×stepover`，`Min_ted = D×stepover×Min_stepover`（默认 0.9，
  钳 [0.05, 0.95]）——允许步距在带内浮动以清角，"Min_stepover 大了会留角"。
- 切片（slice=内切圆球）间连接：优先 biarc 且约束连接弧必须留在上一刀切过的"球"内
  （`is_biarc_inside_ball`：线-圆/圆-圆相交测试），出界或短于 `_min_arc_len` 则退化为直线
  chord。路径条目类型：SLICE / SPIRAL / CHORD / SMOOTH_CHORD / GUIDE / RETURN_TO_BASE。

**easy_cam（luhill/easy_cam，TypeScript PWA）**——路线 b 的浏览器实现，与 SceneLab 同栈，
最具移植参考价值：

- `trochoidalPath.ts`：引导线 arc-length 参数化（`GuideFrame{pos,tangent,normal,s}`，闭环
  方向由 `signedLoopArea2D` 定），采样/截段/最近点投影工具集。
- `adaptiveForwardIncrement(D, stepover%) = max(D·stepover%, D·0.05)`——每转前进=径向步距，
  下限 5% D。`slotClearance = slotWidth − D`。
- `adaptiveFourZone.ts`：微环按相位分区——相位 ≥0.5 为切削弧，0.08–0.38 做正弦抬刀回程
  泡；`CUT_PHASE_ROTATION = 105°` 让切削弧在前、回程在后（climb=CCW）；每环采样
  `max(8, orbitStepsPerRev≈90)` 点；入刀螺旋半径从 0.05 渐增、终点相位对齐首环
  `CUT_PHASE_START` 防接缝跳变。
- 角落"spur"（窄突）处理：`cornerSpurs.ts` 标记 CornerSpurRange，进入 spur 时 orbit 半径
  收缩，≤2% 基准半径时退化为**尖点直线触碰**；段端钳制到 spur 边界 + 保护缓冲；零长段用
  `minStep = max(stepover·0.05, 0.02)` 跳出。
- 环绕方向：外轮廓 climb = 绕件 CW，内腔 climb = CCW；orbit 自身 climb = +1（CCW）。

### 1.4 角落、再入、窄区、连接（专题归纳）

- **角落处理**：①corner-looping（Choy & Chan 2003：在偏置刀路角落插回环）；②matmill 的
  Min_ted 步距带收缩；③easy_cam 的 spur orbit 半径收缩→退化为点；④FreeCAD 靠啮合目标
  自动绕行。**角落=啮合角尖峰的唯一来源**，任何路线都必须显式处理。
- **再入（reentry）**：FreeCAD 用 EngagementPoint 沿未切边界找 1.5×optimal 阈值点；商业
  实现选择"啮合最深的新区域"；easy_cam 用 `skipArcLength` + 最近点投影。再入点必须
  已清料（否则等于满啮合扎入）——helix/斜坡入刀是标配兜底。
- **窄区检测（trochoid↔直线切换）**：区域剩余宽度 < D + 2ε 时摆线无意义（orbit 放不下），
  切换为直线槽铣（此时啮合天然受限）；检测可用"逐层 inset 面积/宽度退化"（offset 消失
  或剩中轴线）或中轴半径 < R 判定。easy_cam 的 spur 退化点是其特例。
- **连接（keep-tool-down）**：行/环间优先在已清区内走 biarc/直线（FreeCAD 的跳刀扫掠
  布尔 + Keep Tool Down Ratio 参数：绕行路径长/直线距的容忍上限）；否则抬刀快移。
  SceneLab pocket 已有同语义的 `linkRows` 逻辑可对照移植。

### 1.5 推荐路线（SceneLab 具体方案）

**推荐：路线 a 的增量版「offset 参考刀路 + 角落局部 trochoid + helix 入刀」，v1 不做啮合
闭环仿真**（FreeCAD 的逐点布尔最贵也最难调；先用几何规则拿到 80% 收益，v2 再升级为
啮合面积闭环）。

**前置基建（一次性，所有后续 CAM 高级功能共用）**：

1. `cam/polygonClip.ts`：引入 Clipper 系库做多环 offset + 布尔（候选：`clipper-lib@6.4.2`
   纯 JS、`js-angusj-clipper@1.3.1` WASM（带 offset）、`polygon-clipping@0.15.7`（Martinez，
   无 offset）、`polybooljs@1.2.2`；Kiri:Moto 用 ClipperLib 可抄使用姿势）。接口建议：
   `offsetRegion(outer, islands, d, {join:'round', arcTolerance}) → Region[]`、
   `regionBoolean(A, op, B) → Region[]`，Region = `{outer: Point2[], holes: Point2[][]}`，
   内部整型缩放（Kiri 用 `E-3` mm→int，保留 3 位小数）。
2. 现有 `offsetPolygon`（单环 miter）保留给 contour 用；pocket/adaptive 全部切到新接口。

**Adaptive 工序（`cam/adaptive.ts`）流程**：

```
输入：body 的 topSilhouette（外环+岛屿）、tool、params
每层 z（depthLevels，允许比普通 pocket 更深，默认 ap = D）：
  1. 清理区域 region = inset(outer, R+allowance) ⊖ grow(islands, R+allowance)   [Clipper]
  2. 参考刀路 = contour-parallel：从 region 边界逐次 inset stepover（ae = D·so%）
     直到区域消失；每条环带方向（外环 CCW=climb，同现有约定）
  3. 窄区检测：inset 时若某条环自交/面积骤降 < (D·so)·长度阈值 → 该子区域转直线槽：
     沿其中轴（可用逐步 inset 的收缩序列近似）走 trochoid 槽铣（b=剩余宽度/2−R）
  4. 角落处理：环上凹角（相对清料方向的转角 delta > 阈值）插入 corner loop：
     半径 = max(ae, b_min)，圆心放在角平分线、保持在已清区内；
     或 matmill 式：角落处允许步距收缩至 0.5×ae 再恢复
  5. 连接：相邻环间若直线在已清区内（点到 region 已清部分判定，v1 用简化规则：
     连接段在 inset(stepover·1.5) 区域内）→ biarc/直线 keep-down；否则 retract
  6. 入刀：首个进入点 helix（半径 = min(ae·2, R)、每圈降深 helixAngle≈3–5°）
     ——输出折线，`fitArcs` 自动转 G2/G3
  7. 收尾精修环（可选 spring pass 同现有 contour）
```

**v2 升级路径**（独立小轮）：把 3/4 的几何规则替换为 FreeCAD 式啮合闭环——维护
`clearedRegion`（Clipper Path 集合），每步对候选前进方向算新月面积，超 1.5× 目标就
绕行/插环。届时 `optimalCutAreaPerDist`、边界行走器可按 1.3 的参数照抄。

**数据结构**：

- 复用 `Toolpath`/`ToolpathPoint`，不动 types；`CAMParameters` 增加
  `adaptive?: { stepoverPct, maxStepdown, entryMode: 'helix'|'ramp'|'plunge',
  keepToolDownRatio, cornerLoopMinR }`。
- 刀路中间表示建议加轻量 `Polyline Move[]`（在 `MoveList` 上已有类似物）+ 环分组，便于
  worker 内生成、主线程组装。

**模块划分**：`cam/polygonClip.ts`（基建）→ `cam/trochoid.ts`（摆线/螺旋段生成器：
`trochoidSegment(from, dir, e, b, samples)`、`helixEntry(center, r, depthPerRev)`，纯函数
易测）→ `cam/adaptive.ts`（策略）→ CAMPanel 加 op 类型（复用现有指纹缓存/重算管线）。

**复杂度估计**：每层 Clipper offset O(V log V)（V=多边形顶点，实测 Kiri 同量级毫秒级）；
环行走 O(V)；trochoid 输出 O(路径长/e × 每环采样)。整典型零件（100mm 槽，V≈200，5 层）
预计 < 50 ms/序（主线程亦可，worker 更稳）。比 FreeCAD 逐点布尔方案（秒级）低 1–2 个
数量级。

**测试策略**：

- 不变量单测：所有 cutting 点到 `inset(outer,R+allow)` 边界距离 ≥ −ε（不切壁）、到 grown
  islands ≥ −ε；相邻环距 ∈ [0.5×ae, 1.5×ae]；helix 入刀降深角 ≤ 设定。
- 啮合回归：测试内用"扫掠圆盘并集 vs 刀路折线"的 1D 采样估计最大啮合角 ≤ 目标×1.2
  （corner loop 生效的量化验收）。
- 金样件：方槽、L 形、圆槽、窄缝（宽 ∈ (D, 1.5D)）、带岛槽；快照 + G-code 行数/弧段数
  基线；grbl 语法 lint（圆弧 IJ 精度 ≥4 位，沿用 arcFit 约束）。
- 时间估算与机床仿真直接复用，无需改。

**风险**：①Clipper 整型缩放精度（mm→int 丢真，统一 1e-3）；②岛屿+圆角 join 的弧膨胀导致
环自碰（Kiri 的 `cleanDist` 实践可抄）；③trochoid 输出点量大（orbit 90 点/圈 × 多圈），
需按公差抽稀（`fitArcs` 后弧段数应 < 折线的 1/5）；④用户参数理解成本——UI 上把
stepover 语义标成"径向啮合 % D"并给材料默认。

### 1.6 参数默认值建议（可直接进 UI）

| 参数 | 默认 | 说明 |
|------|------|------|
| stepover（径向啮合） | 20% D（铝可 30%，钢 10–15%） | 对应啮合角 ≈23°/34°/11.5° |
| 最大切深 ap | 1.0–1.5 D（普通 pocket 的 2–3×） | 低啮合的收益点 |
| 进给补偿 | 可选：fz_adaptive = fz / (hm 目标系数) | chip thinning，v1 可先不做、文档提示 |
| trochoid 最小半径 b_min | max(0.5 mm, 0.15 D) | 弧段密度与机床平滑 |
| 入刀 | helix 3°（或 ramp 15° 同现有） | 兜底满啮合 |
| keepToolDownRatio | 3.0 | 同 FreeCAD 语义 |

### 1.7 参考资料（主题 1）

- FreeCAD Adaptive 源码：https://github.com/kreso-t/FreeCAD_Mod_Adaptive_Path （本文 1.3 直接读源）
- FreeCAD wiki CAM Adaptive：https://wiki.freecad.org/CAM_Adaptive
- matmill（CamBam trochoidal 插件，Voronoi+中轴+螺旋）：https://github.com/jkmnt/matmill
- easy_cam（TypeScript 摆线 PWA）：https://github.com/luhill/easy_cam
- bCNC 摆线 pocket 插件：https://github.com/Lachei/bcnc_trochoidal_pocket ；trochoidal slotting（C++/LinuxCNC）：https://github.com/gitcoffey/trochoidal_slotting
- Kiri:Moto（grid-apps，负结论+Clipper 实践参考）：https://github.com/GridSpace/grid-apps
- Uddin（广岛大学）constant engagement offset 方案：https://mecdes.hiroshima-u.ac.jp/lem05_uddin
- Choy & Chan, "A corner-looping based tool path for pocket milling", CAD 2003（ScienceDirect，未直接核验全文）
- Zhou et al. 2023, 椭圆压缩比 trochoid 控制啮合角（AGRIS 检索条目：https://agris.fao.org ）
- "Trochoidal machining for the high-speed milling of pockets"（ResearchGate 检索）
- VoluMill/Celeritive（被 ModuleWorks 收购，2024-05）：https://www.volumill.com 、https://www.celeritive.com 、https://www.moduleworks.com
- Vortex（Vertex/Vero，现 Hexagon）与 Mastercam Dynamic / Fusion 3D Adaptive：产品文档与行业评述（https://help.autodesk.com Fusion CAM 章节；https://machiningconceptserie.com/Blog 2024-08 动态刀路文）
- 多边形库（npm 核验 2026-10）：clipper-lib@6.4.2、js-angusj-clipper@1.3.1、polygon-clipping@0.15.7、martinez-polygon-clipping@0.9.0、polybooljs@1.2.2

---

## 2. V-Carving / 雕刻

### 2.1 几何原理

V 刀（半角 α，理论尖点，实际有 tip 平台径 f）沿**中心线**行进，切削宽度随深度张开：

```
w(z) = 2·z·tan(α/2) + f      ⇒      z = (w − f) / (2·tan(α/2))
```

真 V-carve 的输入不是中心线而是**成对的设计轮廓**（如字母内外笔画边界）：在区域内部每一点，
V 刀能下到的深度由"该点能内切多大的圆"决定——这正是**中轴变换（medial axis transform，
MAT）**：深度场 z(x,y) = (MAT 半径 r(x,y) − f/2)/tan(α/2)，刀心轨迹 = 中轴在深度 z 上的
等值线/骨架本身。窄缝处（两轮廓接近）中轴半径小 → 浅；宽处深。Vectric 论坛/官方文档
口径："深度由矢量间距决定，用户不能直接指定深度"；`Start Depth` 允许在已挖口袋内继续
V-carve。

**宽区问题**：r(x,y) > 刀具全半径 R（宽于 V 刀开口）时，V 刀已到最大宽度仍填不满区域 →
需要 **flat-bottomed clearance**（Vectric：Max Cut Depth + 平底清底刀预清宽区，再 V 精修）
或钳制最大深度留下平底（Easel 论坛实践：flat depth limit 后底面不光滑）。

### 2.2 实践算法

**Vectric 的做法（公开资料层面）**：官方文档只描述行为（constant angled cutter、flowing
variable depth、自动计算、Start/Max depth、clearance tool），**未检索到可引用的公开专利**
（Google Patents 按 Vectric/Delcam assignee + engraving toolpath 检索为空； Vectric 创始人
出身 Delcam/ArtCAM）。实现细节属商业机密，学术等价物就是 MAT。

**F-Engrave（Scorchworks，GPL-3）—— 已读源码的等价开源实现**，算法是"采样式 MAT"
（不做全局中轴，逐边界采样点做内切圆，天然浏览器友好）：

1. 输入轮廓折线（文字轮廓或任意闭合矢量），每段带 `char_num` 分组标签。
2. **网格分区加速**：cell 尺寸 ≈ (2·rmax + dline)·1.1，每段按其包围盒 + 邻域注册到 cell。
3. 沿轮廓以步长 `v_step_len` 采样；每采样点取内向法向 φ，调
   `find_max_circle(xpt, ypt, rmax, char_num, sinφ, cosφ, ...)`：
   - 对邻域内每条候选线段，解"圆心在法向射线上且与该线段相切"的二次方程（线段端点用
     `r = (xc²+yc²)/(2·yc)` 过端点条件），取 min → `rout` = 该点到对侧边界的净距。
   - `CHK_STRING` 控制跨字符检查（文字模式默认只在同字符内求距，防相邻字母互顶）。
4. 刀位点 = 采样点 + rout·(法向)，记录半径 rout；**深度 z = −rout / tan(α/2)**（源码
   3265 行 `z1 = -r1/tan(half_angle)`）。
5. **角落处理**：环上转角 delta > `v_stp_crner`（stop corner，默认约 160°）时在角内按
   `dangle = degrees(dline/rbit)`（钳 ≥2°）插入扇形子步（`phisteps = max(floor((delta−180)
   /dangle), 2)`）；delta < `v_drv_crner`（drive corner）则直接走到角点。
6. `rout ≥ rbit`（碰全径上限）→ `need_clean=1` 标记该处需平底清底工序（`clean_dia`、
   `step over` 参数）。
7. 输出按 `loop_cnt` 分组的多段折线；inlay 模式用锥角反算顶部半径补偿。

**其他开源**：CamBam 无真 V-carve；PyCAM 已停更且无；Kiri:Moto `op-trace` 只是定深轮廓
跟随（无变深）。GitHub 检索 "v-carving" 无实质新实现（多为 Vectric 后处理/教程仓库）——
开源侧真 V-carve 基本只有 F-Engrave 一件，验证了 pass #33 报告"V-carving 是商业护城河、
开源空白"的判断，也意味着 SceneLab 做出来就是**开源/网页生态独有卖点**。

### 2.3 文字 → 切削路径（浏览器侧资源，已核验）

| 资源 | 形态 | 许可 | 用途 |
|------|------|------|------|
| `hersheytext` npm 2.0.0（techninja/hersheytextjs） | Hershey 单线字体 JSON + `renderTextArray(text,{font,scale})` 返回每字符 `d` 路径 | JSON 数据 public domain，代码 MIT | **单线字体**： engrave 直刻；~20+ 字体（futural/cursive/script…），支持自加 SVG font |
| `opentype.js` 2.0.0（nodebox） | 浏览器解析 TTF/OTF → 贝塞尔轮廓 + advance/kerning | MIT | **轮廓字体**：取 glyph 轮廓对 → 真 V-carve（文字轮廓即 2.1 的"成对设计轮廓"） |
| SVG 字体（`<font>`） | 浏览器原生渲染已废弃 | — | 不建议依赖；hersheytext 内置的 SVG font 数据仍可用其自带解析 |
| F-Engrave CXF / TTF2CXF | 单线字体另一格式 | GPL | 仅作数据来源参考，不必兼容 |
| 系统 canvas `fillText`+像素 | 栅格 → 需矢量化 | — | 质量差，不推荐 |

**推荐组合**：单线刻字用 hersheytext（零矢量化成本、开箱即用）；真 V-carve 文字用
opentype.js 取轮廓（含 advance width 排版与 kerning），两条路线共享同一"折线组"后端。

### 2.4 路线对比与推荐

| 路线 | 内容 | 用户价值 | 成本 | 依赖 |
|------|------|----------|------|------|
| **E1 固定深度 engrave** | V/平底刀沿草图折线 + 单线字文本，定深（可多层）、ramp 入刀 | 中高（打标、刻名、单线字立即可用） | **低**：纯折线，复用现有 MoveList/depthLevels/rampEntry | 无新几何 |
| **E2 真 V-carve（F-Engrave 式采样 MAT）** | 闭合轮廓对 → 变深中心刀路 + max depth 钳制 + 宽区平底清底 | 高（招牌/浮雕字、差异化独占） | 中：`find_max_circle` + 网格分区 ≈ 300–500 行 | 无外部库 |
| E3 真 MAT/直骨架 | 全局中轴（Voronoi 或 straight skeleton） | 同 E2 但更"正" | 高：鲁棒 MAT 实现本身是一个大坑 | 新库/自研 |

**推荐两段走**：pass #35 做 E1（ engrave 工序 + 文本工具），pass #36+ 做 E2。E3 不做。

### 2.5 SceneLab 具体建议（E2 实现要点）

- **刀具模型**：`ToolDefinition` 加 `tipAngleDeg?: number`、`tipFlat?: number`（迁移时由
  预设名 60°/90° 回填），feedsSpeeds 对 V 刀按有效直径（2·ap·tan(α/2)+f）估算。
- **数据结构**：输入 = `Contour[] = { poly: Point2[], groupId: string }[]`（草图闭环或
  opentype 字形）；输出 = `MoveList` 分段折线 + 每点深度（y 分量即深度，天然进现有
  `ToolpathPoint`，机床仿真可直接放 3D 播放）。
- **模块**：`cam/vcarve.ts`（采样 MAT 主算法）+ `cam/textPath.ts`（hersheytext/opentype
  封装：`textToPolylines(text, font, size)` / `textToOutlines(...)`）+ CAMPanel op。
- **算法步骤照抄 2.2 的 1–7**；注意点：法向方向取"区域内部"（用现有 `pointInPolygon` 判
  定）；网格 cell 用 (2·rmax+dline)·1.1；跨组检查开关（字距近时防互切）；角扇形子步；
  `rout` 钳到 R 时收集清底区域（union 各触顶点的 R 圆 → Clipper 得平底清料区，交给现有
  pocket 生成器自动清底——**复用 pocket**，不必新写清底策略）。
- **复杂度**：O(P/dline × K)（P 轮廓周长，K 每格候选段数，网格下 K≈O(1)）。10 cm 文字、
  dline=0.3 mm ≈ 数千采样点 × 少数段，< 10 ms 级。
- **测试策略**：几何金样——平行直线对的 V 槽（深度应为 d/2/tan，理论闭式可断言）、
  圆对（中轴过圆心、深度 = R圆/tan）、V 字母宽度扫描（深度场单调）；不变量——刀路点
  必在轮廓组内部、深度 ≤ (rmax)/tan、钳制后平底区不再有超深点；E2E：文本工具输入 →
  op 刀路出现且 G-code 深度变化；快照渲染。

### 2.6 参考资料（主题 2）

- F-Engrave 源码（本文 2.2 直接读源，`V_Carve_It`/`find_max_circle`/`record_v_carve_data`）：https://github.com/stephenhouser/f-engrave （Scorchworks 原版主页 http://www.scorchworks.com/Fengrave/Fengrave.html ，未直接核验）
- Vectric V-Carve Toolpath 文档（Start Depth/Max Cut Depth/flat clearance）：https://docs.vectric.com （Aspire Help "V-Carve Toolpath" 章）
- Vectric 专利检索负结论（Google Patents，2026-10 检索）
- hersheytext：https://github.com/techninja/hersheytextjs （npm `hersheytext@2.0.0`）
- opentype.js：https://github.com/nodebox/opentype.js （npm `opentype.js@2.0.0`）
- Hershey 字体生态（Inkscape Hershey Text 扩展等）：https://github.com/fablabnbg/inkscape-text2hershey 、https://github.com/martenjacobs/LineFont
- 论坛口径佐证（"深度由矢量宽决定"）：Vectric/Sienci/Carbide3D 社区帖（检索摘要）

---

## 3. 2.5D Rest Machining（残料加工）

### 3.1 原理

残料加工 = 第 n 序只用小刀加工"前面各序完成后仍未到目标几何"的区域。核心是**在制毛坯模型
（in-process stock model）**：随工序链推进逐序更新的材料状态。2.5D 场景下三种建模：

1. **高度图差法（heightmap diff）**：stock 为 2D 标量场 `H[x,y]`（当前残料顶高）。每个
   2.5D 工序的 cutting moves 是常深度 y 的圆盘扫掠 → 对 H 做 `H = min(H, y)` 的局部更新。
   目标几何同为高度场 `T[x,y]`（由 silhouette + 各层深度或体素化得到）。残料掩膜 =
   `H − T > 阈值`。学术同类：Z-buffer/dexel in-process 模型、PIST 图像空间规划
   （MacMillan et al., Carleton）。
2. **扫掠区域布尔法（swept-area boolean）**：每序结束后，把该序所有切削段的刀具扫掠
   足迹（线段 buffer 圆端）union 成 2D 区域；残料区 = 目标清理区 ⊖ ∪扫掠区（Clipper）。
   精确的边界多边形（可直接喂 contour-parallel），但大路径 union 成本高、无深度分辨率
   （需要分层做）。
3. **零件阴影栈（Kiri:Moto 方案，已读源码）**：`computeShadowStack` 自顶向下逐层
   `union(上层阴影, 该层轮廓)`，`shadowAt(z)` 取保守下层防撞。注意：Kiri 用它做**区域
   限制与防撞，不是 rest machining**（其 rough/clear 从不做"上一序刀路差"——源码确认的
   负结论）。可借鉴其 shadow 栈做目标场 T。

商业对照：Mastercam "Rough Remaining Stock"（毛坯余量识别减少空切）、Fusion "Rest
Machining"（基于内存 stock model 的 Previous toolpath 范围限制）。BlenderCAM/FabexCNC
社区口径有基于仿真 stock 的残料思路（未读源码核验）。

### 3.2 分辨率 / 内存权衡（heightmap）

Float32Array，stock 200×200 mm：

| 分辨率 | 网格 | 内存 | 适配场景 |
|--------|------|------|----------|
| 0.5 mm | 400×400 = 160k | 0.64 MB | 6 mm 刀粗清残料足够 |
| 0.25 mm | 800×800 = 640k | 2.6 MB | 默认（≤ 刀径/8 时误差可忽略） |
| 0.1 mm | 2000×2000 = 4M | 16 MB | 1 mm 小刀清角（worker + 可能 WASM） |

更新成本：每切削段圆盘扫掠栅格化 ≈ `O(len/res × D/res)`；10 m 总路径、D6/res0.25 ≈
2×10⁷ 单元写入，Worker 内 < 1 s（TypedArray 顺序写）。**自动分辨率 = clamp(上一序最小
刀径/6, 0.1, 0.5) mm**。GPU 纹理路线（Kiri 已用 GPU raster 做 3D surface）留作 v3。

### 3.3 推荐路线（SceneLab 最小方案）

**推荐：heightmap 差法 + 行区间裁剪（零新布尔依赖）**：

```
模块 cam/rest.ts：
  buildStockHeightmap(bounds, res, stockTop)            // H 全场 = stockTop
  applyToolpath(H, toolpath)                            // 切削段圆盘扫掠 min-update（worker）
  buildTargetHeightmap(body, op 链语义)                  // 2.5D: 目标深度场
      v1 简化：目标 = 各 pocket/contour 序的名义清理区+深度（每序区域已知）
  residual = H − T > 阈值(默认 0.05 mm 或 tool2 直径的 5%)
  残料 → 每行连续区间（marching-squares 或逐行行程编码）
  → 与现有 pocket 的 scanlineIntervals 求交（subtractIntervals 复用！）
  → 小刀 pocket 只在残料行区间内光栅，天然跳过已清区
```

这个方案的最大优点：**残料掩膜以"每行区间"形态直接接入现有 pocket 光栅管线**，不需要
多边形化，不需要 Clipper，岛屿语义自动保留（残料行区间天然带洞）。缺点是残料只服务
pocket 光栅（contour-parallel 残料需多边形化，v2 再说）。

**两刀工序 UI 流程（创客化）**：

1. 用户新建 pocket（大刀 D6，正常生成）。
2. 新建第二序 pocket 勾选 **「Rest：仅清残料（基于之前工序）」** + 选小刀（D2）。面板
   显示残料覆盖率 % 与预计减少的空切时间（卖点反馈）。
3. 生成顺序依赖：rest 序重算时需其之前所有序的 points（现有指纹缓存链上加"依赖前序"
   的失效键，改动小）。
4. 安全默认：残料序禁用比前序更大的刀（UI 警告）；阈值外推 0（宁可多切不漏切）。

**测试策略**：合成场景金样——大刀清 80% 宽槽后，小刀 rest 序的 cutting 行区间应近似
等宽分布于两侧残料带；空切率断言（rest 序总切长 < 全新 pocket 的 40%）；H 更新的数值
单测（圆盘扫掠离散步长的边界收玫）；重算链指纹（改前序参数 → rest 序自动失效）。

**风险**：①2.5D 高度图对"侧壁残留"（同深度不同平面）天然正确、对非 2.5D 几何失真——
v1 明确只支持 pocket/contour/face 序做输入；②残料阈值过小 → 几乎重切全部（等于没有），
过大 → 漏清，默认 0.05 mm + UI 滑条；③依赖链重算成本（worker 化后可接受）。

### 3.4 参考资料（主题 3）

- PIST 图像空间刀路规划（MacMillan et al., Carleton）：https://carleton.ca （检索条目）
- Mastercam "Rough Remaining Stock" 讨论：https://www.emastercam.com （检索条目）
- Voxel/dexel CWE 建模综述：ResearchGate "Voxel-based modeling of transient material removal"
- Kiri:Moto shadow 栈（区域限制，非 rest）源码：https://github.com/GridSpace/grid-apps `src/kiri/mode/cam/work/op-shadow.js`、`op-area.js`
- 多边形库（布尔法备选）：见 1.7（clipper-lib 等，npm 已核验）

---

## 4. pass #35 立项建议（按 价值/成本 排序）

### 候选 1（首推，低风险高差异化）：「Engrave 雕刻工序 + 单线字文本工具」

- **内容**：新 op `engrave`（V/平底刀沿草图折线，固定深度多层 + rampEntry + climb 方向）；
  草图/文本工具 `textToPolylines`（hersheytext 内嵌）插入单线字为草图折线；
  `ToolDefinition` 补 `tipAngleDeg/tipFlat`。
- **价值**：打标/刻名是创客高频刚需；单线字在网页 CAD/CAM 里几乎没有竞品；为 E2 真
  V-carve 铺好刀具模型与 op 骨架。
- **成本**：小。无新几何依赖，全部复用 MoveList/depthLevels/arcFit/仿真/时间估算。
- **风险**：文本工具的排版（字距/对齐/中文——Hershey 无 CJK，中文需回退轮廓字体或提示
  不支持）；engrave 语义与 contour 混淆需 UI 文案。
- **验收标准**：① 草图圆弧 engrave 输出含 G2/G3（fitArcs 生效）；② 深度多层 + ramp 正确
  （金样单测）；③ 文本输入 → 一键成 sketch 折线 → 一键成 op → G-code 全链路 E2E；
  ④ 中英文案与帮助条目；⑤ 单测覆盖 ≥ 20 用例（深度层、方向、文本宽度、边界空输入）。

### 候选 2（大工程，建议独立轮）：「Adaptive 清根 v1 = offset 参考刀路 + 角落 trochoid」

- **内容**：`polygonClip.ts`（Clipper 基建）+ `trochoid.ts`（摆线/螺旋发生器）+
  `adaptive.ts`（1.5 节流程，v1 无岛屿版可先行：外轮廓单环即可验证，岛屿第二步接入——
  岛屿在 Clipper offset 下增量小）。helix 入刀、keep-down 连接、G2/G3 输出。
- **价值**：pass #33 商业对标已确认"adaptive 是行业默认心智"；对铝/硬料用户是断刀率与
  节拍的直接改善；技术叙事强。
- **成本**：中高。新库依赖 + 新策略模块 + 参数调优，预计一个完整开发轮。
- **风险**：Clipper 精度/自碰（见 1.5 风险③①）；啮合质量没有闭环保证（v1 是几何规则，
  需用测试内啮合估计器验收并明示"v2 将升级恒啮合闭环"）；点量/G-code 体积膨胀。
- **验收标准**：① 金样 5 件（方槽/L 形/窄缝/圆槽/带岛）无过切（不变量单测）；② 测试内
  最大啮合角 ≤ 目标×1.2（窄缝与角落专项）；③ helix 入刀降深角正确、无直扎满啮合；
  ④ 同参数下与 zigzag pocket 的 G-code 时间估算对比展示（adaptive 应不劣于，深 ap 场景
  优于）；⑤ G-code 弧段占比 > 60%（trochoid 生效的量化信号）；⑥ 指纹缓存/重算/E2E 回归
  全绿。

### 候选 3（中成本，依赖多序场景）：「Rest machining heightmap v1」

- **内容**：`cam/rest.ts`（3.3 节）：worker 高度图、残料行区间、pocket 光栅裁剪、
  「仅清残料」UI 开关与依赖前序的重算失效。
- **价值**：大刀→小刀两序是进阶创客标准玩法；顺带沉淀 heightmap 基建，为后续浏览器材料
  去除仿真（pass #33 报告 #5 需求）复用。
- **成本**：中。核心算法简单，工程量在 worker 管线与工序依赖链。
- **风险**：残料阈值/分辨率默认值需实测调参；v1 只支持 pocket 类输入（文档明示）；
  若用户只有单序则无感知（依赖引导 UI）。
- **验收标准**：① 合成场景空切率 < 全新 pocket 的 40%；② 改前序参数 → rest 序自动重算；
  ③ 高度图数值单测（扫掠边界收敛 ±1 cell）；④ 200×200 mm stock 默认分辨率内存 ≤ 4 MB、
  计算在 worker、UI 无卡顿；⑤ E2E 两序场景生成成功且 G-code 行数显著少于非 rest 版。

**排期建议**：pass #35 = 候选 1 全量 + 候选 2 的基建切片（`polygonClip.ts` + `trochoid.ts`
纯函数与单测，不含 op 接线）；pass #36 = 候选 2 主体；pass #37 = 候选 3 或 E2 真 V-carve
（按候选 2 交付后的用户反馈决定优先级）。

---

## 5. 附：本文引用的开源实现与库清单（速查）

| 名称 | 语言 | 许可 | 与 SceneLab 关系 |
|------|------|------|------------------|
| kreso-t/FreeCAD_Mod_Adaptive_Path | Python | GPL | 啮合闭环参考（v2 抄参数） |
| jkmnt/matmill | C# | MIT | 中轴+Archimedean 螺旋+biarc+啮合带参考 |
| luhill/easy_cam | TypeScript | （见仓库） | 同栈摆线实现，trochoidPath/adaptiveFourZone 可对照移植 |
| stephenhouser/f-engrave（Scorchworks） | Python | GPL-3 | V-carve 采样 MAT 算法蓝本（注意 GPL：**参考算法思路重写，勿拷代码**） |
| GridSpace/grid-apps（Kiri:Moto） | JS | MIT | Clipper offset 工程实践、shadow 栈；无摆线/无 rest（负结论） |
| clipper-lib / js-angusj-clipper / polygon-clipping / polybooljs | JS/WASM | 各自 | 多环 offset + 布尔基建候选 |
| hersheytext | JS | MIT（数据 PD） | 单线字 |
| opentype.js | JS | MIT | 轮廓字（真 V-carve 文字） |
