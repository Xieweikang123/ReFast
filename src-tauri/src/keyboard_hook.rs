#[cfg(target_os = "windows")]
pub mod windows {
    use std::sync::{Arc, Mutex, OnceLock};
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::{
        Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM},
        UI::WindowsAndMessaging::{
            CallNextHookEx, DispatchMessageW, GetMessageW, KBDLLHOOKSTRUCT, MSG, SetWindowsHookExA,
            TranslateMessage, UnhookWindowsHookEx, HHOOK, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP,
            WM_SYSKEYDOWN, WM_SYSKEYUP,
        },
    };

    // Virtual key code for Ctrl
    const VK_CONTROL: u32 = 0x11;
    const VK_LCONTROL: u32 = 0xA2;
    const VK_RCONTROL: u32 = 0xA3;

    // Low-level keyboard hook constants (already imported from windows_sys)

    // Timeout for double Ctrl detection (400ms)
    const DOUBLE_CTRL_TIMEOUT_MS: u64 = 400;

    // State machine for double Ctrl detection
    #[derive(Debug, Clone, Copy, PartialEq)]
    enum DoubleCtrlState {
        Idle,                    // Waiting for first Ctrl press
        FirstCtrlPressed,        // First Ctrl pressed, waiting for release
        FirstCtrlReleased,       // First Ctrl released, waiting for second press (within timeout)
    }

    struct DoubleCtrlDetector {
        state: DoubleCtrlState,
        first_press_time: Option<Instant>,
        last_release_time: Option<Instant>,
        other_key_pressed: bool, // Track if any other key was pressed
    }

    impl DoubleCtrlDetector {
        fn new() -> Self {
            Self {
                state: DoubleCtrlState::Idle,
                first_press_time: None,
                last_release_time: None,
                other_key_pressed: false,
            }
        }

        fn reset(&mut self) {
            self.state = DoubleCtrlState::Idle;
            self.first_press_time = None;
            self.last_release_time = None;
            self.other_key_pressed = false;
        }

        fn is_ctrl_key(vk_code: u32) -> bool {
            vk_code == VK_CONTROL || vk_code == VK_LCONTROL || vk_code == VK_RCONTROL
        }

        fn handle_key_event(&mut self, vk_code: u32, is_keydown: bool) -> bool {
            let is_ctrl = Self::is_ctrl_key(vk_code);

            if is_keydown {
                // Key press event
                if is_ctrl {
                    match self.state {
                        DoubleCtrlState::Idle => {
                            // First Ctrl press
                            self.state = DoubleCtrlState::FirstCtrlPressed;
                            self.first_press_time = Some(Instant::now());
                            self.other_key_pressed = false;
                        }
                        DoubleCtrlState::FirstCtrlReleased => {
                            // Check timeout
                            if let Some(release_time) = self.last_release_time {
                                let elapsed = release_time.elapsed();
                                if elapsed.as_millis() <= DOUBLE_CTRL_TIMEOUT_MS as u128
                                    && !self.other_key_pressed
                                {
                                    // Double Ctrl detected!
                                    self.reset();
                                    return true; // Signal that double Ctrl was detected
                                }
                            }
                            // Timeout or interference, reset and start new sequence
                            self.reset();
                            self.state = DoubleCtrlState::FirstCtrlPressed;
                            self.first_press_time = Some(Instant::now());
                            self.other_key_pressed = false;
                        }
                        DoubleCtrlState::FirstCtrlPressed => {
                            // Ctrl still pressed, ignore
                        }
                    }
                } else {
                    // Non-Ctrl key pressed - this is interference
                    if self.state == DoubleCtrlState::FirstCtrlPressed
                        || self.state == DoubleCtrlState::FirstCtrlReleased
                    {
                        self.other_key_pressed = true;
                    }
                }
            } else {
                // Key release event
                if is_ctrl {
                    match self.state {
                        DoubleCtrlState::FirstCtrlPressed => {
                            // First Ctrl released
                            self.state = DoubleCtrlState::FirstCtrlReleased;
                            self.last_release_time = Some(Instant::now());
                        }
                        DoubleCtrlState::FirstCtrlReleased => {
                            // Ctrl released again, but we're already waiting for second press
                            // This might happen if user releases and presses again quickly
                            // Reset timeout
                            self.last_release_time = Some(Instant::now());
                        }
                        DoubleCtrlState::Idle => {
                            // Ignore
                        }
                    }
                }
            }

            // Check timeout for FirstCtrlReleased state
            if self.state == DoubleCtrlState::FirstCtrlReleased {
                if let Some(release_time) = self.last_release_time {
                    let elapsed = release_time.elapsed();
                    if elapsed.as_millis() > DOUBLE_CTRL_TIMEOUT_MS as u128 {
                        // Timeout, reset
                        self.reset();
                    }
                }
            }

            false // No double Ctrl detected yet
        }
    }

    // Global state shared between hook callback and thread
    static HOOK_STATE: OnceLock<Arc<Mutex<HookState>>> = OnceLock::new();

    struct HookState {
        hook_handle: Option<HHOOK>,
        sender: Option<std::sync::mpsc::Sender<()>>,
        detector: DoubleCtrlDetector,
    }

    impl HookState {
        fn new() -> Self {
            Self {
                hook_handle: None,
                sender: None,
                detector: DoubleCtrlDetector::new(),
            }
        }
    }

    // Low-level keyboard hook callback
    unsafe extern "system" fn low_level_keyboard_proc(
        n_code: i32,
        w_param: WPARAM,
        l_param: LPARAM,
    ) -> LRESULT {
        // If n_code is less than zero, we must pass it to CallNextHookEx
        // and return the value returned by CallNextHookEx
        if n_code < 0 {
            return CallNextHookEx(0, n_code, w_param, l_param);
        }

        // Get hook state
        if let Some(state) = HOOK_STATE.get() {
            let mut state_guard = state.lock().unwrap();

            // Extract virtual key code from l_param
            // l_param points to a KBDLLHOOKSTRUCT structure
            let hook_struct_ptr = l_param as *const KBDLLHOOKSTRUCT;
            if hook_struct_ptr.is_null() {
                return CallNextHookEx(0, n_code, w_param, l_param);
            }
            let hook_struct = *hook_struct_ptr;
            let vk_code = hook_struct.vkCode as u32;

            // Determine if this is a keydown or keyup event
            let is_keydown = w_param == WM_KEYDOWN as usize || w_param == WM_SYSKEYDOWN as usize;

            // Process the key event
            let double_ctrl_detected = state_guard.detector.handle_key_event(vk_code, is_keydown);

            if double_ctrl_detected {
                // Send signal through channel
                if let Some(ref sender) = state_guard.sender {
                    let _ = sender.send(());
                }
            }
        }

        // Always call next hook to ensure normal keyboard behavior
        // Use 0 for hhk when we don't have a previous hook handle
        CallNextHookEx(0, n_code, w_param, l_param)
    }

    /// Start the global keyboard hook in a background thread
    /// The hook will detect double Ctrl presses and send a signal through the channel
    pub fn start_hook(
        sender: std::sync::mpsc::Sender<()>,
    ) -> Result<thread::JoinHandle<()>, String> {

        // Initialize global state
        let state = Arc::new(Mutex::new(HookState::new()));
        {
            let mut state_guard = state.lock().unwrap();
            state_guard.sender = Some(sender);
        }

        // Store in global OnceLock
        HOOK_STATE
            .set(state.clone())
            .map_err(|_| "Hook state already initialized".to_string())?;

        // Spawn background thread with message loop
        let handle = thread::spawn(move || {
            unsafe {
                // Install the low-level keyboard hook
                let hook_handle = SetWindowsHookExA(
                    WH_KEYBOARD_LL,
                    Some(low_level_keyboard_proc),
                    0 as HINSTANCE, // NULL - install in current process
                    0,              // dwThreadId = 0 means system-wide hook
                );

                if hook_handle == 0 {
                    eprintln!("Failed to install keyboard hook");
                    return;
                }

                // Store hook handle
                {
                    let mut state_guard = state.lock().unwrap();
                    state_guard.hook_handle = Some(hook_handle);
                }

                eprintln!("Keyboard hook installed successfully");

                // Message loop - required for low-level hooks to work
                let mut msg = MSG {
                    hwnd: 0,
                    message: 0,
                    wParam: 0,
                    lParam: 0,
                    time: 0,
                    pt: windows_sys::Win32::Foundation::POINT { x: 0, y: 0 },
                };

                loop {
                    // GetMessage with NULL hwnd to receive messages for all windows in the thread
                    let result = GetMessageW(&mut msg, 0, 0, 0);

                    if result == 0 {
                        // WM_QUIT
                        break;
                    }

                    if result == -1 {
                        // Error
                        eprintln!("GetMessage error in keyboard hook thread");
                        break;
                    }

                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }

                // Cleanup: Unhook the keyboard hook
                if let Some(state) = HOOK_STATE.get() {
                    let state_guard = state.lock().unwrap();
                    if let Some(hook) = state_guard.hook_handle {
                        unsafe {
                            if UnhookWindowsHookEx(hook) == 0 {
                                eprintln!("Failed to unhook keyboard hook");
                            } else {
                                eprintln!("Keyboard hook uninstalled successfully");
                            }
                        }
                    }
                }
            }
        });

        Ok(handle)
    }

    /// Stop the keyboard hook (cleanup)
    pub fn stop_hook() -> Result<(), String> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{PostQuitMessage, UnhookWindowsHookEx};

        if let Some(state) = HOOK_STATE.get() {
            let state_guard = state.lock().unwrap();
            if let Some(hook) = state_guard.hook_handle {
                unsafe {
                    if UnhookWindowsHookEx(hook) == 0 {
                        return Err("Failed to unhook keyboard hook".to_string());
                    }
                }
            }
        }

        // Post quit message to the message loop
        // Note: This needs to be called from the thread that owns the message loop
        // For now, we'll just unhook and let the thread exit naturally
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
pub mod windows {
    use std::sync::mpsc;
    use std::thread;

    pub fn start_hook(
        _sender: mpsc::Sender<()>,
    ) -> Result<thread::JoinHandle<()>, String> {
        Err("Keyboard hook is only supported on Windows".to_string())
    }

    pub fn stop_hook() -> Result<(), String> {
        Err("Keyboard hook is only supported on Windows".to_string())
    }
}

