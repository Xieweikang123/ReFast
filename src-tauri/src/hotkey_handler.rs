#[cfg(target_os = "windows")]
pub mod windows {
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        UI::WindowsAndMessaging::{DispatchMessageW, GetMessageW, TranslateMessage, MSG},
    };

    // These functions are in user32.dll but not exposed in windows-sys
    extern "system" {
        fn RegisterHotKey(hWnd: HWND, id: i32, fsModifiers: u32, vk: u32) -> i32;
        fn UnregisterHotKey(hWnd: HWND, id: i32) -> i32;
    }

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
    }

    static HOTKEY_STATE: Mutex<Option<Arc<Mutex<HotkeyState>>>> = Mutex::new(None);

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

                // Register hotkey
                let state_clone = state.clone();
                let (mods, vk_code) = {
                    let state_guard = state_clone.lock().unwrap();
                    (state_guard.modifiers, state_guard.vk)
                };

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
                // wParam: modifiers, lParam: vk
                unsafe {
                    use windows_sys::Win32::UI::WindowsAndMessaging::PostMessageW;
                    let result = PostMessageW(
                        hwnd,
                        WM_UPDATE_HOTKEY,
                        modifiers as usize,
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
                
                eprintln!("Hotkey update message sent successfully: modifiers={:x}, vk={:x}", modifiers, vk);
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
                
                eprintln!("Window thread: Received hotkey update message: modifiers={:x}, vk={:x}", modifiers, vk);
                
                // 先取消注册旧热键（忽略错误，可能未注册）
                let unregister_result = UnregisterHotKey(hwnd, HOTKEY_ID);
                if unregister_result == 0 {
                    let error_code = GetLastError();
                    // 1419 = ERROR_HOTKEY_NOT_REGISTERED，这是正常的，可以忽略
                    if error_code != 1419 {
                        eprintln!("Warning: Failed to unregister old hotkey (error code: {})", error_code);
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
                
                // 对于重复修饰键（如 Ctrl+Ctrl），不能使用 RegisterHotKey
                // 需要使用低级键盘钩子来检测，这里先提示用户
                if is_double {
                    eprintln!("Window thread: Double modifier hotkey detected (modifiers={:x}, vk={:x})", modifiers, vk);
                    eprintln!("Note: Double modifier hotkeys require keyboard hook implementation");
                    // TODO: 实现键盘钩子来检测重复修饰键
                    // 目前先尝试注册，虽然可能不会工作
                }
                
                // 注册新热键（在窗口线程中执行，符合线程亲和性要求）
                let result = RegisterHotKey(hwnd, HOTKEY_ID, modifiers, vk);
                if result == 0 {
                    let error_code = GetLastError();
                    
                    // ERROR_HOTKEY_ALREADY_REGISTERED = 1409
                    if error_code == 1409 {
                        eprintln!("Error: Hotkey already registered by another program (error code: 1409)");
                    } else {
                        eprintln!("Error: Failed to register hotkey (error code: {})", error_code);
                        if is_double {
                            eprintln!("Note: Double modifier hotkeys may not work with RegisterHotKey API");
                        }
                    }
                } else {
                    eprintln!("Window thread: Hotkey updated successfully: modifiers={:x}, vk={:x}, is_double={}", modifiers, vk, is_double);
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
