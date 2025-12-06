import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { executePlugin } from "../plugins";
import type { PluginContext } from "../types";
import { tauriApi } from "../api/tauri";
import { AppCenterContent } from "./AppCenterContent";

export function PluginListWindow() {
  const handleClose = async () => {
    const window = getCurrentWindow();
    await window.close();
  };

  // 处理插件点击
  const isClosingRef = useRef(false);
  
  const handlePluginClick = async (pluginId: string) => {
    if (isClosingRef.current) return; // 防止重复点击
    
    try {
      isClosingRef.current = true;
      
      // 创建插件上下文（在插件列表窗口中，大多数上下文函数不需要，使用空函数即可）
      const pluginContext: PluginContext = {
        setQuery: () => {},
        setSelectedIndex: () => {},
        hideLauncher: async () => {
          await handleClose();
        },
        tauriApi,
      };

      // 执行插件
      await executePlugin(pluginId, pluginContext);

      // 执行完成后关闭插件列表窗口（如果插件没有关闭它）
      try {
        await handleClose();
      } catch (error) {
        // 如果窗口已经关闭，忽略错误
        // This is expected if hideLauncher already closed it
      }
    } catch (error) {
      console.error("Failed to execute plugin:", error);
      isClosingRef.current = false; // 出错时重置，允许重试
    }
  };

  // ESC 键处理
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.keyCode === 27) {
        e.preventDefault();
        e.stopPropagation();
        await handleClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col bg-gray-50">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-200 bg-white flex-shrink-0">
        <h2 className="text-lg font-semibold text-gray-800">应用中心</h2>
        <button
          onClick={handleClose}
          className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded transition-colors"
        >
          关闭
        </button>
      </div>

      {/* Main Content */}
      <AppCenterContent onPluginClick={handlePluginClick} onClose={handleClose} />
    </div>
  );
}

