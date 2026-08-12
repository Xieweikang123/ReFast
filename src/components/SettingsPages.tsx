import { tauriApi } from "../api/tauri";
import { useEffect, useState } from "react";
import { UpdateSection } from "./UpdateSection";
import { ErrorDialog } from "./ErrorDialog";
import type { SearchEngineConfig, BrowserRule, DetectedBrowser } from "../types";

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
  isListingModels: boolean;
  availableModels: string[];
  onListModels: () => void;
}

export function OllamaSettingsPage({
  settings,
  onSettingsChange,
  isTesting,
  testResult,
  onTestConnection,
  isListingModels,
  availableModels,
  onListModels,
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
            <div className="flex gap-2">
              <input
                type="text"
                value={settings.ollama.model}
                onChange={(e) =>
                  onSettingsChange({
                    ...settings,
                    ollama: { ...settings.ollama, model: e.target.value },
                  })
                }
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="例如: llama2, mistral, codellama"
              />
              <button
                onClick={onListModels}
                disabled={isListingModels || !settings.ollama.base_url.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors text-sm whitespace-nowrap"
                title="列出所有可用的模型"
              >
                {isListingModels ? "加载中..." : "列出模型"}
              </button>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              输入已安装的 Ollama 模型名称，或点击"列出模型"自动获取
            </p>
            {availableModels.length > 0 && (
              <div className="mt-2 p-3 bg-blue-50 border border-blue-200 rounded-md">
                <p className="text-xs font-medium text-blue-800 mb-2">可用模型：</p>
                <div className="flex flex-wrap gap-2">
                  {availableModels.map((model) => (
                    <button
                      key={model}
                      onClick={() =>
                        onSettingsChange({
                          ...settings,
                          ollama: { ...settings.ollama, model: model },
                        })
                      }
                      className={`px-2 py-1 text-xs rounded transition-colors ${
                        settings.ollama.model === model
                          ? "bg-blue-600 text-white"
                          : "bg-white text-blue-700 hover:bg-blue-100 border border-blue-300"
                      }`}
                    >
                      {model}
                    </button>
                  ))}
                </div>
              </div>
            )}
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
    result_style?: "compact" | "soft" | "skeuomorphic";
    close_on_blur?: boolean;
    auto_check_update?: boolean;
    clipboard_max_items?: number;
    translation_tab_order?: string[];
  };
  onSettingsChange: (settings: any) => void;
  onOpenHotkeySettings: () => void;
}

export function SystemSettingsPage({
  settings,
  onSettingsChange,
  onOpenHotkeySettings,
}: SystemSettingsProps) {
  const [nextCheckTime, setNextCheckTime] = useState<string>("");

  // 计算下次检查更新的时间
  useEffect(() => {
    const calculateNextCheckTime = () => {
      const lastCheckTimeStr = localStorage.getItem("last_update_check_time");
      if (!lastCheckTimeStr) {
        setNextCheckTime("启动时检查");
        return;
      }

      const lastCheckTime = parseInt(lastCheckTimeStr, 10);
      const nextCheck = lastCheckTime + 24 * 60 * 60 * 1000; // 24小时后
      const now = Date.now();

      if (now >= nextCheck) {
        setNextCheckTime("启动时检查");
      } else {
        const nextCheckDate = new Date(nextCheck);
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // 判断是今天还是明天
        if (nextCheckDate.toDateString() === today.toDateString()) {
          setNextCheckTime(`今天 ${nextCheckDate.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`);
        } else if (nextCheckDate.toDateString() === tomorrow.toDateString()) {
          setNextCheckTime(`明天 ${nextCheckDate.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`);
        } else {
          setNextCheckTime(nextCheckDate.toLocaleString("zh-CN", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }));
        }
      }
    };

    calculateNextCheckTime();
    
    // 每分钟更新一次
    const interval = setInterval(calculateNextCheckTime, 60000);
    
    return () => clearInterval(interval);
  }, []);

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
                搜索结果风格
              </label>
              <p className="text-xs text-gray-500">
                在线性（紧凑）、渐变卡片与拟物风之间切换
              </p>
            </div>
            <select
              value={settings.result_style || "compact"}
              onChange={(e) =>
                onSettingsChange({
                  ...settings,
                  result_style: e.target.value as "compact" | "soft" | "skeuomorphic",
                })
              }
              className="px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
            >
              <option value="compact">紧凑线性</option>
              <option value="soft">渐变卡片</option>
              <option value="skeuomorphic">拟物风</option>
            </select>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                失焦自动关闭启动器
              </label>
              <p className="text-xs text-gray-500">
                当窗口失去焦点时自动隐藏启动器（默认开启）
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={settings.close_on_blur ?? true}
                onChange={(e) =>
                  onSettingsChange({
                    ...settings,
                    close_on_blur: e.target.checked,
                  })
                }
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>

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
                  自动检查更新
                </label>
                <p className="text-xs text-gray-500 mb-1">
                  启动时自动检查是否有新版本（每 24 小时检查一次）
                </p>
                {settings.auto_check_update !== false && nextCheckTime && (
                  <p className="text-xs text-blue-600 font-medium flex items-center gap-1">
                    <span>🕐</span>
                    <span>下次检查：{nextCheckTime}</span>
                  </p>
                )}
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.auto_check_update ?? true}
                  onChange={(e) =>
                    onSettingsChange({
                      ...settings,
                      auto_check_update: e.target.checked,
                    })
                  }
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

