# CNC 软件市场调研与 SceneLab CAM 对标

> 2026-10-10 · multi-agent-dev pass #33 研究产物（两个研究 Agent 并行检索验证，来源链接见文末）。
> 目的：调研市面 CNC/CAM 软件（商业 + 创客/开源），找出 SceneLab CAM
> 值得学习的功能与设计，指导后续开发优先级。

## 1. SceneLab CAM 现状盘点（对照基线）

### 1.1 已有能力（v0.26.0，`src/lib/cam/` + `CAMPanel`）

| 领域 | 现状 |
|------|------|
| 工序类型 | 4 种：pocket（光栅 zigzag、岛屿裁剪、行间连接、斜坡下刀）、contour（轮廓偏移刀补、多次切深、留料余量）、drill（啄式、孔自动检测/手动钉定）、face（面铣 zigzag、过界余量） |
| 刀具 | 平底/球刀/V 刀/钻头 4 类；自定义刀具（⌀/刃数编辑，localStorage 持久化） |
| 进给 | 8 种材料 Vc/fz 公式推荐 + RPM 钳制 + 一键应用 |
| 后处理 | grbl / LinuxCNC 两种；G90/G21/G17/G94 头、模态 F、G83 或展开啄式、M6 换刀（grbl 为注释暂停）、M2/M30 结尾 |
| 仿真 | 机床仿真（播放/暂停/重置/seek，按进给速率走刀，视口内刀具模型跟随） |
| 时间估算 | 按移动段长/进给逐段累加，快移 5000 mm/min |
| 毛坯 | bbox+margin 或显式 box（随工程序列化，未在视口可视化） |
| 工序管理 | 增/删/启停/单工序重算/参数化编辑后存活（指纹缓存 + 去抖重算） |
| 导出 | .nc 下载（无预览） |

### 1.2 已知缺口（盘点阶段自查，已被研究结论确认优先级）

1. 轮廓无 **tab/bridge 桁料**——切穿后零件飞出（创客安全关键项）
2. 无 **climb/conventional** 方向控制（当前外环 CCW=顺铣、岛屿 CCW=逆铣，不自洽）
3. 无 **spring pass** 精光刀、无进刀 **ramp lead-in**
4. G-code **纯直线**（无 G2/G3 圆弧输出——曲线件文件大、运行抖）
5. 工序不可 **编辑回填/重排/复制**（只能删了重加）
6. 无 **G-code 预览/预检**（直接下载）
7. 仿真无 **倍速/单步**控制
8. 钻孔仅 G83（无 G81/G82 停留）
9. 无 WCS（G54）显式输出与对刀原点选择
10. 毛坯未在视口可视化
11. 无 setup sheet 工艺卡
12. pocket 无侧壁精光、无 helix/摆线等高级下刀

## 2. 商业 CAM 软件对标结论（要点）

调研对象：Fusion 360、Mastercam、PowerMill、SolidWorks CAM/CAMWorks、GibbsCAM、ESPRIT、hyperMILL、NX CAM、Edgecam、BobCAD、SprutCAM、ZW3D、Carbide Create（2025–2026 版本口径）。

**与我们定位（个人创客网页 CAD/CAM）相关的最佳实践：**

| 维度 | 市面最佳实践 | 代表 |
|------|-------------|------|
| 后处理 | 可脚本生态（JS `.cps` + 开源库 + 无代码属性 UI） | Fusion 360（最开放）；Mastercam Arc Filter 标杆 |
| Setup 模型 | 一个 Setup 绑 WCS+毛坯+夹具；多装夹=多 Setup | Fusion 三 tab 范式 |
| 智能默认值 | 材料库驱动 feeds/speeds，"选材料即安全参数" | Carbide Create/Easel |
| 粗加工 | adaptive/trochoidal 恒定啮合角为行业默认心智 | Mastercam Dynamic/Fusion Adaptive/VoluMill |
| 粗精合一 | 粗加工内嵌精修 passes（2024-2026 趋势） | Mastercam 2025 / PowerMill / Fusion |
| Contour 标配 | 多深度 + spring pass + climb/conv + tabs + ramp | Fusion 2D Contour |
| 路径质量控制 | 切削公差与平滑公差分离；**G2/G3 圆弧拟合**减体积、防 look-ahead 溢出 | Mastercam Arc Filter + total tolerance |
| 工序管理 | 工序树：重排/复制/抑制 + 逐序时间（rapid 速率可配置） | NX Operation Navigator |
| 仿真 | 三层：回放 → in-process stock 碰撞 → 整机孪生；GPU 并行 | Fusion/Mastercam 2026/NX |
| 输出 | setup sheet 工艺卡（HTML 可配）；时间估算 ±10% 依赖参数校准 | Fusion/Mastercam |
| 差异化机会 | V-carving 一等公民（工业软件普遍缺位） | Vectric/Carbide Create |

**15 个最值得学习的设计**（商业报告按影响排序，节选与本项目相关）：开放后处理生态、Setup 容器模型、材料库智能默认、adaptive 默认开粗、3D 斜坡 tabs、即时刀路预览（后台计算不阻塞 UI）、浏览器材料去除仿真（heightmap/voxel 即够）、工序树重排/复制/抑制、共享刀具库、rest machining 创客化简化、切线/斜坡进刀为默认、双公差 + G2/G3 拟合、孔识别向导、setup sheet、V-carving。

## 3. 创客 / 开源 CNC 软件对标结论（要点）

