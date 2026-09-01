use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct EverythingResult {
    pub path: String,
    pub name: String,
    pub size: Option<u64>,
    pub date_modified: Option<String>,
    pub is_folder: Option<bool>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct EverythingSearchResponse {
    pub results: Vec<EverythingResult>,
    pub total_count: u32,
}

/// Everything 错误类型枚举
#[derive(Debug, Clone)]
pub enum EverythingError {
    /// Everything 服务未运行
    ServiceNotRunning,
    /// 搜索超时
    Timeout,
    /// IPC 通信失败
    IpcFailed(String),
    /// 查询参数错误
    InvalidQuery(String),
    /// 其他错误
    Other(String),
}

impl fmt::Display for EverythingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EverythingError::ServiceNotRunning => {
                write!(
                    f,
                    "SERVICE_NOT_RUNNING:Everything 服务未运行，请启动 Everything 主程序"
                )
            }
            EverythingError::Timeout => {
                write!(f, "TIMEOUT:搜索超时，请缩短关键字或稍后再试")
            }
            EverythingError::IpcFailed(msg) => {
                write!(f, "IPC_FAILED:IPC 通信失败: {}", msg)
            }
            EverythingError::InvalidQuery(msg) => {
                write!(f, "INVALID_QUERY:查询参数错误: {}", msg)
            }
            EverythingError::Other(msg) => {
                write!(f, "OTHER:{}", msg)
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub mod windows {
    use super::*;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::ptr;
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::System::DataExchange::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    // Everything IPC 常量
    // Everything v1.4 使用 EVERYTHING_TASKBAR_NOTIFICATION 窗口类进行 IPC
    const EVERYTHING_IPC_WNDCLASS: &str = "EVERYTHING_TASKBAR_NOTIFICATION";
    // Everything 1.4+ 新协议 QueryW (Unicode/Wide Char 版本)
    const EVERYTHING_IPC_COPYDATAQUERYW: usize = 2; // Unicode 查询命令（必须使用 2，不是 0x10001）
    const EVERYTHING_IPC_REPLY: u32 = 2;
    const COPYDATA_QUERYCOMPLETE: u32 = 0x804E; // 新协议必须使用 0x804E

    // Everything IPC 搜索标志
    const EVERYTHING_IPC_REGEX: u32 = 0x00000001;

    // Everything IPC 查询结构体（Everything 1.4+ QueryW 协议）
    // 字段顺序必须严格按照新协议：
    // reply_hwnd, reply_copydata_message (0x804E), search_flags, reply_offset, max_results, search_string
    // 注意：使用 #[repr(C)] 而不是 packed，因为 DWORD 在 Windows 上是 4 字节对齐的
    #[repr(C)]
    struct EverythingIpcQueryW {
        reply_hwnd: u32,             // HWND cast to u32 (DWORD) - 4 bytes
        reply_copydata_message: u32, // DWORD - 必须填 0x804E
        search_flags: u32,           // DWORD - 4 bytes
        reply_offset: u32,           // DWORD - 新增字段！通常填 0
        max_results: u32,            // DWORD - 4 bytes
                                     // search_string follows as WCHAR[] (UTF-16), must end with 0,0
                                     // 注意：结构体后面紧跟着 UTF-16 字符串，没有额外的对齐
    }

    // Everything IPC 回复结构体（根据官方头文件 everything_ipc.h）
    // 对应 EVERYTHING_IPC_LISTW 结构体
    // 总大小：28 字节（7 * DWORD）
    #[repr(C)]
    #[derive(Debug, Clone, Copy)]
    struct EverythingIpcList {
        totfolders: u32, // Offset 0  - DWORD - 找到的文件夹总数
        totfiles: u32,   // Offset 4  - DWORD - 找到的文件总数
        totitems: u32,   // Offset 8  - DWORD - totfolders + totfiles
        numfolders: u32, // Offset 12 - DWORD - 当前返回的文件夹数
        numfiles: u32,   // Offset 16 - DWORD - 当前返回的文件数
        numitems: u32,   // Offset 20 - DWORD - 当前返回的 item 数
        offset: u32,     // Offset 24 - DWORD - 第一个结果在 item 列表中的索引偏移
                         // items[] follows at offset 28
    }

    // Everything IPC Item 结构体（根据官方头文件 everything_ipc.h）
    // 对应 EVERYTHING_IPC_ITEMW 结构体
    // 总大小：12 字节（3 * DWORD）
    #[repr(C)]
    #[derive(Debug, Clone, Copy)]
    struct EverythingIpcItem {
        flags: u32,           // DWORD - item 标志（EVERYTHING_IPC_FOLDER | EVERYTHING_IPC_DRIVE | EVERYTHING_IPC_ROOT）
        filename_offset: u32, // DWORD - 文件名从 list 结构起始地址开始的字节偏移
        path_offset: u32,     // DWORD - 路径从 list 结构起始地址开始的字节偏移
    }

    // Everything item flags（与 everything_ipc.h 保持一致）
    // 参考官方定义：
    // #define EVERYTHING_IPC_FOLDER 0x00000001
    // #define EVERYTHING_IPC_DRIVE  0x00000002
    // #define EVERYTHING_IPC_ROOT   0x00000004
    const EVERYTHING_IPC_FOLDER: u32 = 0x00000001;
    const EVERYTHING_IPC_DRIVE: u32 = 0x00000002;
    const EVERYTHING_IPC_ROOT: u32 = 0x00000004;

    // 全局状态：存储每个窗口句柄对应的发送器
    // 注意：该映射只允许在专用 IPC 线程上访问（创建/销毁/查询），且任何线程都
    // 不得在持有此锁期间调用 SendMessage 类同步 API，否则会引入跨线程死锁风险
    use std::collections::HashMap;

    /// 单个批次的 IPC 结果类型：(结果列表(路径, flags), 总条数, 当前批条数, 偏移量)
    type IpcBatchResult = Result<(Vec<(String, u32)>, u32, u32, u32), EverythingError>;

    /// 专用 IPC 线程的命令
    /// 回复窗口的所有生命周期操作都由专用 IPC 线程串行执行，
    /// 搜索线程只通过命令通道请求，绝不跨线程创建/销毁窗口或泵消息
    enum IpcCommand {
        /// 创建回复窗口并注册结果发送器
        CreateReplyWindow {
            result_sender: mpsc::Sender<IpcBatchResult>,
            reply_tx: mpsc::Sender<Result<HWND, EverythingError>>,
        },
        /// 销毁回复窗口并清理发送器映射
        DestroyReplyWindow { hwnd: HWND },
    }

    /// IPC 命令通道（静态持有 Sender 以保持 IPC 线程存活；线程退出时置 None 以便重建）
    static IPC_COMMAND_CHANNEL: OnceLock<Mutex<Option<mpsc::Sender<IpcCommand>>>> = OnceLock::new();

    /// IPC 线程 ID，用于向阻塞中的 IPC 线程投递唤醒消息
    /// 使用 Mutex<Option<u32>> 以便线程退出时清除，支持异常退出后重建
    static IPC_THREAD_ID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();

    fn get_ipc_thread_id_slot() -> &'static Mutex<Option<u32>> {
        IPC_THREAD_ID.get_or_init(|| Mutex::new(None))
    }

    /// 自定义唤醒消息：命令通道有新命令时，唤醒阻塞在 GetMessageW 的 IPC 线程
    const WM_APP_IPC_WAKE: u32 = WM_APP + 0x7A61;

    static WINDOW_SENDERS: OnceLock<
        Arc<
            Mutex<
                HashMap<HWND, mpsc::Sender<IpcBatchResult>>,
            >,
        >,
    > = OnceLock::new();

    // 日志文件（使用应用数据目录下的 logs 文件夹，按天生成）
    struct LogFileState {
        file_path: PathBuf,
    }

    static LOG_FILE_STATE: OnceLock<Arc<Mutex<LogFileState>>> = OnceLock::new();

    /// 获取日志目录路径
    pub fn get_log_dir() -> PathBuf {
        // 优先使用 APPDATA 环境变量
        if let Ok(appdata) = std::env::var("APPDATA") {
            PathBuf::from(appdata).join("re-fast").join("logs")
        } else {
            // 回退到临时目录
            std::env::temp_dir().join("re-fast-logs")
        }
    }

    fn get_log_file_state() -> Arc<Mutex<LogFileState>> {
        LOG_FILE_STATE
            .get_or_init(|| {
                // 初始化日志文件状态
                let today = chrono::Local::now().format("%Y%m%d").to_string();
                let log_dir = get_log_dir();

                // 确保日志目录存在
                if let Err(e) = std::fs::create_dir_all(&log_dir) {
                    eprintln!(
                        "[DEBUG] ERROR: Failed to create log directory {}: {}",
                        log_dir.display(),
                        e
                    );
                }

                let log_path = log_dir.join(format!("everything-ipc-{}.log", today));

                // 日志输出已禁用，仅记录路径

                Arc::new(Mutex::new(LogFileState {
                    file_path: log_path,
                }))
            })
            .clone()
    }

    /// 获取日志文件路径
    pub fn get_log_file_path() -> Option<PathBuf> {
        let state = get_log_file_state();
        state.lock().ok().map(|s| s.file_path.clone())
    }

    /// 在程序启动时初始化日志文件（确保路径被保存和显示）
    pub fn init_log_file_early() {
        // 强制初始化日志文件
        let _ = get_log_file_state();

        // 日志输出已禁用
    }

    /// 日志宏，支持格式化字符串，同时输出到控制台和日志文件
    macro_rules! log_debug {
        ($($arg:tt)*) => {
            // 日志已禁用
        };
    }

    fn get_window_senders() -> &'static Arc<Mutex<HashMap<HWND, mpsc::Sender<IpcBatchResult>>>> {
        WINDOW_SENDERS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
    }

    /// 专用 IPC 线程入口
    /// 该线程是进程中唯一创建/持有/销毁 Everything 回复窗口的线程。
    /// 结构要点：
    /// 1. 空闲时阻塞在 GetMessageW（内核等待，零 CPU），任何到达该线程窗口的
    ///    sent message（包括 Everything 跨进程 SendMessage 的 WM_COPYDATA 回复）
    ///    都会被立即分发，Everything 侧的同步发送不会悬挂；
    /// 2. 搜索线程的命令通过 mpsc 通道投递，配合 PostThreadMessageW 唤醒，
    ///    避免「线程阻塞在通道上导致 sent message 无法处理」的另一种死锁形态；
    /// 3. 该线程绝不持有任何锁跨等待，也绝不调用 SendMessage 等待其他线程 ——
    ///    经典的「SendMessage 同步等待 + 对方被锁卡住」循环等待被结构性消除。
    fn ipc_thread_main(cmd_receiver: mpsc::Receiver<IpcCommand>) {
        let thread_id =
            unsafe { windows_sys::Win32::System::Threading::GetCurrentThreadId() };
        eprintln!("[IPC-DIAG] IPC 线程已启动 tid={}", thread_id);

        // 先强制创建本线程消息队列，再发布线程 ID：
        // 保证其他线程读到 IPC_THREAD_ID 后 PostThreadMessageW 必然成功
        unsafe {
            let mut msg: MSG = std::mem::zeroed();
            PeekMessageW(&mut msg, 0, 0, 0, PM_NOREMOVE);
        }
        if let Ok(mut slot) = get_ipc_thread_id_slot().lock() {
            *slot = Some(thread_id);
        }

        let mut msg: MSG = unsafe { std::mem::zeroed() };

        loop {
            // 1. 排空命令队列（唤醒消息可能已丢失或有积压）
            loop {
                match cmd_receiver.try_recv() {
                    Ok(command) => match command {
                        IpcCommand::CreateReplyWindow {
                            result_sender,
                            reply_tx,
                        } => {
                            eprintln!("[IPC-DIAG] 处理 CreateReplyWindow 命令");
                            let hwnd = create_reply_window_on_ipc_thread(result_sender);
                            eprintln!("[IPC-DIAG] CreateReplyWindow 完成 hwnd={:?}", hwnd);
                            let _ = reply_tx.send(hwnd);
                        }
                        IpcCommand::DestroyReplyWindow { hwnd } => {
                            eprintln!("[IPC-DIAG] 处理 DestroyReplyWindow 命令 hwnd={:?}", hwnd);
                            destroy_reply_window_on_ipc_thread(hwnd);
                        }
                    },
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        // 所有 Sender 已 drop：进程准备退出，结束线程
                        if let Ok(mut slot) = get_ipc_thread_id_slot().lock() {
                            *slot = None;
                        }
                        return;
                    }
                }
            }

            // 2. 阻塞等待消息：线程消息（WM_APP_IPC_WAKE 唤醒）、跨进程 sent message（WM_COPYDATA 回复）
            let ret = unsafe { GetMessageW(&mut msg, 0, 0, 0) };
            eprintln!("[IPC-DIAG] GetMessageW 返回 ret={} msg=0x{:X} hwnd=0x{:X}", ret, msg.message, msg.hwnd);
            if ret <= 0 {
                // WM_QUIT 或错误：退出线程（正常流程中不应发生）
                if let Ok(mut slot) = get_ipc_thread_id_slot().lock() {
                    *slot = None;
                }
                return;
            }

            match msg.message {
                WM_APP_IPC_WAKE => {
                    // 唤醒信号：回到循环顶部排空命令队列
                    eprintln!("[IPC-DIAG] 收到唤醒消息，回顶排空命令队列");
                    continue;
                }
                WM_COPYDATA => {
                    eprintln!("[IPC-DIAG] 收到 WM_COPYDATA（跨进程回复到达 IPC 线程队列）");
                }
                _ => {}
            }

            // 其他消息（如果有）正常分发
            unsafe {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    /// 在 IPC 线程上创建回复窗口（仅供 ipc_thread_main 调用）
    fn create_reply_window_on_ipc_thread(result_sender: mpsc::Sender<IpcBatchResult>) -> Result<HWND, EverythingError> {
        // 确保窗口类已注册（必须在拥有消息队列的线程上注册窗口类，避免竞态）
        static INIT_ONCE: std::sync::Once = std::sync::Once::new();
        INIT_ONCE.call_once(|| unsafe {
            let class_name = wide_string("ReFastEverythingIPC");
            let wc = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(window_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: 0,
                hIcon: 0,
                hCursor: 0,
                hbrBackground: 0,
                lpszMenuName: ptr::null(),
                lpszClassName: class_name.as_ptr(),
            };
            let _atom = RegisterClassW(&wc);
        });

        unsafe {
            let class_name = wide_string("ReFastEverythingIPC");
            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                class_name.as_ptr(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                0,
                0,
                ptr::null_mut(),
            );

            if hwnd == 0 {
                let last_error = windows_sys::Win32::Foundation::GetLastError();
                return Err(EverythingError::IpcFailed(format!(
                    "无法创建消息窗口, error: {}",
                    last_error
                )));
            }

            // 注册发送器（IPC 线程独占访问，锁竞争窗口极小）
            let senders = get_window_senders();
            if let Ok(mut senders_guard) = senders.lock() {
                senders_guard.insert(hwnd, result_sender);
            }

            Ok(hwnd)
        }
    }

    /// 在 IPC 线程上销毁回复窗口（仅供 ipc_thread_main 调用）
    fn destroy_reply_window_on_ipc_thread(hwnd: HWND) {
        unsafe {
            let senders = get_window_senders();
            if let Ok(mut senders_guard) = senders.lock() {
                senders_guard.remove(&hwnd);
            }
            DestroyWindow(hwnd);
        }
    }

    /// 向专用 IPC 线程发送命令
    /// 注意：不在持有任何锁的状态下发送/唤醒，等待回执由调用方用 mpsc 完成（无死锁风险）
    fn send_command_to_ipc_thread(command: IpcCommand) -> Result<(), EverythingError> {
        // 获取（或启动）IPC 线程的命令发送器
        // 仅在克隆 Sender 这个短操作期间持锁，绝不持锁等待
        let sender = {
            let mut channel_guard = IPC_COMMAND_CHANNEL
                .get_or_init(|| Mutex::new(None))
                .lock()
                .map_err(|_| EverythingError::IpcFailed("IPC 命令通道锁损坏".to_string()))?;

            match channel_guard.as_ref() {
                Some(s) => s.clone(),
                None => {
                    // IPC 线程尚未启动，启动它
                    let (tx, rx) = mpsc::channel::<IpcCommand>();
                    std::thread::Builder::new()
                        .name("everything-ipc".to_string())
                        .spawn(move || ipc_thread_main(rx))
                        .map_err(|e| {
                            EverythingError::IpcFailed(format!("无法启动 IPC 线程: {}", e))
                        })?;

                    *channel_guard = Some(tx.clone());
                    tx
                }
            }
        }; // channel_guard 在此释放

        // 发送命令（非阻塞；通道容量足够大不会满）
        sender
            .send(command)
            .map_err(|_| EverythingError::IpcFailed("IPC 线程已退出".to_string()))?;

        // 唤醒可能阻塞在 GetMessageW 的 IPC 线程（PostThreadMessageW 对阻塞在
        // GetMessage 的线程会使其立即返回，避免命令长时间滞留队列）
        if let Ok(slot) = get_ipc_thread_id_slot().lock() {
            if let Some(thread_id) = *slot {
                unsafe {
                    PostThreadMessageW(thread_id, WM_APP_IPC_WAKE, 0, 0);
                }
            }
        }

        Ok(())
    }

    // 缓存 Everything 窗口句柄，避免重复查找
    struct CachedEverythingWindow {
        hwnd: Option<HWND>,
        timestamp: Instant,
    }

    static CACHED_WINDOW: OnceLock<Arc<Mutex<CachedEverythingWindow>>> = OnceLock::new();
    const CACHE_DURATION: Duration = Duration::from_secs(5); // 缓存5秒

    fn get_cached_window() -> Arc<Mutex<CachedEverythingWindow>> {
        CACHED_WINDOW
            .get_or_init(|| {
                Arc::new(Mutex::new(CachedEverythingWindow {
                    hwnd: None,
                    timestamp: Instant::now() - CACHE_DURATION, // 初始化为过期
                }))
            })
            .clone()
    }

    /// 窗口过程，处理 WM_COPYDATA 消息
    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        // 只记录重要消息，忽略常见的系统消息以减少日志噪音

        match msg {
            WM_COPYDATA => {
                let cds = ptr::read(lparam as *const COPYDATASTRUCT);

                // Everything 回复时，dwData 通常是 EVERYTHING_IPC_REPLY (2)
                // 新协议也可能使用我们发送的 reply_copydata_message 值
                // 为了兼容性，我们检查多种可能
                let is_reply = cds.dwData == EVERYTHING_IPC_REPLY as usize
                    || cds.dwData == COPYDATA_QUERYCOMPLETE as usize
                    || cds.dwData == 0x804E; // 兼容新协议可能的回复值

                if is_reply {
                    // 解析结果（现在返回四元组：结果列表(路径, flags), 总条数, 当前页条数, 当前页偏移量）
                    let result = parse_ipc_reply(&cds);
                    match &result {
                        Ok((paths_with_flags, tot, num, _off)) => {
                            // 只在批次数量很大或出错时输出详细日志，减少日志噪音
                            if *tot > 100_000 || paths_with_flags.len() != *num as usize {
                                log_debug!("[DEBUG] Parsed result: {} paths (Total: {}, This batch: {})", paths_with_flags.len(), tot, num);
                            }
                        }
                        Err(_e) => {
                            log_debug!("[DEBUG] Parsed result error: {:?}", e);
                        }
                    }

                    // 获取对应的发送器并发送结果
                    let senders = get_window_senders();
                    if let Ok(senders_guard) = senders.lock() {
                        if let Some(sender) = senders_guard.get(&hwnd) {
                            if let Err(_e) = sender.send(result) {
                                log_debug!(
                                    "[DEBUG] ERROR: Failed to send result to channel: {:?}",
                                    e
                                );
                            }
                        } else {
                            log_debug!("[DEBUG] WARNING: No sender found for hwnd: {:?}", hwnd);
                        }
                    } else {
                        log_debug!("[DEBUG] ERROR: Failed to lock senders mutex");
                    }
                } else {
                    log_debug!("[DEBUG] Unexpected dwData value: {} (expected EVERYTHING_IPC_REPLY={} or COPYDATA_QUERYCOMPLETE={})", 
                        cds.dwData, EVERYTHING_IPC_REPLY, COPYDATA_QUERYCOMPLETE);
                }
                1 // TRUE - 消息已处理
            }
            WM_DESTROY => {
                // 清理发送器
                // 注意：不要 PostQuitMessage —— 本窗口由常驻 IPC 线程持有，
                // 销毁单个批次窗口绝不能终止 IPC 线程的消息循环
                let senders = get_window_senders();
                if let Ok(mut senders_guard) = senders.lock() {
                    senders_guard.remove(&hwnd);
                }
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    /// Everything IPC 查询句柄，用于管理结果接收
    /// 回复窗口由专用 IPC 线程持有；本句柄仅持有结果通道，
    /// 创建/销毁通过命令通道请求 IPC 线程执行
    struct EverythingIpcHandle {
        reply_hwnd: HWND,
        result_receiver: mpsc::Receiver<IpcBatchResult>,
        /// 标记窗口是否仍需销毁（创建失败时为 false，避免重复销毁）
        needs_destroy: bool,
    }

    /// 命令执行回执等待上限（远大于 IPC 线程正常处理耗时，防御性兜底）
    const IPC_COMMAND_REPLY_TIMEOUT: Duration = Duration::from_secs(10);

    impl EverythingIpcHandle {
        fn new() -> Result<Self, EverythingError> {
            eprintln!("[IPC-DIAG] EverythingIpcHandle::new 开始");
            // 创建通道用于接收搜索结果
            let (sender, receiver) = mpsc::channel();

            // 请求 IPC 线程创建回复窗口并登记发送器
            let (reply_tx, reply_rx) = mpsc::channel();
            send_command_to_ipc_thread(IpcCommand::CreateReplyWindow {
                result_sender: sender,
                reply_tx,
            })?;
            eprintln!("[IPC-DIAG] CreateReplyWindow 命令已发送，等待回执");

            // 等待 IPC 线程执行完毕（mpsc 等待，非窗口消息等待，无死锁风险）
            let reply_hwnd = match reply_rx.recv_timeout(IPC_COMMAND_REPLY_TIMEOUT) {
                Ok(Ok(hwnd)) => {
                    eprintln!("[IPC-DIAG] CreateReplyWindow 回执收到 hwnd=0x{:X}", hwnd);
                    hwnd
                }
                Ok(Err(e)) => return Err(e),
                Err(_) => {
                    eprintln!("[IPC-DIAG] ERROR: 等待 CreateReplyWindow 回执超时（IPC 线程可能卡死）");
                    return Err(EverythingError::IpcFailed(
                        "等待 IPC 线程创建回复窗口超时".to_string(),
                    ))
                }
            };

            Ok(EverythingIpcHandle {
                reply_hwnd,
                result_receiver: receiver,
                needs_destroy: true,
            })
        }

        fn destroy(&mut self) {
            if !self.needs_destroy {
                return;
            }
            self.needs_destroy = false;

            // 请求 IPC 线程销毁窗口（单向命令，无需等待回执：
            // IPC 线程空闲时即会处理，窗口残留的最坏影响是多一条无效 sender 记录）
            let _ = send_command_to_ipc_thread(IpcCommand::DestroyReplyWindow {
                hwnd: self.reply_hwnd,
            });
        }
    }

    impl Drop for EverythingIpcHandle {
        fn drop(&mut self) {
            self.destroy();
        }
    }

    /// 将 Rust 字符串转换为 Windows UTF-16 宽字符串
    /// Everything v1.4.1 要求字符串必须以 UTF-16 双 0 结尾（\0\0）
    fn wide_string(s: &str) -> Vec<u16> {
        let mut result: Vec<u16> = OsStr::new(s).encode_wide().collect();
        // Everything v1.4.1 要求字符串以双 0 结尾
        result.push(0);
        result.push(0);
        result
    }

    /// 从 UTF-16 宽字符串转换为 Rust 字符串
    fn from_wide_string(wide: &[u16]) -> String {
        let end = wide.iter().position(|&x| x == 0).unwrap_or(wide.len());
        String::from_utf16_lossy(&wide[..end])
    }

    /// 从 u16 指针读取 UTF-16 字符串（辅助函数）
    unsafe fn read_u16_string(str_ptr: *const u16, max_chars: usize) -> String {
        let mut chars = Vec::new();
        let mut len = 0;

        while len < max_chars {
            let wchar = *str_ptr.add(len);
            if wchar == 0 {
                break;
            }
            chars.push(wchar);
            len += 1;
        }

        if !chars.is_empty() {
            from_wide_string(&chars)
        } else {
            String::new()
        }
    }

    /// 安全读取 UTF-16 字符串（从基地址 + 偏移量）
    /// 允许 offset == 0（表示空字符串）
    /// offset 必须是相对于整个 EVERYTHING_IPC_LIST 结构起始地址的字节偏移
    unsafe fn read_u16_string_at_offset(
        base: *const u8,
        offset: u32,
        max_len: usize,
        data_size: u32,
    ) -> Option<String> {
        // offset == 0 表示空字符串，这是一个合法值
        if offset == 0 {
            return Some(String::new());
        }

        // 边界检查：确保偏移量在有效范围内
        if offset as usize >= data_size as usize {
            log_debug!(
                "[DEBUG] ERROR: offset {} exceeds data size {}",
                offset,
                data_size
            );
            return None;
        }

        // 奇数 offset 是解析错误，Everything 不会返回奇数 offset
        // UTF-16 字符串必须 2 字节对齐
        if offset % 2 != 0 {
            log_debug!(
                "[DEBUG] ERROR: Invalid odd offset {} - this indicates a parsing bug! \
                Everything should never return odd offsets. Check struct layout and base address calculation.",
                offset
            );
            return None; // 直接返回错误，不要尝试"修复"
        }

        // 直接使用 offset，不需要对齐
        let str_ptr = base.add(offset as usize) as *const u16;

        // 计算最大可读取的字符数（防止越界）
        let max_chars = ((data_size as usize - offset as usize) / 2).min(max_len);

        Some(read_u16_string(str_ptr, max_chars))
    }

    /// 解析 Everything IPC 回复（官方协议）
    /// 返回 (结果列表(路径, flags), 总条数, 当前页条数, 当前页偏移量)
    fn parse_ipc_reply(
        cds: &COPYDATASTRUCT,
    ) -> Result<(Vec<(String, u32)>, u32, u32, u32), EverythingError> {
        // 验证结构体大小（根据官方头文件，应该是 28 字节）
        let expected_list_size = 28u32; // 7 * DWORD = 28 字节
        let actual_list_size = std::mem::size_of::<EverythingIpcList>() as u32;
        if actual_list_size != expected_list_size {
            log_debug!(
                "[DEBUG] ERROR: EverythingIpcList size mismatch! Expected {}, got {}. This will cause parsing errors!",
                expected_list_size,
                actual_list_size
            );
        }

        let expected_item_size = 12u32; // 3 * u32 = 12 字节
        let actual_item_size = std::mem::size_of::<EverythingIpcItem>() as u32;
        if actual_item_size != expected_item_size {
            log_debug!(
                "[DEBUG] ERROR: EverythingIpcItem size is {} bytes, expected 12! This will cause parsing errors.",
                actual_item_size
            );
        }

        let list_size = actual_list_size;

        if cds.cbData < list_size {
            log_debug!(
                "[DEBUG] ERROR: Reply data too short: {} < {}",
                cds.cbData,
                list_size
            );
            return Err(EverythingError::IpcFailed("回复数据太短".to_string()));
        }

        unsafe {
            // 读取 EverythingIpcList 结构体（根据官方头文件：28 字节头部）
            let list_ptr = cds.lpData as *const EverythingIpcList;
            let list = &*list_ptr;

            let _totfolders = list.totfolders; // Offset 0
            let _totfiles = list.totfiles;     // Offset 4
            let totitems = list.totitems;     // Offset 8 - totfolders + totfiles
            let _numfolders = list.numfolders; // Offset 12
            let _numfiles = list.numfiles;     // Offset 16
            let numitems = list.numitems;     // Offset 20 - 当前返回的 item 数
            let offset = list.offset;         // Offset 24 - 第一个结果在 item 列表中的索引偏移

            // 验证读取的值是否合理（只检查 totitems，不限制 numitems，因为分页时 numitems 是批次大小）
            if totitems > 10_000_000 {
                log_debug!(
                    "[DEBUG] ERROR: TotItems {} is suspicious (>10M), aborting parse.",
                    totitems
                );
                return Err(EverythingError::IpcFailed(format!(
                    "总结果数异常: {} (超过合理范围)",
                    totitems
                )));
            }

            // 如果 totitems 和 numitems 为 0，直接返回空结果
            if numitems == 0 {
                return Ok((Vec::<(String, u32)>::new(), totitems, 0, offset));
            }

            // 处理所有返回的 item（不再限制）
            let items_to_process = numitems;

            // 计算 Items 起始位置（根据官方头文件：Items 数组紧跟在 28 字节的 Header 之后）
            let items_start_offset = 28;
            let base_addr = cds.lpData as usize;
            let items_ptr = (base_addr + items_start_offset) as *const EverythingIpcItem;

            // 验证数据大小是否足够容纳所有 items
            let items_size = (items_to_process as usize) * std::mem::size_of::<EverythingIpcItem>();
            let min_required_size = items_start_offset + items_size;
            if cds.cbData < min_required_size as u32 {
                log_debug!(
                    "[DEBUG] ERROR: Reply data too small for {} items: {} < {} bytes",
                    items_to_process,
                    cds.cbData,
                    min_required_size
                );
                return Err(EverythingError::IpcFailed(format!(
                    "回复数据大小不足: 需要 {} 字节，实际只有 {} 字节",
                    min_required_size, cds.cbData
                )));
            }

            // 根据官方头文件：filename_offset 和 path_offset 都是从 EVERYTHING_IPC_LIST 结构起始地址（lpData）开始的字节偏移
            // 使用宏定义：EVERYTHING_IPC_ITEMFILENAMEW(list,item) = (WCHAR *)((CHAR *)(list) + item->filename_offset)
            // 使用宏定义：EVERYTHING_IPC_ITEMPATHW(list,item) = (WCHAR *)((CHAR *)(list) + item->path_offset)

            let mut results: Vec<(String, u32)> = Vec::new();
            let mut skipped_count = 0;
            let mut invalid_offset_count = 0;

            // 遍历每个 item
            for i in 0..items_to_process {
                let current_item_ptr = items_ptr.add(i as usize);

                // 边界检查：防止读取超出 cbData 范围
                let item_size = std::mem::size_of::<EverythingIpcItem>();
                if (current_item_ptr as usize) + item_size > base_addr + cds.cbData as usize {
                    log_debug!("[DEBUG] Reached end of buffer at item {}, stopping", i);
                    break;
                }

                let item = &*current_item_ptr;
                let flags = item.flags;
                let filename_offset = item.filename_offset;
                let path_offset = item.path_offset;

                // 验证读取的 offset 值是否合理（只记录错误）
                if filename_offset != 0 && filename_offset % 2 != 0 {
                    log_debug!(
                        "[DEBUG] ERROR: Item {} has odd filename_offset={} - struct parsing may be wrong!",
                        i, filename_offset
                    );
                }
                if path_offset != 0 && path_offset % 2 != 0 {
                    log_debug!(
                        "[DEBUG] ERROR: Item {} has odd path_offset={} - struct parsing may be wrong!",
                        i, path_offset
                    );
                }

                // 解析文件名（允许 offset=0 表示空）
                let filename = if filename_offset == 0 {
                    String::new() // offset=0 表示空
                } else if (filename_offset as usize) < cds.cbData as usize {
                    match read_u16_string_at_offset(
                        cds.lpData as *const u8,
                        filename_offset,
                        32767,
                        cds.cbData,
                    ) {
                        Some(s) => s,
                        None => {
                            invalid_offset_count += 1;
                            if i < 10 {
                                log_debug!(
                                    "[DEBUG] WARNING: Item {} filename_offset={} failed to read",
                                    i,
                                    filename_offset
                                );
                            }
                            String::from("[Invalid Offset]")
                        }
                    }
                } else {
                    invalid_offset_count += 1;
                    if i < 10 {
                        log_debug!(
                            "[DEBUG] WARNING: Item {} filename_offset={} exceeds data size",
                            i,
                            filename_offset
                        );
                    }
                    String::from("[Invalid Offset]")
                };

                // 解析路径部分（允许 offset=0 表示空，例如根目录）
                let path_part = if path_offset == 0 {
                    String::new() // offset=0 表示空（例如根目录）
                } else if (path_offset as usize) < cds.cbData as usize {
                    match read_u16_string_at_offset(
                        cds.lpData as *const u8,
                        path_offset,
                        32767,
                        cds.cbData,
                    ) {
                        Some(s) => s,
                        None => {
                            // path offset 无效不应该导致整个 item 丢弃，给个空值即可
                            if i < 10 {
                                log_debug!("[DEBUG] WARNING: Item {} path_offset={} failed to read, using empty path", i, path_offset);
                            }
                            String::new()
                        }
                    }
                } else {
                    // path offset 超出范围，使用空路径
                    if i < 10 {
                        log_debug!("[DEBUG] WARNING: Item {} path_offset={} exceeds data size, using empty path", i, path_offset);
                    }
                    String::new()
                };

                // 如果文件名是无效标记，跳过这个 item
                if filename == "[Invalid Offset]" {
                    skipped_count += 1;
                    if i < 10 {
                        log_debug!(
                            "[DEBUG] WARNING: Item {} has invalid filename offset, skipping",
                            i
                        );
                    }
                    continue;
                }

                // 拼接完整路径：path + filename
                // Everything 返回的 path 是父目录，filename 是文件名
                let full_path = if path_part.is_empty() {
                    filename.clone()
                } else if filename.is_empty() {
                    path_part.clone()
                } else {
                    // 处理 Windows 驱动器号的情况（如 "D:" 需要变成 "D:\"）
                    let normalized_path = if path_part.len() == 2 && path_part.ends_with(':') {
                        format!("{}\\", path_part)
                    } else if !path_part.ends_with('\\') && !path_part.ends_with('/') {
                        format!("{}\\", path_part)
                    } else {
                        path_part.clone()
                    };
                    
                    // 使用 PathBuf 来正确拼接路径
                    let path_buf = PathBuf::from(&normalized_path);
                    if let Some(joined) = path_buf.join(&filename).to_str() {
                        joined.to_string()
                    } else {
                        // 如果路径包含无效字符，使用简单拼接
                        format!("{}{}", normalized_path, filename)
                    }
                };

                // 只有当文件名或路径至少有一个有效时才添加结果
                if !filename.is_empty() || !path_part.is_empty() {
                    // 返回路径和 flags 的元组
                    results.push((full_path, flags));
                } else {
                    skipped_count += 1;
                    // 性能优化：减少日志输出
                    // if i < 10 {
                    //     log_debug!("[DEBUG] WARNING: Item {} has empty path and filename, skipping", i);
                    // }
                }
            }

            // 只在出错或批次很大时输出解析摘要，减少日志噪音
            if skipped_count > 0 || invalid_offset_count > 0 || items_to_process > 5000 {
                log_debug!(
                    "[DEBUG] Parse summary: Total items={}, Parsed={}, Skipped={}, Invalid offsets={}",
                    items_to_process,
                    results.len(),
                    skipped_count,
                    invalid_offset_count
                );
            }

            // 返回四元组：(结果列表, 总条数, 当前页条数, 当前页偏移量)
            Ok((results, totitems, numitems, offset))
        }
    }

    /// 查找 Everything 窗口（内部函数，带缓存）
    fn find_everything_window_internal(_caller: &str) -> Option<HWND> {
        log_debug!("[DEBUG] find_everything_window called from: {}", caller);

        // 检查缓存
        let cache = get_cached_window();
        if let Ok(cached) = cache.lock() {
            let now = Instant::now();
            if cached.hwnd.is_some() && now.duration_since(cached.timestamp) < CACHE_DURATION {
                log_debug!("[DEBUG] Using cached Everything window: {:?}", cached.hwnd);
                return cached.hwnd;
            }
        }

        // 缓存过期或不存在，重新查找
        log_debug!("[DEBUG] Cache expired or empty, searching for Everything window...");

        unsafe {
            // Everything v1.4 使用 EVERYTHING_TASKBAR_NOTIFICATION 窗口类进行 IPC
            let class_name = wide_string(EVERYTHING_IPC_WNDCLASS);
            log_debug!(
                "[DEBUG] Looking for Everything IPC window with class: {}",
                EVERYTHING_IPC_WNDCLASS
            );
            let hwnd = FindWindowW(class_name.as_ptr(), ptr::null());

            let result = if hwnd != 0 {
                log_debug!("[DEBUG] Everything IPC window found: {:?}", hwnd);
                Some(hwnd)
            } else {
                log_debug!("[DEBUG] Everything IPC window NOT found (FindWindowW returned 0)");
                let _last_error = windows_sys::Win32::Foundation::GetLastError();
                log_debug!("[DEBUG] Last error: {}", last_error);
                log_debug!("[DEBUG] Please ensure Everything is running");
                None
            };

            // 更新缓存
            if let Ok(mut cached) = cache.lock() {
                cached.hwnd = result;
                cached.timestamp = Instant::now();
                log_debug!("[DEBUG] Updated cache with window: {:?}", cached.hwnd);
            }

            result
        }
    }

    /// 查找 Everything 窗口
    fn find_everything_window() -> Option<HWND> {
        find_everything_window_internal("find_everything_window")
    }

    /// 检查 Everything 服务是否运行
    /// 通过查找 Everything 窗口来判断（使用缓存）
    pub fn check_everything_service_running() -> bool {
        find_everything_window_internal("check_everything_service_running").is_some()
    }

    /// 查找 Everything.exe 主程序路径（用于启动）
    pub fn find_everything_main_exe() -> Option<PathBuf> {
        let everything_paths = [
            r"C:\Program Files\Everything\Everything.exe",
            r"C:\Program Files (x86)\Everything\Everything.exe",
            r"C:\Tools\Everything\Everything.exe",
            r"C:\Everything\Everything.exe",
        ];

        for path in &everything_paths {
            let exe_path = PathBuf::from(path);
            if exe_path.exists() {
                return Some(exe_path);
            }
        }

        None
    }

    /// 获取 Everything 版本号
    /// 通过读取 Everything.exe 的文件版本信息来获取
    pub fn get_everything_version() -> Option<String> {
        let exe_path = find_everything_main_exe()?;

        // 使用 PowerShell 获取文件版本信息
        // 这样可以避免复杂的 Windows API 调用
        // 将路径中的单引号转义，并转义反斜杠
        let path_str = exe_path.to_string_lossy();
        let escaped_path = path_str
            .replace('\'', "''") // PowerShell 中单引号需要双写来转义
            .replace('\\', "\\\\");

        let ps_command = format!(
            r#"
            try {{
                $version = (Get-ItemProperty -LiteralPath '{}' -ErrorAction Stop).VersionInfo
                $versionString = "$($version.FileMajorPart).$($version.FileMinorPart).$($version.FileBuildPart).$($version.FilePrivatePart)"
                Write-Output $versionString
            }} catch {{
                exit 1
            }}
            "#,
            escaped_path
        );

        match std::process::Command::new("powershell")
            .args(&["-NoProfile", "-NonInteractive", "-Command", &ps_command])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW - 隐藏 PowerShell 窗口
            .output()
        {
            Ok(output) => {
                if output.status.success() {
                    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if !version.is_empty() {
                        Some(version)
                    } else {
                        None
                    }
                } else {
                    // 输出错误信息以便调试
                    if !output.stderr.is_empty() {
                        eprintln!(
                            "[DEBUG] PowerShell error: {}",
                            String::from_utf8_lossy(&output.stderr)
                        );
                    }
                    None
                }
            }
            Err(_e) => {
                // 日志输出已禁用
                None
            }
        }
    }

    /// 通过 IPC 发送搜索查询
    fn send_search_query(
        query: &str,
        max_results: u32,
        offset: u32, // 新增参数：分页偏移量
        reply_hwnd: HWND,
        everything_hwnd: HWND,
        search_flags: u32, // 搜索标志（如全字匹配、大小写敏感等）
    ) -> Result<(), EverythingError> {
        // 将查询字符串转换为 UTF-16（以双 0 结尾）
        let query_wide = wide_string(query);
        // 验证字符串以双 0 结尾
        if query_wide.len() < 2
            || query_wide[query_wide.len() - 2] != 0
            || query_wide[query_wide.len() - 1] != 0
        {
            log_debug!("[DEBUG] WARNING: Query string does not end with double null!");
        }

        // 计算结构体大小（Everything 1.4+ QueryW 协议）
        let base_size = std::mem::size_of::<EverythingIpcQueryW>();
        let string_size = query_wide.len() * std::mem::size_of::<u16>();
        let struct_size = base_size + string_size;

        // 分配内存
        let mut query_data = vec![0u8; struct_size];
        let query_ptr = query_data.as_mut_ptr() as *mut EverythingIpcQueryW;

        unsafe {
            // 按照 Everything 1.4+ QueryW 协议顺序填充结构体
            // 顺序：reply_hwnd, reply_copydata_message (0x804E), search_flags, reply_offset, max_results
            (*query_ptr).reply_hwnd = reply_hwnd as u32; // HWND 转换为 u32
            (*query_ptr).reply_copydata_message = COPYDATA_QUERYCOMPLETE; // 必须填 0x804E
            (*query_ptr).search_flags = search_flags; // 使用传入的搜索标志
            (*query_ptr).reply_offset = offset; // 使用传入的 offset 参数
            (*query_ptr).max_results = max_results;

            // 复制查询字符串到结构体后面
            let search_string_ptr = (query_ptr as *mut u8).add(base_size) as *mut u16;
            ptr::copy_nonoverlapping(query_wide.as_ptr(), search_string_ptr, query_wide.len());
        }

        // 创建 COPYDATASTRUCT（Everything 1.4+ 使用 QueryW 协议）
        let mut cds = COPYDATASTRUCT {
            dwData: EVERYTHING_IPC_COPYDATAQUERYW, // 关键！必须是 2 (EVERYTHING_IPC_COPYDATAQUERYW)
            cbData: struct_size as u32,
            lpData: query_data.as_mut_ptr() as *mut std::ffi::c_void,
        };


        // 发送消息
        unsafe {
            // 验证窗口句柄是否有效
            use windows_sys::Win32::UI::WindowsAndMessaging::IsWindow;
            let window_valid = IsWindow(everything_hwnd);

            if window_valid == 0 {
                return Err(EverythingError::IpcFailed(format!(
                    "Everything 窗口句柄无效: {:?}",
                    everything_hwnd
                )));
            }

            eprintln!(
                "[IPC-DIAG] send_search_query 开始 SendMessageTimeoutW（5s 上限）query_len={} offset={}",
                query.len(),
                offset
            );

            // SendMessageW 是同步的，会阻塞直到 Everything 处理完消息
            // 如果 Everything 在 SendMessageW 期间调用 SendMessageW 发送回复到我们的窗口，
            // 我们的窗口过程会被 Everything 的线程调用，而不是在消息循环中
            // SendMessageTimeoutW 替代 SendMessageW：Everything 偶发挂起时不再无限阻塞，
            // 超时后放弃本批（上层分页循环会带超时/取消逻辑退出）
            const SMTO_BLOCK: u32 = 0x0001;
            const SEND_TIMEOUT_MS: u32 = 5000;
            let mut send_result: usize = 0;
            let send_ok = SendMessageTimeoutW(
                everything_hwnd,
                WM_COPYDATA,
                reply_hwnd as usize,
                &mut cds as *mut COPYDATASTRUCT as isize,
                SMTO_ABORTIFHUNG | SMTO_BLOCK | SMTO_ERRORONEXIT,
                SEND_TIMEOUT_MS,
                &mut send_result,
            );

            if send_ok == 0 {
                let last_error = windows_sys::Win32::Foundation::GetLastError();
                eprintln!(
                    "[IPC-DIAG] ERROR: SendMessageTimeout 失败/超时, last error: {}",
                    last_error
                );
                log_debug!(
                    "[DEBUG] ERROR: SendMessageTimeout failed/timeout, last error: {}",
                    last_error
                );
                return Err(EverythingError::IpcFailed(format!(
                    "SendMessage 超时或失败（Everything 可能未响应）, error: {}",
                    last_error
                )));
            }
            eprintln!("[IPC-DIAG] SendMessageTimeoutW 成功返回，Everything 已接受查询");

            // SendMessageW 返回后，Everything 可能已经发送了回复
            // 如果是通过 SendMessageW 发送的，窗口过程已经在 SendMessageW 期间被调用了
            // 如果是通过 PostMessage 发送的，需要在消息循环中等待
            // 移除详细的 SendMessageW 日志，减少日志噪音
            // 这些日志在正常运行时不需要，只在调试时有用
        }

        Ok(())
    }

    /// 搜索文件（使用 Everything IPC）
    ///
    /// # Arguments
    /// * `query` - 搜索查询字符串
    /// * `max_results` - 最大结果数量
    /// * `cancelled` - 可选的取消标志，如果设置为 true，搜索将提前终止
    /// * `on_batch` - 可选的批次回调函数，每获取一批结果时调用
    pub fn search_files<F>(
        query: &str,
        max_results: usize,
        chunk_size: usize,
        cancelled: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
        mut on_batch: Option<F>,
    ) -> Result<EverythingSearchResponse, EverythingError>
    where
        F: FnMut(&[EverythingResult], u32, u32), // (batch_results, total_count, current_count)
    {
        log_debug!("[DEBUG] ===== search_files called =====");
        log_debug!(
            "[DEBUG] Query: '{}', max_results: {}, chunk_size: {}",
            query,
            max_results,
            chunk_size
        );

        // 验证查询字符串
        if query.trim().is_empty() {
            log_debug!("[DEBUG] ERROR: Query is empty");
            return Err(EverythingError::InvalidQuery(
                "查询字符串不能为空".to_string(),
            ));
        }

        // 检查 Everything 是否运行（只查找一次）
        log_debug!("[DEBUG] Checking if Everything service is running...");
        let everything_hwnd = find_everything_window().ok_or_else(|| {
            log_debug!("[DEBUG] ERROR: Everything service is not running");
            EverythingError::ServiceNotRunning
        })?;

        // 每批次的超时（略放宽，避免大结果集/高负载时过早超时）
        let timeout = Duration::from_secs(12);

        // 归一化参数
        let target_max = max_results.max(1);
        let chunk = chunk_size.max(1);

        // 检查是否被取消（在搜索开始前检查）
        // 这是第一个检查点，如果标志已经是 true，说明搜索在开始前就被取消了
        if let Some(cancel_flag) = cancelled {
            let is_cancelled = cancel_flag.load(std::sync::atomic::Ordering::Relaxed);
            if is_cancelled {
                log_debug!("[DEBUG] Search cancelled by user before starting (cancel_flag was true at first check)");
                log_debug!("[DEBUG] This means the search was cancelled before it even started!");
                return Err(EverythingError::Other("搜索已取消".to_string()));
            } else {
                log_debug!("[DEBUG] Search starting, cancel_flag is false (OK) at first check");
            }
        } else {
            log_debug!("[DEBUG] Search starting, no cancel_flag provided");
        }

        // 构建搜索标志
        let mut search_flags = 0u32;
        // 如果使用正则表达式，需要设置正则表达式标志
        if query.trim_start().starts_with("regex:") {
            search_flags |= EVERYTHING_IPC_REGEX;
        }

        let mut offset: usize = 0;
        let mut all_results: Vec<EverythingResult> = Vec::new();
        let mut total_from_everything: Option<u32> = None;

        // 如果部分批次成功但后续等待超时，我们会带着已获取的结果提前返回
        let mut timeout_with_partial = false;

        while offset < target_max {
            // 取消检查
            if let Some(cancel_flag) = cancelled {
                if cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
                    log_debug!("[DEBUG] Search cancelled before sending batch at offset {}", offset);
                    return Err(EverythingError::Other("搜索已取消".to_string()));
                }
            }

            let limit_for_batch = std::cmp::min(target_max - offset, chunk);

            // 创建 IPC 句柄（每批一次，确保收发通道独立）
            let ipc_handle = EverythingIpcHandle::new().map_err(|e| {
                log_debug!("[DEBUG] ERROR: Failed to create IPC handle: {:?}", e);
                e
            })?;

            log_debug!(
                "[DEBUG] Sending batch query: offset={}, limit={}",
                offset,
                limit_for_batch
            );

            // 发送查询
            send_search_query(
                query,
                limit_for_batch as u32,
                offset as u32,
                ipc_handle.reply_hwnd,
                everything_hwnd,
                search_flags,
            )
            .map_err(|e| {
                log_debug!("[DEBUG] ERROR: Failed to send search query: {:?}", e);
                e
            })?;

            // 等待回复（分段 recv_timeout：阻塞等待不占 CPU，且随时可检查取消标志）
            let start = Instant::now();
            let wait_slice = Duration::from_millis(50);
            let mut batch_result: Option<IpcBatchResult> = None;

            loop {
                // 取消检查
                if let Some(cancel_flag) = cancelled {
                    if cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
                        log_debug!("[DEBUG] Search cancelled while waiting for batch reply");
                        return Err(EverythingError::Other("搜索已取消".to_string()));
                    }
                }

                // 分段阻塞等待结果通道（窗口消息全部由专用 IPC 线程处理，
                // 搜索线程不再泵消息，也不再 sleep 轮询）
                match ipc_handle
                    .result_receiver
                    .recv_timeout(wait_slice)
                {
                    Ok(result) => {
                        batch_result = Some(result);
                        break;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        // 本批次超时：带着已获取的部分结果提前返回
                        if start.elapsed() > timeout {
                            if !all_results.is_empty() {
                                log_debug!(
                                    "[DEBUG] Batch timeout after {:?}, returning partial results count={}",
                                    start.elapsed(),
                                    all_results.len()
                                );
                                timeout_with_partial = true;
                                break;
                            } else {
                                log_debug!(
                                    "[DEBUG] ERROR: Timeout waiting for batch reply after {:?}",
                                    start.elapsed()
                                );
                                return Err(EverythingError::Timeout);
                            }
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        log_debug!("[DEBUG] ERROR: Result channel disconnected");
                        return Err(EverythingError::IpcFailed("通道已断开".to_string()));
                    }
                }
            }

            // 如果超时但已有部分结果，跳出分页循环并返回已有数据
            if timeout_with_partial {
                break;
            }

            // 处理本批结果
            let (batch_paths_with_flags, tot_items, num_items, _reply_offset) = match batch_result {
                Some(Ok((paths_with_flags, tot, num, off))) => (paths_with_flags, tot, num, off),
                Some(Err(e)) => {
                    log_debug!("[DEBUG] ERROR: Received error: {:?}", e);
                    return Err(e);
                }
                None => {
                    log_debug!("[DEBUG] ERROR: No result received");
                    return Err(EverythingError::Timeout);
                }
            };

            if total_from_everything.is_none() {
                total_from_everything = Some(tot_items);
            }

            // 转换为 EverythingResult，限制每批
            let mut batch_results: Vec<EverythingResult> = Vec::new();
            for (path, flags) in batch_paths_with_flags.iter().take(limit_for_batch) {
                let path_buf = PathBuf::from(path);
                let name = path_buf
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| path.clone());

                let size = None;
                let date_modified = None;
                let is_folder = if (flags & EVERYTHING_IPC_FOLDER) != 0
                    || (flags & EVERYTHING_IPC_DRIVE) != 0
                    || (flags & EVERYTHING_IPC_ROOT) != 0
                {
                    Some(true)
                } else {
                    Some(false)
                };

                batch_results.push(EverythingResult {
                    path: path.clone(),
                    name,
                    size,
                    date_modified,
                    is_folder,
                });
            }

            // 追加到总结果
            for item in batch_results.iter() {
                if all_results.len() >= target_max {
                    break;
                }
                all_results.push(item.clone());
            }

            let current_count = all_results.len() as u32;
            if let Some(ref mut callback) = on_batch {
                callback(&batch_results, tot_items, current_count);
            }

            // 终止条件：本批返回少于请求、已达上限或 Everything 告知无更多
            if batch_results.is_empty()
                || batch_results.len() < limit_for_batch
                || num_items == 0
                || all_results.len() >= target_max
            {
                log_debug!(
                    "[DEBUG] Breaking pagination: batch_len={}, num_items={}, current_count={}",
                    batch_results.len(),
                    num_items,
                    current_count
                );
                break;
            }

            offset += batch_results.len();
        }

        // 如果发生了超时但已返回部分结果，则报告实际返回数量作为总数，避免前端看到“总数很大但只收到很少”的错觉
        let tot_items = if timeout_with_partial {
            all_results.len() as u32
        } else {
            total_from_everything.unwrap_or(all_results.len() as u32)
        };

        log_debug!(
            "[DEBUG] ===== search_files completed (paged): {} total results (Everything found {} total) =====",
            all_results.len(),
            tot_items
        );

        Ok(EverythingSearchResponse {
            results: all_results,
            total_count: tot_items,
        })
    }

    /// 检查 Everything 是否可用
    pub fn is_everything_available() -> bool {
        check_everything_service_running()
    }

    /// 获取 Everything 可用性状态和错误信息
    pub fn check_everything_status() -> (bool, Option<String>) {
        if check_everything_service_running() {
            (true, None)
        } else {
            // 先检查 Everything.exe 是否存在，以区分"未安装"和"已安装但未运行"
            if find_everything_main_exe().is_some() {
                (false, Some("SERVICE_NOT_RUNNING".to_string()))
            } else {
                (false, Some("NOT_INSTALLED".to_string()))
            }
        }
    }

    /// 获取 Everything 路径（返回 Everything.exe 路径）
    pub fn get_everything_path() -> Option<PathBuf> {
        find_everything_main_exe()
    }
}

#[cfg(not(target_os = "windows"))]
pub mod windows {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    /// Search files using macOS Spotlight (mdfind)
    pub fn search_files<F>(
        query: &str,
        max_results: usize,
        _chunk_size: usize,
        cancelled: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
        mut on_batch: Option<F>,
    ) -> Result<EverythingSearchResponse, EverythingError>
    where
        F: FnMut(&[EverythingResult], u32, u32),
    {
        if query.trim().is_empty() {
            return Err(EverythingError::InvalidQuery("查询字符串不能为空".to_string()));
        }

        // Use mdfind to search via Spotlight
        let output = Command::new("mdfind")
            .arg(query)
            .output()
            .map_err(|e| EverythingError::IpcFailed(format!("mdfind 执行失败: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(EverythingError::IpcFailed(format!("mdfind 错误: {}", stderr)));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut results: Vec<EverythingResult> = Vec::new();

        for (count, line) in stdout.lines().enumerate() {
            // Check cancellation
            if let Some(cancel) = cancelled {
                if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
            }

            if count >= max_results {
                break;
            }

            let path = line.trim();
            if path.is_empty() {
                continue;
            }

            let path_buf = std::path::Path::new(path);
            let name = path_buf
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            // Get file metadata
            let (size, date_modified, is_folder) = match std::fs::metadata(path_buf) {
                Ok(meta) => {
                    let size = if meta.is_file() { Some(meta.len()) } else { None };
                    let is_folder = Some(meta.is_dir());
                    let date_modified = meta.modified().ok().and_then(|t| {
                        let datetime: chrono::DateTime<chrono::Local> = t.into();
                        Some(datetime.format("%Y-%m-%d %H:%M:%S").to_string())
                    });
                    (size, date_modified, is_folder)
                }
                Err(_) => (None, None, None),
            };

            results.push(EverythingResult {
                path: path.to_string(),
                name,
                size,
                date_modified,
                is_folder,
            });

            // Call batch callback every 20 results
            if let Some(ref mut cb) = on_batch {
                if (count + 1) % 20 == 0 {
                    let total = results.len() as u32;
                    cb(&results[results.len() - 20..], total, total);
                }
            }
        }

        let total_count = results.len() as u32;

        // Final batch callback
        if let Some(ref mut cb) = on_batch {
            let remainder = results.len() % 20;
            if remainder > 0 {
                cb(&results[results.len() - remainder..], total_count, total_count);
            }
        }

        Ok(EverythingSearchResponse {
            results,
            total_count,
        })
    }

    pub fn is_everything_available() -> bool {
        // Spotlight is always available on macOS
        true
    }

    pub fn check_everything_status() -> (bool, Option<String>) {
        (true, None)
    }

    pub fn get_everything_path() -> Option<PathBuf> {
        // Spotlight is built into macOS, return mdfind path
        Some(PathBuf::from("/usr/bin/mdfind"))
    }

    pub fn get_everything_version() -> Option<String> {
        Some("Spotlight".to_string())
    }

    pub fn get_log_file_path() -> Option<PathBuf> {
        None
    }

    pub fn check_everything_service_running() -> bool {
        // Spotlight is always running on macOS
        true
    }

    pub fn find_everything_main_exe() -> Option<PathBuf> {
        Some(PathBuf::from("/usr/bin/mdfind"))
    }

    pub fn init_log_file_early() {}
}
