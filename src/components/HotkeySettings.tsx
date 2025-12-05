import { useState, useEffect, useRef } from "react";
import { tauriApi } from "../api/tauri";

interface HotkeySettingsProps {
  onClose: () => void;
}

interface HotkeyConfig {
  modifiers: string[];
  key: string;
}

export function HotkeySettings({ onClose }: HotkeySettingsProps) {
  const [hotkey, setHotkey] = useState<HotkeyConfig>({ modifiers: ["Alt"], key: "Space" });
  const [isRecording, setIsRecording] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [currentKeys, setCurrentKeys] = useState<string[]>([]);
  const recordingRef = useRef(false);
  const lastModifierRef = useRef<string | null>(null);
  const lastModifierTimeRef = useRef<number>(0);
  const isCompletingRef = useRef(false); // 标记是否正在完成录制，防止重复处理
  const finalKeysRef = useRef<string[] | null>(null); // 存储最终应该显示的按键，一旦设置就不再更新

  useEffect(() => {
    loadHotkey();
  }, []);

  // 打印当前快捷键（用于调试）
  useEffect(() => {
    const mods = hotkey.modifiers.join(" + ");
    const formatted = `${mods} + ${hotkey.key}`;
    console.log("当前快捷键:", formatted);
    console.log("快捷键配置对象:", hotkey);
    console.log("修饰键数组:", hotkey.modifiers);
    console.log("按键:", hotkey.key);
    console.log("修饰键数量:", hotkey.modifiers.length);
  }, [hotkey]);

  const loadHotkey = async () => {
    try {
      const config = await tauriApi.getHotkeyConfig();
      if (config) {
        setHotkey(config);
      }
    } catch (error) {
      console.error("Failed to load hotkey config:", error);
    }
  };

  const formatHotkey = (config: HotkeyConfig): string => {
    const mods = config.modifiers.join(" + ");
    
    // 【修复显示问题】对于重复修饰键（如 Ctrl+Ctrl），key 本身就是修饰键，不需要再拼接
    // 检查是否是重复修饰键：modifiers 长度为 2 且两个元素相同，且 key 也相同
    if (config.modifiers.length === 2 && 
        config.modifiers[0] === config.modifiers[1] && 
        config.modifiers[0] === config.key) {
      return mods; // 只返回 modifiers，不拼接 key
    }
    
    return `${mods} + ${config.key}`;
  };

  const startRecording = () => {
    setIsRecording(true);
    recordingRef.current = true;
    setCurrentKeys([]);
    finalKeysRef.current = null; // 重置最终按键
  };

  const stopRecording = () => {
    setIsRecording(false);
    recordingRef.current = false;
    setCurrentKeys([]);
    lastModifierRef.current = null;
    lastModifierTimeRef.current = 0;
    isCompletingRef.current = false;
    finalKeysRef.current = null; // 重置最终按键
  };

  useEffect(() => {
    if (!isRecording) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // 【顶层防御】如果已经停止录制、正在完成录制、或是重复触发，直接拦截
      if (!recordingRef.current || isCompletingRef.current || e.repeat) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation(); // 增强拦截能力
        return;
      }
      
      // 【关键修复】如果 finalKeysRef 已设置，说明已经完成双击，立即拦截所有后续事件
      if (finalKeysRef.current) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }

      // 排除修饰键本身
      const keyMap: Record<string, string> = {
        "Control": "Ctrl",
        "Alt": "Alt",
        "Shift": "Shift",
        "Meta": "Meta",
      };

      let key = e.key;
      
      // 如果是修饰键，检测是否重复按下
      if (keyMap[key]) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation(); // 增强拦截能力
        
        const mappedKey = keyMap[key];
        const now = Date.now();
        
        // 【关键修复】双击检测逻辑前置！在更新任何状态之前先判断
        const isSameModifier = lastModifierRef.current === mappedKey;
        const hasPreviousPress = lastModifierTimeRef.current > 0;
        const timeSinceLastPress = hasPreviousPress ? now - lastModifierTimeRef.current : Infinity;
        const isDoubleTapTime = timeSinceLastPress < 500; // 缩短到 500ms，避免误触
        
        // 检测到双击：立即锁定并强制覆写状态
        if (isSameModifier && hasPreviousPress && isDoubleTapTime) {
          console.log(`✅ 检测到重复修饰键: ${mappedKey}, 时间差: ${timeSinceLastPress}ms`);
          
          // 立即锁定，防止后续事件处理（必须在最前面）
          isCompletingRef.current = true;
          recordingRef.current = false;
          
          // 【核心修复】使用 ref 锁定最终显示的按键，防止后续事件覆盖
          const finalModifiers: string[] = [mappedKey, mappedKey]; // 直接定死为两个
          finalKeysRef.current = finalModifiers; // 立即锁定，后续事件无法覆盖
          
          const newHotkey: HotkeyConfig = {
            modifiers: finalModifiers,
            key: mappedKey,
          };
          
          // 立即重置时间戳，防止后续事件被误判（在状态更新之前）
          lastModifierRef.current = null;
          lastModifierTimeRef.current = 0;
          
          // 强制覆写显示和状态
          setCurrentKeys(finalModifiers); // 直接设置，不使用 [...prev, key]
          setHotkey(newHotkey);
          setIsRecording(false);
          
          // 立即移除事件监听器，防止后续事件进入
          window.removeEventListener("keydown", handleKeyDown, true);
          window.removeEventListener("keyup", handleKeyUp, true);
          
          // 延迟解锁（防止后续余震）
          setTimeout(() => {
            isCompletingRef.current = false;
          }, 300);
          
          return; // 立即返回，不再执行后续任何逻辑
        }
        
        // 普通按键处理：第一次按下、不同修饰键、或超过时间窗口
        // 【关键】如果 finalKeysRef 已设置，说明已经完成双击，不再更新
        if (finalKeysRef.current) {
          const lockedKeys: string[] = finalKeysRef.current;
          console.log(`⚠️ 已锁定最终按键，忽略后续事件: ${lockedKeys.join(" + ")}`);
          return;
        }
        
        if (!hasPreviousPress || !isSameModifier || timeSinceLastPress >= 500) {
          // 第一次按下、不同的修饰键、或超过时间窗口，重置为新的按下
          if (!hasPreviousPress) {
            console.log(`记录修饰键: ${mappedKey} (第一次按下)`);
          } else if (!isSameModifier) {
            console.log(`记录修饰键: ${mappedKey} (之前: ${lastModifierRef.current})`);
          } else {
            console.log(`记录修饰键: ${mappedKey} (时间差: ${timeSinceLastPress}ms，超过窗口)`);
          }
          
          lastModifierRef.current = mappedKey;
          lastModifierTimeRef.current = now;
          // 更新显示为单个修饰键
          setCurrentKeys([mappedKey]);
        }
        
        return;
      }
      
      // 如果不是修饰键，重置重复检测
      lastModifierRef.current = null;
      lastModifierTimeRef.current = 0;
      
      e.preventDefault();
      e.stopPropagation();

      // 收集修饰键（排除当前按下的键本身）
      const modifiers: string[] = [];
      if (e.ctrlKey) modifiers.push("Ctrl");
      if (e.altKey) modifiers.push("Alt");
      if (e.shiftKey) modifiers.push("Shift");
      if (e.metaKey) modifiers.push("Meta");

      // 处理特殊键名
      if (key === " ") key = "Space";
      if (key.length === 1) key = key.toUpperCase();

      // 验证快捷键必须包含至少一个修饰键
      if (modifiers.length === 0) {
        setCurrentKeys([key]);
        return; // 不完成录制，等待用户按下修饰键
      }

      const newHotkey: HotkeyConfig = {
        modifiers: modifiers,
        key: key,
      };

      setHotkey(newHotkey);
      setCurrentKeys([...modifiers, key]);
      setIsRecording(false);
      recordingRef.current = false;
    };

    const handleKeyUp = () => {
      if (!recordingRef.current) return;
      // 可以在这里处理释放逻辑
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
    };
  }, [isRecording]);

  // ESC 键处理
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isRecording) {
        onClose();
      } else if (e.key === "Escape" && isRecording) {
        stopRecording();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isRecording, onClose]);

  const handleSave = async () => {
    try {
      setIsSaving(true);
      setSaveMessage(null);
      await tauriApi.saveHotkeyConfig(hotkey);
      setSaveMessage("快捷键已保存并生效");
      setTimeout(() => setSaveMessage(null), 2000);
    } catch (error) {
      console.error("Failed to save hotkey config:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      setSaveMessage(errorMessage || "保存失败");
      setTimeout(() => setSaveMessage(null), 5000);
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    const defaultHotkey: HotkeyConfig = { modifiers: ["Alt"], key: "Space" };
    setHotkey(defaultHotkey);
    try {
      await tauriApi.saveHotkeyConfig(defaultHotkey);
      setSaveMessage("已重置为默认快捷键");
      setTimeout(() => setSaveMessage(null), 2000);
    } catch (error) {
      console.error("Failed to reset hotkey config:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      setSaveMessage(errorMessage || "重置失败");
      setTimeout(() => setSaveMessage(null), 5000);
    }
  };

  const handleRestart = async () => {
    try {
      await tauriApi.restartApp();
    } catch (error) {
      console.error("Failed to restart app:", error);
      setSaveMessage("重启失败");
      setTimeout(() => setSaveMessage(null), 2000);
    }
  };

  return (
    <div className="h-full w-full flex flex-col bg-white">
      {/* Header */}
      <div className="flex items-center justify-between p-6 border-b border-gray-200 flex-shrink-0">
        <h3 className="text-lg font-semibold text-gray-800">快捷键设置</h3>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-700 transition-colors"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6" style={{ minHeight: 0 }}>
        <div className="max-w-2xl mx-auto space-y-6">
          <div className="bg-gray-50 rounded-lg p-6 border border-gray-200">
            <h4 className="text-sm font-medium text-gray-700 mb-2">当前快捷键</h4>
            <div className="text-2xl font-mono font-semibold text-gray-800 mb-4">
              {formatHotkey(hotkey)}
            </div>
            <p className="text-xs text-gray-500 mb-4">
              此快捷键用于打开/关闭启动器窗口
            </p>
            
            {isRecording && (
              <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-md">
                <p className="text-sm text-yellow-800">
                  正在录制... 请按下您想要设置的快捷键组合
                </p>
                {currentKeys.length > 0 && (
                  <p className="text-xs text-yellow-600 mt-1">
                    已按下: {currentKeys.join(" + ")}
                  </p>
                )}
              </div>
            )}

            <div className="flex gap-3">
              {!isRecording ? (
                <button
                  onClick={startRecording}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                >
                  重新设置
                </button>
              ) : (
                <button
                  onClick={stopRecording}
                  className="px-4 py-2 bg-gray-500 text-white rounded-md hover:bg-gray-600 transition-colors"
                >
                  取消录制
                </button>
              )}
              <button
                onClick={handleReset}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 transition-colors"
              >
                重置为默认 (Alt + Space)
              </button>
            </div>
          </div>

          <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
            <h4 className="text-sm font-medium text-blue-800 mb-2">提示</h4>
            <ul className="text-xs text-blue-700 space-y-1 list-disc list-inside">
              <li>快捷键必须包含至少一个修饰键（Ctrl、Alt、Shift 或 Meta）</li>
              <li>建议使用 Alt 或 Ctrl 作为修饰键，避免与其他应用冲突</li>
              <li>保存后需要重启应用才能生效</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="bg-white border-t border-gray-200 px-6 py-4 flex items-center justify-between flex-shrink-0">
        <div className="text-sm text-gray-600 flex-1">
          {saveMessage && (
            <div className="flex flex-col gap-2">
              <span className={saveMessage.includes("失败") || saveMessage.includes("重启") ? "text-red-600" : "text-green-600"}>
                {saveMessage}
              </span>
              {saveMessage.includes("重启") && (
                <button
                  onClick={handleRestart}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors text-sm w-fit"
                >
                  立即重启
                </button>
              )}
            </div>
          )}
        </div>
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || isRecording}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            {isSaving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

