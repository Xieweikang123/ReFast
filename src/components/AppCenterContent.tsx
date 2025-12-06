import { useState, useMemo, useEffect, useRef } from "react";
import { plugins, executePlugin } from "../plugins";
import type { PluginContext, IndexStatus, FileHistoryItem, AppInfo } from "../types";
import { tauriApi } from "../api/tauri";
import { listen, emit } from "@tauri-apps/api/event";
import { OllamaSettingsPage, SystemSettingsPage, AboutSettingsPage } from "./SettingsPages";

// 菜单分类类型
type MenuCategory = "plugins" | "settings" | "about" | "index";

// 设置子页面类型
type SettingsPage = "system" | "ollama";

// 设置接口
interface Settings {
  ollama: {
    model: string;
    base_url: string;
  };
  startup_enabled?: boolean;
  result_style?: "compact" | "soft" | "skeuomorphic";
  close_on_blur?: boolean;
}

interface MenuItem {
  id: MenuCategory;
  name: string;
  icon: JSX.Element;
}

const menuItems: MenuItem[] = [
  {
    id: "plugins",
    name: "插件",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
      </svg>
    ),
  },
  {
    id: "index",
    name: "索引",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h18M3 12h18M3 19h18" />
      </svg>
    ),
  },
  {
    id: "settings",
    name: "设置",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
      </svg>
    ),
  },
  {
    id: "about",
    name: "关于",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
];

interface AppCenterContentProps {
  onPluginClick?: (pluginId: string) => Promise<void>;
  onClose?: () => void;
}

