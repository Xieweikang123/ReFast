# 性能优化审计清单

- **审计日期**：2026-09-01
- **代码版本**：v1.0.83（file:line 以该版本为准，会随代码漂移，动手前先重新定位）
- **审计方式**：前端渲染 / 打包体积 / Rust 后端 三路只读审查，未改任何代码
- **原则**：所有条目均不改对外行为；触及 `compareSearchResults` 的改动必须保持排序铁律——**用过（use_count/last_used > 0）的结果始终排在 Everything 结果之上**（见 AGENTS.md）

## 基线数据（优化前后对比用）

| 指标 | 值 |
|------|-----|
| 主 bundle（dist/assets/index-*.js） | 1,896,995 B（1.81 MB），单 chunk |
| CSS | 88,798 B（正常） |
| 动态 chunk | 仅 6 个微型桩（plugins/loader.ts 的动态 import，证明 Tauri 生产环境动态 chunk 加载正常） |
| SQLite 连接模式 | 每次调用新建连接 + 全量迁移（75 处调用点） |
| React.lazy 使用数 | 0 |

## 第一批：高收益、零行为变化（纯机械重构，可一批做）

- [ ] **B1. SQLite 连接与迁移**：每次访问都 `ensure_db_path` + 开连接 + 重跑 ~20 条 DDL 迁移；最热路径是每次按键（`check_path_exists`、`search_file_history`）
  - `src-tauri/src/db.rs:40`（get_connection）、`db.rs:66`（readonly）、`db.rs:88-272`（run_migrations）
  - 修复：进程内持有单一连接（`OnceLock<Mutex<Connection>>`）或连接池；迁移用 `Once`/`AtomicBool` 门控或 meta 表存 schema 版本
- [ ] **B2. getPluginIcon 击穿三层 memo**：组件体内普通函数，每次渲染新引用，使 `HorizontalResultItem`/`VerticalResultItem`/`ResultList` 三层 React.memo 全部失效；Everything 流式期间每批进度都全量重渲染列表
  - `LauncherWindow.tsx:319`（定义）→ `SearchResultArea.tsx:332` → `ResultList.tsx:72/195/499`
  - 修复：移到组件外作模块级纯函数（一行，收益最大）
- [ ] **B3. check_path_exists 逐键全表重载**：每次调用全量重读 open_history 进内存，且持全局 Mutex；前端每键调用
  - `open_history.rs:738-743`（同类问题 `:305-309`、`:312-316`）
  - 修复：仿 `search_history`（`open_history.rs:500-503`）——仅缓存为空时加载，查询走内存 Map
- [ ] **B4. 历史表全量重写**：每次打开文件执行 `DELETE FROM open_history` + 全表重 INSERT（file_history.rs 同模式）
  - `open_history.rs:125-156`（save_history_internal），调用点 `:268`、`:300`、`:639`；`file_history.rs:117-147`
  - 修复：改单行 UPSERT，照抄 `plugin_usage.rs:31-42` 的正确写法；删除/改名/范围清理等低频操作保留全量重写
- [ ] **B5. getOpenHistoryTimestamp 重复规范化**：每条结果线性扫全量 openHistory 且每 key 重做 `normalizePathForHistory`；同文件现成缓存 Map 未被使用
  - `resultUtils.ts:330-341`；调用点 `LauncherWindow.tsx:876`、`resultUtils.ts:348-391`
  - 修复：改用 `getNormalizedOpenHistoryMap`（`resultUtils.ts:779-794`），语义等价
- [ ] **B6. 滚动条样式 MutationObserver 重注入**：每次 DOM 变化都删除+重建 `<style>` 节点，搜索期间强制全文档样式重算
  - `useScrollbarStyle.ts:188-197`（observer 回调）、`:59-64`（injectStyle）
  - 修复：先比对 `textContent`，一致则跳过
- [ ] **B7. 剪贴板写入开 3 个连接**：每次复制事件 add → enforce_max_items（内部 load_settings）→ 共 3 连接 + 2 次迁移；超限逐行 DELETE 无事务
  - `clipboard.rs:69`、`:114`、`:123`、`:190-196`
  - 修复：`clipboard_max_items` 进程内缓存；enforce 复用同一连接；删除改单条 `WHERE id IN (...)` 或包事务；图片文件删除移出事务路径
- [ ] **B8. 小项一批**：
  - `searchPerf.ts:15-25` —— `isSearchPerfEnabled` 每次打点同步读 localStorage（生产也在发生），改模块加载时求值一次
  - `LauncherWindow.tsx:588-606` —— 300ms 永久 `isVisible()` IPC 轮询，已有 `onFocusChanged`（552 行）覆盖主场景，interval 可首次成功后自停或放宽到 1000ms
  - 删除死代码：`src/context/LauncherContext.tsx`、`src/components/UpdateCheckDialog.tsx`（全库无引用，后者是 react-markdown 第四引用源）

## 第二批：中收益（需小量设计/测试）

