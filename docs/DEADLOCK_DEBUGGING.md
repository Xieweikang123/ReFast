# 死锁排查实战手册

> 来源：v1.0.83 期间「Alt+A 微信截图后启动器唤不起」的连续三次死锁排查（2026-09-01）。
> 最终全部通过 **dump 取证 + PDB 符号化** 定位，未靠猜测。本文沉淀可复用的工具链、方法论与架构铁律。

---

## 一、事件回顾（三个死锁，层层递进）

| # | 表象 | 真实根因 | 修复 |
|---|------|---------|------|
| 1 | Everything 搜索期间整进程「未响应」 | 每批搜索在 spawn_blocking 线程上新建 reply 窗口，该线程不泵消息，Everything 跨进程 SendMessage 回复时对方悬挂 | 回复窗口收敛到常驻 IPC 专用线程（`everything_search.rs`） |
| 2 | 截图后热键/托盘唤不起 | 托盘点击回调（事件循环上下文）直接调 `window.is_visible()`——Tauri 该 API 是「向事件循环发请求并阻塞等回复」，回调不返回请求永远无人处理 → **主线程自死锁** | 回调内只 `thread::spawn`，窗口操作全部移出（`main.rs` on_tray_icon_event） |
| 3 | 同样唤不起（托盘菜单却能弹出） | 主线程在执行 **sync command** `record_plugin_usage` → `get_connection` 抢 `SHARED_CONNECTION` 锁；事件循环停摆 → 所有 `is_visible/show/set_focus` 请求悬挂 → 14 线程连环等锁 | sync command 改 `async + spawn_blocking`；唤起热路径（launcher 位置读取）加进程内缓存零 DB 访问 |

**关键教训**：第 2、3 次死锁的表象完全相同（唤不起），但根因不同。如果第二次修复后没有立即复现验证，就会误判为已解决。

---

## 二、取证工具链（全部现成可用，位于 `%TEMP%\opencode`）

无 cdb/windbg/Debugging Tools 环境下的完整替代方案，**PowerShell 5.1 constrained language mode 也可用**（工具是编译好的 exe）：

| 工具 | 用途 | 用法 |
|------|------|------|
| `minidmp.exe` | 抓挂死进程完整 dump（含全部线程栈内存） | `minidmp.exe <pid> <out.dmp>` |
| `hwndump.exe` | 枚举进程全部窗口（hwnd/tid/class/visible） | `hwndump.exe <pid>` |
| `ishung.exe` | 判断窗口线程是否 hung（IsHungAppWindow） | `ishung.exe 0x<hwnd> [0x<hwnd2> ...]` |
| `threaddump.exe` | 全线程 TID + 累计 CPU | `threaddump.exe <pid>` |
| `listthreads.exe` | 列 dump 内全部线程 | `listthreads.exe <dump>` |
| `modlist.exe` | 列进程模块基址（符号化必需） | `modlist.exe <pid>` |
| `symenum3.exe` | 从 PDB 导出符号表（地址+名字） | `symenum3.exe <base> <out.txt>` |
| `fullstack.exe` | 扫描 dump 内指定线程栈，输出 re-fast 符号帧 | `fullstack.exe <dump> <base> <tid> <syms.txt>` |
| `findsqlite.exe` | 跨线程找 SQLite 相关栈帧 | `findsqlite.exe <dump> <base> <tid> <syms.txt>` |
| `addrmod.exe` | 地址 → 模块+偏移 | `addrmod.exe <pid> <addr>...` |
| `clipprobe.exe` | 检查剪贴板内容类型 | `clipprobe.exe` |

源码 `.cs` 同目录都在，改动后用 `csc.exe`（`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`）重编译。

### 标准取证流程（挂死时 5 分钟内完成）

```
1. Get-Process re-fast          # 确认挂死（Responding=False），记下 PID
2. hwndump <pid>                # 拿主窗口 hwnd + 各窗口线程 tid
3. ishung <hwnd>                # 判断主线程是否 hung；热键/钩子窗口线程对照
4. minidmp <pid> hang.dmp       # 立即抓 dump（206MB，挂死现场固化，之后可随意杀进程）
5. modlist <pid>                # 拿 re-fast.exe 基址
6. symenum3 <base> syms.txt     # 导出符号表（需 PDB: target/debug/re_fast.pdb）
7. listthreads hang.dmp         # 列线程，找主线程 tid（或 hwndump 里 Tauri Window 的 tid）
8. fullstack hang.dmp <base> <主线程tid> syms.txt   # 出栈
```

