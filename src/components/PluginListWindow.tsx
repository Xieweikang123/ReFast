import { useEffect } from "react";
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
  const handlePluginClick = async (pluginId: string) => {
    try {
      // 创建插件上下文（在应用中心窗口中，hideLauncher 不关闭应用中心窗口）
      const pluginContext: PluginContext = {
        setQuery: () => {},
        setSelectedIndex: () => {},
        hideLauncher: async () => {
          // 在应用中心窗口中，不关闭窗口，只作为空操作
          // 这样插件可以正常执行，但不会关闭应用中心
        },
        tauriApi,
      };

      // 执行插件
      await executePlugin(pluginId, pluginContext);
      
      // 不自动关闭应用中心窗口，让用户可以继续使用
    } catch (error) {
      console.error("Failed to execute plugin:", error);
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