调研对象：Vectric 全家、Carveco、EstlCAM、CamBam、Kiri:Moto、SheetCam、FreeCAD Path、Blender CAM(Fabex)、发送器（gSender/UGS/CNCjs/bCNC/Candle/OpenBuilds CONTROL）、仿真查看器（CAMotics/NCviewer）、LinuxCNC/Mach/PlanetCNC、GRBL/grblHAL/FluidNC。

**创客生态是分层工具链**：CAD → CAM → G-code 预览 → 发送器 → 固件。关键事实：

- **GRBL v1.1**：支持 G2/G3（IJK 与 R 均可）、G10 L2/L20、G38.2 探测；**不支持** canned cycles（CAM 必须展开）、G41/G42（刀补必须 CAM 端完成）、G43 表（仅 G43.1 动态）。grblHAL 补齐了这些。
- **GRBL error 33 教训**：圆弧小数位不足 → "arc target invalid"。**I/J 与终点至少 4–5 位小数**（CamBam 前车之鉴）。
- 主流 GRBL post **默认不输出行号**（N word 有坑）；断点续跑用文件行索引实现。
- **Tabs 痛点史**：VCarve V12.5 专门重写默认放置、Carbide Create V7 把 tabs 从刀路属性移到矢量属性——两家的补救动作本身就是证据。最佳实践 = 自动均匀分布 + 手动增删 + 独立高/宽参数 + **3D 斜坡造型**（防精修撞刀）。
- **V-carving 是商业护城河**：开源侧基本空白（Kiri:Moto trace 不算、FreeCAD 只有简单 Engrave）。
- 仿真预览最佳实践：**rapid/cut 分色**、按刀着色、播放条 + 单步、时间估算带校准系数、大文件流式解析。
- **gSender "file insights"**：发送前显示进给范围/主轴范围/用刀/时间/尺寸——预检是低成本高价值。
- 用户痛点 Top：CAM 学习曲线第一、CAM 用错 post、换刀刀长补偿、开源工具停更（CAMotics/PyCAM/FlatCAM）、新手默认值缺失断刀。

**网页版创客 CAM 功能排序**（创客报告按 价值/成本）：① Profile 刀路全套（多层+ramp+climb/conv）② Pocket ③ GRBL 友好输出+预检 ④ 刀具库+材料预设 ⑤ 3D G-code 预览 ⑥ Tabs ⑦ 探针对刀向导 ⑧ Web Serial 发送器 ⑨ 时间估算+校准 ⑩ Drill ⑪ override+断点续跑 ⑫ DXF/SVG+文本工具 ⑬ V-carving ⑭ 换刀重对零 ⑮ 双面加工/Nesting。

## 4. 差距分析与立项

对照两份报告与现状：SceneLab 已覆盖 ①②④⑨⑩ 的主体（这正是本项目 CAM 已有的 4 工序+刀具库+材料推荐），**最大缺口集中在 ③⑤⑥（GRBL 圆弧输出、G-code 预检、tabs）与轮廓精修标配（climb/conv、spring pass、ramp 进刀）、工序树管理（编辑/重排/复制）、仿真播放体验（倍速/单步）**。

### 本轮（pass #33）立项 —— 「CAM 平价补全：轮廓精修 + 圆弧输出 + 工序管理 + 预检」

| # | 功能 | 依据 | 切片 |
|---|------|------|------|
| 1 | Contour **tabs**（3D 斜坡桁料：数量/高度/宽度） | 两报告一致高位（创客安全关键） | A |
| 2 | Contour **climb/conventional** 方向（含岛屿自洽） | 创客 ①、商业 Contour 标配 | A |
| 3 | Contour **spring pass** + **ramp 进刀** | Fusion 2D Contour 标配、断刀防护 | A |
| 4 | **G2/G3 圆弧拟合输出**（4+ 位小数、G17 平面、公差控制） | Mastercam Arc Filter 标杆 + GRBL error 33 教训 | B |
| 5 | 工序 **编辑回填/重排/复制** | NX Operation Navigator 范式 | C |
| 6 | **G-code 预览 + 预检**（行数/大小/用刀/进给范围/时间 + 复制下载） | gSender file insights、NCviewer | C |
| 7 | 仿真 **倍速 + 单步** | 创客仿真 UX 最佳实践 | D |

### 后续轮次候选（记录，不在本轮）

- Helical/trochoidal **adaptive clearing**（商业报告 #4；大工程，独立轮）
- **V-carving/文字雕刻**（差异化机会，商业护城河；独立轮）
- **Rest machining** 创客化、**setup sheet** 工艺卡、毛坏视口可视化、按刀着色
- 钻孔 G81/G82 变体、WCS/G54 显式输出
- 探针对刀向导 + Web Serial 发送器（超出 CAD 应用范畴，属产品路线图决策）

## 5. 信息来源

两份完整调研报告（含全部来源链接与功能矩阵）由研究 Agent 产出，要点已并入上文：
商业侧：Autodesk/Mastercam/OPEN MIND/Siemens/Hexagon/GibbsCAM/ZWSOFT/Carbide 3D 官方文档与博客 2025–2026；MLC CAD、eMastercam、toolpath.com（Arc Filter）；Vericut。
创客侧：Vectric/Carveco/EstlCAM 官方；grbl/grblHAL GitHub；Sienci gSender 及资源站；LinuxCNC 文档；CAMotics/NCviewer；V1 Engineering/OneFinity/Carbide 3D/FreeCAD 社区论坛；Reddit r/hobbycnc。