### 工具实现的坑（重写时必读）

- **x64 CONTEXT 的 `ContextFlags` 偏移是 0x30**（前面 6×u64 home 区），不是 0；`Rsp=0x98, Rbp=0xA0, Rip=0xF8`
- **SYMBOL_INFOW 布局**（64 位对齐后）：`Address` 在 +0x38，`Name` 在 +0x54 起（UTF-16，null 结尾）；`MaxNameLen` 在 +0x54 前 4 字节。**不要信文档布局，先 dump 原始字节验证**
- dbghelp 正确导出名是 `SymFromAddrW` / `SymEnumSymbolsW`（`SymGetSymFromAddrW64` 在部分系统缺失）
- `SymInitializeW` 搜索路径直接填 PDB 所在目录（`D:\project\re-fast\src-tauri\target\debug`）
- PowerShell 5.1 的字符串替换会截断 UTF-8 中文 → 源码文件只用 ASCII 字符串
- `List<char>` 传给 `WriteLine(object)` 会打印类型名，用 `Write(char[])` + `WriteLine()`
- 挂死线程的栈页可能被换出，`ReadProcessMemory` 报 err=18 → 从 **dump 文件**里读（MiniDumpWriteDump 会物化内存），不要在活进程上硬读

---

## 三、本项目已确认的死锁模式（改代码前先对照）

### 模式 1：事件循环回调内调用需要事件循环响应的 API ⚠️ 铁律

Tauri 2 的 `is_visible()/show()/set_focus()/hide()` 等 API 实现 = 向事件循环发 channel 请求 + 阻塞等回复。
**任何在事件循环线程上执行的代码（托盘/菜单/窗口事件回调）调用它们 = 自死锁。**

```rust
// ❌ 死锁：on_tray_icon_event / on_menu_event / tao 窗口事件回调内
window.is_visible()

// ✅ 正确：投递到独立线程
std::thread::spawn(move || {
    let _ = window.is_visible();
});
```

**判定方法**：回调闭包是否在 `run_event_loop` 上下文执行。拿不准就 spawn，成本可忽略。

### 模式 2：sync command 在主线程做慢操作 ⚠️ 铁律

Tauri 2 的 `#[tauri::command] pub fn xxx`（非 async）**在主线程事件循环上执行**。
主线程一卡：全部窗口 API 悬挂 → 热键/托盘/焦点全死 → 表现为「进程未响应」。

```rust
// ❌ 主线程执行，碰 DB 锁
#[tauri::command]
pub fn record_plugin_usage(...) -> ... {
    plugin_usage::record_plugin_open(...)  // 内部 get_connection 抢全局锁
}

// ✅ DB 操作移出主线程
#[tauri::command]
pub async fn record_plugin_usage(...) -> ... {
    tauri::async_runtime::spawn_blocking(move || {
        plugin_usage::record_plugin_open(...)
    }).await.map_err(...)?
}
```

**存量风险**：`record_open_history`、`add_file_to_history`、`delete_file_history`、`update_*`、shortcuts 系列等 sync command 仍碰 DB（open_history.rs 6 处、plugin_usage.rs 2 处、shortcuts.rs 2 处），应逐步 async 化。

### 模式 3：全局锁 + 高频路径

`SHARED_CONNECTION`（db.rs）是全进程单连接全局锁。任何线程持锁做慢事（大查询、跨 await、IO），所有 DB 访问者排队。

**守则**：
- guard 生命周期最短化——拿锁、用完立刻 drop，绝不跨 await / 跨消息发送 / 跨回调
- 高频读路径加进程内缓存（参考 `window_config.rs` 的 `LAUNCHER_POSITION_CACHE` 模式）
- 唤起热路径（热键/托盘 → 显示窗口）**绝不碰 DB**

