import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { plugins, executePlugin } from "../plugins";
import type { PluginContext, IndexStatus, FileHistoryItem, DatabaseBackupInfo, PluginUsage } from "../types";
import { tauriApi } from "../api/tauri";
import { listen, emit } from "@tauri-apps/api/event";
import { OllamaSettingsPage, SystemSettingsPage, AboutSettingsPage } from "./SettingsPages";
import { fetchUsersCount } from "../api/events";
import { ConfirmDialog } from "./ConfirmDialog";
import { AppIndexList } from "./AppIndexList";

// Icon extraction failure marker 和相关函数已移至 AppIndexList 组件

// 菜单分类类型
type MenuCategory = "plugins" | "settings" | "about" | "index" | "statistics";

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
    name: "数据管理",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h18M3 12h18M3 19h18" />
      </svg>
    ),
  },
  {
    id: "statistics",
    name: "统计",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16h3V9H4v7zM10.5 16h3V5h-3v11zM17 16h3v-5h-3v5z" />
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
  const [fileHistoryItems, setFileHistoryItems] = useState<FileHistoryItem[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyStartDate, setHistoryStartDate] = useState<string>("");
  const [historyEndDate, setHistoryEndDate] = useState<string>("");
  const [historyDaysAgo, setHistoryDaysAgo] = useState<string>("");
  const [isDeletingHistory, setIsDeletingHistory] = useState(false);
  const [historyMessage, setHistoryMessage] = useState<string | null>(null);
  const [isBackingUpDb, setIsBackingUpDb] = useState(false);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [backupList, setBackupList] = useState<DatabaseBackupInfo[]>([]);
  const [backupDir, setBackupDir] = useState<string>("");
  const [isLoadingBackups, setIsLoadingBackups] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null);
  const [deletingBackup, setDeletingBackup] = useState<string | null>(null);
  const [restoreConfirmPath, setRestoreConfirmPath] = useState<string | null>(null);
  const [deleteBackupConfirmPath, setDeleteBackupConfirmPath] = useState<string | null>(null);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [pendingDeleteCount, setPendingDeleteCount] = useState(0);
  
  // 应用快捷键相关状态（需要在父组件管理，以便在其他地方使用）
  const [appHotkeys, setAppHotkeys] = useState<Record<string, { modifiers: string[]; key: string }>>({});
  
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
  // 标记当前是否正在应用后端加载的设置，避免立即触发自动保存
  const isApplyingSettingsRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const [usersCount, setUsersCount] = useState<number | null>(null);
  const [isLoadingUsersCount, setIsLoadingUsersCount] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const ALL_TIME_FROM = "1970-01-01"; // 用于覆盖后端默认 7 天范围，统计全部时间
  const [pluginUsage, setPluginUsage] = useState<PluginUsage[]>([]);
  const [isLoadingPluginUsage, setIsLoadingPluginUsage] = useState(false);
  const [pluginUsageError, setPluginUsageError] = useState<string | null>(null);
  const pluginUsageTimeoutRef = useRef<number | null>(null);
  const hasLoadedPluginUsageRef = useRef(false);

  const formatTimestamp = (timestamp?: number | null) => {
    if (!timestamp) return "暂无";
    return new Date(timestamp * 1000).toLocaleString();
  };

  const formatBytes = (size?: number | null) => {
    if (!size && size !== 0) return "未知";
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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

  // 超时保护辅助函数
  const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> => {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
      ),
    ]);
  };

  const loadUsersCount = useCallback(
    async (fromOverride?: string, toOverride?: string) => {
      setIsLoadingUsersCount(true);
      setStatsError(null);
      const normalizedFrom = fromOverride?.trim() || ALL_TIME_FROM;
      const normalizedTo = toOverride?.trim() || undefined;

      try {
        const count = await fetchUsersCount(normalizedFrom, normalizedTo);
        setUsersCount(count);
      } catch (error) {
        const message = error instanceof Error ? error.message : "获取失败";
        setStatsError(message);
      } finally {
        setIsLoadingUsersCount(false);
      }
    },
    []
  );

  const pluginNameMap = useMemo(() => {
    const map = new Map<string, string>();
    plugins.forEach((plugin) => {
      map.set(plugin.id, plugin.name);
    });
    return map;
  }, []);

  const loadPluginUsage = useCallback(async () => {
    setIsLoadingPluginUsage(true);
    setPluginUsageError(null);
    const timeoutMs = 8000;
    console.log("[statistics] load plugin usage start");
    try {
      const usage = await Promise.race([
        tauriApi.getPluginUsage(),
        new Promise<PluginUsage[]>((_, reject) =>
          setTimeout(() => reject(new Error("加载超时，请重试")), timeoutMs)
        ),
      ]);
      console.log("[statistics] load plugin usage success", usage);
      setPluginUsage(usage);
    } catch (error: any) {
      console.warn("[statistics] failed to load plugin usage", error);
      console.log("[statistics] plugin usage error detail", error);
      setPluginUsageError(error?.message || "加载插件使用数据失败");
    } finally {
      console.log("[statistics] load plugin usage end");
      setIsLoadingPluginUsage(false);
    }
  }, []);

  useEffect(() => {
    if (isLoadingPluginUsage) {
      if (pluginUsageTimeoutRef.current) {
        window.clearTimeout(pluginUsageTimeoutRef.current);
      }
      pluginUsageTimeoutRef.current = window.setTimeout(() => {
        setIsLoadingPluginUsage(false);
        setPluginUsageError((prev) => prev || "加载超时，请重试或检查本地服务");
      }, 12000);
    } else if (pluginUsageTimeoutRef.current) {
      window.clearTimeout(pluginUsageTimeoutRef.current);
      pluginUsageTimeoutRef.current = null;
    }
    return () => {
      if (pluginUsageTimeoutRef.current) {
        window.clearTimeout(pluginUsageTimeoutRef.current);
        pluginUsageTimeoutRef.current = null;
      }
    };
  }, [isLoadingPluginUsage]);

  useEffect(() => {
    if (activeCategory === "statistics" && usersCount === null && !isLoadingUsersCount) {
      void loadUsersCount(ALL_TIME_FROM, "");
    }
  }, [ALL_TIME_FROM, activeCategory, isLoadingUsersCount, loadUsersCount, usersCount]);

  useEffect(() => {
    if (
      activeCategory === "statistics" &&
      !hasLoadedPluginUsageRef.current &&
      !isLoadingPluginUsage
    ) {
      hasLoadedPluginUsageRef.current = true;
      void loadPluginUsage();
    }
  }, [activeCategory, isLoadingPluginUsage, loadPluginUsage, pluginUsage.length, pluginUsageError]);

  const indexSummaryCards = useMemo(
    () => {
      const everythingAvailable = indexStatus?.everything?.available;
      return [
        {
          title: "Everything",
          value: everythingAvailable ? "可用" : "未就绪",
          helper: everythingAvailable
            ? `版本 ${indexStatus?.everything?.version || "未知"}`
            : indexStatus?.everything?.path
              ? "已找到路径，待启动"
              : "未安装/未找到",
          tone: everythingAvailable ? "success" : "warning",
        },
        {
          title: "应用索引",
          value: `${indexStatus?.applications?.total ?? 0}`,
          helper: indexStatus?.applications?.cache_mtime
            ? `更新于 ${formatTimestamp(indexStatus.applications.cache_mtime)}`
            : "等待生成缓存",
          tone: "info",
        },
        {
          title: "文件历史",
          value: `${indexStatus?.file_history?.total ?? 0}`,
          helper: indexStatus?.file_history?.mtime
            ? `更新于 ${formatTimestamp(indexStatus.file_history.mtime)}`
            : "暂无数据",
          tone: "neutral",
        },
        {
          title: "数据库备份",
          value: `${backupList.length} 份`,
          helper: backupDir ? "已设置存储目录" : "暂未备份",
          tone: backupList.length > 0 ? "success" : "neutral",
        },
      ];
    },
    [backupDir, backupList.length, indexStatus]
  );

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
      // 添加超时保护：8秒超时
      const data = await withTimeout(
        tauriApi.getIndexStatus(),
        8000,
        "获取索引状态超时，请重试"
      );
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
      // 添加超时保护：15秒超时（文件历史可能数据量大）
      const list = await withTimeout(
        tauriApi.getAllFileHistory(),
        15000,
        "加载文件历史超时，数据量可能较大，请稍后重试"
      );
      // 后端已按时间排序，但这里再保险按 last_used 降序
      // 使用 requestIdleCallback 优化数组排序，避免阻塞 UI（无论数据量大小）
      const sorted = await new Promise<FileHistoryItem[]>((resolve) => {
        const worker = () => {
          const sorted = [...list].sort((a, b) => b.last_used - a.last_used);
          resolve(sorted);
        };
        if (window.requestIdleCallback) {
          // 使用 requestIdleCallback 在浏览器空闲时执行排序，避免阻塞 UI
          window.requestIdleCallback(worker, { timeout: 1000 });
        } else {
          // 降级方案：使用 setTimeout 让出主线程
          setTimeout(worker, 0);
        }
      });
      setFileHistoryItems(sorted);
    } catch (error: any) {
      console.error("加载文件历史失败:", error);
      setIndexError(error?.message || "加载文件历史失败");
      // 即使失败也设置空数组，避免 UI 显示异常
      setFileHistoryItems([]);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const loadBackupList = async () => {
    try {
      setIsLoadingBackups(true);
      setBackupError(null);
      // 添加超时保护：10秒超时
      const result = await withTimeout(
        tauriApi.getDatabaseBackups(),
        10000,
        "获取备份列表超时，请重试"
      );
      setBackupDir(result.dir);
      setBackupList(result.items);
    } catch (error: any) {
      console.error("获取备份列表失败:", error);
      setBackupError(error?.message || "获取备份列表失败");
      // 即使失败也设置空数组
      setBackupList([]);
    } finally {
      setIsLoadingBackups(false);
    }
  };

  const handleRefreshIndex = async () => {
    // 优化：先加载轻量数据，再延迟加载重量数据，避免阻塞 UI
    // 1. 立即加载索引状态（轻量数据）
    void fetchIndexStatus();
    
    // 2. 延迟加载文件历史（重量数据），让 UI 先渲染
    setTimeout(() => {
      void loadFileHistoryList();
    }, 100);
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

  const handleBackupDatabase = async () => {
    setIsBackingUpDb(true);
    setBackupMessage(null);
    try {
      const path = await tauriApi.backupDatabase();
      setBackupMessage(`备份成功：${path}`);
      await loadBackupList();
    } catch (error: any) {
      console.error("备份数据库失败:", error);
      setBackupMessage(error?.message || "备份失败");
    } finally {
      setIsBackingUpDb(false);
      setTimeout(() => setBackupMessage(null), 4000);
    }
  };

  const handleOpenBackupDir = async () => {
    if (!backupDir) return;
    try {
      await tauriApi.revealInFolder(backupDir);
    } catch (error: any) {
      console.error("打开备份目录失败:", error);
      setBackupError(error?.message || "无法打开备份目录");
      setTimeout(() => setBackupError(null), 3000);
    }
  };

  const handleCopyBackupDir = async () => {
    if (!backupDir) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(backupDir);
      }
      setBackupMessage("已复制存储路径");
    } catch (error: any) {
      console.error("复制备份目录失败:", error);
      setBackupError(error?.message || "复制失败");
    } finally {
      setTimeout(() => {
        setBackupMessage(null);
        setBackupError(null);
      }, 3000);
    }
  };

  const handleRestoreBackup = async (path: string) => {
    setRestoringBackup(path);
    setBackupError(null);
    setBackupMessage(null);
    try {
      const dest = await tauriApi.restoreDatabaseBackup(path);
      setBackupMessage(`已还原到：${dest}`);
      await Promise.all([loadBackupList(), fetchIndexStatus(), loadFileHistoryList()]);
    } catch (error: any) {
      console.error("还原备份失败:", error);
      setBackupError(error?.message || "还原失败");
    } finally {
      setRestoringBackup(null);
      setTimeout(() => {
        setBackupMessage(null);
        setBackupError(null);
      }, 4000);
    }
  };

  const handleOpenRestoreConfirm = (path: string) => {
    setRestoreConfirmPath(path);
  };

  const handleCancelRestore = () => {
    setRestoreConfirmPath(null);
  };

  const handleConfirmRestore = async () => {
    if (!restoreConfirmPath) return;
    const path = restoreConfirmPath;
    setRestoreConfirmPath(null);
    await handleRestoreBackup(path);
  };

  const handleOpenDeleteBackupConfirm = (path: string) => {
    setDeleteBackupConfirmPath(path);
  };

  const handleCancelDeleteBackup = () => {
    setDeleteBackupConfirmPath(null);
  };

  const handleConfirmDeleteBackup = async () => {
    if (!deleteBackupConfirmPath) return;
    const path = deleteBackupConfirmPath;
    setDeleteBackupConfirmPath(null);
    await handleDeleteBackup(path);
  };

  const handleDeleteBackup = async (path: string) => {
    setDeletingBackup(path);
    setBackupError(null);
    setBackupMessage(null);
    try {
      await tauriApi.deleteDatabaseBackup(path);
      setBackupMessage("备份已删除");
      await loadBackupList();
    } catch (error: any) {
      console.error("删除备份失败:", error);
      setBackupError(error?.message || "删除失败");
    } finally {
      setDeletingBackup(null);
      setTimeout(() => {
        setBackupMessage(null);
        setBackupError(null);
      }, 4000);
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

  const handleOpenAppIndexModal = () => {
    setIsAppIndexModalOpen(true);
  };

  const handleCloseAppIndexModal = () => {
    setIsAppIndexModalOpen(false);
  };

  const handleQueryDaysAgo = () => {
    const days = parseInt(historyDaysAgo, 10);
    if (isNaN(days) || days < 0) {
      setHistoryMessage("请输入有效的天数（大于等于0）");
      setTimeout(() => setHistoryMessage(null), 3000);
      return;
    }
    
    // 计算n天前的日期（作为结束日期，查询n天前及更早的所有数据）
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - days);
    const dateStr = targetDate.toISOString().split('T')[0];
    
    // 开始日期不设置（或设置为空），结束日期设置为n天前
    // 这样会查询n天前及更早的所有历史数据
    setHistoryStartDate("");
    setHistoryEndDate(dateStr);
  };

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
      isApplyingSettingsRef.current = true;
      hasLoadedSettingsRef.current = false; // 重置标志，避免加载时触发自动保存
      const data = await tauriApi.getSettings();
      // 同步开机启动状态
      const startupEnabled = await tauriApi.isStartupEnabled();
      setSettings({
        ...data,
        startup_enabled: startupEnabled,
        result_style: (data.result_style as Settings["result_style"]) || (localStorage.getItem("result-style") as Settings["result_style"]) || "skeuomorphic",
        close_on_blur: data.close_on_blur ?? true,
      });
    } catch (error) {
      console.error("Failed to load settings:", error);
    } finally {
      setIsLoadingSettings(false);
      // 延迟清除标记，确保这轮由加载触发的设置变更不会被自动保存
      // 使用 requestAnimationFrame 确保在下一个渲染周期清除
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          isApplyingSettingsRef.current = false;
          hasLoadedSettingsRef.current = true;
        });
      });
    }
  };

  // 保存设置
  const saveSettings = useCallback(async () => {
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
  }, [settings]);

  // 设置变更自动保存（防抖处理）
  useEffect(() => {
    if (isLoadingSettings) return;
    if (isApplyingSettingsRef.current) return;

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
  }, [settings, isLoadingSettings, saveSettings]);

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

  // 加载应用快捷键
  const loadAppHotkeys = useCallback(async () => {
    try {
      // 添加超时保护：5秒超时（这个操作通常很快）
      const hotkeys = await withTimeout(
        tauriApi.getAppHotkeys(),
        5000,
        "加载应用快捷键超时"
      );
      setAppHotkeys(hotkeys);
    } catch (error) {
      console.error("Failed to load app hotkeys:", error);
      // 即使失败也设置空对象
      setAppHotkeys({});
    }
  }, []);

  // 当切换到索引分类时加载索引状态和应用快捷键
  useEffect(() => {
    if (activeCategory === "index") {
      // 优化加载顺序：先加载轻量数据，再加载重量数据
      // 1. 先加载轻量数据（快速响应）
      void loadAppHotkeys();
      void fetchIndexStatus();
      
      // 2. 延迟加载重量数据（避免阻塞 UI）
      // 使用 setTimeout 让 UI 先渲染，再加载数据
      const timer1 = setTimeout(() => {
        void loadBackupList();
      }, 100);
      
      const timer2 = setTimeout(() => {
        void loadFileHistoryList();
      }, 200);
      
      return () => {
        clearTimeout(timer1);
        clearTimeout(timer2);
      };
    }
  }, [activeCategory, loadAppHotkeys]);

  // 事件监听器已移至 AppIndexList 组件

  // 所有可用插件（排除 show_plugin_list，因为它就是用来显示插件列表的，不应该出现在列表里）
  const availablePlugins = useMemo(() => {
    return plugins.filter(plugin => plugin.id !== 'show_plugin_list');
  }, [plugins]);

  // 过滤插件
  const filteredPlugins = useMemo(() => {
    if (!searchQuery.trim()) {
      return availablePlugins;
    }
    const query = searchQuery.toLowerCase();
    return availablePlugins.filter(
      (plugin) =>
        plugin.name.toLowerCase().includes(query) ||
        plugin.description?.toLowerCase().includes(query) ||
        plugin.keywords.some((keyword) => keyword.toLowerCase().includes(query))
    );
  }, [searchQuery, availablePlugins]);

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
                共 <span className="font-medium text-green-600">{availablePlugins.length}</span> 个插件
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
      case "index": {
        const toneClassMap: Record<string, string> = {
          success: "bg-gradient-to-br from-green-50 to-green-100/70 border-green-200",
          warning: "bg-gradient-to-br from-amber-50 to-amber-100/70 border-amber-200",
          info: "bg-gradient-to-br from-blue-50 to-blue-100/70 border-blue-200",
          neutral: "bg-gradient-to-br from-slate-50 to-slate-100/70 border-slate-200",
        };
        const skeuoSurface =
          "rounded-xl border border-[#dfe3ea] bg-[linear-gradient(145deg,#fdfdff,#eef1f6)] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_12px_28px_rgba(0,0,0,0.08)]";
        const skeuoPanel =
          "rounded-2xl border border-[#dfe3ea] bg-[radial-gradient(circle_at_20%_20%,rgba(255,255,255,0.75),transparent_42%),radial-gradient(circle_at_80%_0%,rgba(255,255,255,0.55),transparent_38%),#f4f6f9] shadow-[0_18px_40px_rgba(0,0,0,0.12)]";
        return (
              <div className={`${skeuoPanel} space-y-4 p-5`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-lg font-semibold text-gray-900 drop-shadow-sm">数据概况</div>
                    <div className="text-sm text-gray-600">查看 Everything、应用缓存与文件历史的索引状态</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleRefreshIndex}
                      className="px-3.5 py-2 text-sm rounded-xl bg-gradient-to-br from-white to-[#f5f7fb] border border-[#e1e5ed] text-gray-800 shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_8px_16px_rgba(0,0,0,0.06)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_12px_22px_rgba(0,0,0,0.10)] hover:-translate-y-[1px] active:translate-y-0 active:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_6px_14px_rgba(0,0,0,0.08)] transition"
                      disabled={isLoadingIndex}
                    >
                      {isLoadingIndex ? "刷新中..." : "刷新"}
                    </button>
                    <button
                      onClick={handleRescanApplications}
                      className="px-4 py-2 text-sm rounded-xl text-green-900 bg-gradient-to-br from-emerald-50 via-emerald-50 to-emerald-100/80 border border-emerald-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_8px_14px_rgba(0,0,0,0.08)] hover:border-emerald-300 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_12px_18px_rgba(0,0,0,0.12)] hover:-translate-y-[1px] active:translate-y-0 active:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_7px_14px_rgba(0,0,0,0.08)] transition"
                      disabled={isLoadingIndex}
                    >
                      重新扫描应用
                    </button>
                  </div>
                </div>

                {indexError && (
                  <div className="p-3 rounded-lg bg-gradient-to-r from-red-50 to-red-100/70 border border-red-200 text-sm text-red-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_8px_20px_rgba(239,68,68,0.15)]">
                    {indexError}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                  {indexSummaryCards.map((card) => {
                    const toneClass = toneClassMap[card.tone] || toneClassMap.neutral;
                    return (
                      <div
                        key={card.title}
                        className={`p-4 ${skeuoSurface} ${toneClass} shadow-[inset_0_1px_0_rgba(255,255,255,0.92),0_14px_28px_rgba(0,0,0,0.12)]`}
                      >
                        <div className="text-xs font-medium uppercase tracking-wide text-gray-600">
                          {card.title}
                        </div>
                        <div className="mt-2 flex items-baseline gap-2">
                          <div className="text-2xl font-semibold text-gray-900">{card.value}</div>
                          <div className="text-xs text-gray-600 truncate">{card.helper}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className={`p-4 ${skeuoSurface}`}>
                    <div className="flex items-center justify-between mb-3">
                      <div className="font-semibold text-gray-900">Everything 索引</div>
                      <span className={`text-xs px-2 py-1 rounded-full ${indexStatus?.everything?.available ? "bg-green-50 text-green-700 border border-green-200" : "bg-yellow-50 text-yellow-700 border border-yellow-200"}`}>
                        {indexStatus?.everything?.available ? "可用" : "不可用"}
                      </span>
                    </div>
                    <div className="space-y-1 text-sm text-gray-700">
                      <div>版本：{indexStatus?.everything?.version || "未知"}</div>
                      <div className="break-all">路径：{indexStatus?.everything?.path || "未找到"}</div>
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

                  <div className={`p-4 ${skeuoSurface}`}>
                    <div className="flex items-center justify-between mb-3">
                      <div className="font-semibold text-gray-900">应用索引</div>
                      <span className="text-xs px-2 py-1 rounded-full bg-gray-50 text-gray-700 border border-gray-200">
                        {indexStatus?.applications?.total ?? 0} 条
                      </span>
                    </div>
                    <div className="space-y-1 text-sm text-gray-700">
                      <div className="break-all">缓存文件：{indexStatus?.applications?.cache_file || "未生成"}</div>
                      <div>更新时间：{formatTimestamp(indexStatus?.applications?.cache_mtime)}</div>
                    </div>
                    <button
                      onClick={handleOpenAppIndexModal}
                      className="mt-3 px-3 py-2 text-xs rounded-lg bg-white text-gray-700 border border-gray-200 hover:border-gray-300 hover:shadow-sm transition w-full text-left flex items-center justify-between"
                      disabled={isLoadingIndex}
                    >
                      <span>查看索引列表</span>
                      <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </div>

                  <div className={`p-4 ${skeuoSurface} md:col-span-2`}>
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <div className="font-semibold text-gray-900">数据库备份</div>
                        <button
                          type="button"
                          aria-label="备份说明"
                          title="备份包含：设置、快捷方式、文件历史、打开历史、备忘录、窗口位置；不包含：应用索引缓存(app_cache.json)、录制文件、插件目录。还原会覆盖当前数据库。"
                          className="w-6 h-6 flex items-center justify-center text-[11px] rounded-full bg-gray-100 text-gray-600 border border-gray-200 hover:border-gray-300"
                        >
                          ?
                        </button>
                      </div>
                      <span className="text-xs px-2 py-1 rounded-full bg-gray-50 text-gray-700 border border-gray-200">
                        {backupList.length} 份
                      </span>
                    </div>
                    <div className="space-y-1 text-sm text-gray-700">
                      <div className="break-all flex flex-wrap items-center gap-2">
                        <span>存储路径：{backupDir || "未生成"}</span>
                        {backupDir && (
                          <>
                            <button
                              onClick={handleOpenBackupDir}
                              className="px-2.5 py-1 text-[11px] rounded border border-gray-200 text-blue-600 hover:border-blue-300 hover:text-blue-700 transition"
                            >
                              打开
                            </button>
                            <button
                              onClick={handleCopyBackupDir}
                              className="px-2.5 py-1 text-[11px] rounded border border-gray-200 text-gray-700 hover:border-gray-300 transition"
                            >
                              复制路径
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 items-center">
                      <button
                        onClick={loadBackupList}
                        className="px-3 py-2 text-xs rounded-lg bg-white text-gray-800 border border-gray-200 hover:border-gray-300 transition"
                        disabled={isLoadingBackups}
                      >
                        {isLoadingBackups ? "加载中..." : "刷新列表"}
                      </button>
                      <button
                        onClick={handleBackupDatabase}
                        className="px-3 py-2 text-xs rounded-lg bg-emerald-500 text-white border border-emerald-500 shadow-[0_6px_14px_rgba(16,185,129,0.2)] hover:bg-emerald-600 hover:border-emerald-600 transition"
                        disabled={isBackingUpDb}
                      >
                        {isBackingUpDb ? "备份中..." : "立即备份"}
                      </button>
                      {(backupMessage || backupError) && (
                        <div
                          className={`w-full text-xs px-3 py-2 rounded-lg border ${
                            backupError
                              ? "bg-red-50 text-red-700 border-red-200"
                              : "bg-green-50 text-green-700 border-green-200"
                          }`}
                        >
                          {backupError || backupMessage}
                        </div>
                      )}
                    </div>
                    <div className="mt-3 border-t border-gray-100 pt-3 max-h-48 overflow-auto">
                      {isLoadingBackups && <div className="text-xs text-gray-500">加载中...</div>}
                      {!isLoadingBackups && backupList.length === 0 && (
                        <div className="text-xs text-gray-500">暂无备份，点击“立即备份”生成第一份备份。</div>
                      )}
                      {!isLoadingBackups && backupList.length > 0 && (
                        <div className="space-y-2 text-xs text-gray-700">
                          {backupList.slice(0, 30).map((item) => (
                            <div
                              key={item.path}
                              className="p-2 rounded-md border border-gray-100 hover:border-gray-200 hover:bg-slate-50 transition"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="font-medium text-gray-900 truncate" title={item.name}>
                                    {item.name}
                                  </div>
                                  <div className="text-gray-500 break-all text-[11px]" title={item.path}>
                                    {item.path}
                                  </div>
                                </div>
                                <div className="text-[11px] text-gray-500 whitespace-nowrap">
                                  {formatBytes(item.size)} · {formatTimestamp(item.modified)}
                                </div>
                              </div>
                              <div className="mt-2 flex items-center justify-between gap-3">
                                <div className="text-[11px] text-gray-400 truncate">
                                  更新时间 {formatTimestamp(item.modified)}
                                </div>
                                <div className="flex gap-2 shrink-0">
                                  <button
                                    onClick={() => handleOpenRestoreConfirm(item.path)}
                                    className="px-2.5 py-1 text-[11px] rounded border border-gray-200 hover:border-gray-300 text-green-700 bg-white"
                                    disabled={restoringBackup === item.path || deletingBackup === item.path}
                                  >
                                    {restoringBackup === item.path ? "还原中..." : "还原"}
                                  </button>
                                  <button
                                    onClick={() => handleOpenDeleteBackupConfirm(item.path)}
                                    className="px-2.5 py-1 text-[11px] rounded border border-gray-200 hover:border-gray-300 text-red-600 bg-white"
                                    disabled={restoringBackup === item.path || deletingBackup === item.path}
                                  >
                                    {deletingBackup === item.path ? "删除中..." : "删除"}
                                  </button>
                                </div>
                              </div>
                            </div>
                          ))}
                          {backupList.length > 30 && (
                            <div className="text-gray-400 text-[11px]">
                              已显示前 30 条，共 {backupList.length} 条
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className={`p-4 ${skeuoSurface} md:col-span-2`}>
                    <div className="flex items-center justify-between mb-3">
                      <div className="font-semibold text-gray-900">文件历史</div>
                      <span className="text-xs px-2 py-1 rounded-full bg-gray-50 text-gray-700 border border-gray-200">
                        {(historyStartDate || historyEndDate) 
                          ? `${filteredHistoryItems.length} / ${indexStatus?.file_history?.total ?? 0} 条`
                          : `${indexStatus?.file_history?.total ?? 0} 条`}
                      </span>
                    </div>
                    <div className="space-y-1 text-sm text-gray-700">
                      <div className="break-all">存储路径：{indexStatus?.file_history?.path || "未生成"}</div>
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
                      <div className="flex items-center gap-1 border border-gray-200 rounded-lg px-2 py-1">
                        <input
                          type="number"
                          value={historyDaysAgo}
                          onChange={(e) => setHistoryDaysAgo(e.target.value)}
                          placeholder="天数"
                          min="0"
                          className="w-16 px-1 py-0.5 text-xs border-0 focus:outline-none focus:ring-0"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              handleQueryDaysAgo();
                            }
                          }}
                        />
                        <span className="text-xs text-gray-500">天前</span>
                        <button
                          onClick={handleQueryDaysAgo}
                          className="px-2 py-0.5 text-xs rounded bg-blue-50 text-blue-700 hover:bg-blue-100 transition"
                        >
                          查询
                        </button>
                      </div>
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
      }
      case "statistics": {
        const summaryCards = [
          {
            title: "用户总数",
            value: isLoadingUsersCount ? "加载中..." : usersCount !== null ? usersCount.toLocaleString() : "—",
            desc: statsError ? `获取失败：${statsError}` : "按时间范围统计去重用户数",
          },
          { title: "活跃趋势", value: "开发中", desc: "计划支持日/周/月活跃与留存" },
          { title: "功能热度", value: "规划中", desc: "用于了解功能点击、使用占比" },
        ];

        const roadmap = [
          "用户增长与活跃趋势图表",
          "核心功能/插件的使用统计",
          "渠道来源及版本分布",
          "导出报表与自定义时间范围",
        ];

        return (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-gray-900">统计概览</div>
                <div className="text-sm text-gray-500">统计用户数、活跃度等数据</div>
              </div>
              <span className="px-2 py-1 text-xs rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                早期版本
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {summaryCards.map((card) => (
                <div key={card.title} className="p-4 rounded-xl border border-gray-200 bg-white shadow-sm">
                  <div className="text-sm text-gray-500">{card.title}</div>
                  <div className="mt-2 text-2xl font-semibold text-gray-900">{card.value}</div>
                  <div className="mt-1 text-xs text-gray-500">{card.desc}</div>
                </div>
              ))}
            </div>

            <div className="p-4 rounded-xl border border-gray-200 bg-white shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-gray-900">插件使用次数</div>
                  <div className="text-sm text-gray-500">基于本地 SQLite 的启动次数统计，先运行任意插件后会出现数据</div>
                </div>
                <div className="flex items-center gap-2">
                  {pluginUsageError && <span className="text-xs text-red-500">{pluginUsageError}</span>}
                  <button
                    onClick={() => void loadPluginUsage()}
                    className="px-3 py-2 text-xs rounded-lg bg-blue-50 text-blue-700 border border-blue-200 hover:border-blue-300 transition disabled:opacity-50"
                    disabled={isLoadingPluginUsage}
                  >
                    {isLoadingPluginUsage ? "刷新中..." : "刷新"}
                  </button>
                </div>
              </div>

              <div className="mt-3">
                {isLoadingPluginUsage && <div className="text-xs text-gray-500">加载中...</div>}
                {!isLoadingPluginUsage && pluginUsageError && (
                  <div className="text-xs text-red-500">{pluginUsageError}</div>
                )}
                {!isLoadingPluginUsage && !pluginUsageError && pluginUsage.length === 0 && (
                  <div className="text-xs text-gray-500">
                    暂无插件使用数据，尝试执行一个插件后再点击右上角刷新
                  </div>
                )}
                {!isLoadingPluginUsage && pluginUsage.length > 0 && (
                  <div className="space-y-3">
                    {(() => {
                      const maxCount = Math.max(...pluginUsage.map((p) => p.openCount), 1);
                      const barColors = [
                        "bg-blue-500",
                        "bg-green-500",
                        "bg-indigo-500",
                        "bg-amber-500",
                        "bg-purple-500",
                        "bg-rose-500",
                      ];
                      return pluginUsage.slice(0, 20).map((item, idx) => {
                        const displayName = item.name || pluginNameMap.get(item.pluginId) || item.pluginId;
                        const widthPercent = Math.max(6, Math.round((item.openCount / maxCount) * 100));
                        const colorClass = barColors[idx % barColors.length];
                        return (
                          <div key={item.pluginId} className="space-y-1">
                            <div className="flex items-center justify-between text-xs text-gray-600">
                              <div className="truncate pr-2 font-medium text-gray-900">{displayName}</div>
                              <div className="flex items-center gap-2">
                                <span className="text-gray-500">{item.openCount.toLocaleString()}</span>
                                <span className="text-[11px] text-gray-400">累计次数</span>
                              </div>
                            </div>
                            <div className="w-full h-2 rounded-full bg-gray-100 overflow-hidden">
                              <div
                                className={`h-2 rounded-full ${colorClass} transition-all`}
                                style={{ width: `${widthPercent}%` }}
                                aria-label={`${displayName} 使用 ${item.openCount} 次`}
                              />
                            </div>
                            <div className="text-[11px] text-gray-400">
                              最近使用 {formatTimestamp(item.lastOpened)}
                            </div>
                          </div>
                        );
                      });
                    })()}
                    {pluginUsage.length > 20 && (
                      <div className="text-[11px] text-gray-400">已显示前 20 个插件</div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="p-4 rounded-xl border border-dashed border-gray-200 bg-white shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-gray-900">功能规划</div>
                  <div className="text-sm text-gray-500">正在设计统计能力，后续版本陆续上线</div>
                </div>
                <button
                  type="button"
                  disabled
                  className="px-3 py-2 text-xs rounded-lg bg-gray-100 text-gray-500 border border-gray-200 cursor-not-allowed"
                >
                  敬请期待
                </button>
              </div>
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                {roadmap.map((item, idx) => (
                  <div
                    key={idx}
                    className="flex items-start gap-2 p-3 rounded-lg bg-gray-50 text-sm text-gray-700 border border-gray-100"
                  >
                    <span className="mt-1 w-2 h-2 rounded-full bg-green-500" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      }
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

      <ConfirmDialog
        isOpen={isDeleteConfirmOpen}
        title="确认删除"
        message={`确认删除当前筛选的 ${pendingDeleteCount} 条记录？该操作不可恢复。`}
        confirmText="确认删除"
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />

      <ConfirmDialog
        isOpen={!!restoreConfirmPath}
        title="确认还原"
        message="将用此备份覆盖当前数据库，操作不可撤销。"
        detail={restoreConfirmPath || undefined}
        confirmText="确认还原"
        onConfirm={handleConfirmRestore}
        onCancel={handleCancelRestore}
      />

      <ConfirmDialog
        isOpen={!!deleteBackupConfirmPath}
        title="确认删除备份"
        message="删除后无法恢复此备份文件，确定继续吗？"
        detail={deleteBackupConfirmPath || undefined}
        confirmText="确认删除"
        onConfirm={handleConfirmDeleteBackup}
        onCancel={handleCancelDeleteBackup}
      />

      <AppIndexList
        isOpen={isAppIndexModalOpen}
        onClose={handleCloseAppIndexModal}
        appHotkeys={appHotkeys}
        onHotkeysChange={setAppHotkeys}
      />
    </>
  );
}