- [ ] **M1. Bundle 代码分割**：`main.tsx:4-18` 15 个子窗口 App 全静态导入 → launcher 每次唤起都在解析 mathjs（~500KB，最大单一贡献者）、chart.js、monaco-loader
  - 修复：除 Launcher 外改 `React.lazy` + 最小 `<Suspense fallback>`（fallback 透明，避免透明窗口闪白）；现有 6 个微型 chunk 已证明动态加载可用，风险低
  - 配套：`LauncherWindow.tsx` 的 `PluginListModal` 按 `isPluginListModalOpen` 条件挂载，把 chart.js 整条链移出首屏
  - 不建议：按 API 裁剪 mathjs（精度行为可能变化）；monaco 本地化打包（+3MB，属功能变更）
- [ ] **M2. 合并排序预计算**：`combineResultsUtils.ts:1012-1047` 每次合并跑两遍全排序，比较器每次比较重复算 `calculateRelevanceScore` + `getMatchTier` + usage 查找；触发频率 = 每键 + Everything 每流式批次 + 每个图标完成（`extractedIconsVersion` bump，`LauncherWindow.tsx:838/850`）
  - 修复：排序前预计算每条的 `{tier, score, usage}`，比较器只读缓存；`extractedIconsVersion` bump 做 ~100ms 合并
  - **必须加单测锁定排序不变**（扩展现有 `resultUtils.test.ts`）
- [ ] **M3. 结果列表无虚拟化**：DOM 行数 = 结果总数（初始 100 + 每批 50 无上限），视口仅 ~10 行；每个 `.lnk` 行挂载即打 IPC
  - `ResultList.tsx:548/571` 全量 map；`resultUtils.ts:703-705` 增量加载只分批 setState
  - 修复：虚拟化（容器 500px 固定）或退一步做渲染上限+滚动加载；⚠️ 唯一有 UI 风险项，`LauncherWindow.tsx:980-1171` 大量依赖 `querySelector('[data-item-key]')`，需完整回归键盘导航
- [ ] **M4. 历史搜索拼音逐键重算**：`file_history.rs:399-421`、`open_history.rs:450-472` 每键对每个候选项实时 to_pinyin；`app_search` 已有预计算先例
  - 修复：写库时预计算存列（加列迁移），搜索直接读
- [ ] **M5. Everything 消息窗口每批新建/销毁 + sleep 轮询**：普通搜索单批无感；会话搜索 chunk 5000（`commands.rs:1836-1839`）时多批抖动
  - `everything_search.rs:1237-1241`、`:1271-1341`
  - 修复：复用常驻消息窗口（`WINDOW_SENDERS` 已按 hwnd 存 sender，天然支持）；等待改 `MsgWaitForMultipleObjectsEx`
- [ ] **M6. 搜索会话缓存无上限**：硬上限 2,000,000 条（`commands.rs:1822-1825`），仅显式 close 释放
  - 修复：LRU 上限（保留最近 2-3 会话）
- [ ] **M7. settings 无缓存**：每次读写都连接+迁移+全量 JSON 反序列化（`settings.rs:154-178`、`commands.rs:5198` 起）
  - 修复：进程内 `RwLock<Option<Settings>>` 缓存，save 后同步更新
- [ ] **M8. launcher 热键路径 window_config IO**：每次呼出/隐藏 1-3 个新连接（`commands.rs:1229/1250`、`window_config.rs:78-86`）
  - 修复：位置内存缓存，防抖落库；至少 save 不再先 load，直接 UPSERT

## 第三批：低收益（顺手做）

- [ ] 热路径 println/eprintln 门控（`file_history.rs:340`、`commands.rs:1264` 等）→ 统一 log + level 过滤
- [ ] `get_everything_version` 每次spawn PowerShell（`everything_search.rs:919-972`）→ `OnceLock` 缓存
- [ ] launcher HWND 探测线程 500ms 永久轮询（`main.rs:453-497`）→ 拉长到 1s 或改事件驱动
- [ ] `vite.config.ts` 加 `build.target: 'chrome105'`；可选 manualChunks 拆 react vendor（M1 落地后再做）
- [ ] `tauri.conf.json:20` launcher `transparent: true`：若 UI 无圆角/毛玻璃需求可改 false 省合成开销，改前确认前端样式避免视觉回归

## 确认过没问题的（避免重复调查）

- 剪贴板监控是事件驱动（`AddClipboardFormatListener`），非轮询，CPU 空闲成本≈0
- SQLite 索引覆盖到位（`idx_clipboard_history_created_at` 等），不缺索引
- 防抖分层完善：本地源 80ms / Everything 200-320ms / 合并 32ms，输入走 startTransition + 本地 state
- resize/滚动处理规范（ResizeObserver + 双 rAF + 1px 去重）；拖拽宽度 rAF 节流
- 内置插件模块级单例，无每渲染重建
- `plugin_usage.rs:31-42` 的 UPSERT 是正确示范；Everything 窗口句柄 5s 缓存正确
- ClipboardWindow 图片 IntersectionObserver 懒加载 + blob URL 清理，实现良好
- monaco 内核运行时从 CDN 加载（未进 bundle），但 JSON 格式化窗口离线首开会失败——既有行为，与优化无关

## 验证手段

- 每步后：`npm run build`（含 tsc）+ `cargo check`（src-tauri/）+ `npm test`
- 排序改动必须扩展现有 compareSearchResults 用例，锁定「used > Everything」铁律
- bundle 分析：`npx vite-bundle-visualizer` 核对 mathjs/chart.js/react-markdown 真实占比
- 基线数据见上表，优化后回填对比