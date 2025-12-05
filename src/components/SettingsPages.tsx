import { tauriApi } from "../api/tauri";
import { useEffect, useState } from "react";

const handleCheckUpdate = async () => {
  try {
    await tauriApi.openUrl("https://github.com/Xieweikang123/ReFast/releases");
  } catch (error) {
    console.error("Failed to open update page:", error);
    alert("打开更新页面失败");
  }
};

interface OllamaSettingsProps {
  settings: {
    ollama: {
      model: string;
      base_url: string;
    };
  };
  onSettingsChange: (settings: any) => void;
  isTesting: boolean;
  testResult: { success: boolean; message: string } | null;
  onTestConnection: () => void;
}

export function OllamaSettingsPage({
  settings,
  onSettingsChange,
  isTesting,
  testResult,
  onTestConnection,
}: OllamaSettingsProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-800 mb-2">Ollama 配置</h2>
        <p className="text-sm text-gray-500">配置 Ollama AI 模型和 API 服务地址</p>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              模型名称
            </label>
            <input
              type="text"
              value={settings.ollama.model}
              onChange={(e) =>
                onSettingsChange({
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
                onSettingsChange({
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
              onClick={onTestConnection}
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
  );
}

interface SystemSettingsProps {
  settings: {
    startup_enabled?: boolean;
  };
  onSettingsChange: (settings: any) => void;
  onOpenHotkeySettings: () => void;
}

export function SystemSettingsPage({
  settings,
  onSettingsChange,
  onOpenHotkeySettings,
}: SystemSettingsProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-800 mb-2">系统设置</h2>
        <p className="text-sm text-gray-500">配置应用程序的系统级设置</p>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                开机启动
              </label>
              <p className="text-xs text-gray-500">
                开机时自动启动应用程序
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={settings.startup_enabled || false}
                onChange={(e) =>
                  onSettingsChange({
                    ...settings,
                    startup_enabled: e.target.checked,
                  })
                }
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>
          
          <div className="border-t border-gray-200 pt-6">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  快捷键设置
                </label>
                <p className="text-xs text-gray-500">
                  设置全局快捷键来打开启动器
                </p>
              </div>
              <button
                onClick={onOpenHotkeySettings}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors text-sm"
              >
                设置快捷键
              </button>
            </div>
          </div>

          <div className="border-t border-gray-200 pt-6">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  检查更新
                </label>
                <p className="text-xs text-gray-500">
                  前往 GitHub 查看最新版本
                </p>
              </div>
              <button
                onClick={handleCheckUpdate}
                className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors text-sm"
              >
                检查更新
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface AboutSettingsProps {}

export function AboutSettingsPage({}: AboutSettingsProps) {
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    const loadVersion = async () => {
      try {
        const v = await tauriApi.getAppVersion();
        setVersion(v);
      } catch (error) {
        console.error("Failed to load version:", error);
        setVersion("未知");
      }
    };
    loadVersion();
  }, []);

  const handleOpenGitHub = async () => {
    try {
      await tauriApi.openUrl("https://github.com/Xieweikang123/ReFast");
    } catch (error) {
      console.error("Failed to open GitHub:", error);
      alert("打开 GitHub 页面失败");
    }
  };

  const handleOpenReleases = async () => {
    try {
      await tauriApi.openUrl("https://github.com/Xieweikang123/ReFast/releases");
    } catch (error) {
      console.error("Failed to open releases page:", error);
      alert("打开更新页面失败");
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-800 mb-2">关于 ReFast</h2>
        <p className="text-sm text-gray-500">应用信息和版本</p>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="space-y-6">
          <div className="text-center">
            <div className="text-4xl font-bold text-blue-600 mb-2">ReFast</div>
            <p className="text-gray-600 mb-4">一个快速启动器和输入宏录制工具</p>
            <div className="text-sm text-gray-500">
              版本: <span className="font-semibold text-gray-700">{version}</span>
            </div>
          </div>

          <div className="border-t border-gray-200 pt-6">
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-2">项目信息</h3>
                <p className="text-sm text-gray-600 mb-4">
                  ReFast 是一个基于 Tauri 2 开发的 Windows 快速启动器，提供快速应用启动、文件搜索、宏录制等功能。
                </p>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={handleOpenGitHub}
                  className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 transition-colors text-sm"
                >
                  GitHub 主页
                </button>
                <button
                  onClick={handleOpenReleases}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors text-sm"
                >
                  检查更新
                </button>
              </div>
            </div>
          </div>

          <div className="border-t border-gray-200 pt-6">
            <div className="text-xs text-gray-500 text-center">
              <p>© 2024 ReFast</p>
              <p className="mt-1">MIT License</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

