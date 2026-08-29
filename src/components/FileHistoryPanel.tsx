import { useState, useMemo, useEffect, useCallback } from "react";
import type { IndexStatus, FileHistoryItem } from "../types";
import { tauriApi } from "../api/tauri";
import { ConfirmDialog } from "./ConfirmDialog";
import { formatSimpleDateTime } from "../utils/dateUtils";
import { isFolderLikePath } from "../utils/launcherUtils";

interface FileHistoryPanelProps {
  indexStatus?: IndexStatus | null;
  skeuoSurface?: string;
  onRefresh?: () => Promise<void> | void;
}

// 列表每页渲染条数（避免大量数据一次性渲染导致卡顿）
const PAGE_SIZE = 50;

const CATEGORY_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "url", label: "URL" },
  { value: "exe", label: "EXE" },
  { value: "folder", label: "文件夹" },
  { value: "image", label: "图片" },
  { value: "other", label: "其他" },
] as const;

// 格式化时间戳
const formatTimestamp = (timestamp?: number | null) => {
  if (!timestamp) return "暂无";
  return formatSimpleDateTime(timestamp);
};

// 格式化为相对时间（如「3 小时前」超过30天则显示绝对日期）
const formatRelativeTime = (timestamp?: number | null) => {
  if (!timestamp) return "暂无";
  const diffSec = Math.floor(Date.now() / 1000 - timestamp);
  if (diffSec < 60) return "刚刚";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  if (diffSec < 2592000) return `${Math.floor(diffSec / 86400)} 天前`;
  return formatSimpleDateTime(timestamp);
};

// 解析日期范围为时间戳
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

