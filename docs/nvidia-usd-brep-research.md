# NVIDIA USD BRep / SMLib 开源事件深研与 SceneLab 集成可行性

> 2026-10-14 · 多 Agent 调研产物（外部实证 Agent + 代码摸底 Agent + FFI spike Agent）。
> 方法：Web 检索 + 仓库克隆一手核验（浅克隆保留于 `$TEMP/usdbrep-inspect`）+ SceneLab 全库只读摸底 + 本机 Rust FFI 实验。
> 来源链接见文末；凡标注「未直接核验」的条目为检索摘要结论，引用前请再确认。

---

## TL;DR

- 事件属实：NVIDIA 于 2026-10-08 将 **USD BRep**（含 SMLib v10.0.0 BRep 内核与 NLib NURBS 库，约 103 万行 C/C++）以 **Apache 2.0** 开源，仓库 [NVIDIA-Omniverse/usd-brep](https://github.com/NVIDIA-Omniverse/usd-brep)，附 Windows/Linux 预编译二进制与 Python wheel。
- **能融入，但不是"替换内核"，而是"分层增援"**。SMLib 的价值在精确 BRep 能力（真圆角/抽壳/偏置/修复/解析几何），而不是给现有网格管线提速——manifold 布尔已是毫秒级，SMLib 对它没有性能优势。
- 最现实的集成路径是 **Tauri Rust 侧原生调用（FFI 预编译 DLL）**，前端 WASM 路径目前无官方支持、成本高（premake+Packman 工具链、TBB 依赖、103 万行编译），留作观察项。
- **本机 spike 已实测打通**：Rust（MSVC 工具链）链接官方 `SM_API.lib` 调用内核，两盒布尔并体积精确等于解析值 1500.000000，布尔 1.75 ms、细分 0.57 ms，5000 次循环无泄漏；Python 绑定同样通过（§6）。
- 两个前置缺口与 SMLib 无关但被本次研究确认为最高性价比：**① CAM 多环 2D 偏置（项目文档自己建议引入 Clipper 系库）；② SolidBody 数据模型无解析面承载能力**（`FaceSource` 只有 cylinder 单成员）。②是任何精确内核（含未来的 SMLib）落地的前提。
- 本机 spike 已验证 Rust 侧调用 SMLib 的可行性（见 §6）。

---

## 1. 事件核验（一手证据）

| 转述要点 | 核验结果 |
|---|---|
| NVIDIA 开源 "USD BRep" | ✅ 仓库 https://github.com/NVIDIA-Omniverse/usd-brep |
| 包含 SMLib | ✅ 且含完整 NLib（NURBS 库）；SMS 全家桶其余产品（TSNLib/GSNlib/VSLib/PolyMLib）**不在**仓库中 |
| Apache 2.0 | ✅ 仓库根 LICENSE（2020-2026 NVIDIA）；`repo.sh`/`repo.bat` 等引导脚本为 MIT 例外 |
| v1.0.0 发布于 2026-10-08 | ✅ CHANGELOG 全文仅一条 `[1.0.0] - 2026-10-08`；GitHub Release 发布于 10-09 |
| 此前仅商业许可 | ✅ SMLib 是 Solid Modeling Solutions 商业内核（1998 年创立，血统溯至 Boeing TIGER NURBS 研究），2022-05 被 NVIDIA 收购 |

注意版本号语义：**1.0.0 是 USD BRep 整体包版本；SMLib 内核自身是 10.0.0**（`source/SMLib/inc/SmConfig.h`）。

仓库信号（截至 2026-10-14）：约 1217 stars / 143 forks；**仅 1 个提交**（开发历史被压缩）；README 明示 **"currently not accepting contributions"**（只收 bug report）。这是一个"倒出来"的开源，不是"社区共建"的开源—— fork 自维护是常态预期。

## 2. 包内容与内核画像

### 2.1 组件清单（克隆实测，~94 MB）

| 组件 | 内容 | 规模 |
|---|---|---|
| **SMLib** | 核心：`NL_*`（NURBS 曲线/曲面求值、拟合、偏置）+ `Sm_*`（拓扑、布尔 `SmTopologySolver`、圆角、偏置/抽壳、扫掠、缝合、修复 `SmHealData`、细分 `SmTess`、多面体、射线） | 224 cpp / 238 h |
| **SM_API** | 纯 C 风格高层 API（Primitives/Brep/Curves/Surfaces/Fillets/Polygons/Intersectors/Queries/ImportExport/Heal） | 13 头文件 |
| SM_API_USD + BREP_STAGING/USD_DATA + HYDRA | USD 序列化桥 + Hydra 渲染插件 | 中 |
| **OCCT_BREP_IMPORT/EXPORT** | **独立解析 OCCT `.brep` 文件，不链接 OCCT SDK** | 小 |
| SmPyLib (`_omni_solid`) | pybind11 Python 绑定（PyPI: `usd-brep`，win_amd64 + manylinux wheel） | 中 |
| `.agents/` | NVIDIA 为 AI 编码 Agent 准备的 20+ SKILL（含 text-to-3d-asset-generation）——NVIDIA 内部已用 Agent 在该内核上做文本生成 CAD | — |

### 2.2 关键工程事实

- **构建系统**：premake5（NVIDIA 分支）+ Packman 拉依赖（OpenUSD 25.11、Python 3.12、pybind11）。**不是 CMake**。
- **内核与 USD 解耦良好**：`source/SMLib` 内无任何 `pxr/` 头；SMLib 唯一外部链接是 **TBB**。可以脱离 USD 单独用内核。
- **平台**：Windows（MSVC v142）/ Linux x86_64+aarch64 一等公民，官方 Releases 有预编译 7z；macOS 仅 Apple Silicon 且残缺（Packman 无 USD 包）。
- **并发模型**（`.agents/operations/concurrency.md`）：单进程内操作是**单线程**的（并行代码被编译期关闭），并发靠每 worker 一进程；全局 `SmContext` 非线程安全。文档有专门 "WASM workers" 一节——**NVIDIA 内部有浏览器/WASM 部署经验**，但**无官方 emscripten 构建/脚本**。
- **无 STEP/IGES 翻译器**：原生 I/O 仅 `.smb`/part container；外部 CAD 靠 OCCT `.brep` 文件前端或商业第三方（HarmonyWare 宣称已适配 SMLib v10，未直接核验）。
- **KNOWN_ISSUES（官方坦承）**：`remove_fillet` 无操作却报成功；`heal_brep` 失败仍报成功；闭合曲面缝合线修复有 9 种误修场景；**圆弧边界几何的面积/体积测量误差默认精度下最高 1.4%（低精度档 20%）**——对 CAM 有实际影响；畸形 BrepArray 可致导入崩溃。
- 社区已有移植动作：SolidCraft 作者在 [bherbruck/solidcore](https://github.com/bherbruck/solidcore) 做 SMLib 子集的 Rust 直译移植（目标含浏览器），HN 评价"优雅失败不崩溃、解开了此前专有的数学"（[HN 50064840](https://news.ycombinator.com/item?id=50064840)）。

## 3. SceneLab 现状基线（代码事实，file:line 见摸底报告）

与内核选型直接相关的代码事实：

1. **几何 100% 在前端 JS/WASM**；Rust 侧仅 7 个文件 IO 命令，零几何（`src-tauri/src/lib.rs:181-189`）。
2. **内核隔离极佳**：Manifold 全部交互收缩在 `booleanManifold.ts` 单文件，带 warmup/readiness/fallback/测试钩子完整协议（`boolean.ts` 调度层）。换核/加核的模板现成。
3. **`SolidBody` 是多边形面汤**：无拓扑边、无参数曲面、`Face` 无多环、`FaceSource` 仅 `{kind:'cylinder'}` 单成员（`geometry/types.ts:7-47`）。**表达不了精确 BRep**。
4. **离散发生在最上游**：草图圆/弧在 `extractProfileFromSketch` 即采为折线（弦差 0.005mm）；STEP 导入时 OCCT 在内核内部网格化、返回的 `brep_faces` 结构被丢弃（`stepOCCT.ts:193-198`）。
5. **CAM 对精确几何渴求充分自证**：`arcFit.ts`（折线再拟合回 G2/G3，曾 3.4s 冻结主线程）、`offsetPolygon` 单环 miter 偏置（docs/cnc-algorithms.md 自己写明"最大前置缺口，建议引入 Clipper 系库"）、`detectCircularHoles` 从刻面反推圆孔；而 `gcode.ts:78-95` 的 `emitArc` 已就绪——**只欠圆弧刀路的来源**。
6. **WASM 工程先例**：manifold 541KB（启动）+ occt-import-js 7.6MB（懒加载），CSP null，vite 无需专用配置。
7. **验收网现成**：2883 个 vitest 含几何金测试（对照解析公式）。
8. **已知能力缺口**（todo.md）：凹边精确圆角整体拒绝、非凸抽壳体素近似、多环 cap 面不支持、样条草图实体缺失、非流形输入体素回退 15-19s 悬崖。

## 4. 契合点分析：SMLib 到底能补 SceneLab 什么

| SceneLab 痛点 | 现状 | SMLib 能否解 | 判断 |
|---|---|---|---|
| 凹边精确圆角（现在整体拒绝→近似覆层） | `booleanManifold.ts:196-242` reflex 边拒绝 | ✅ 滚球圆角是内核原生能力 | **高价值** |
| 非凸抽壳体素近似（~0.2s、各向异性侵蚀） | `shellManifold` 非凸路径 | ✅ `SmShell` 精确抽壳 | **高价值** |
| 非流形输入布尔回退 15-19s 悬崖 | `booleanVoxel.ts` | ✅ `SmHealData` 修复 + 多面体布尔 | **高价值**（鲁棒性） |
| CAM 多环/带弧 2D 偏置 | `offsetPolygon` 单环 miter | ⚠️ 内核可做但重；**Clipper2 类库 1/100 成本可解** | 用 Clipper 系库 |
| CAM 圆弧刀路直出（去 arcFit 补丁） | 折线→拟合 | ✅ 但前置 = SolidBody 能承载解析边/面 | **中价值，先改数据模型** |
| STEP 导入保 BRep | occt-import-js 网格化 | ❌ SMLib 无 STEP 读入（`.brep` 文件可读但管线无生产者） | 维持 OCCT |
| 布尔速度 | manifold 毫秒级 | ❌ 无优势（内核单线程操作） | manifold 留任 |
| 样条草图/扫掠/放样 | 缺失 | ✅ NURBS 求值/拟合/扫掠原生 | **中价值**（建模广度） |
| AI/文本生成 CAD（SceneLab 有 ai 模块） | — | NVIDIA 自带 `.agents/` text-to-3d 工作流先例 | 远期观察 |

**结论：SMLib 是"精确算子增援"而非"性能替换"。** 性能收益只出现在现在走体素/近似回退的路径上（那是数量级级别的改善），其余收益全是能力维度。

## 5. 集成路径对比

| | A. 前端 WASM（仿 manifold/occt） | **B. Tauri Rust 侧原生（FFI）** | C. 观望社区（solidcore/官方 WASM） |
|---|---|---|---|
| 工程量 | 大：自建 emscripten 构建，premake+Packman 改造、TBB 需替换/桩化、103 万行编译进 vite 管线 | 中：预编译 DLL + `libloading`/静态链接，Tauri command IPC | 零 |
| 证据强度 | 无官方先例（NVIDIA 内部有但未发布） | **本机 spike 已验证（§6）**；官方预编译 Windows/Linux 二进制 + 纯 C API | 依赖第三方进度 |
| 架构方向 | 与现状同构（几何在前端） | 新增前后端几何 IPC 边界（现状仅网格 JSON） | — |
| 分发 | wasm 资产随 webview，跨平台一致 | 需按平台打包 DLL（Tauri sidecar/resources），macOS 残缺 | — |
| 单线程约束影响 | worker 内各自实例（NVIDIA 文档明示支持） | 进程内全局锁即可（桌面单用户） | — |
| 许可 | Apache 2.0 ✅ | Apache 2.0 ✅（随包分发义务满足） | 同 |

**推荐：B 为主路径起步（算子级、非全量替换），A/C 作为演进选项。** 关键架构决策：不把 SMLib 塞进现有特征树求值热路径（同步签名约束、memo 语义都会被破坏），而是作为**离散的"重算子服务"**：圆角/抽壳/修复这类现在走近似或拒绝的操作，经 Tauri command 异步调用，结果网格化后回到 SolidBody——与现有 `asyncBooleanOp` 变体和 boolean.ts 调度模板（exact → manifold → voxel 回退链中插入一档）兼容。

## 6. 本机 Spike 验证（Rust FFI）

> 2026-10-14 实测。产物保留于 `%TEMP%\sm-spike\`（下载包 `dl`/`pkg`、Rust 工程 `ffi-crate`、Python 验证 `py312`/`two_boxes.py`）；仓库克隆在 `%TEMP%\usdbrep-inspect`。

**结论：路径 A（Rust 链接期绑定直接调用内核）与路径 B（Python 绑定）均验证通过。**

| 验证项 | 结果 |
|---|---|
| 官方预编译包 | `usd_brep@1.0.0…windows-x86_64.release.7z`，28.7 MB 下载 / 225 MB 解压；**含全套 .lib 导入库与头文件** |
| 内核运行时依赖 | `SM_API.dll + SMLib.dll` **不依赖 TBB**（TBB 仅 USD 插件用）；仅需 VC++ 2015-2022 redist + ucrt |
| Rust 环境 | cargo 1.98.0，host `x86_64-pc-windows-msvc`（Tauri Windows 默认工具链即满足） |
| 布尔正确性 | 两 10³ 盒错位 5 → union 体积 **1500.000000 = 解析值**；tight bbox 精确 `[0,0,0]..[15,10,10]`；manifold=true |
| 细分 | `SmApiTessellate` 574 µs，网格体积同为 1500.000000 |
| 性能信号 | 布尔 1.75 ms、细分 0.57 ms、create+volume+destroy 488 µs/次（Release，冷进程含初始化 2.45 s 总耗时） |
| 稳定性 | 5000 次 create→volume→destroy 循环：工作集 Δ352 KB（分配器噪声级），无泄漏无崩溃 |
| Python 侧 | 官方 embeddable CPython 3.12 + 包内绑定：union 1.40 ms 体积精确；球体 r=5 BRep 体积 523.5988 与解析一致 |

**FFI 集成的关键坑（已实测排雷）**：
1. `SmApi*` 函数是 **NONAME 序号导出**——`libloading` 按名 `GetProcAddress` 取不到；正解是 **build.rs 链接 `SM_API.lib` + `#[link_name = "<MSVC mangled 名>"]`**（mangled 名自带确切 ABI 信息，spike 的 main.rs 即模板）。
2. 头文件是 C++（引用/内联默认参/模板），FFI 层需手写少量 `repr(C)` 镜像结构（`SmVector3d`=3×f64 无虚表、`SmTessellationParams`=5×f64 POD 等）。
3. **成功码是 1000（SM_SUCCESS）不是 0**；`TCHAR/SmChar` 本包为窄字符 char。
4. **内存所有权协议**：布尔成功会吃掉第二操作数（B 被内核删除）、result 是 A 别名；跨模块释放必须「DLL 导出的虚析构 + ucrt `free`」，不能让 Rust `Drop` 接管（压测已证实协议正确）。
5. 单线程内核：Tauri 侧应串行化调用（全局锁或专用 worker 线程），勿在 async runtime 并发调。
6. ~~网格数据提取缺口~~ **已由第二轮 spike 闭合（2026-10-14）**：SMLib.dll 的 C++ 访问器（`GetPolyFaces`/`GetPolyVertices`/`GetPolyShells` 等 21880 个导出，全部按名导出——前轮"访问器未导出"是误判，源于一份在 8192 行处截断的导出清单）。验证方案：单文件 C++ shim（`smmesh.cpp`，14 个 extern "C" 导出，把 `SmTArray<T>` 模板出参翻译成扁平数组），Rust libloading 调用：box → 8 点/12 三角形坐标正确；球 r=5 → **224 面/114 点与 Python 绑定精确一致**，chordTol=0.1 细化 → 3968 面体积 521.47 收敛于解析值 523.60，无泄漏无崩溃。编译要点：`/MD /std:c++17 /DUNICODE /D_UNICODE`（TCHAR 宽字符不匹配会 LNK2019）。产物：`%TEMP%\sm-spike\mesh-extract\`。正式集成形态：smmesh.cpp 入库 + build.rs 开发机编译 + 发布预编译 smmesh.dll 随 SMLib.dll 分发。

## 7. 分阶段路线图（建议）

**P1（与 SMLib 无关，立即可做，性价比最高）**
- 引入 Clipper 系 2D 偏置库（如 `js-angusj-clipper`/`polygon-clipping`），替换 `offsetPolygon` 的单环 miter 实现，解掉 docs 承认的 trochoidal/adaptive 前置缺口。纯前端、低风险、测试网现成。

**P2（任何精确内核的前提，kernel-agnostic）**
- 扩展 `FaceSource` 为解析面联合类型（plane/cylinder/cone/sphere/torus + 解析边圆弧），允许多环 Face（todo.md:79 已立项）。
- `Toolpath` 增加圆弧段类型，`gcode.ts` 的 `emitArc` 消费之，逐步让圆弧免于"离散→再拟合"往返。
- 这一层即使永不集成 SMLib 也直接回本（STEP 导出再缩减、工程图真圆、CAM 弧直出）。

**P3（SMLib 增援算子，依赖 P2 + spike 结论）**
- Rust 侧封装 SMLib 服务：首批三个算子——凹边精确圆角、非凸精确抽壳、非流形输入修复（替代体素回退）。
- 接入点：boolean.ts 回退链插入 SMLib 档；特征求值器在精确路径失败时异步请求 SMLib。
- FFI 按 §6 协议：build.rs 链 `SM_API.lib` + mangled `#[link_name]`、repr(C) 镜像结构、专用 worker 线程序列化调用、「DLL 析构 + ucrt free」所有权协议。
- 网格回传走已验证的 smmesh shim（§6 坑 6）：`smmesh.cpp` 入库，开发机 build.rs 调 cl 编译（`/MD /std:c++17 /DUNICODE /D_UNICODE`），发布产物预编译 `smmesh.dll` 随 `SMLib.dll`/`SM_API.dll` 分发。
- CI：Windows/Linux 预编译 DLL 的获取与打包脚本（注意官方 7z 用 BCJ2 压缩法，`py7zr` 解压会静默截断，须用真 7z 工具）；KNOWN_ISSUES 规避清单入测试。

**P4（观察项）**
- 跟踪 solidcore（Rust 移植）与 NVIDIA 官方动向（WASM 构建/STEP 前端/贡献政策变化）；若官方出 WASM，评估把 P3 服务迁回前端，消除 IPC 边界。
- HarmonyWare STEP 翻译器（商业）作为 STEP→SMLib 全链路的未来选项记录在案。

## 8. 风险与未核验项

- ~~网格数据提取缺口~~ 已闭合（§6 坑 6 更正：C++ 访问器本就按名导出，shim 方案实测通过）。
- SMLib 单提交历史 + 不接受贡献 → 行为变化只能靠 fork 自维护，升级路径弱。
- KNOWN_ISSUES 的测量精度问题（圆弧体积误差至 1.4%/低精度 20%）对 CAM 切深估算有影响，需在 P3 用金测试量化。
- macOS 支持残缺；若 SceneLab 未来出 mac 版，路径 B 需另行评估。
- spike 性能数字为单进程冷启动 + 单线程 Release 粗粒度计时，未与 manifold 在同负载下对照实测；P3 立项前应补同场景基准。
- 「HarmonyWare 已适配 SMLib v10」「Reddit 社区反应细节」为检索摘要，未一手核验。
- Rust FFI spike 的结论仅覆盖本机（Windows x64 + cargo 1.98 MSVC）；Linux CI 需另行验证（Linux 包的 .so 链接方式未测）。

## 来源

- 仓库：https://github.com/NVIDIA-Omniverse/usd-brep （LICENSE / CHANGELOG.md / README / KNOWN_ISSUES.md / `.agents/operations/concurrency.md` / `source/` 清单，2026-10-14 克隆核验）
- PyPI：https://pypi.org/project/usd-brep/
- 报道：[Develop3D](https://develop3d.com/cad/nvidia-launches-usd-brep-geometry-kernel-for-solid-modelling)、[HN 50064840](https://news.ycombinator.com/item?id=50064840)、[r/openscad 1x55v8u](https://www.reddit.com/r/openscad/comments/1x55v8u/nvidia_release_smlib_as_open_source)（后两者部分未一手核验）
- SMS 历史：[Wikipedia: Solid Modeling Solutions](https://en.wikipedia.org/wiki/Solid_Modeling_Solutions)
- Rust 移植：https://github.com/bherbruck/solidcore
- SceneLab 侧：全库只读摸底（file:line 引用见 §3，基于 v0.29.0 代码，2026-10-14 核验）
