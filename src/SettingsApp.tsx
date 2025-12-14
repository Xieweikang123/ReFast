import { useEffect, useState, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import { tauriApi } from "./api/tauri";
import { OllamaSettingsPage, SystemSettingsPage, AboutSettingsPage } from "./components/SettingsPages";
import "./styles.css";

interface Settings {
  ollama: {
    model: string;
    base_url: string;
  };
  startup_enabled?: boolean;
  result_style?: "compact" | "soft" | "skeuomorphic";
  close_on_blur?: boolean;
  auto_check_update?: boolean;
}

type SettingsPage = "ollama" | "system" | "about";

function SettingsApp() {
  const [activePage, setActivePage] = useState<SettingsPage>("system");
  const [settings, setSettings] = useState<Settings>({
    ollama: {
      model: "llama2",
      base_url: "http://localhost:11434",
    },
    startup_enabled: false,
    result_style: "skeuomorphic",
    close_on_blur: true,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const hasLoadedSettingsRef = useRef(false);

  const loadSettings = async () => {
    try {
      setIsLoading(true);
      hasLoadedSettingsRef.current = false; // 重置标志，避免加载时触发自动保存
      const data = await tauriApi.getSettings();
      // 同步开机启动状态
      const startupEnabled = await tauriApi.isStartupEnabled();
      setSettings({
        ...data,
        startup_enabled: startupEnabled,
        result_style: data.result_style || "skeuomorphic",
        close_on_blur: data.close_on_blur ?? true,
        auto_check_update: data.auto_check_update ?? true,
      });
    } catch (error) {
      console.error("Failed to load settings:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const saveSettings = async () => {
    try {
      setIsSaving(true);
      setSaveMessage(null);
      await tauriApi.saveSettings(settings);
      // 保存开机启动设置
      if (settings.startup_enabled !== undefined) {
        await tauriApi.setStartupEnabled(settings.startup_enabled);
      }
      setSaveMessage("设置已保存");
      setTimeout(() => setSaveMessage(null), 2000);
      
      // 发送设置更新事件，通知其他窗口
      await emit("settings:updated", {});
    } catch (error) {
      console.error("Failed to save settings:", error);
      setSaveMessage("保存失败");
      setTimeout(() => setSaveMessage(null), 2000);
    } finally {
      setIsSaving(false);
    }
  };

  const testConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    
    const baseUrl = settings.ollama.base_url || 'http://localhost:11434';
    const model = settings.ollama.model || 'llama2';

    try {
      // 尝试使用 chat API 测试连接
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model,
          messages: [
            {
              role: 'user',
              content: '你好',
            },
          ],
          stream: false,
        }),
      });

      if (!response.ok) {
        // 如果 chat API 失败，尝试使用 generate API
        const generateResponse = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: model,
            prompt: '你好',
            stream: false,
          }),
        });

        if (!generateResponse.ok) {
          throw new Error(`API 请求失败: ${generateResponse.status} ${generateResponse.statusText}`);
        }

        await generateResponse.json();
        setTestResult({
          success: true,
          message: `连接成功！模型 "${model}" 可用。`,
        });
      } else {
        await response.json();
        setTestResult({
          success: true,
          message: `连接成功！模型 "${model}" 可用。`,
        });
      }
    } catch (error: any) {
      console.error('测试连接失败:', error);
      const errorMessage = error.message || '未知错误';
      setTestResult({
        success: false,
        message: `连接失败: ${errorMessage}`,
      });
    } finally {
      setIsTesting(false);
    }
  };

  useEffect(() => {
    loadSettings();

    // 监听刷新事件
    const unlisten = listen("settings:refresh", () => {
      loadSettings();
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 设置变更自动保存（防抖处理）
  useEffect(() => {
    if (isLoading) return;

    if (!hasLoadedSettingsRef.current) {
      hasLoadedSettingsRef.current = true;
      return;
    }

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = window.setTimeout(() => {
      saveSettings();
    }, 400);

    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [settings, isLoading]);

  // 卸载时清理定时器
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  const handleClose = async () => {
    try {
      const window = getCurrentWindow();
      await window.close();
    } catch (error) {
      console.error("Failed to close window:", error);
    }
  };

  if (isLoading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-600">加载中...</div>
      </div>
    );
  }

  const handleOpenHotkeySettings = async () => {
    try {
      await tauriApi.showHotkeySettings();
    } catch (error) {
      console.error("Failed to open hotkey settings:", error);
      alert("打开快捷键设置失败");
    }
  };

  const menuItems = [
    { id: "system" as SettingsPage, label: "系统设置", icon: "⚙️" },
    { id: "ollama" as SettingsPage, label: "Ollama 配置", icon: "🤖" },
    { id: "about" as SettingsPage, label: "关于", icon: "ℹ️" },
  ];

  return (
    <div className="h-screen w-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between flex-shrink-0">
        <h1 className="text-xl font-semibold text-gray-800">设置</h1>
        <button
          onClick={handleClose}
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

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar Navigation */}
        <div className="w-48 bg-white border-r border-gray-200 flex-shrink-0 overflow-y-auto">
          <nav className="p-4">
            <ul className="space-y-1">
              {menuItems.map((item) => (
                <li key={item.id}>
                  <button
                    onClick={() => setActivePage(item.id)}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-colors ${
                      activePage === item.id
                        ? "bg-blue-50 text-blue-700 font-medium"
                        : "text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    <span className="text-lg">{item.icon}</span>
                    <span className="text-sm">{item.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto bg-gray-50">
          <div className="p-6 max-w-4xl">
            {activePage === "ollama" && (
              <OllamaSettingsPage
                settings={settings}
                onSettingsChange={setSettings}
                isTesting={isTesting}
                testResult={testResult}
                onTestConnection={testConnection}
              />
            )}
            {activePage === "system" && (
              <SystemSettingsPage
                settings={settings}
                onSettingsChange={setSettings}
                onOpenHotkeySettings={handleOpenHotkeySettings}
              />
            )}
            {activePage === "about" && (
              <AboutSettingsPage />
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="bg-white border-t border-gray-200 px-6 py-4 flex items-center justify-between flex-shrink-0">
        <div className="text-sm text-gray-600">
          {saveMessage && (
            <span className={saveMessage === "设置已保存" ? "text-green-600" : "text-red-600"}>
              {saveMessage}
            </span>
          )}
        </div>
        <button
          onClick={saveSettings}
          disabled={isSaving}
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
        >
          {isSaving ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}

export default SettingsApp;