export function AppCenterContent({ onPluginClick, onClose: _onClose }: AppCenterContentProps) {
  const [activeCategory, setActiveCategory] = useState<MenuCategory>("plugins");
  const [searchQuery, setSearchQuery] = useState("");
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [isLoadingIndex, setIsLoadingIndex] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [isAppIndexModalOpen, setIsAppIndexModalOpen] = useState(false);
  const [appIndexLoading, setAppIndexLoading] = useState(false);
  const [appIndexError, setAppIndexError] = useState<string | null>(null);
  const [appIndexList, setAppIndexList] = useState<AppInfo[]>([]);
  const [appIndexSearch, setAppIndexSearch] = useState("");
  const [fileHistoryItems, setFileHistoryItems] = useState<FileHistoryItem[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyStartDate, setHistoryStartDate] = useState<string>("");
  const [historyEndDate, setHistoryEndDate] = useState<string>("");
  const [isDeletingHistory, setIsDeletingHistory] = useState(false);
  const [historyMessage, setHistoryMessage] = useState<string | null>(null);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [pendingDeleteCount, setPendingDeleteCount] = useState(0);
  
  // 设置相关状态
  const [activeSettingsPage, setActiveSettingsPage] = useState<SettingsPage>("system");
  const [settings, setSettings] = useState<Settings>({
    ollama: {
      model: "llama2",
      base_url: "http://localhost:11434",
    },
    startup_enabled: false,
    result_style: "skeuomorphic",
    close_on_blur: true,
  });
  const [isLoadingSettings, setIsLoadingSettings] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const hasLoadedSettingsRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);

  const formatTimestamp = (timestamp?: number | null) => {
    if (!timestamp) return "暂无";
    return new Date(timestamp * 1000).toLocaleString();
  };

  const parseDateRangeToTs = (start: string, end: string): { start?: number; end?: number } => {
    const toTs = (dateStr: string, endOfDay = false) => {
      if (!dateStr) return undefined;
      const d = new Date(dateStr);
      if (Number.isNaN(d.getTime())) return undefined;
      if (endOfDay) {
        d.setHours(23, 59, 59, 999);
      } else {
        d.setHours(0, 0, 0, 0);
      }
      return Math.floor(d.getTime() / 1000);
    };
    return {
      start: toTs(start, false),
      end: toTs(end, true),
    };
  };

  // 处理插件点击
  const handlePluginClick = async (pluginId: string) => {
    if (onPluginClick) {
      await onPluginClick(pluginId);
    } else {
      // 默认行为：创建插件上下文并执行
      // 在应用中心窗口中，不关闭窗口
      const pluginContext: PluginContext = {
        setQuery: () => {},
        setSelectedIndex: () => {},
        hideLauncher: async () => {
          // 在应用中心窗口中，不关闭窗口，只作为空操作
        },
        tauriApi,
      };
      await executePlugin(pluginId, pluginContext);
      // 不自动关闭应用中心窗口
    }
  };

  const fetchIndexStatus = async () => {
    try {
      setIsLoadingIndex(true);
      setIndexError(null);
      const data = await tauriApi.getIndexStatus();
      setIndexStatus(data);
    } catch (error: any) {
      console.error("获取索引状态失败:", error);
      setIndexError(error?.message || "获取索引状态失败");
    } finally {
      setIsLoadingIndex(false);
    }
  };

  const loadFileHistoryList = async () => {
    try {
      setIsLoadingHistory(true);
      const list = await tauriApi.getAllFileHistory();
      // 后端已按时间排序，但这里再保险按 last_used 降序
      const sorted = [...list].sort((a, b) => b.last_used - a.last_used);
      setFileHistoryItems(sorted);
    } catch (error: any) {
      console.error("加载文件历史失败:", error);
      setIndexError(error?.message || "加载文件历史失败");
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const handleRefreshIndex = async () => {
    await Promise.all([fetchIndexStatus(), loadFileHistoryList()]);
  };

  const handleRescanApplications = async () => {
    try {
      setIsLoadingIndex(true);
      await tauriApi.rescanApplications();
      await fetchIndexStatus();
    } catch (error: any) {
      console.error("重新扫描应用失败:", error);
      setIndexError(error?.message || "重新扫描应用失败");
    } finally {
      setIsLoadingIndex(false);
    }
  };

  const handleStartEverything = async () => {
    try {
      setIsLoadingIndex(true);
      await tauriApi.startEverything();
      await fetchIndexStatus();
    } catch (error: any) {
      console.error("启动 Everything 失败:", error);
      setIndexError(error?.message || "启动 Everything 失败");
    } finally {
      setIsLoadingIndex(false);
    }
  };

  const handlePurgeHistory = async () => {
    try {
      setIsDeletingHistory(true);
      setHistoryMessage(null);
      const { start, end } = parseDateRangeToTs(historyStartDate, historyEndDate);
      const removed = await tauriApi.deleteFileHistoryByRange(start, end);
      setHistoryMessage(`已删除 ${removed} 条记录`);
      await Promise.all([loadFileHistoryList(), fetchIndexStatus()]);
    } catch (error: any) {
      console.error("删除文件历史失败:", error);
      setHistoryMessage(error?.message || "删除文件历史失败");
    } finally {
      setIsDeletingHistory(false);
      setTimeout(() => setHistoryMessage(null), 3000);
    }
  };

  const handleOpenDeleteConfirm = () => {
    if (!historyStartDate && !historyEndDate) {
      setHistoryMessage("请先选择日期范围");
      setTimeout(() => setHistoryMessage(null), 2000);
      return;
    }
    const count = filteredHistoryItems.length;
    if (count === 0) {
      setHistoryMessage("当前筛选无结果");
      setTimeout(() => setHistoryMessage(null), 2000);
      return;
    }
    setPendingDeleteCount(count);
    setIsDeleteConfirmOpen(true);
  };

  const handleConfirmDelete = async () => {
    setIsDeleteConfirmOpen(false);
    await handlePurgeHistory();
  };

  const handleCancelDelete = () => {
    setIsDeleteConfirmOpen(false);
  };

  const loadAppIndexList = async (forceRescan = false) => {
    try {
      setAppIndexLoading(true);
      setAppIndexError(null);
      const data = forceRescan ? await tauriApi.rescanApplications() : await tauriApi.scanApplications();
      setAppIndexList(data);
    } catch (error: any) {
      console.error("获取应用索引列表失败:", error);
      setAppIndexError(error?.message || "获取应用索引列表失败");
    } finally {
      setAppIndexLoading(false);
    }
  };

  const handleOpenAppIndexModal = async () => {
    setIsAppIndexModalOpen(true);
    if (appIndexList.length === 0 && !appIndexLoading) {
      await loadAppIndexList();
    }
  };

  const handleCloseAppIndexModal = () => {
    setIsAppIndexModalOpen(false);
    setAppIndexSearch("");
  };

  const filteredAppIndexList = useMemo(() => {
    if (!appIndexSearch.trim()) return appIndexList;
    const query = appIndexSearch.toLowerCase();
    return appIndexList.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        item.path.toLowerCase().includes(query)
    );
  }, [appIndexList, appIndexSearch]);

  const filteredHistoryItems = useMemo(() => {
    const { start, end } = parseDateRangeToTs(historyStartDate, historyEndDate);
    return fileHistoryItems.filter((item) => {
      if (start && item.last_used < start) return false;
      if (end && item.last_used > end) return false;
      return true;
    });
  }, [fileHistoryItems, historyStartDate, historyEndDate]);

  // 加载设置
  const loadSettings = async () => {
    try {
      setIsLoadingSettings(true);
      const data = await tauriApi.getSettings();
      // 同步开机启动状态
      const startupEnabled = await tauriApi.isStartupEnabled();
      setSettings({
        ...data,
        startup_enabled: startupEnabled,
        result_style: data.result_style || (localStorage.getItem("result-style") as Settings["result_style"]) || "skeuomorphic",
        close_on_blur: data.close_on_blur ?? true,
      });
    } catch (error) {
      console.error("Failed to load settings:", error);
    } finally {
      setIsLoadingSettings(false);
    }
  };

  // 保存设置
  const saveSettings = async () => {
    try {
      setIsSaving(true);
      setSaveMessage("正在保存...");
      await tauriApi.saveSettings(settings);
      // 保存开机启动设置
      if (settings.startup_enabled !== undefined) {
        await tauriApi.setStartupEnabled(settings.startup_enabled);
      }
      // 本地缓存样式，避免后端旧版本未持久化时丢失
      if (settings.result_style) {
        localStorage.setItem("result-style", settings.result_style);
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

  // 设置变更自动保存（防抖处理）
  useEffect(() => {
    if (isLoadingSettings) return;

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
  }, [settings, isLoadingSettings]);

  // 卸载时清理定时器
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  // 测试连接
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

  // 打开快捷键设置
  const handleOpenHotkeySettings = async () => {
    try {
      await tauriApi.showHotkeySettings();
    } catch (error) {
      console.error("Failed to open hotkey settings:", error);
      alert("打开快捷键设置失败");
    }
  };

  // 当切换到设置分类时加载设置
  useEffect(() => {
    if (activeCategory === "settings") {
      loadSettings();
      
      // 监听设置刷新事件
      const unlisten = listen("settings:refresh", () => {
        loadSettings();
      });

      return () => {
        unlisten.then((fn) => fn());
      };
    }
  }, [activeCategory]);

  // 当切换到索引分类时加载索引状态
  useEffect(() => {
    if (activeCategory === "index") {
      fetchIndexStatus();
      loadFileHistoryList();
    }
  }, [activeCategory]);

  // 过滤插件
  const filteredPlugins = useMemo(() => {
    if (!searchQuery.trim()) {
      return plugins;
    }
    const query = searchQuery.toLowerCase();
    return plugins.filter(
      (plugin) =>
        plugin.name.toLowerCase().includes(query) ||
        plugin.description?.toLowerCase().includes(query) ||
        plugin.keywords.some((keyword) => keyword.toLowerCase().includes(query))
    );
  }, [searchQuery]);

  // 根据插件ID获取对应的图标
  const getPluginIcon = (pluginId: string) => {
    const iconClass = "w-5 h-5";
    switch (pluginId) {
      case "everything_search":
        return (
          <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        );
      case "json_formatter":
        return (
          <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
        );
      case "calculator_pad":
        return (
          <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
        );
      case "memo_center":
        return (
          <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        );
      case "show_main_window":
        return (
          <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        );
      case "show_plugin_list":
        return (
          <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
        );
      case "file_toolbox":
        return (
          <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
          </svg>
        );
      default:
        return (
          <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
        );
    }
  };

  // 根据插件ID获取图标背景渐变色
  const getPluginIconBg = (pluginId: string) => {
    switch (pluginId) {
      case "everything_search":
        return "bg-gradient-to-br from-blue-100 to-blue-200";
      case "json_formatter":
        return "bg-gradient-to-br from-purple-100 to-purple-200";
      case "calculator_pad":
        return "bg-gradient-to-br from-orange-100 to-orange-200";
      case "memo_center":
        return "bg-gradient-to-br from-green-100 to-green-200";
      case "show_main_window":
        return "bg-gradient-to-br from-indigo-100 to-indigo-200";
      case "show_plugin_list":
        return "bg-gradient-to-br from-teal-100 to-teal-200";
      case "file_toolbox":
        return "bg-gradient-to-br from-pink-100 to-pink-200";
      default:
        return "bg-gradient-to-br from-gray-100 to-gray-200";
    }
  };

  // 根据插件ID获取图标颜色
  const getPluginIconColor = (pluginId: string) => {
    switch (pluginId) {
      case "everything_search":
        return "text-blue-600";
      case "json_formatter":
        return "text-purple-600";
      case "calculator_pad":
        return "text-orange-600";
      case "memo_center":
        return "text-green-600";
      case "show_main_window":
        return "text-indigo-600";
      case "show_plugin_list":
        return "text-teal-600";
      case "file_toolbox":
        return "text-pink-600";
      default:
        return "text-gray-600";
    }
  };

  // 渲染当前分类的内容
  const renderContent = () => {
    switch (activeCategory) {
      case "plugins":
        return (
          <div className="space-y-4">
            {filteredPlugins.length === 0 ? (
              <div className="text-center py-16">
                <svg
                  className="w-16 h-16 mx-auto text-gray-300 mb-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <div className="text-gray-500 text-lg font-medium">
                  {searchQuery ? "未找到匹配的插件" : "暂无插件"}
                </div>
                {searchQuery && (
                  <div className="text-gray-400 text-sm mt-2">
                    尝试使用其他关键词搜索
                  </div>
                )}
              </div>
            ) : (
              filteredPlugins.map((plugin, index) => {
                const displayedKeywords = plugin.keywords?.slice(0, 6) || [];
                const hasMoreKeywords = (plugin.keywords?.length || 0) > 6;
                
                return (
                  <div
                    key={plugin.id}
                    onClick={() => handlePluginClick(plugin.id)}
                    className="group relative p-5 bg-white rounded-xl border border-gray-200 hover:border-gray-300 hover:shadow-lg transition-all duration-200 cursor-pointer active:scale-[0.98]"
                    style={{
                      animation: `fadeInUp 0.3s ease-out ${index * 0.05}s both`,
                    }}
                  >
                    <div className="flex items-start gap-4">
                      <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${getPluginIconBg(plugin.id)} group-hover:scale-110 transition-transform duration-200 shadow-sm`}>
                        <div className={getPluginIconColor(plugin.id)}>
                          {getPluginIcon(plugin.id)}
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-gray-900 text-base mb-1.5 group-hover:text-gray-700 transition-colors">
                          {plugin.name}
                        </div>
                        {plugin.description && (
                          <div className="text-sm text-gray-600 leading-relaxed mb-3">
                            {plugin.description}
                          </div>
                        )}
                        {displayedKeywords.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {displayedKeywords.map((keyword, idx) => (
                              <span
                                key={idx}
                                className="px-2.5 py-1 text-xs bg-gray-50 text-gray-600 rounded-md border border-gray-200 hover:bg-gray-100 transition-colors"
                              >
                                {keyword}
                              </span>
                            ))}
                            {hasMoreKeywords && (
                              <span className="px-2.5 py-1 text-xs bg-gray-50 text-gray-500 rounded-md border border-gray-200">
                                +{(plugin.keywords?.length || 0) - 6}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    {/* 悬停时的装饰性边框 */}
                    <div className="absolute inset-0 rounded-xl border-2 border-transparent group-hover:border-green-200 pointer-events-none transition-colors duration-200" />
                  </div>
                );
              })
            )}
            {/* 插件统计信息 - 显示在列表底部 */}
            <div className="mt-6 pt-6 border-t border-gray-200 flex items-center justify-center gap-4 text-sm">
              <div className="text-gray-600">
                共 <span className="font-medium text-green-600">{plugins.length}</span> 个插件
                {searchQuery && (
                  <span className="ml-1 text-gray-500">
                    （找到 <span className="font-medium text-green-600">{filteredPlugins.length}</span> 个）
                  </span>
                )}
              </div>
              <div className="text-gray-400">•</div>
              <div className="text-gray-500">插件持续开发优化中...</div>
            </div>
          </div>
        );
      case "index":
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-lg font-semibold text-gray-900">索引概况</div>
                <div className="text-sm text-gray-500">查看 Everything、应用缓存与文件历史的索引状态</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleRefreshIndex}
                  className="px-3 py-2 text-sm rounded-lg bg-white border border-gray-200 hover:border-gray-300 hover:shadow-sm transition"
                  disabled={isLoadingIndex}
                >
                  {isLoadingIndex ? "刷新中..." : "刷新"}
                </button>
                <button
                  onClick={handleRescanApplications}
                  className="px-3 py-2 text-sm rounded-lg bg-green-50 text-green-700 border border-green-200 hover:border-green-300 hover:shadow-sm transition"
                  disabled={isLoadingIndex}
                >
                  重新扫描应用
                </button>
              </div>
            </div>

            {indexError && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                {indexError}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-xl border border-gray-200 bg-white shadow-sm">
                <div className="flex items-center justify-between mb-3">
                  <div className="font-semibold text-gray-900">Everything 索引</div>
                  <span className={`text-xs px-2 py-1 rounded-full ${indexStatus?.everything?.available ? "bg-green-50 text-green-700 border border-green-200" : "bg-yellow-50 text-yellow-700 border border-yellow-200"}`}>
                    {indexStatus?.everything?.available ? "可用" : "不可用"}
                  </span>
                </div>
                <div className="space-y-1 text-sm text-gray-700">
                  <div>版本：{indexStatus?.everything?.version || "未知"}</div>
                  <div>路径：{indexStatus?.everything?.path || "未找到"}</div>
                  {indexStatus?.everything?.error && (
                    <div className="text-xs text-red-600">错误：{indexStatus.everything.error}</div>
                  )}
                </div>
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={handleStartEverything}
                    className="px-3 py-2 text-xs rounded-lg bg-blue-50 text-blue-700 border border-blue-200 hover:border-blue-300 transition"
                    disabled={isLoadingIndex}
                  >
                    启动 Everything
                  </button>
                  {!indexStatus?.everything?.available && (
                    <button
                      onClick={() => tauriApi.openEverythingDownload()}
                      className="px-3 py-2 text-xs rounded-lg bg-white text-gray-700 border border-gray-200 hover:border-gray-300 transition"
                    >
                      下载/安装
                    </button>
                  )}
                </div>
              </div>

              <div className="p-4 rounded-xl border border-gray-200 bg-white shadow-sm">
                <div className="flex items-center justify-between mb-3">
                  <div className="font-semibold text-gray-900">应用索引</div>
                  <span className="text-xs px-2 py-1 rounded-full bg-gray-50 text-gray-700 border border-gray-200">
                    {indexStatus?.applications?.total ?? 0} 条
                  </span>
                </div>
                <div className="space-y-1 text-sm text-gray-700">
                  <div>缓存文件：{indexStatus?.applications?.cache_file || "未生成"}</div>
                  <div>更新时间：{formatTimestamp(indexStatus?.applications?.cache_mtime)}</div>
                </div>
                <button
                  onClick={handleOpenAppIndexModal}
                  className="mt-3 px-3 py-2 text-xs rounded-lg bg-white text-gray-700 border border-gray-200 hover:border-gray-300 hover:shadow-sm transition w-full text-left flex items-center justify-between"
                  disabled={isLoadingIndex || appIndexLoading}
                >
                  <span>查看索引列表</span>
                  <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>

              <div className="p-4 rounded-xl border border-gray-200 bg-white shadow-sm">
                <div className="flex items-center justify-between mb-3">
                  <div className="font-semibold text-gray-900">文件历史</div>
                  <span className="text-xs px-2 py-1 rounded-full bg-gray-50 text-gray-700 border border-gray-200">
                    {indexStatus?.file_history?.total ?? 0} 条
                  </span>
                </div>
                <div className="space-y-1 text-sm text-gray-700">
                  <div>存储路径：{indexStatus?.file_history?.path || "未生成"}</div>
                  <div>更新时间：{formatTimestamp(indexStatus?.file_history?.mtime)}</div>
                </div>
              <div className="mt-3 flex flex-wrap gap-2 items-center">
                <button
                  onClick={loadFileHistoryList}
                  className="px-3 py-2 text-xs rounded-lg bg-white text-gray-700 border border-gray-200 hover:border-gray-300 transition"
                  disabled={isLoadingHistory}
                >
                  {isLoadingHistory ? "加载中..." : "刷新文件历史"}
                </button>
                <input
                  type="date"
                  value={historyStartDate}
                  onChange={(e) => setHistoryStartDate(e.target.value)}
                  className="px-2 py-1 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-green-400"
                />
                <span className="text-xs text-gray-500">至</span>
                <input
                  type="date"
                  value={historyEndDate}
                  onChange={(e) => setHistoryEndDate(e.target.value)}
                  className="px-2 py-1 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-green-400"
                />
                {(historyStartDate || historyEndDate) && (
                  <button
                    onClick={() => {
                      setHistoryStartDate("");
                      setHistoryEndDate("");
                    }}
                    className="px-2 py-1 text-xs text-gray-600 hover:text-gray-800"
                  >
                    清除筛选
                  </button>
                )}
                <button
                  onClick={handleOpenDeleteConfirm}
                  className="px-3 py-2 text-xs rounded-lg bg-red-50 text-red-700 border border-red-200 hover:border-red-300 transition"
                  disabled={isDeletingHistory}
                >
                  {isDeletingHistory ? "删除中..." : "删除当前查询结果"}
                </button>
                {historyMessage && (
                  <div className="text-xs text-gray-500">{historyMessage}</div>
                )}
              </div>
              <div className="mt-3 border-t border-gray-100 pt-3 max-h-64 overflow-auto">
                {isLoadingHistory && <div className="text-xs text-gray-500">加载中...</div>}
                {!isLoadingHistory && filteredHistoryItems.length === 0 && (
                  <div className="text-xs text-gray-500">暂无历史记录</div>
                )}
                {!isLoadingHistory && filteredHistoryItems.length > 0 && (
                  <div className="space-y-2 text-xs text-gray-700">
                    {filteredHistoryItems.slice(0, 30).map((item) => (
                      <div
                        key={item.path}
                        className="p-2 rounded-md border border-gray-100 hover:border-gray-200"
                      >
                        <div className="font-medium text-gray-900 truncate">{item.name}</div>
                        <div className="text-gray-500 truncate">{item.path}</div>
                        <div className="text-gray-400">
                          使用 {item.use_count} 次 · 最近 {formatTimestamp(item.last_used)}
                        </div>
                      </div>
                    ))}
                    {filteredHistoryItems.length > 30 && (
                      <div className="text-gray-400 text-[11px]">
                        已显示前 30 条，共 {filteredHistoryItems.length} 条
                      </div>
                    )}
                  </div>
                )}
              </div>
              </div>
            </div>
          </div>
        );
      case "settings":
        if (isLoadingSettings) {
          return (
            <div className="flex items-center justify-center py-12">
              <div className="text-gray-600">加载中...</div>
            </div>
          );
        }

        const settingsMenuItems = [
          { id: "system" as SettingsPage, label: "系统设置", icon: "⚙️" },
          { id: "ollama" as SettingsPage, label: "Ollama 配置", icon: "🤖" },
        ];

        return (
          <div className="flex-1 flex overflow-hidden">
            {/* 设置子导航 */}
            <div className="w-48 border-r border-gray-200 bg-white flex-shrink-0 flex flex-col">
              <nav className="p-4 flex-1 overflow-y-auto">
                <ul className="space-y-1">
                  {settingsMenuItems.map((item) => (
                    <li key={item.id}>
                      <button
                        onClick={() => setActiveSettingsPage(item.id)}
                        className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-colors ${
                          activeSettingsPage === item.id
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

            {/* 设置内容区域 */}
            <div className="flex-1 overflow-y-auto bg-gray-50">
              <div className="p-6 max-w-4xl">
                {saveMessage && (
                  <div
                    className={`mb-4 text-sm px-3 py-2 rounded-md inline-flex items-center gap-2 ${
                      saveMessage === "设置已保存"
                        ? "bg-green-50 text-green-700 border border-green-200"
                        : saveMessage === "正在保存..."
                          ? "bg-blue-50 text-blue-700 border border-blue-200"
                          : "bg-red-50 text-red-700 border border-red-200"
                    }`}
                  >
                    {(isSaving || saveMessage === "正在保存...") && (
                      <span className="w-2 h-2 rounded-full bg-blue-500 animate-ping" />
                    )}
                    <span>{saveMessage}</span>
                  </div>
                )}
                {activeSettingsPage === "ollama" && (
                  <OllamaSettingsPage
                    settings={settings}
                    onSettingsChange={setSettings}
                    isTesting={isTesting}
                    testResult={testResult}
                    onTestConnection={testConnection}
                  />
                )}
                {activeSettingsPage === "system" && (
                  <SystemSettingsPage
                    settings={settings}
                    onSettingsChange={setSettings}
                    onOpenHotkeySettings={handleOpenHotkeySettings}
                  />
                )}
              </div>
            </div>
          </div>
        );
      case "about":
        return (
          <div className="flex-1 overflow-y-auto bg-gray-50">
            <div className="p-6 max-w-4xl mx-auto">
              <AboutSettingsPage />
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <>
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <div className="w-48 border-r border-gray-200 bg-white flex-shrink-0 flex flex-col">
          <nav className="flex-1 p-2">
            {menuItems.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  setActiveCategory(item.id);
                  setSearchQuery(""); // 切换分类时清空搜索
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors mb-1 ${
                  activeCategory === item.id
                    ? "bg-green-50 text-green-700 font-medium"
                    : "text-gray-700 hover:bg-gray-50"
                }`}
              >
                <span className={activeCategory === item.id ? "text-green-600" : "text-gray-500"}>
                  {item.icon}
                </span>
                <span>{item.name}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* Content Area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Search Bar - 仅在插件分类显示 */}
          {activeCategory === "plugins" && (
            <div className="p-5 border-b border-gray-200 bg-gradient-to-r from-white to-gray-50 flex-shrink-0">
              <div className="relative max-w-2xl mx-auto">
                <div className="relative">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="搜索插件..."
                    className="w-full px-5 py-3 pl-12 pr-4 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-green-400 focus:border-green-400 bg-white shadow-sm hover:shadow-md transition-all duration-200 text-gray-900 placeholder-gray-400"
                  />
                  <svg
                    className="absolute left-4 top-3.5 w-5 h-5 text-gray-400 pointer-events-none"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery("")}
                      className="absolute right-3 top-3.5 w-5 h-5 text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Scrollable Content - 设置和关于页面占据整个区域，其他页面有 padding */}
          {activeCategory === "settings" || activeCategory === "about" ? (
            renderContent()
          ) : (
            <div className="flex-1 overflow-y-auto p-4">
              <div className="max-w-4xl mx-auto">{renderContent()}</div>
            </div>
          )}
        </div>
      </div>

      {isDeleteConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-gray-200 p-5">
            <div className="text-lg font-semibold text-gray-900 mb-2">确认删除</div>
            <div className="text-sm text-gray-700 mb-4">
              确认删除当前筛选的 {pendingDeleteCount} 条记录？该操作不可恢复。
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={handleCancelDelete}
                className="px-3 py-2 text-sm rounded-lg bg-white border border-gray-200 hover:border-gray-300 text-gray-700"
              >
                取消
              </button>
              <button
                onClick={handleConfirmDelete}
                className="px-3 py-2 text-sm rounded-lg bg-red-50 text-red-700 border border-red-200 hover:border-red-300"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {isAppIndexModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[80vh] flex flex-col border border-gray-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <div className="text-lg font-semibold text-gray-900">应用索引列表</div>
                <div className="text-sm text-gray-500">
                  共 {appIndexList.length} 条{appIndexSearch ? `，筛选后 ${filteredAppIndexList.length} 条` : ""}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => loadAppIndexList()}
                  className="px-3 py-2 text-xs rounded-lg bg-white border border-gray-200 hover:border-gray-300 hover:shadow-sm transition"
                  disabled={appIndexLoading}
                >
                  {appIndexLoading ? "刷新中..." : "刷新缓存"}
                </button>
                <button
                  onClick={() => loadAppIndexList(true)}
                  className="px-3 py-2 text-xs rounded-lg bg-green-50 text-green-700 border border-green-200 hover:border-green-300 hover:shadow-sm transition"
                  disabled={appIndexLoading}
                >
                  {appIndexLoading ? "扫描中..." : "重新扫描"}
                </button>
                <button
                  onClick={handleCloseAppIndexModal}
                  className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-500 transition"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="px-6 py-3 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <div className="relative flex-1">
                  <input
                    value={appIndexSearch}
                    onChange={(e) => setAppIndexSearch(e.target.value)}
                    placeholder="按名称或路径过滤..."
                    className="w-full px-4 py-2.5 pl-10 pr-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-400 focus:border-green-400 bg-white text-sm text-gray-900 placeholder-gray-400"
                  />
                  <svg
                    className="absolute left-3 top-2.5 w-4 h-4 text-gray-400 pointer-events-none"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </div>
                {appIndexSearch && (
                  <button
                    onClick={() => setAppIndexSearch("")}
                    className="px-3 py-2 text-xs rounded-lg bg-white border border-gray-200 hover:border-gray-300 transition"
                  >
                    清空
                  </button>
                )}
              </div>
              {appIndexError && (
                <div className="mt-3 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                  {appIndexError}
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto">
              {appIndexLoading ? (
                <div className="flex items-center justify-center py-12 text-gray-600 text-sm">加载中...</div>
              ) : filteredAppIndexList.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-gray-500 text-sm">暂无索引数据</div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {filteredAppIndexList.map((item, idx) => (
                    <div key={`${item.path}-${idx}`} className="px-6 py-3 flex items-start gap-3 hover:bg-gray-50">
                      <div className="w-6 h-6 rounded bg-green-50 text-green-700 flex items-center justify-center text-xs flex-shrink-0">
                        {idx + 1}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-gray-900">{item.name}</div>
                        <div className="text-xs text-gray-500 break-all mt-1">{item.path}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