// 判断记录的最后使用时间是否落在 [start, end] 范围内（列表筛选与汇总统计共用）
const matchRange = (lastUsed: number, start?: number, end?: number): boolean => {
  if (start !== undefined && lastUsed < start) return false;
  if (end !== undefined && lastUsed > end) return false;
  return true;
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

// 判断是否是文件夹的辅助函数（优先使用 is_folder，如果为 null 则使用 isFolderLikePath）
const isItemFolder = (item: FileHistoryItem): boolean => {
  if (item.is_folder !== null && item.is_folder !== undefined) {
    return item.is_folder;
  }
  // 如果 is_folder 为 null/undefined，使用路径特征判断
  return isFolderLikePath(item.path);
};

// 判断是否是图片文件的辅助函数
const isImageFile = (path: string): boolean => {
  const pathLower = path.toLowerCase();
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff', '.tif', '.heic', '.heif'];
  return imageExtensions.some(ext => pathLower.endsWith(ext));
};

export function FileHistoryPanel({ indexStatus, skeuoSurface = "bg-white rounded-lg border border-gray-200 shadow-sm", onRefresh, refreshKey }: FileHistoryPanelProps & { refreshKey?: number }) {
  const [fileHistoryItems, setFileHistoryItems] = useState<FileHistoryItem[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyStartDate, setHistoryStartDate] = useState<string>("");
  const [historyEndDate, setHistoryEndDate] = useState<string>("");
  const [historyDaysAgo, setHistoryDaysAgo] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [categoryFilter, setCategoryFilter] = useState<"all" | "url" | "exe" | "folder" | "image" | "other">("all");
  const [isDeletingHistory, setIsDeletingHistory] = useState(false);
  const [historyMessage, setHistoryMessage] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<"time" | "count">("time");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [pendingDeleteCount, setPendingDeleteCount] = useState(0);
  const [isSingleDeleteConfirmOpen, setIsSingleDeleteConfirmOpen] = useState(false);
  const [pendingDeleteItem, setPendingDeleteItem] = useState<FileHistoryItem | null>(null);

  const loadFileHistoryList = useCallback(async () => {
    try {
      setIsLoadingHistory(true);
      // 添加超时保护：15秒超时（文件历史可能数据量大）
      const list = await withTimeout(
        tauriApi.getAllFileHistory(),
        15000,
        "加载文件历史超时，数据量可能较大，请稍后重试"
      );
      // 后端已按时间排序，这里再保险按 last_used 降序作为基础顺序
      const sorted = [...list].sort((a, b) => b.last_used - a.last_used);
      setFileHistoryItems(sorted);
    } catch (error: any) {
      console.error("加载文件历史失败:", error);
      setHistoryMessage(error?.message || "加载文件历史失败");
      // 即使失败也设置空数组，避免 UI 显示异常
      setFileHistoryItems([]);
    } finally {
      setIsLoadingHistory(false);
    }
  }, []);

  // 组件挂载时或 refreshKey 变化时加载文件历史
  useEffect(() => {
    // 延迟加载文件历史（重量数据），让 UI 先渲染
    const timer = setTimeout(() => {
      void loadFileHistoryList();
    }, 100);
    return () => clearTimeout(timer);
  }, [loadFileHistoryList, refreshKey]);

  // 筛选条件变化时重置分页
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [historyStartDate, historyEndDate, historyDaysAgo, searchQuery, categoryFilter, sortOrder]);

  const handleQueryDaysAgo = useCallback((daysValue?: string) => {
    const value = daysValue !== undefined ? daysValue : historyDaysAgo;
    // 如果天数为空，则查询所有
    if (!value || value.trim() === "") {
      setHistoryStartDate("");
      setHistoryEndDate("");
      return;
    }
    
    // 如果天数不为空，验证是否为有效的数字且 >= 0
    const days = parseInt(value, 10);
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
  }, [historyDaysAgo]);

  // 获取日期范围的辅助函数（确保与查询逻辑完全一致）
  const getPeriodDateRange = useCallback((period: '5days' | '5-10days' | '10-30days' | '30days') => {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    
    switch (period) {
      case '5days': {
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - 5);
        return {
          startDate: startDate.toISOString().split('T')[0],
          endDate: todayStr,
          daysAgo: "5",
        };
      }
      case '5-10days': {
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - 10);
        startDate.setHours(0, 0, 0, 0);
        const endDate = new Date(now);
        endDate.setDate(endDate.getDate() - 5);
        endDate.setHours(23, 59, 59, 999);
        const range = {
          startDate: startDate.toISOString().split('T')[0],
          endDate: endDate.toISOString().split('T')[0],
          daysAgo: "10",
        };
        console.log('5-10天筛选日期范围:', {
          开始日期: range.startDate,
          结束日期: range.endDate,
          开始时间: startDate.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
          结束时间: endDate.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
          开始时间戳: Math.floor(startDate.getTime() / 1000),
          结束时间戳: Math.floor(endDate.getTime() / 1000),
        });
        return range;
      }
      case '10-30days': {
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - 30);
        const endDate = new Date(now);
        endDate.setDate(endDate.getDate() - 10);
        return {
          startDate: startDate.toISOString().split('T')[0],
          endDate: endDate.toISOString().split('T')[0],
          daysAgo: "30",
        };
      }
      case '30days': {
        const endDate = new Date(now);
        endDate.setDate(endDate.getDate() - 30);
        return {
          startDate: "",
          endDate: endDate.toISOString().split('T')[0],
          daysAgo: "30",
        };
      }
    }
  }, []);

  // 处理点击汇总统计的时间段，自动查询（清空天数输入框）
  const handleClickSummaryPeriod = useCallback((period: '5days' | '5-10days' | '10-30days' | '30days') => {
    const range = getPeriodDateRange(period);
    setHistoryDaysAgo(""); // 清空天数输入框
    setHistoryStartDate(range.startDate);
    setHistoryEndDate(range.endDate);
  }, [getPeriodDateRange]);

  const filteredHistoryItems = useMemo(() => {
    const { start, end } = parseDateRangeToTs(historyStartDate, historyEndDate);
    const filtered = fileHistoryItems.filter((item) => {
      // 日期过滤
      if (!matchRange(item.last_used, start, end)) return false;

      // 分类过滤
      if (categoryFilter !== "all") {
        const pathLower = item.path.toLowerCase();
        if (categoryFilter === "url") {
          if (!(pathLower.startsWith("http://") || pathLower.startsWith("https://"))) {
            return false;
          }
        } else if (categoryFilter === "exe") {
          if (!pathLower.endsWith(".exe")) {
            return false;
          }
        } else if (categoryFilter === "folder") {
          if (!isItemFolder(item)) {
            return false;
          }
        } else if (categoryFilter === "image") {
          if (!isImageFile(item.path)) {
            return false;
          }
        } else if (categoryFilter === "other") {
          // 其他类型：既不是 URL，也不是 exe，也不是文件夹，也不是图片
          if (pathLower.startsWith("http://") || pathLower.startsWith("https://") ||
              pathLower.endsWith(".exe") || isItemFolder(item) || isImageFile(item.path)) {
            return false;
          }
        }
      }

      // 文件名搜索过滤
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        return item.name.toLowerCase().includes(query) || item.path.toLowerCase().includes(query);
      }

      return true;
    });
    // 排序：使用次数降序（并列时按时间降序）或时间降序
    if (sortOrder === "count") {
      filtered.sort((a, b) => (b.use_count - a.use_count) || (b.last_used - a.last_used));
    }
    return filtered;
  }, [fileHistoryItems, historyStartDate, historyEndDate, searchQuery, categoryFilter, sortOrder]);

  // 计算不同时间段的数据汇总（使用与查询完全相同的逻辑）
  const historySummary = useMemo(() => {
    // 使用与点击按钮相同的日期范围计算逻辑
    const range5Days = getPeriodDateRange('5days');
    const range5_10Days = getPeriodDateRange('5-10days');
    const range10_30Days = getPeriodDateRange('10-30days');
    const range30Days = getPeriodDateRange('30days');

    // 使用与 filteredHistoryItems 相同的过滤逻辑
    const { start: start5Days, end: end5Days } = parseDateRangeToTs(range5Days.startDate, range5Days.endDate);
    const { start: start5_10Days, end: end5_10Days } = parseDateRangeToTs(range5_10Days.startDate, range5_10Days.endDate);
    const { start: start10_30Days, end: end10_30Days } = parseDateRangeToTs(range10_30Days.startDate, range10_30Days.endDate);
    const { end: end30Days } = parseDateRangeToTs(range30Days.startDate, range30Days.endDate);

    let count5Days = 0;
    let count5_10Days = 0;
    let count10_30Days = 0;
    let count30DaysOlder = 0;

    // 每个时间段独立计算，只根据时间范围判断，不互相影响
    fileHistoryItems.forEach((item) => {
      // 近5天
      if (matchRange(item.last_used, start5Days, end5Days)) {
        count5Days++;
      }
      // 5-10天
      if (matchRange(item.last_used, start5_10Days, end5_10Days)) {
        count5_10Days++;
      }
      // 10-30天
      if (matchRange(item.last_used, start10_30Days, end10_30Days)) {
        count10_30Days++;
      }
      // 30天前（只有 end，没有 start）
      if (end30Days !== undefined && item.last_used <= end30Days) {
        count30DaysOlder++;
      }
    });

    return {
      fiveDaysAgo: count5Days,
      tenDaysAgo: count5_10Days,
      thirtyDaysAgo: count10_30Days,
      older: count30DaysOlder,
    };
  }, [fileHistoryItems, getPeriodDateRange]);

  const handlePurgeHistory = useCallback(async () => {
    try {
      setIsDeletingHistory(true);
      setHistoryMessage(null);
      
      // 基于当前筛选结果进行删除，确保与显示的列表完全一致
      // 逐个删除（或者可以批量删除，但后端目前只支持单个删除）
      // 所有数据现在都在 open_history 中，统一使用 deleteFileHistory
      let deletedCount = 0;
      for (const item of filteredHistoryItems) {
        try {
          await tauriApi.deleteFileHistory(item.path);
          deletedCount++;
        } catch (error) {
          console.error(`删除文件历史失败: ${item.path}`, error);
          // 继续删除其他项，不因单个失败而停止
        }
      }
      
      setHistoryMessage(`已删除 ${deletedCount} 条记录`);
      await loadFileHistoryList();
      if (onRefresh) {
        onRefresh();
      }
    } catch (error: any) {
      console.error("删除文件历史失败:", error);
      setHistoryMessage(error?.message || "删除文件历史失败");
    } finally {
      setIsDeletingHistory(false);
      setTimeout(() => setHistoryMessage(null), 3000);
    }
  }, [filteredHistoryItems, loadFileHistoryList, onRefresh]);

  const handleOpenDeleteConfirm = useCallback(() => {
    if (!historyStartDate && !historyEndDate && !historyDaysAgo && !searchQuery && categoryFilter === "all") {
      setHistoryMessage("请先选择筛选条件或输入搜索关键词");
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
  }, [historyStartDate, historyEndDate, historyDaysAgo, searchQuery, categoryFilter, filteredHistoryItems]);

  const handleConfirmDelete = useCallback(async () => {
    setIsDeleteConfirmOpen(false);
    await handlePurgeHistory();
  }, [handlePurgeHistory]);

  const handleCancelDelete = useCallback(() => {
    setIsDeleteConfirmOpen(false);
  }, []);

  const handleOpenSingleDeleteConfirm = useCallback((item: FileHistoryItem) => {
    setPendingDeleteItem(item);
    setIsSingleDeleteConfirmOpen(true);
  }, []);

  const handleConfirmSingleDelete = useCallback(async () => {
    if (!pendingDeleteItem) return;
    
    try {
      setIsDeletingHistory(true);
      setHistoryMessage(null);
      
      // 所有数据现在都在 open_history 中，统一使用 deleteFileHistory
      await tauriApi.deleteFileHistory(pendingDeleteItem.path);
      
      setHistoryMessage(`已删除文件历史记录: ${pendingDeleteItem.name}`);
      await loadFileHistoryList();
      if (onRefresh) {
        onRefresh();
      }
    } catch (error: any) {
      console.error("删除文件历史失败:", error);
      setHistoryMessage(error?.message || "删除文件历史失败");
    } finally {
      setIsDeletingHistory(false);
      setIsSingleDeleteConfirmOpen(false);
      setPendingDeleteItem(null);
      setTimeout(() => setHistoryMessage(null), 3000);
    }
  }, [pendingDeleteItem, loadFileHistoryList, onRefresh]);

  const handleCancelSingleDelete = useCallback(() => {
    setIsSingleDeleteConfirmOpen(false);
    setPendingDeleteItem(null);
  }, []);

  // 打开记录（URL 用浏览器打开，本地路径用系统默认方式打开）
  const handleOpenItem = useCallback(async (item: FileHistoryItem) => {
    try {
      const pathLower = item.path.toLowerCase();
      if (pathLower.startsWith("http://") || pathLower.startsWith("https://")) {
        await tauriApi.openUrl(item.path);
      } else {
        await tauriApi.launchFile(item.path);
      }
    } catch (error: any) {
      console.error("打开文件历史记录失败:", error);
      setHistoryMessage(error?.message || "打开失败，文件可能已不存在");
      setTimeout(() => setHistoryMessage(null), 3000);
    }
  }, []);

  // 判断当前日期筛选是否来自某个时段按钮（用于回显选中态）
  const activePeriod = useMemo<'5days' | '5-10days' | '10-30days' | '30days' | null>(() => {
    if (!historyStartDate && !historyEndDate) return null;
    const periods = ['5days', '5-10days', '10-30days', '30days'] as const;
    for (const period of periods) {
      const range = getPeriodDateRange(period);
      if (range.startDate === historyStartDate && range.endDate === historyEndDate) {
        return period;
      }
    }
    return null;
  }, [historyStartDate, historyEndDate, getPeriodDateRange]);

  const hasActiveFilter = Boolean(
    historyStartDate || historyEndDate || historyDaysAgo || searchQuery || categoryFilter !== "all"
  );

  return (
    <>
      <div className={`p-4 ${skeuoSurface} md:col-span-2`}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-baseline gap-2 min-w-0">
            <div className="font-semibold text-gray-900 shrink-0">文件历史</div>
            <div className="flex items-center gap-1.5 text-xs text-gray-400 min-w-0">
              <span className="truncate" title={indexStatus?.file_history?.path || ""}>
                {indexStatus?.file_history?.path || "未生成"}
              </span>
              <span>·</span>
              <span className="shrink-0">更新 {formatTimestamp(indexStatus?.file_history?.mtime)}</span>
            </div>
          </div>
          <span className="text-xs px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100 shrink-0 font-medium">
            {hasActiveFilter
              ? `${filteredHistoryItems.length} / ${indexStatus?.file_history?.total ?? 0} 条`
              : `${indexStatus?.file_history?.total ?? 0} 条`}
          </span>
        </div>
        {!isLoadingHistory && fileHistoryItems.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {([
              { period: '5days', label: '近5天', count: historySummary.fiveDaysAgo },
              { period: '5-10days', label: '5-10天', count: historySummary.tenDaysAgo },
              { period: '10-30days', label: '10-30天', count: historySummary.thirtyDaysAgo },
              { period: '30days', label: '30天前', count: historySummary.older },
            ] as const).map(({ period, label, count }) => {
              const isActive = activePeriod === period;
              const isDisabled = period === '30days' && count === 0;
              return (
                <button
                  key={period}
                  onClick={() => handleClickSummaryPeriod(period)}
                  className={`inline-flex items-center gap-1.5 h-8 px-3.5 text-xs rounded-full transition-all duration-200 active:scale-[0.97] ${
                    isDisabled
                      ? 'bg-gray-50 text-gray-400 cursor-not-allowed opacity-60'
                      : isActive
                        ? 'bg-indigo-600 text-white font-medium shadow-[0_2px_8px_rgba(79,70,229,0.4)] cursor-pointer'
                        : 'bg-indigo-50/70 text-indigo-900 cursor-pointer hover:bg-indigo-100'
                  }`}
                  disabled={isDisabled}
                >
                  <span className="font-medium">{label}</span>
                  <span className={`inline-flex items-center justify-center min-w-[22px] h-5 px-1.5 rounded-full text-[10px] font-bold transition-colors ${
                    isDisabled
                      ? 'bg-gray-200 text-gray-400'
                      : isActive
                        ? 'bg-white/25 text-white'
                        : 'bg-indigo-200/80 text-indigo-800'
                  }`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <div className="mt-3 flex flex-col gap-3">
          {/* 第一行：分类筛选和搜索 */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* 分类筛选 Chips */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {CATEGORY_OPTIONS.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setCategoryFilter(value)}
                  className={`px-3.5 h-7 inline-flex items-center text-xs rounded-full border transition-all duration-200 ${
                    categoryFilter === value
                      ? "bg-indigo-600 text-white font-medium border-indigo-600 shadow-[0_1px_4px_rgba(79,70,229,0.35)]"
                      : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50 hover:border-gray-400"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* 搜索框（Material 圆角填充样式） */}
            <div className="relative group">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                }}
                placeholder="搜索文件名..."
                className="w-48 h-8 px-3 pl-8 text-xs border border-transparent rounded-full bg-gray-100/90 text-gray-700 placeholder:text-gray-400 focus:outline-none focus:bg-white focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/15 transition-all"
              />
              <svg
                className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-gray-400 group-focus-within:text-indigo-500 transition-colors"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 p-0.5 rounded-full hover:bg-gray-200/70 transition-all"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {/* 第二行：日期筛选和操作 */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 text-gray-500">
              <span className="text-xs">最近</span>
              <input
                type="number"
                value={historyDaysAgo}
                onChange={(e) => {
                  const newValue = e.target.value;
                  setHistoryDaysAgo(newValue);
                  handleQueryDaysAgo(newValue);
                }}
                placeholder="0"
                min="0"
                className="w-14 h-7 px-1.5 text-xs text-center bg-gray-100/90 border border-transparent rounded-full text-gray-700 focus:outline-none focus:bg-white focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/15 transition-all"
              />
              <span className="text-xs">天</span>
            </div>

            <div className="flex items-center gap-1.5">
              <input
                type="date"
                value={historyStartDate}
                onChange={(e) => {
                  setHistoryStartDate(e.target.value);
                }}
                className="h-7 px-2.5 text-xs bg-gray-100/90 border border-transparent rounded-full text-gray-700 focus:outline-none focus:bg-white focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/15 transition-all"
              />
              <span className="text-xs text-gray-400">至</span>
              <input
                type="date"
                value={historyEndDate}
                onChange={(e) => {
                  setHistoryEndDate(e.target.value);
                }}
                className="h-7 px-2.5 text-xs bg-gray-100/90 border border-transparent rounded-full text-gray-700 focus:outline-none focus:bg-white focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/15 transition-all"
              />
            </div>

            <div className="flex-1"></div>

            {/* 排序切换 */}
            <div className="flex items-center rounded-full bg-indigo-50/70 p-0.5">
              <button
                onClick={() => setSortOrder("time")}
                className={`px-3 h-6 text-xs rounded-full transition-all ${
                  sortOrder === "time"
                    ? "bg-indigo-600 text-white font-medium shadow-[0_1px_4px_rgba(79,70,229,0.35)]"
                    : "text-indigo-900/60 hover:text-indigo-900"
                }`}
                title="按最后使用时间降序"
              >
                时间
              </button>
              <button
                onClick={() => setSortOrder("count")}
                className={`px-3 h-6 text-xs rounded-full transition-all ${
                  sortOrder === "count"
                    ? "bg-indigo-600 text-white font-medium shadow-[0_1px_4px_rgba(79,70,229,0.35)]"
                    : "text-indigo-900/60 hover:text-indigo-900"
                }`}
                title="按使用次数降序"
              >
                次数
              </button>
            </div>

            {hasActiveFilter && (
              <button
                onClick={() => {
                  setHistoryDaysAgo("");
                  setHistoryStartDate("");
                  setHistoryEndDate("");
                  setSearchQuery("");
                  setCategoryFilter("all");
                }}
                className="flex items-center gap-1 px-2.5 h-7 text-xs font-medium text-indigo-600 hover:bg-indigo-50 rounded-full transition-all"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                清除筛选
              </button>
            )}

            <button
              onClick={handleOpenDeleteConfirm}
              className="flex items-center gap-1 px-3 h-7 text-xs font-medium text-red-600 hover:bg-red-50 rounded-full transition-all active:scale-[0.97]"
              disabled={isDeletingHistory}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              {isDeletingHistory ? "删除中..." : "删除结果"}
            </button>
          </div>

          {historyMessage && (
            <div className="text-xs text-indigo-700 bg-indigo-50 px-3 py-1.5 rounded-lg flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {historyMessage}
            </div>
          )}
        </div>
        <div className="mt-3 border-t border-indigo-100/60 pt-3 h-96 overflow-y-auto">
          {isLoadingHistory && <div className="text-xs text-gray-400">加载中...</div>}
          {!isLoadingHistory && filteredHistoryItems.length === 0 && (
            <div className="text-xs text-gray-400">暂无历史记录</div>
          )}
          {!isLoadingHistory && filteredHistoryItems.length > 0 && (
            <div className="space-y-0.5">
              {filteredHistoryItems.slice(0, visibleCount).map((item, index) => {
                const isUrl = item.path.match(/^https?:\/\//i) !== null;
                const isExe = item.path.toLowerCase().endsWith(".exe");
                const isFolder = isItemFolder(item);
                const isImg = isImageFile(item.path);
                const badgeCls = isUrl
                  ? "text-blue-600 bg-blue-50"
                  : isExe
                    ? "text-purple-600 bg-purple-50"
                    : isFolder
                      ? "text-amber-600 bg-amber-50"
                      : isImg
                        ? "text-pink-600 bg-pink-50"
                        : "text-gray-500 bg-gray-100";
                const badgeText = isUrl ? "URL" : isExe ? "EXE" : isFolder ? "DIR" : isImg ? "IMG" : "FILE";
                return (
                <div
                  key={item.path}
                  className="group flex items-center gap-3 px-2.5 py-2 rounded-xl transition-colors duration-150 hover:bg-indigo-50/50"
                >
                  <span className="w-5 text-right text-[11px] font-mono text-gray-300 shrink-0">
                    {index + 1}
                  </span>
                  <span className={`text-[10px] w-9 h-5 inline-flex items-center justify-center shrink-0 font-semibold rounded-full uppercase tracking-wide ${badgeCls}`}>
                    {badgeText}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium text-gray-800 truncate">{item.name}</span>
                      <span className="text-[11px] text-gray-400 truncate" title={item.path}>
                        {item.path}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5 text-[11px] shrink-0 font-mono text-gray-400">
                    <span>{item.use_count} 次</span>
                    <span className="w-1 h-1 rounded-full bg-gray-200"></span>
                    <span title={formatTimestamp(item.last_used)}>{formatRelativeTime(item.last_used)}</span>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      onClick={() => handleOpenItem(item)}
                      className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-indigo-600 hover:bg-indigo-100/60 p-1 rounded-full transition-all duration-150"
                      title="打开"
                      disabled={isDeletingHistory}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleOpenSingleDeleteConfirm(item)}
                      className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 hover:bg-red-50 p-1 rounded-full transition-all duration-150"
                      title="删除此记录"
                      disabled={isDeletingHistory}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
                );
              })}
              {visibleCount < filteredHistoryItems.length && (
                <button
                  onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                  className="w-full py-2 mt-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 rounded-full transition-all"
                >
                  显示更多 {filteredHistoryItems.length - visibleCount} 条 ▾
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        isOpen={isDeleteConfirmOpen}
        title="确认删除"
        message={`确定要删除当前筛选的 ${pendingDeleteCount} 条文件历史记录吗？`}
        confirmText="删除"
        cancelText="取消"
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
        variant="danger"
      />
      <ConfirmDialog
        isOpen={isSingleDeleteConfirmOpen}
        title="确认删除"
        message={pendingDeleteItem ? `确定要删除文件历史记录: ${pendingDeleteItem.name} 吗？` : "确定要删除这条文件历史记录吗？"}
        confirmText="删除"
        cancelText="取消"
        onConfirm={handleConfirmSingleDelete}
        onCancel={handleCancelSingleDelete}
        variant="danger"
      />
    </>
  );
}