### 模式 4：跨线程同步等待 + 窗口消息

持有窗口的线程必须泵消息，否则向它 `SendMessage` 的外部进程（Everything）会悬挂。
反过来，任何线程不得「持锁状态下 SendMessage / recv 等待其他线程」——对方若也在等锁即成环。

已加固：Everything reply 窗口收敛到常驻 IPC 线程（空闲时阻塞在 GetMessageW，零 CPU）；
`window_proc` 的 `WM_DESTROY` 不得 `PostQuitMessage`（会杀死常驻线程消息循环）。

### 模式 5：系统级资源的独占窗口

剪贴板是全系统单例。**绝不带着 `OpenClipboard` 做耗时工作**（像素转换/哈希/编码/DB 写），
否则其他进程的剪贴板访问全被阻塞。正确姿势：快照字节 → 立即 CloseClipboard → 重处理移后台线程。

---

## 四、排查方法论（为什么这次能破案）

### 1. 先取证，后推理；证据不够就制造取证条件

三次死锁的定位都依赖「挂死瞬间抓 dump」。第一反应不要是猜，而是确保**下次挂死时能拿到栈**：
- 给关键链路加 `eprintln!` 诊断（stderr 重定向到文件），先证明「哪条链路是健康的」
- 诊断日志的价值一半在「记录」，另一半在「排除」——Everything IPC 全链路日志正常，直接把嫌疑从 IPC 挪开

### 2. 健康路径的日志和异常路径同样重要

「SendMessageTimeoutW 全部成功返回」这条**正常**日志，帮我们排除了整个 IPC 方向，避免了在错误方向继续挖掘。

### 3. 表象 → 机理 → 根因三层剥离

「唤不起」≠「热键坏了」。取证发现：热键线程活着、钩子活着、消息能投递——卡的是主线程。
「修好一个死锁」≠「修好所有死锁」——同一表象下的第二个死锁（sync command 等锁）要靠再次复现 + 再次取证才能发现。

### 4. 复现步骤是最宝贵的线索

「搜索框开着 + Alt+A 微信截图」这个复现步骤直接圈定了剪贴板/失焦/唤起三条链路，把排查空间缩小了一个数量级。

### 5. 符号化是一锤定音的最后一环

debug 构建 PDB 就在 `target/debug/re_fast.pdb`，200MB 但完整。**不要再无符号猜栈**——本目录的工具链 5 分钟出符号化栈。release 构建也建议保留 PDB 到符号服务器/本地归档（不随安装包分发即可）。

### 6. 死锁排查的判定要点速查

| 现象 | 指向 |
|------|------|
| 全线程 Wait + 0 CPU | 纯阻塞死锁（非死循环） |
| 主窗口 `IsHungAppWindow=True` | 主线程事件循环卡死 |
| 热键/钩子窗口线程 hung=False | 输入链路健康，问题在下游处理 |
| 新建 EventPairLow 线程 | 有线程刚进入 SendMessage 类同步等待 |
| Rust `Mutex::lock_contended` 在多线程栈上出现 | 全局锁热点，找持锁者 |
| futex 状态=2 但「无人持锁」 | 持锁者隐身 → 查跨 await 持锁 / 自我重入 |

---

## 五、遗留风险清单（后续迭代）

- [ ] sync command 批量 async 化：`record_open_history`、`add_file_to_history`、`delete_file_history`、`update_open_history_remark`、`purge_file_history`、shortcuts 系列写命令
- [ ] `get_app_data_dir` 在命令热路径上每次调 `app.path()`——考虑启动时缓存
- [ ] 主线程栈里发现 tokio spawn 残留（async command 在主线程 poll）——审计哪些 async command 的 future 在 poll 中做重活/拿锁
- [ ] Debugging Tools for Windows（cdb）安装后，dump 分析可省去自研工具链（`!analyze -v` 一步到位）
- [ ] 考虑把 `SHARED_CONNECTION` 换成连接池或读写锁，降低写锁排他性

---

*取证工具链源码与符号表快照保留在 `%TEMP%\opencode\`（机器本地，重装系统后需按第二节重写，全部工具 ≤200 行 C#，csc.exe 即可编译）。*