interface LauncherSettingsProps {
  settings: {
    search_engines?: SearchEngineConfig[];
  };
  onSettingsChange: (settings: any) => void;
}

const BROWSER_OPTIONS = [
  { value: "default", label: "系统默认浏览器" },
  { value: "edge", label: "Microsoft Edge" },
  { value: "chrome", label: "Google Chrome" },
  { value: "firefox", label: "Mozilla Firefox" },
];

const CUSTOM_BROWSER_VALUE = "__custom__";

interface BrowserRulesSettingsProps {
  settings: {
    browser_rules?: BrowserRule[];
  };
  onSettingsChange: (settings: any) => void;
}

export function BrowserRulesSettingsPage({
  settings,
  onSettingsChange,
}: BrowserRulesSettingsProps) {
  const [browserRules, setBrowserRules] = useState<BrowserRule[]>(
    settings.browser_rules || []
  );
  const [detectedBrowsers, setDetectedBrowsers] = useState<DetectedBrowser[]>([]);
  const [errorDialog, setErrorDialog] = useState<{
    isOpen: boolean;
    type: "error" | "success" | "warning" | "info";
    message: string;
  }>({
    isOpen: false,
    type: "error",
    message: "",
  });
  const [saveSuccessMessage, setSaveSuccessMessage] = useState<string | null>(null);

  // 当外部设置更新时同步
  useEffect(() => {
    if (settings.browser_rules) {
      setBrowserRules(settings.browser_rules);
    }
  }, [settings.browser_rules]);

  // 检测本机已安装的浏览器
  useEffect(() => {
    tauriApi
      .detectBrowsers()
      .then((browsers) => setDetectedBrowsers(browsers))
      .catch((error) => console.error("检测浏览器失败:", error));
  }, []);

  const handleAddRule = () => {
    setBrowserRules([
      ...browserRules,
      { pattern: "", browser: "default", enabled: true },
    ]);
  };

  const handleUpdateRule = (
    index: number,
    field: keyof BrowserRule,
    value: string | boolean
  ) => {
    const updated = [...browserRules];
    updated[index] = { ...updated[index], [field]: value };
    setBrowserRules(updated);
  };

  const handleDeleteRule = (index: number) => {
    setBrowserRules(browserRules.filter((_, i) => i !== index));
  };

  // 计算下拉框当前值：自定义路径时返回 CUSTOM_BROWSER_VALUE
  const getBrowserSelectValue = (browser: string): string => {
    return BROWSER_OPTIONS.some((opt) => opt.value === browser)
      ? browser
      : CUSTOM_BROWSER_VALUE;
  };

  const handleBrowserSelectChange = (index: number, value: string) => {
    if (value === CUSTOM_BROWSER_VALUE) {
      // 切到自定义时保留现有值（可能是之前的路径）
      if (BROWSER_OPTIONS.some((opt) => opt.value === browserRules[index].browser)) {
        handleUpdateRule(index, "browser", "");
      }
    } else {
      handleUpdateRule(index, "browser", value);
    }
  };

  const handleSave = () => {
    // 校验浏览器路由规则
    for (const rule of browserRules) {
      if (!rule.pattern.trim()) {
        setErrorDialog({
          isOpen: true,
          type: "warning",
          message: "请填写每条浏览器路由规则的匹配模式（如 opencode.ai 或 https://opencode.ai）",
        });
        return;
      }
    }
    // 保存配置
    onSettingsChange({
      ...settings,
      browser_rules: browserRules,
    });
    // 显示成功提示（自动消失）
    setSaveSuccessMessage("浏览器路由规则已保存成功");
    setTimeout(() => {
      setSaveSuccessMessage(null);
    }, 2000);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-800 mb-2">浏览器路由规则</h2>
        <p className="text-sm text-gray-500">
          为特定网址指定使用的浏览器，未命中规则的网址使用系统默认浏览器
        </p>
      </div>

      {saveSuccessMessage && (
        <div className="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 bg-green-50 text-green-700 border border-green-200 rounded-md px-4 py-2 text-sm flex items-center gap-2 shadow-lg">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{saveSuccessMessage}</span>
        </div>
      )}

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="space-y-6">
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-700">规则列表</h3>
              <div className="flex gap-2">
                <button
                  onClick={handleAddRule}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors text-sm"
                >
                  添加规则
                </button>
                <button
                  onClick={handleSave}
                  className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors text-sm"
                >
                  保存配置
                </button>
              </div>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              模式填写域名（如 <code className="bg-gray-100 px-1 rounded">opencode.ai</code>）或完整网址前缀（如
              <code className="bg-gray-100 px-1 rounded">https://linux.do</code>）。域名按后缀匹配（子域名也会命中），完整网址按前缀匹配。
            </p>
            {detectedBrowsers.length > 0 && (
              <div className="mb-4">
                <p className="text-sm font-medium text-gray-700 mb-1">检测到的浏览器：</p>
                <div className="flex flex-wrap gap-2">
                  {detectedBrowsers.map((browser) => (
                    <span
                      key={browser.id}
                      className="px-2 py-1 text-xs rounded bg-green-50 text-green-700 border border-green-200"
                    >
                      {browser.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {browserRules.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <p>暂无浏览器路由规则</p>
                <p className="text-sm mt-2">点击"添加规则"来为指定网址设置浏览器</p>
              </div>
            ) : (
              <div className="space-y-4">
                {browserRules.map((rule, index) => (
                  <div
                    key={index}
                    className="border border-gray-200 rounded-lg p-4 space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-medium text-gray-700">
                        规则 #{index + 1}
                      </h4>
                      <div className="flex items-center gap-3">
                        <label className="flex items-center gap-1 text-xs text-gray-600 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            onChange={(e) =>
                              handleUpdateRule(index, "enabled", e.target.checked)
                            }
                            className="rounded border-gray-300"
                          />
                          启用
                        </label>
                        <button
                          onClick={() => handleDeleteRule(index)}
                          className="text-red-600 hover:text-red-700 text-sm"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          匹配模式 <span className="text-red-500">*</span>
                        </label>
                        <input
                          type="text"
                          value={rule.pattern}
                          onChange={(e) =>
                            handleUpdateRule(index, "pattern", e.target.value)
                          }
                          placeholder='例如: "opencode.ai" 或 "https://linux.do"'
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          打开方式
                        </label>
                        <select
                          value={getBrowserSelectValue(rule.browser)}
                          onChange={(e) =>
                            handleBrowserSelectChange(index, e.target.value)
                          }
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                        >
                          {BROWSER_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                          <option value={CUSTOM_BROWSER_VALUE}>
                            自定义浏览器路径...
                          </option>
                        </select>
                        {getBrowserSelectValue(rule.browser) === CUSTOM_BROWSER_VALUE && (
                          <input
                            type="text"
                            value={rule.browser}
                            onChange={(e) =>
                              handleUpdateRule(index, "browser", e.target.value)
                            }
                            placeholder="例如: C:\Program Files\App\app.exe"
                            className="mt-2 w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm font-mono"
                          />
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <ErrorDialog
        isOpen={errorDialog.isOpen}
        type={errorDialog.type}
        title={errorDialog.type === "success" ? "保存成功" : errorDialog.type === "warning" ? "配置验证" : "错误"}
        message={errorDialog.message}
        onClose={() => setErrorDialog({ ...errorDialog, isOpen: false })}
      />
    </div>
  );
}

export function LauncherSettingsPage({
  settings,
  onSettingsChange,
}: LauncherSettingsProps) {
  const [searchEngines, setSearchEngines] = useState<SearchEngineConfig[]>(
    settings.search_engines || []
  );
  const [errorDialog, setErrorDialog] = useState<{
    isOpen: boolean;
    type: "error" | "success" | "warning" | "info";
    message: string;
  }>({
    isOpen: false,
    type: "error",
    message: "",
  });
  const [saveSuccessMessage, setSaveSuccessMessage] = useState<string | null>(null);

  // 当外部设置更新时同步
  useEffect(() => {
    if (settings.search_engines) {
      setSearchEngines(settings.search_engines);
    }
  }, [settings.search_engines]);

  const handleAddEngine = () => {
    setSearchEngines([
      ...searchEngines,
      {
        prefix: "",
        url: "",
        name: "",
      },
    ]);
  };

  const handleUpdateEngine = (index: number, field: keyof SearchEngineConfig, value: string) => {
    const updated = [...searchEngines];
    updated[index] = { ...updated[index], [field]: value };
    setSearchEngines(updated);
  };

  const handleDeleteEngine = (index: number) => {
    setSearchEngines(searchEngines.filter((_, i) => i !== index));
  };

  const handleAddPreset = (preset: SearchEngineConfig) => {
    // 检查是否已存在相同前缀的引擎
    if (searchEngines.some((e) => e.prefix === preset.prefix)) {
      alert(`前缀 "${preset.prefix}" 已存在，请先删除或修改现有配置`);
      return;
    }
    setSearchEngines([...searchEngines, preset]);
  };

  const handleSave = () => {
    // 验证配置
    for (const engine of searchEngines) {
      if (!engine.prefix.trim() || !engine.name.trim() || !engine.url.trim()) {
        setErrorDialog({
          isOpen: true,
          type: "warning",
          message: "请确保所有搜索引擎的前缀、名称和 URL 模板都已填写完整",
        });
        return;
      }
      if (!engine.url.includes("{query}")) {
        setErrorDialog({
          isOpen: true,
          type: "warning",
          message: `搜索引擎 "${engine.name}" 的 URL 模板必须包含 {query} 占位符`,
        });
        return;
      }
    }
    // 检查是否有重复的前缀
    const prefixes = searchEngines.map((e) => e.prefix.trim());
    const uniquePrefixes = new Set(prefixes);
    if (prefixes.length !== uniquePrefixes.size) {
      setErrorDialog({
        isOpen: true,
        type: "warning",
        message: "存在重复的前缀，请确保每个搜索引擎的前缀都是唯一的",
      });
      return;
    }
    // 保存配置
    onSettingsChange({
      ...settings,
      search_engines: searchEngines,
    });
    // 显示成功提示（自动消失）
    setSaveSuccessMessage("搜索引擎配置已保存成功");
    setTimeout(() => {
      setSaveSuccessMessage(null);
    }, 2000);
  };

  const presets: SearchEngineConfig[] = [
    {
      prefix: "g ",
      url: "https://www.google.com/search?q={query}",
      name: "Google",
    },
    {
      prefix: "bd ",
      url: "https://www.baidu.com/s?wd={query}",
      name: "百度",
    },
    {
      prefix: "b ",
      url: "https://www.bing.com/search?q={query}",
      name: "必应",
    },
    {
      prefix: "gh ",
      url: "https://github.com/search?q={query}",
      name: "GitHub",
    },
    {
      prefix: "so ",
      url: "https://stackoverflow.com/search?q={query}",
      name: "Stack Overflow",
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-800 mb-2">启动器设置</h2>
        <p className="text-sm text-gray-500">配置启动器的行为和功能</p>
      </div>

      {saveSuccessMessage && (
        <div className="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 bg-green-50 text-green-700 border border-green-200 rounded-md px-4 py-2 text-sm flex items-center gap-2 shadow-lg">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{saveSuccessMessage}</span>
        </div>
      )}

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="space-y-6">
          <div>
            <div className="sticky top-0 z-10 bg-white pb-4 -mx-6 px-6 pt-0 mb-4 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-medium text-gray-700">搜索引擎配置</h3>
                <div className="flex gap-2">
                  <button
                    onClick={handleAddEngine}
                    className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors text-sm"
                  >
                    添加搜索引擎
                  </button>
                  <button
                    onClick={handleSave}
                    className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors text-sm"
                  >
                    保存配置
                  </button>
                </div>
              </div>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              配置搜索引擎前缀，输入特定前缀时可在浏览器中快速搜索。URL 模板中使用 <code className="bg-gray-100 px-1 rounded">{`{query}`}</code> 作为搜索关键词的占位符。
            </p>

            {/* 预设搜索引擎 */}
            <div className="mb-4">
              <p className="text-sm font-medium text-gray-700 mb-2">快速添加预设：</p>
              <div className="flex flex-wrap gap-2">
                {presets.map((preset, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleAddPreset(preset)}
                    disabled={searchEngines.some((e) => e.prefix === preset.prefix)}
                    className={`px-3 py-1 text-sm rounded transition-colors ${
                      searchEngines.some((e) => e.prefix === preset.prefix)
                        ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                        : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                    }`}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
            </div>

            {/* 搜索引擎列表 */}
            {searchEngines.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <p>暂无搜索引擎配置</p>
                <p className="text-sm mt-2">点击"添加搜索引擎"或选择预设来添加</p>
              </div>
            ) : (
              <div className="space-y-4">
                {searchEngines.map((engine, index) => (
                  <div
                    key={index}
                    className="border border-gray-200 rounded-lg p-4 space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-medium text-gray-700">
                        搜索引擎 #{index + 1}
                      </h4>
                      <button
                        onClick={() => handleDeleteEngine(index)}
                        className="text-red-600 hover:text-red-700 text-sm"
                      >
                        删除
                      </button>
                    </div>
                    <div className="grid grid-cols-1 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          前缀 <span className="text-red-500">*</span>
                        </label>
                        <input
                          type="text"
                          value={engine.prefix}
                          onChange={(e) =>
                            handleUpdateEngine(index, "prefix", e.target.value)
                          }
                          placeholder='例如: "s ", "g "'
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          输入此前缀后跟搜索关键词即可触发搜索
                        </p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          名称 <span className="text-red-500">*</span>
                        </label>
                        <input
                          type="text"
                          value={engine.name}
                          onChange={(e) =>
                            handleUpdateEngine(index, "name", e.target.value)
                          }
                          placeholder='例如: "Google", "百度"'
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          URL 模板 <span className="text-red-500">*</span>
                        </label>
                        <input
                          type="text"
                          value={engine.url}
                          onChange={(e) =>
                            handleUpdateEngine(index, "url", e.target.value)
                          }
                          placeholder='例如: "https://www.google.com/search?q={query}"'
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm font-mono"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          必须包含 <code className="bg-gray-100 px-1 rounded">{`{query}`}</code> 占位符
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <ErrorDialog
        isOpen={errorDialog.isOpen}
        type={errorDialog.type}
        title={errorDialog.type === "success" ? "保存成功" : errorDialog.type === "warning" ? "配置验证" : "错误"}
        message={errorDialog.message}
        onClose={() => setErrorDialog({ ...errorDialog, isOpen: false })}
      />
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

  const handleContactAuthor = async () => {
    try {
      await tauriApi.openUrl("https://github.com/Xieweikang123/ReFast?tab=readme-ov-file#%E4%BD%9C%E8%80%85%E5%BE%AE%E4%BF%A1");
    } catch (error) {
      console.error("Failed to open contact page:", error);
      alert("打开联系页面失败");
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
            <p className="text-gray-600 mb-4">一个快速启动器</p>
            <div className="text-sm text-gray-500">
              版本: <span className="font-semibold text-gray-700">{version}</span>
            </div>
          </div>

          {/* 更新检查区域 - 使用独立组件 */}
          <UpdateSection currentVersion={version} />

          <div className="border-t border-gray-200 pt-6">
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-2">项目信息</h3>
                <p className="text-sm text-gray-600 mb-4">
                  ReFast 是一个基于 Tauri 2 开发的 Windows 快速启动器，提供快速应用启动、文件搜索等功能。
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex gap-3">
                  <button
                    onClick={handleOpenGitHub}
                    className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 transition-colors text-sm"
                  >
                    GitHub 主页
                  </button>
                  <button
                    onClick={handleContactAuthor}
                    className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors text-sm"
                  >
                    加入产品交流群
                  </button>
                </div>
                <p className="text-xs text-gray-500">
                  点击"加入产品交流群"可查看作者微信，加入产品交流群获取最新动态和反馈建议
                </p>
                <p className="text-xs text-gray-400">
                  如果打不开 GitHub，请加微信：<span className="font-mono text-gray-600">570312124</span>
                </p>
              </div>
            </div>
          </div>

          <div className="border-t border-gray-200 pt-6">
            <div className="text-xs text-gray-500 text-center">
              <p>© 2025 ReFast</p>
              <p className="mt-1">MIT License</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

