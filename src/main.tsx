import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import RecordingApp from "./RecordingApp";
import LauncherApp from "./LauncherApp";
import ShortcutsConfigApp from "./ShortcutsConfigApp";
import MemoApp from "./MemoApp";
import PluginListApp from "./PluginListApp";
import SettingsApp from "./SettingsApp";
import JsonFormatterApp from "./JsonFormatterApp";
import FileToolboxApp from "./FileToolboxApp";
import HotkeySettingsApp from "./HotkeySettingsApp";
import CalculatorPadApp from "./CalculatorPadApp";
import EverythingSearchApp from "./EverythingSearchApp";
import TranslationApp from "./TranslationApp";
import { HexConverterApp } from "./HexConverterApp";
import { ColorPickerApp } from "./ColorPickerApp";
import ClipboardApp from "./ClipboardApp";
import { initializePlugins } from "./plugins";
import { trackEvent } from "./api/events";
import "./styles.css";

// Determine which app to render based on window label
async function initApp() {
  console.log("[初始化] 开始初始化应用...");
  
  const root = document.getElementById("root");
  if (!root) {
    console.error("[初始化] Root 元素未找到!");
    return;
  }
  console.log("[初始化] Root 元素已找到");
  
  // 获取窗口标签（只获取一次）
  let label: string;
  try {
    const window = getCurrentWindow();
    label = window.label;
    console.log("[初始化] 窗口标签:", label);
  } catch (error: unknown) {
    console.error("[初始化] 获取窗口标签失败:", error);
    // Fallback to launcher
    label = "launcher";
  }

  trackEvent("app_started", { window_label: label });
  
  // 初始化插件系统（仅在 launcher 窗口初始化）
  // 注意：不等待插件初始化完成，避免阻塞渲染
  if (label === "launcher") {
    console.log("[初始化] 检测到 launcher 窗口，将在后台初始化插件系统...");
    // 在后台初始化插件，不阻塞渲染
    initializePlugins().catch((error) => {
      console.error("[初始化] 插件初始化失败:", error);
      // 继续渲染，使用后备插件
    });
  }
  
  // 根据窗口标签渲染对应的应用
  try {
    console.log("[初始化] 开始渲染应用，窗口标签:", label);
    
    if (label === "launcher") {
      ReactDOM.createRoot(root).render(
        <StrictMode>
          <LauncherApp />
        </StrictMode>
      );
      console.log("[初始化] LauncherApp 已渲染");
    } else if (label === "shortcuts-config") {
      ReactDOM.createRoot(root).render(
        <StrictMode>
          <ShortcutsConfigApp />
        </StrictMode>
      );
      console.log("[初始化] ShortcutsConfigApp 已渲染");
    } else if (label === "memo-window") {
      ReactDOM.createRoot(root).render(
        <StrictMode>
          <MemoApp />
        </StrictMode>
      );
      console.log("[初始化] MemoApp 已渲染");
    } else if (label === "plugin-list-window") {
      ReactDOM.createRoot(root).render(
        <StrictMode>
          <PluginListApp />
        </StrictMode>
      );
      console.log("[初始化] PluginListApp 已渲染");
    } else if (label === "settings") {
      ReactDOM.createRoot(root).render(
        <StrictMode>
          <SettingsApp />
        </StrictMode>
      );
      console.log("[初始化] SettingsApp 已渲染");
    } else if (label === "json-formatter-window") {
      ReactDOM.createRoot(root).render(
        <StrictMode>
          <JsonFormatterApp />
        </StrictMode>
      );
      console.log("[初始化] JsonFormatterApp 已渲染");
    } else if (label === "file-toolbox-window") {
      ReactDOM.createRoot(root).render(
        <StrictMode>
          <FileToolboxApp />
        </StrictMode>
      );
      console.log("[初始化] FileToolboxApp 已渲染");
    } else if (label === "hotkey-settings") {
      ReactDOM.createRoot(root).render(
        <StrictMode>
          <HotkeySettingsApp />
        </StrictMode>
      );
      console.log("[初始化] HotkeySettingsApp 已渲染");
    } else if (label === "calculator-pad-window") {
      ReactDOM.createRoot(root).render(
        <StrictMode>
          <CalculatorPadApp />
        </StrictMode>
      );
      console.log("[初始化] CalculatorPadApp 已渲染");
    } else if (label === "everything-search-window") {
      ReactDOM.createRoot(root).render(
        <StrictMode>
          <EverythingSearchApp />
        </StrictMode>
      );
      console.log("[初始化] EverythingSearchApp 已渲染");
    } else if (label === "translation-window") {
      ReactDOM.createRoot(root).render(
        <StrictMode>
          <TranslationApp />
        </StrictMode>
      );
      console.log("[初始化] TranslationApp 已渲染");
    } else if (label === "hex-converter-window") {
      ReactDOM.createRoot(root).render(
        <StrictMode>
          <HexConverterApp />
        </StrictMode>
      );
      console.log("[初始化] HexConverterApp 已渲染");
    } else if (label === "color-picker-window") {
      ReactDOM.createRoot(root).render(
        <StrictMode>
          <ColorPickerApp />
        </StrictMode>
      );
      console.log("[初始化] ColorPickerApp 已渲染");
    } else if (label === "clipboard") {
      ReactDOM.createRoot(root).render(
        <StrictMode>
          <ClipboardApp />
        </StrictMode>
      );
      console.log("[初始化] ClipboardApp 已渲染");
    } else if (label === "recording-window" || label === "main") {
      ReactDOM.createRoot(root).render(
        <StrictMode>
          <RecordingApp />
        </StrictMode>
      );
      console.log("[初始化] RecordingApp 已渲染");
    } else {
      // 未知的窗口标签，显示错误信息
      console.error(`[初始化] 未知的窗口标签: ${label}`);
      ReactDOM.createRoot(root).render(
        <StrictMode>
          <div className="flex flex-col items-center justify-center h-screen bg-gray-50">
            <div className="text-center p-8 bg-white rounded-lg shadow-lg max-w-md">
              <div className="text-6xl mb-4">⚠️</div>
              <h1 className="text-xl font-bold text-red-600 mb-2">窗口加载失败</h1>
              <p className="text-gray-600 mb-4">未知的窗口标签: <code className="bg-gray-100 px-2 py-1 rounded">{label}</code></p>
              <p className="text-sm text-gray-500">请检查控制台获取更多信息</p>
            </div>
          </div>
        </StrictMode>
      );
    }
  } catch (error: unknown) {
    console.error("[初始化] 渲染应用失败:", error);
    // Fallback to launcher app with error display
    root.innerHTML = `
      <div style="
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        min-height: 80px;
        background-color: rgba(255, 255, 255, 0.95);
        color: #333;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        padding: 20px;
        box-sizing: border-box;
      ">
        <div style="font-size: 16px; font-weight: 600; margin-bottom: 10px;">应用渲染失败</div>
        <div style="font-size: 12px; color: #666; text-align: center;">
          ${error instanceof Error ? error.message : String(error)}
        </div>
        <div style="font-size: 11px; color: #999; margin-top: 20px;">
          窗口标签: ${label || "未知"}<br/>
          请检查控制台获取更多信息
        </div>
      </div>
    `;
    throw error; // 重新抛出以便外部错误处理
  }
}

// Initialize app (now async)
initApp().catch((error) => {
  console.error("Failed to initialize app:", error);
  // 即使初始化失败，也尝试渲染一个错误界面
  const root = document.getElementById("root");
  if (root) {
    root.innerHTML = `
      <div style="
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        min-height: 80px;
        background-color: rgba(255, 255, 255, 0.95);
        color: #333;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        padding: 20px;
        box-sizing: border-box;
      ">
        <div style="font-size: 16px; font-weight: 600; margin-bottom: 10px;">应用加载失败</div>
        <div style="font-size: 12px; color: #666; text-align: center;">
          ${error instanceof Error ? error.message : String(error)}
        </div>
        <div style="font-size: 11px; color: #999; margin-top: 20px;">
          请检查控制台获取更多信息
        </div>
      </div>
    `;
  }
});
