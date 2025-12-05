#[cfg(target_os = "windows")]
pub mod windows {
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::path::PathBuf;
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        UI::WindowsAndMessaging::{DispatchMessageW, GetMessageW, TranslateMessage, MSG},
    };
    
    // 日志文件状态
    struct LogFileState {
        file: Option<std::fs::File>,
        file_path: PathBuf,
        date: String,
    }
    
    static LOG_FILE_STATE: std::sync::OnceLock<Arc<Mutex<LogFileState>>> = std::sync::OnceLock::new();
    
    fn get_log_dir() -> PathBuf {
        // 使用与 everything_search 相同的日志目录
        #[cfg(target_os = "windows")]
        {
            if let Ok(appdata) = std::env::var("APPDATA") {
                PathBuf::from(appdata).join("re-fast").join("logs")
            } else {
                std::env::temp_dir().join("re-fast-logs")
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::env::temp_dir().join("re-fast-logs")
        }
    }
    
    fn get_log_file_state() -> Arc<Mutex<LogFileState>> {
        LOG_FILE_STATE
            .get_or_init(|| {
                let today = chrono::Local::now().format("%Y%m%d").to_string();
                let log_dir = get_log_dir();
                
                if let Err(e) = std::fs::create_dir_all(&log_dir) {
                    eprintln!("[Hotkey] Failed to create log directory: {}", e);
                }
                
                // 使用与 everything_search 相同的日志文件名
                let log_path = log_dir.join(format!("everything-ipc-{}.log", today));
                let file = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&log_path)
                    .ok();
                
                Arc::new(Mutex::new(LogFileState {
                    file,
                    file_path: log_path,
                    date: today,
                }))
            })
            .clone()
    }
    
    fn ensure_current_log_file() {
        let state = get_log_file_state();
        let today = chrono::Local::now().format("%Y%m%d").to_string();
        
        let mut state_guard = match state.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        
        if state_guard.date != today {
            if let Some(mut old_file) = state_guard.file.take() {
                let _ = old_file.flush();
            }
            
            let log_dir = get_log_dir();
            if let Err(e) = std::fs::create_dir_all(&log_dir) {
                eprintln!("[Hotkey] Failed to create log directory: {}", e);
            }
            
            // 使用与 everything_search 相同的日志文件名
            let log_path = log_dir.join(format!("everything-ipc-{}.log", today));
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
                .ok();
            
            state_guard.file = file;
            state_guard.file_path = log_path;
            state_guard.date = today;
        }
    }
    
    fn write_log_to_file(msg: &str) {
        ensure_current_log_file();
        let state = get_log_file_state();
        let state_guard_result = state.lock();
        if let Ok(mut state_guard) = state_guard_result {
            if let Some(file) = state_guard.file.as_mut() {
                let timestamp = chrono::Local::now().format("%H:%M:%S%.3f");
                let log_msg = format!("[{}] {}\n", timestamp, msg);
                let _ = file.write_all(log_msg.as_bytes());
                let _ = file.flush();
            }
        }
    }
    
    macro_rules! log_hotkey {
        ($($arg:tt)*) => {
            {
                let msg = format!($($arg)*);
                eprintln!("{}", msg);
                write_log_to_file(&msg);
            }
        };
    }
    
    /// 初始化日志文件并返回日志文件路径（用于调试）
    pub fn init_hotkey_log() -> Option<std::path::PathBuf> {
        let state = get_log_file_state();
        let state_guard = state.lock().ok()?;
        let log_path = state_guard.file_path.clone();
        drop(state_guard);
        
        // 输出日志文件路径到控制台
        eprintln!("[Hotkey] Log file initialized: {}", log_path.display());
        log_hotkey!("[Hotkey] ===== Hotkey log initialized =====");
        
        Some(log_path)
    }

    // These functions are in user32.dll but not exposed in windows-sys
    extern "system" {
        fn RegisterHotKey(hWnd: HWND, id: i32, fsModifiers: u32, vk: u32) -> i32;
        fn UnregisterHotKey(hWnd: HWND, id: i32) -> i32;
        fn SetWindowsHookExW(idHook: i32, lpfn: unsafe extern "system" fn(i32, WPARAM, LPARAM) -> LRESULT, hMod: windows_sys::Win32::Foundation::HINSTANCE, dwThreadId: u32) -> windows_sys::Win32::UI::WindowsAndMessaging::HHOOK;
        fn UnhookWindowsHookEx(hhk: windows_sys::Win32::UI::WindowsAndMessaging::HHOOK) -> i32;
        fn CallNextHookEx(hhk: windows_sys::Win32::UI::WindowsAndMessaging::HHOOK, nCode: i32, wParam: WPARAM, lParam: LPARAM) -> LRESULT;
    }
    
    const WH_KEYBOARD_LL: i32 = 13;
    const WM_KEYDOWN: u32 = 0x0100;
    const WM_KEYUP: u32 = 0x0101;
    const WM_SYSKEYDOWN: u32 = 0x0104;
    const WM_SYSKEYUP: u32 = 0x0105;
    const WM_HOTKEY: u32 = 0x0312;

    const MOD_ALT: u32 = 0x0001;
    const MOD_CONTROL: u32 = 0x0002;
    const MOD_SHIFT: u32 = 0x0004;
    const MOD_WIN: u32 = 0x0008;

    const HOTKEY_ID: i32 = 1;
    
    // 自定义消息：更新热键
    const WM_UPDATE_HOTKEY: u32 = windows_sys::Win32::UI::WindowsAndMessaging::WM_APP + 1;

    // 存储当前的快捷键配置和窗口句柄
    struct HotkeyState {
        hwnd: Option<HWND>,
        modifiers: u32,
        vk: u32,
        is_double_modifier: bool, // 是否是重复修饰键（如 Ctrl+Ctrl）
        hook: Option<windows_sys::Win32::UI::WindowsAndMessaging::HHOOK>, // 键盘钩子句柄（用于重复修饰键）
        last_keyup_time: Option<std::time::Instant>, // 上次按键抬起时间（用于检测重复）
        waiting_for_second: bool, // 是否正在等待第二次按键抬起
        other_key_pressed: bool, // 是否按下了其他键（需要重置状态）
    }

    static HOTKEY_STATE: Mutex<Option<Arc<Mutex<HotkeyState>>>> = Mutex::new(None);

    // 检查虚拟键码是否匹配目标键（包括左右键变体）
    fn is_target_key(vk_code: u32, target_vk: u32) -> bool {
        if vk_code == target_vk {
            return true;
        }
        
        // 对于修饰键，需要检查左右键变体
        match target_vk {
            0x12 => {
                // VK_MENU (Alt) - 检查左 Alt 和右 Alt
                vk_code == 0xA4 || vk_code == 0xA5 // VK_LMENU, VK_RMENU
            }
            0x11 => {
                // VK_CONTROL (Ctrl) - 检查左 Ctrl 和右 Ctrl
                vk_code == 0xA2 || vk_code == 0xA3 // VK_LCONTROL, VK_RCONTROL
            }
            0x10 => {
                // VK_SHIFT (Shift) - 检查左 Shift 和右 Shift
                vk_code == 0xA0 || vk_code == 0xA1 // VK_LSHIFT, VK_RSHIFT
            }
            _ => false,
        }
    }

    // 键盘钩子回调函数：检测重复修饰键（使用企业微信的实现方式）
    unsafe extern "system" fn keyboard_hook_proc(nCode: i32, wParam: WPARAM, lParam: LPARAM) -> LRESULT {
        use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, HHOOK, KBDLLHOOKSTRUCT};
        
        // 如果 nCode < 0，必须调用 CallNextHookEx
        if nCode < 0 {
            return CallNextHookEx(HHOOK::default(), nCode, wParam, lParam);
        }
        
        // 解析 KBDLLHOOKSTRUCT（先解析，用于日志）
        let hook_struct = &*(lParam as *const KBDLLHOOKSTRUCT);
        let vk_code = hook_struct.vkCode as u32;
        let is_keydown = wParam == WM_KEYDOWN as WPARAM || wParam == WM_SYSKEYDOWN as WPARAM;
        let is_keyup = wParam == WM_KEYUP as WPARAM || wParam == WM_SYSKEYUP as WPARAM;
        
        // 获取全局状态
        let global_state = HOTKEY_STATE.lock().unwrap();
        if let Some(state) = global_state.as_ref() {
            let mut state_guard = state.lock().unwrap();
            
            // 检查是否是重复修饰键模式
            if state_guard.is_double_modifier {
                // 检查是否是目标键（包括左右键变体）
                let is_target = is_target_key(vk_code, state_guard.vk);
                
                // 记录所有键盘事件（用于调试）
                if is_target {
                    if is_keydown {
                        log_hotkey!("[Hotkey] Keyboard hook: Target key DOWN detected, vk_code={} (target={}), waiting_for_second={}", vk_code, state_guard.vk, state_guard.waiting_for_second);
                    } else if is_keyup {
                        log_hotkey!("[Hotkey] Keyboard hook: Target key UP detected, vk_code={} (target={}), waiting_for_second={}", vk_code, state_guard.vk, state_guard.waiting_for_second);
                    }
                } else if is_keydown || is_keyup {
                    // 只在等待第二次时记录其他键，避免日志过多
                    if state_guard.waiting_for_second {
                        log_hotkey!("[Hotkey] Keyboard hook: Other key event while waiting, vk_code={}, is_keydown={}", vk_code, is_keydown);
                    }
                }
                
                // 检查是否是目标修饰键（包括左右键变体）
                if is_target {
                    let now = std::time::Instant::now();
                    
                    // 处理按键按下事件（KeyDown）- 检查超时
                    if wParam == WM_KEYDOWN as WPARAM || wParam == WM_SYSKEYDOWN as WPARAM {
                        if state_guard.waiting_for_second {
                            // 正在等待第二次，检查是否超时
                            if let Some(last_time) = state_guard.last_keyup_time {
                                let delta = now.duration_since(last_time).as_millis();
                                if delta >= 500 {
                                    // 超时，重置状态并开始新的序列
                                    log_hotkey!("[Hotkey] Keyboard hook: Timeout detected on keydown ({}ms >= 500ms), resetting and starting new sequence", delta);
                                    state_guard.waiting_for_second = false;
                                    state_guard.last_keyup_time = None;
                                    state_guard.other_key_pressed = false;
                                } else if state_guard.other_key_pressed {
                                    // 按了其他键，重置状态
                                    log_hotkey!("[Hotkey] Keyboard hook: Other key was pressed before this keydown, resetting state");
                                    state_guard.waiting_for_second = false;
                                    state_guard.last_keyup_time = None;
                                    state_guard.other_key_pressed = false;
                                }
                            }
                        }
                    }
                    
                    // 处理按键抬起事件（KeyUp）
                    if wParam == WM_KEYUP as WPARAM || wParam == WM_SYSKEYUP as WPARAM {
                        log_hotkey!("[Hotkey] Keyboard hook: Modifier keyup detected, vk_code={}, waiting_for_second={}, other_key_pressed={}", 
                                 vk_code, state_guard.waiting_for_second, state_guard.other_key_pressed);
                        
                        if state_guard.waiting_for_second {
                            // 正在等待第二次抬起
                            if !state_guard.other_key_pressed {
                                // 没有按下其他键，检查时间差
                                if let Some(last_time) = state_guard.last_keyup_time {
                                    let delta = now.duration_since(last_time).as_millis();
                                    log_hotkey!("[Hotkey] Keyboard hook: Checking delta: {}ms (threshold: 500ms)", delta);
                                    if delta < 500 {
                                        // 检测到双击！触发热键
                                        log_hotkey!("[Hotkey] Keyboard hook: ✅ Double modifier detected! Delta: {}ms, triggering hotkey", delta);
                                        if let Some(hwnd) = state_guard.hwnd {
                                            PostMessageW(hwnd, WM_HOTKEY, HOTKEY_ID as WPARAM, 0);
                                        }
                                        // 重置状态
                                        state_guard.waiting_for_second = false;
                                        state_guard.last_keyup_time = None;
                                        state_guard.other_key_pressed = false;
                                        drop(state_guard);
                                        drop(global_state);
                                        // 放行消息，让其他程序也能响应
                                        return CallNextHookEx(HHOOK::default(), nCode, wParam, lParam);
                                    } else {
                                        log_hotkey!("[Hotkey] Keyboard hook: Delta {}ms >= 500ms, timeout, resetting state", delta);
                                    }
                                } else {
                                    log_hotkey!("[Hotkey] Keyboard hook: ⚠️ waiting_for_second=true but last_keyup_time is None, resetting");
                                }
                            } else {
                                log_hotkey!("[Hotkey] Keyboard hook: Other key was pressed, resetting state");
                            }
                            // 超时或按了其他键，重置状态
                            state_guard.waiting_for_second = false;
                            state_guard.last_keyup_time = None;
                            state_guard.other_key_pressed = false;
                        } else {
                            // 第一次抬起，记录时间戳
                            log_hotkey!("[Hotkey] Keyboard hook: First modifier keyup detected, recording timestamp, waiting for second");
                            state_guard.last_keyup_time = Some(now);
                            state_guard.waiting_for_second = true;
                            state_guard.other_key_pressed = false;
                        }
                    }
                } else {
                    // 按下了其他键
                    if wParam == WM_KEYDOWN as WPARAM || wParam == WM_SYSKEYDOWN as WPARAM {
                        // 如果正在等待第二次，检查超时或标记为按了其他键
                        if state_guard.waiting_for_second {
                            let now = std::time::Instant::now();
                            if let Some(last_time) = state_guard.last_keyup_time {
                                let delta = now.duration_since(last_time).as_millis();
                                if delta >= 500 {
                                    // 超时，直接重置状态
                                    log_hotkey!("[Hotkey] Keyboard hook: Timeout detected on other key ({}ms >= 500ms), resetting state", delta);
                                    state_guard.waiting_for_second = false;
                                    state_guard.last_keyup_time = None;
                                    state_guard.other_key_pressed = false;
                                } else {
                                    // 未超时，标记为按了其他键
                                    log_hotkey!("[Hotkey] Keyboard hook: Other key pressed while waiting ({}ms < 500ms), marking as interference", delta);
                                    state_guard.other_key_pressed = true;
                                }
                            } else {
                                // 没有时间戳，直接重置
                                log_hotkey!("[Hotkey] Keyboard hook: Other key pressed, no timestamp, resetting state");
                                state_guard.waiting_for_second = false;
                                state_guard.other_key_pressed = false;
                            }
                        }
                    }
                }
            } else {
                // 不是重复修饰键模式，但钩子已安装（可能是状态不一致）
                if is_keydown || is_keyup {
                    log_hotkey!("[Hotkey] Keyboard hook: Hook installed but is_double_modifier=false, vk_code={}, target_vk={}", vk_code, state_guard.vk);
                }
            }
        } else {
            // 状态未初始化
            if is_keydown || is_keyup {
                log_hotkey!("[Hotkey] Keyboard hook: State not initialized, vk_code={}", vk_code);
            }
        }
        
        // 调用下一个钩子（关键：必须放行消息）
        CallNextHookEx(HHOOK::default(), nCode, wParam, lParam)
    }

    // 将字符串格式的修饰符转换为 Windows 修饰符标志
    // 返回 (flags, is_double_modifier)
    fn parse_modifiers(modifiers: &[String]) -> Result<(u32, bool), String> {
        let mut flags = 0u32;
        let mut is_double = false;
        
        // 检查是否是重复修饰键（如 ["Ctrl", "Ctrl"]）
        if modifiers.len() == 2 && modifiers[0] == modifiers[1] {
            is_double = true;
            // 对于重复修饰键，只设置一次标志
            match modifiers[0].as_str() {
                "Alt" => flags = MOD_ALT,
                "Ctrl" => flags = MOD_CONTROL,
                "Shift" => flags = MOD_SHIFT,
                "Meta" => flags = MOD_WIN,
                _ => return Err(format!("Unknown modifier: {}", modifiers[0])),
            }
        } else {
            // 普通组合键
            for mod_str in modifiers {
                match mod_str.as_str() {
                    "Alt" => flags |= MOD_ALT,
                    "Ctrl" => flags |= MOD_CONTROL,
                    "Shift" => flags |= MOD_SHIFT,
                    "Meta" => flags |= MOD_WIN,
                    _ => return Err(format!("Unknown modifier: {}", mod_str)),
                }
            }
        }
        
        if flags == 0 {
            return Err("At least one modifier is required".to_string());
        }
        Ok((flags, is_double))
    }

    // 将字符串格式的键转换为 Windows 虚拟键码
    // 对于重复修饰键，key 可能是修饰键名称（如 "Ctrl"）
    fn parse_virtual_key(key: &str) -> Result<u32, String> {
        // 处理修饰键作为键的情况（用于重复修饰键）
        if key == "Ctrl" {
            return Ok(0x11); // VK_CONTROL
        }
        if key == "Alt" {
            return Ok(0x12); // VK_MENU (Alt key)
        }
        if key == "Shift" {
            return Ok(0x10); // VK_SHIFT
        }
        if key == "Meta" {
            return Ok(0x5B); // VK_LWIN (Left Windows key)
        }
        
        // 处理特殊键
        match key {
            "Space" => Ok(0x20), // VK_SPACE
            "Enter" => Ok(0x0D), // VK_RETURN
            "Escape" => Ok(0x1B), // VK_ESCAPE
            "Tab" => Ok(0x09),   // VK_TAB
            "Backspace" => Ok(0x08), // VK_BACK
            "Delete" => Ok(0x2E), // VK_DELETE
            "Insert" => Ok(0x2D), // VK_INSERT
            "Home" => Ok(0x24),   // VK_HOME
            "End" => Ok(0x23),    // VK_END
            "PageUp" => Ok(0x21), // VK_PRIOR
            "PageDown" => Ok(0x22), // VK_NEXT
            "ArrowUp" => Ok(0x26), // VK_UP
            "ArrowDown" => Ok(0x28), // VK_DOWN
            "ArrowLeft" => Ok(0x25), // VK_LEFT
            "ArrowRight" => Ok(0x27), // VK_RIGHT
            "F1" => Ok(0x70),
            "F2" => Ok(0x71),
            "F3" => Ok(0x72),
            "F4" => Ok(0x73),
            "F5" => Ok(0x74),
            "F6" => Ok(0x75),
            "F7" => Ok(0x76),
            "F8" => Ok(0x77),
            "F9" => Ok(0x78),
            "F10" => Ok(0x79),
            "F11" => Ok(0x7A),
            "F12" => Ok(0x7B),
            _ => {
                // 处理字母和数字
                if key.len() == 1 {
                    let ch = key.chars().next().unwrap();
                    if ch.is_ascii_alphanumeric() {
                        // A-Z: 0x41-0x5A, 0-9: 0x30-0x39
                        let code = ch.to_ascii_uppercase() as u32;
                        if code >= 0x30 && code <= 0x39 {
                            Ok(code) // 0-9
                        } else if code >= 0x41 && code <= 0x5A {
                            Ok(code) // A-Z
                        } else {
                            Err(format!("Unsupported key: {}", key))
                        }
                    } else {
                        Err(format!("Unsupported key: {}", key))
                    }
                } else {
                    Err(format!("Unsupported key: {}", key))
                }
            }
        }
    }

    pub fn start_hotkey_listener(
        sender: mpsc::Sender<()>,
        hotkey_config: Option<crate::settings::HotkeyConfig>,
    ) -> Result<thread::JoinHandle<()>, String> {
        // 解析快捷键配置，默认使用 Alt+Space
        let (modifiers, vk, is_double) = if let Some(config) = hotkey_config {
            let (mods, is_double_mod) = parse_modifiers(&config.modifiers)?;
            let vk_code = parse_virtual_key(&config.key)?;
            (mods, vk_code, is_double_mod)
        } else {
            (MOD_ALT, 0x20, false) // 默认 Alt+Space
        };

        // 创建共享状态
        let state = Arc::new(Mutex::new(HotkeyState {
            hwnd: None,
            modifiers,
            vk,
            is_double_modifier: is_double,
            hook: None,
            last_keyup_time: None,
            waiting_for_second: false,
            other_key_pressed: false,
        }));

        // 保存到全局状态
        {
            let mut global_state = HOTKEY_STATE.lock().unwrap();
            *global_state = Some(state.clone());
        }

        let handle = thread::spawn(move || {
            unsafe {
                use std::ffi::OsStr;
                use std::os::windows::ffi::OsStrExt;
                use windows_sys::Win32::UI::WindowsAndMessaging::{
                    CreateWindowExW, RegisterClassW, UnregisterClassW, CW_USEDEFAULT, WNDCLASSW,
                    WS_OVERLAPPED,
                };

                // Create a window class
                let class_name: Vec<u16> = OsStr::new("ReFastHotkeyWindow")
                    .encode_wide()
                    .chain(Some(0))
                    .collect();

                let wc = WNDCLASSW {
                    style: 0,
                    lpfnWndProc: Some(hotkey_wnd_proc),
                    cbClsExtra: 0,
                    cbWndExtra: 0,
                    hInstance: 0,
                    hIcon: 0,
                    hCursor: 0,
                    hbrBackground: 0,
                    lpszMenuName: std::ptr::null(),
                    lpszClassName: class_name.as_ptr(),
                };

                let atom = RegisterClassW(&wc);
                if atom == 0 {
                    eprintln!("Failed to register window class");
                    return;
                }

                // Create a hidden window
                let hwnd = CreateWindowExW(
                    0,
                    class_name.as_ptr(),
                    std::ptr::null(),
                    WS_OVERLAPPED,
                    CW_USEDEFAULT,
                    CW_USEDEFAULT,
                    CW_USEDEFAULT,
                    CW_USEDEFAULT,
                    0,
                    0,
                    0,
                    std::ptr::null_mut(),
                );

                if hwnd == 0 {
                    eprintln!("Failed to create hotkey window");
                    let _ = UnregisterClassW(class_name.as_ptr(), 0);
                    return;
                }

                // 更新状态中的 hwnd
                {
                    let mut state_guard = state.lock().unwrap();
                    state_guard.hwnd = Some(hwnd);
                }

                // Store sender in window user data
                let sender_ptr = Box::into_raw(Box::new(sender));
                windows_sys::Win32::UI::WindowsAndMessaging::SetWindowLongPtrW(
                    hwnd,
                    windows_sys::Win32::UI::WindowsAndMessaging::GWLP_USERDATA,
                    sender_ptr as isize,
                );

                // Register hotkey or install keyboard hook
                let state_clone = state.clone();
                let (mods, vk_code, is_double) = {
                    let state_guard = state_clone.lock().unwrap();
                    (state_guard.modifiers, state_guard.vk, state_guard.is_double_modifier)
                };

                // 对于重复修饰键（如双击 Alt），使用键盘钩子而不是 RegisterHotKey
                if is_double {
                    log_hotkey!("[Hotkey] Initial setup: Double modifier hotkey detected (modifiers={:x}, vk={:x}), using keyboard hook", mods, vk_code);
                    
                    // 安装键盘钩子
                    unsafe {
                        use windows_sys::Win32::Foundation::HINSTANCE;
                        let hook = SetWindowsHookExW(
                            WH_KEYBOARD_LL,
                            keyboard_hook_proc,
                            HINSTANCE::default(), // hMod 为 NULL 表示当前进程
                            0, // dwThreadId 为 0 表示全局钩子
                        );
                        
                        use windows_sys::Win32::UI::WindowsAndMessaging::HHOOK;
                        if hook == HHOOK::default() {
                            log_hotkey!("[Hotkey] Error: Failed to install keyboard hook during initialization");
                            // Free the sender pointer before cleanup
                            let sender_ptr = windows_sys::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                                hwnd,
                                windows_sys::Win32::UI::WindowsAndMessaging::GWLP_USERDATA,
                            ) as *mut mpsc::Sender<()>;
                            if !sender_ptr.is_null() {
                                let _ = Box::from_raw(sender_ptr);
                            }
                            let _ = UnregisterClassW(class_name.as_ptr(), 0);
                            return;
                        }
                        
                        // 保存钩子句柄
                        let mut state_guard = state.lock().unwrap();
                        state_guard.hook = Some(hook);
                        log_hotkey!("[Hotkey] Initial setup: Keyboard hook installed successfully, hook={:?}, hwnd={:?}", hook, hwnd);
                    }
                } else {
                    // 对于非重复修饰键，使用 RegisterHotKey
                    let result = RegisterHotKey(hwnd, HOTKEY_ID, mods, vk_code);

                    if result == 0 {
                        eprintln!("Failed to register global hotkey");
                        // Free the sender pointer before cleanup
                        let sender_ptr = windows_sys::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                            hwnd,
                            windows_sys::Win32::UI::WindowsAndMessaging::GWLP_USERDATA,
                        ) as *mut mpsc::Sender<()>;
                        if !sender_ptr.is_null() {
                            let _ = Box::from_raw(sender_ptr);
                        }
                        let _ = UnregisterClassW(class_name.as_ptr(), 0);
                        return;
                    }
                    
                    log_hotkey!("[Hotkey] Initial setup: Hotkey registered successfully: modifiers={:x}, vk={:x}", mods, vk_code);
                }

                // Message loop
                let mut msg = MSG {
                    hwnd: 0,
                    message: 0,
                    wParam: 0,
                    lParam: 0,
                    time: 0,
                    pt: windows_sys::Win32::Foundation::POINT { x: 0, y: 0 },
                };

                loop {
                    // Use NULL (0) to receive messages for all windows in the thread
                    let result = GetMessageW(&mut msg, 0, 0, 0);

                    if result == 0 {
                        // WM_QUIT
                        break;
                    }

                    if result == -1 {
                        // Error
                        eprintln!("GetMessage error");
                        break;
                    }

                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }

                // Cleanup
                // 卸载键盘钩子（如果存在）
                {
                    let global_state = HOTKEY_STATE.lock().unwrap();
                    if let Some(state) = global_state.as_ref() {
                        let mut state_guard = state.lock().unwrap();
                        if let Some(hook) = state_guard.hook {
                            UnhookWindowsHookEx(hook);
                            state_guard.hook = None;
                        }
                    }
                }
                
                // 取消注册热键（如果已注册）
                let _ = UnregisterHotKey(hwnd, HOTKEY_ID);

                // Free the sender pointer
                let sender_ptr = windows_sys::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                    hwnd,
                    windows_sys::Win32::UI::WindowsAndMessaging::GWLP_USERDATA,
                ) as *mut mpsc::Sender<()>;
                if !sender_ptr.is_null() {
                    let _ = Box::from_raw(sender_ptr);
                }

                // 清除全局状态
                {
                    let mut global_state = HOTKEY_STATE.lock().unwrap();
                    *global_state = None;
                }

                let _ = UnregisterClassW(class_name.as_ptr(), 0);
            }
        });

        Ok(handle)
    }

    // 更新快捷键配置
    // 使用 PostMessage 发送消息到窗口线程，让窗口线程自己执行注册操作
    pub fn update_hotkey(config: crate::settings::HotkeyConfig) -> Result<(), String> {
        let (modifiers, is_double) = parse_modifiers(&config.modifiers)?;
        let vk = parse_virtual_key(&config.key)?;

        // 等待 hwnd 初始化（最多等待 2 秒）
        let mut retries = 0;
        const MAX_RETRIES: u32 = 40; // 40 * 50ms = 2秒
        
        loop {
            let global_state = HOTKEY_STATE.lock().unwrap();
            if let Some(state) = global_state.as_ref() {
                let state_guard = state.lock().unwrap();
                
                // 如果 hwnd 还没有设置，等待并重试
                if state_guard.hwnd.is_none() {
                    drop(state_guard);
                    drop(global_state);
                    
                    if retries >= MAX_RETRIES {
                        return Err("热键窗口未初始化，请重启应用".to_string());
                    }
                    
                    retries += 1;
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    continue;
                }
                
                let hwnd = state_guard.hwnd.unwrap();
                
                // 验证窗口句柄是否有效
                unsafe {
                    use windows_sys::Win32::UI::WindowsAndMessaging::IsWindow;
                    if IsWindow(hwnd) == 0 {
                        return Err("热键窗口句柄已失效，请重启应用".to_string());
                    }
                }
                
                // 更新配置（在发送消息前更新，窗口线程会读取）
                drop(state_guard);
                {
                    let mut state_guard = state.lock().unwrap();
                    state_guard.modifiers = modifiers;
                    state_guard.vk = vk;
                    state_guard.is_double_modifier = is_double;
                }
                drop(global_state);
                
                // 使用 PostMessage 发送自定义消息到窗口线程
                // wParam: modifiers | (is_double << 16), lParam: vk
                unsafe {
                    use windows_sys::Win32::UI::WindowsAndMessaging::PostMessageW;
                    let wparam = modifiers | ((if is_double { 1 } else { 0 }) << 16);
                    log_hotkey!("[Hotkey] Sending hotkey update message: modifiers={:x}, vk={:x}, is_double={}, wparam={:x}", modifiers, vk, is_double, wparam);
                    let result = PostMessageW(
                        hwnd,
                        WM_UPDATE_HOTKEY,
                        wparam as usize,
                        vk as isize,
                    );
                    
                    if result == 0 {
                        use windows_sys::Win32::Foundation::GetLastError;
                        let error_code = unsafe { GetLastError() };
                        return Err(format!(
                            "发送热键更新消息失败 (错误代码: {})，请重启应用",
                            error_code
                        ));
                    }
                }
                
                log_hotkey!("[Hotkey] Hotkey update message sent successfully: modifiers={:x}, vk={:x}", modifiers, vk);
                return Ok(());
            } else {
                return Err("热键监听器未启动".to_string());
            }
        }
    }

    unsafe extern "system" fn hotkey_wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            DefWindowProcW, PostQuitMessage, WM_DESTROY, WM_HOTKEY,
        };
        use windows_sys::Win32::Foundation::GetLastError;

        match msg {
            WM_UPDATE_HOTKEY => {
                // 在窗口线程中执行热键更新操作
                // wParam: modifiers | (is_double << 16), lParam: vk
                let modifiers = (wparam as u32) & 0xFFFF;
                let is_double = ((wparam as u32) >> 16) != 0;
                let vk = lparam as u32;
                
                log_hotkey!("[Hotkey] Window thread: Received hotkey update message: modifiers={:x}, vk={:x}, is_double={}, wparam={:x}", modifiers, vk, is_double, wparam);
                
                // 先取消注册旧热键（忽略错误，可能未注册）
                let unregister_result = UnregisterHotKey(hwnd, HOTKEY_ID);
                if unregister_result == 0 {
                    let error_code = GetLastError();
                    // 1419 = ERROR_HOTKEY_NOT_REGISTERED，这是正常的，可以忽略
                    if error_code != 1419 {
                        log_hotkey!("[Hotkey] Warning: Failed to unregister old hotkey (error code: {})", error_code);
                    }
                }
                
                // 更新全局状态
                {
                    let global_state = HOTKEY_STATE.lock().unwrap();
                    if let Some(state) = global_state.as_ref() {
                        let mut state_guard = state.lock().unwrap();
                        state_guard.modifiers = modifiers;
                        state_guard.vk = vk;
                        state_guard.is_double_modifier = is_double;
                    }
                }
                
                // 对于重复修饰键（如 Ctrl+Ctrl），使用键盘钩子而不是 RegisterHotKey
                if is_double {
                    log_hotkey!("[Hotkey] Window thread: Double modifier hotkey detected (modifiers={:x}, vk={:x}), using keyboard hook", modifiers, vk);
                    
                    // 先卸载旧的钩子（如果存在）
                    {
                        let global_state = HOTKEY_STATE.lock().unwrap();
                        if let Some(state) = global_state.as_ref() {
                            let mut state_guard = state.lock().unwrap();
                            if let Some(old_hook) = state_guard.hook {
                                UnhookWindowsHookEx(old_hook);
                                state_guard.hook = None;
                            }
                            state_guard.last_keyup_time = None;
                            state_guard.waiting_for_second = false;
                            state_guard.other_key_pressed = false;
                        }
                    }
                    
                    // 安装新的键盘钩子
                    unsafe {
                        use windows_sys::Win32::Foundation::HINSTANCE;
                        let hook = SetWindowsHookExW(
                            WH_KEYBOARD_LL,
                            keyboard_hook_proc,
                            HINSTANCE::default(), // hMod 为 NULL 表示当前进程
                            0, // dwThreadId 为 0 表示全局钩子
                        );
                        
                        use windows_sys::Win32::UI::WindowsAndMessaging::HHOOK;
                        if hook == HHOOK::default() {
                            log_hotkey!("[Hotkey] Error: Failed to install keyboard hook");
                            return 0;
                        }
                        
                        // 保存钩子句柄和窗口句柄
                        let global_state = HOTKEY_STATE.lock().unwrap();
                        if let Some(state) = global_state.as_ref() {
                            let mut state_guard = state.lock().unwrap();
                            state_guard.hook = Some(hook);
                            state_guard.hwnd = Some(hwnd); // 确保 hwnd 已设置
                            log_hotkey!("[Hotkey] Window thread: Keyboard hook installed successfully, hook={:?}, hwnd={:?}, modifiers={:x}, vk={:x}, is_double_modifier={}", 
                                      hook, hwnd, state_guard.modifiers, state_guard.vk, state_guard.is_double_modifier);
                        }
                    }
                    
                    return 0;
                }
                
                // 对于非重复修饰键，先卸载钩子（如果存在）
                {
                    let global_state = HOTKEY_STATE.lock().unwrap();
                    if let Some(state) = global_state.as_ref() {
                        let mut state_guard = state.lock().unwrap();
                        if let Some(old_hook) = state_guard.hook {
                            UnhookWindowsHookEx(old_hook);
                            state_guard.hook = None;
                        }
                         state_guard.last_keyup_time = None;
                        state_guard.waiting_for_second = false;
                        state_guard.other_key_pressed = false;
                    }
                }
                
                // 注册新热键（在窗口线程中执行，符合线程亲和性要求）
                let result = RegisterHotKey(hwnd, HOTKEY_ID, modifiers, vk);
                if result == 0 {
                    let error_code = GetLastError();
                    
                    // ERROR_HOTKEY_ALREADY_REGISTERED = 1409
                    if error_code == 1409 {
                        log_hotkey!("[Hotkey] Error: Hotkey already registered by another program (error code: 1409)");
                    } else {
                        log_hotkey!("[Hotkey] Error: Failed to register hotkey (error code: {})", error_code);
                        if is_double {
                            log_hotkey!("[Hotkey] Note: Double modifier hotkeys may not work with RegisterHotKey API");
                        }
                    }
                } else {
                    log_hotkey!("[Hotkey] Window thread: Hotkey updated successfully: modifiers={:x}, vk={:x}, is_double={}", modifiers, vk, is_double);
                }
                
                0
            }
            WM_HOTKEY => {
                if wparam == HOTKEY_ID as usize {
                    // Get sender from window user data
                    let sender_ptr = windows_sys::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                        hwnd,
                        windows_sys::Win32::UI::WindowsAndMessaging::GWLP_USERDATA,
                    ) as *mut mpsc::Sender<()>;

                    if !sender_ptr.is_null() {
                        let sender = &*sender_ptr;
                        let _ = sender.send(());
                    }
                }
                0
            }
            WM_DESTROY => {
                // 卸载键盘钩子（如果存在）
                {
                    let global_state = HOTKEY_STATE.lock().unwrap();
                    if let Some(state) = global_state.as_ref() {
                        let mut state_guard = state.lock().unwrap();
                        if let Some(hook) = state_guard.hook {
                            UnhookWindowsHookEx(hook);
                            state_guard.hook = None;
                        }
                    }
                }
                
                // 取消注册热键
                let _ = UnregisterHotKey(hwnd, HOTKEY_ID);
                
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub mod windows {
    use std::sync::mpsc;
    use std::thread;

    pub fn start_hotkey_listener(
        _sender: mpsc::Sender<()>,
        _hotkey_config: Option<crate::settings::HotkeyConfig>,
    ) -> Result<thread::JoinHandle<()>, String> {
        Err("Hotkey listener is only supported on Windows".to_string())
    }

    pub fn update_hotkey(_config: crate::settings::HotkeyConfig) -> Result<(), String> {
        Err("Hotkey listener is only supported on Windows".to_string())
    }
}
