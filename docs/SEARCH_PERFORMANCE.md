# 搜索链路性能优化记录

> 记录 2026-09 启动器搜索「不丝滑」问题的定位与修复过程。后续改动搜索相关代码前建议先读本文，避免把性能修回去。

## 背景

用户反馈启动器搜索「不丝滑」：打字回显卡顿、出结果慢、列表闪跳，但难以定位具体环节。

## 定位方法：搜索链路耗时打点

新增 `src/utils/searchPerf.ts`（临时工具，定位完成后可整体删除）。**dev 模式自动开启**，生产构建自动关闭。

每个搜索会话（每次输入变化）输出一行汇总到 `.cursor/debug.log`（`[search-perf]` 前缀），例如：

```
[search-perf] #3 q="we" 会话总耗时1908ms | 本地首帧呈现=361ms | everything防抖等待=417ms |
本地搜索执行=4ms | IPC:search_applications=8ms | 合并:computeCombinedResults=397ms |
everything:会话创建=607ms | everything:首包获取=290ms | 窗口resize次数=5 | ⚠️最长帧408ms(主线程卡顿)
```

### 搜索链路结构（打点位置）

```
按键 → query 变化（useSearch.ts 的 useEffect 开启会话 perfBeginSession）
  ├─ 本地源防抖 80ms（LOCAL_DEBOUNCE_MS）
  │    → 并行 invoke：search_applications / search_file_history / search_system_folders / memos
  ├─ Everything 防抖 200~320ms（everythingDebounceMs，按关键词长度）
  │    → start_everything_search_session → get_everything_search_range 首包
  → 结果回来 → 合并层防抖 32ms（useCombinedResults）→ computeCombinedResults 重排序
  → 列表渲染 + 窗口高度跟随调整（useWindowSizeAdjustment）
```

### 读数指南

| 指标 | 含义 | 异常阈值 |
|---|---|---|
| `本地首帧呈现` | 输入 → 结果上屏 | >150ms 需关注 |
| `合并:computeCombinedResults` | 主线程合并+排序 | >30ms 说明排序/去重回退 |
| `⚠️最长帧` | 主线程单帧 >50ms 即记 | 出现即表示打字会卡 |
| `IPC:search_system_folders` | 系统目录查询 | >100ms 说明预热失效 |
| `窗口高度突变(>40px)` | 列表高度跳变次数 | 频繁出现即闪跳 |
| `[未完成:...]` | 会话结束仍未完成的阶段 | Everything 会话悬挂时出现 |

日志位置：`D:\project\re-fast\.cursor\debug.log`（Rust 侧旧打点也在这个文件，按 `search-perf` 过滤）。

## 定位到的三大热点（2026-09 实测数据）

### 1. 排序比较器 O(n) 全量扫描（打字卡顿主因）— 已修

- **现象**：`computeCombinedResults=397~483ms`，最长帧 408~558ms
- **根因**：`getResultUsageInfo`（launcherUtils.ts）在排序比较器里被每对结果调用 2 次，每次都 `Object.entries(openHistory).find()` 全量扫描 + 为每个 key 做路径规范化。openHistory 数千条时，一次排序 = 数十万次对象分配。
- **修复**：模块级缓存 `openHistory` 的规范化 Map（`getNormalizedOpenHistoryMap`），以对象引用判变更，比较时 O(1) 查表。
- **守卫**：不要在 `compareSearchResults` 比较器里做 `Object.entries()` / `.find()` / `toLowerCase()` 之外的重复规范化；openHistory 结构改动时记得让缓存 key 判定失效（当前按引用比较，`useEffect` 里每次重建对象天然失效）。

### 2. 系统目录冷启动重复 IPC（首次搜索卡 1.1s）— 已修

- **现象**：`IPC:search_system_folders=1110ms`（仅首次搜索）
- **根因**：`useSystemFoldersInitialization` 启动预热 和 `searchSystemFolders` 首次搜索 **各自发了一次** `searchSystemFolders("")`；预热未完成时搜索再等一次完整冷启动。
- **修复**：`searchUtils.ts` 模块级 `loadSystemFoldersOnce()` 共享 in-flight Promise；预热 hook 改调 `prefetchSystemFolders(refs)` 填充缓存。
- **守卫**：任何新代码需要系统目录列表时，一律走 `prefetchSystemFolders` / `loadSystemFoldersOnce`，禁止直接 `tauriApi.searchSystemFolders("")`。

### 3. Everything 会话创建慢（607ms+，未修）

- `IPC:start_everything_session=607ms`、首包 290ms，属 Rust/Everything 服务侧开销。
- 已有的缓解：软超时 4s / 硬超时 15s、分页首包（30~50 条）、本地结果先出。
- 如需继续优化，方向是 Rust 侧会话创建耗时（见 `src-tauri/src/everything_search.rs`）。

## 效果

修复后复测：排序长帧消失，打字跟手；首次搜索不再卡 1.1s（预热命中共享 Promise）。

## 后续改动注意事项

1. **排序比较器**是热路径：每键触发、每对结果比较一次。任何新增逻辑请保持 O(1)，不要在里面做线性扫描。
2. **合并层**（`computeCombinedResults`）已是 `useCombinedResults` 32ms 防抖 + `startTransition` 包裹，输入框回显不受它阻塞；不要把合并计算移出 transition。
3. 本地源（80ms）与 Everything（200~320ms）分开防抖是刻意的分层设计（useSearch.ts），改防抖数值前先看打点数据。
4. 打点工具 `searchPerf.ts` 默认 dev 开启、生产关闭、可 `localStorage.setItem("refast-search-perf","0")` 强制关闭。确认性能问题不再复发后可整体删除（`src/utils/searchPerf.ts` + 各文件中 `perf*` 调用）。