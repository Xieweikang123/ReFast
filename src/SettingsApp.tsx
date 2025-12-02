import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import { tauriApi } from "./api/tauri";
import "./styles.css";

interface Settings {
  ollama: {
    model: string;
    base_url: string;
  };
}

function SettingsApp() {
  const [settings, setSettings] = useState<Settings>({
    ollama: {
      model: "llama2",
      base_url: "http://localhost:11434",
    },
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const loadSettings = async () => {
    try {
      setIsLoading(true);
      const data = await tauriApi.getSettings();
      setSettings(data);
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
    
    try {
      const baseUrl = settings.ollama.base_url || 'http://localhost:11434';
      const model = settings.ollama.model || 'llama2';
      
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
          const errorText = await generateResponse.text();
          throw new Error(`API 请求失败: ${generateResponse.status} ${generateResponse.statusText}`);
        }

        const data = await generateResponse.json();
        setTestResult({
          success: true,
          message: `连接成功！模型 "${model}" 可用。`,
        });
      } else {
        const data = await response.json();
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

  return (
    <div className="h-screen w-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
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

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* Ollama Settings */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">Ollama 配置</h2>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                模型名称
              </label>
              <input
                type="text"
                value={settings.ollama.model}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    ollama: { ...settings.ollama, model: e.target.value },
                  })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="例如: llama2, mistral, codellama"
              />
              <p className="mt-1 text-xs text-gray-500">
                输入已安装的 Ollama 模型名称
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                API 地址
              </label>
              <input
                type="text"
                value={settings.ollama.base_url}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    ollama: { ...settings.ollama, base_url: e.target.value },
                  })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="http://localhost:11434"
              />
              <p className="mt-1 text-xs text-gray-500">
                Ollama API 服务地址
              </p>
            </div>

            <div className="pt-2">
              <button
                onClick={testConnection}
                disabled={isTesting || !settings.ollama.model.trim() || !settings.ollama.base_url.trim()}
                className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors text-sm"
              >
                {isTesting ? "测试中..." : "测试连接"}
              </button>
              {testResult && (
                <div className={`mt-2 p-2 rounded-md text-sm ${
                  testResult.success 
                    ? "bg-green-50 text-green-700 border border-green-200" 
                    : "bg-red-50 text-red-700 border border-red-200"
                }`}>
                  {testResult.message}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="bg-white border-t border-gray-200 px-6 py-4 flex items-center justify-between">
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

