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

// 格式化时间戳
const formatTimestamp = (timestamp?: number | null) => {
  if (!timestamp) return "暂无";
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
    if (period === '5-10days') {
      // 计算实际的时间范围（包含小时、分钟、秒）
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 10);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date();
      endDate.setDate(endDate.getDate() - 5);
      endDate.setHours(23, 59, 59, 999);
      const { start, end } = parseDateRangeToTs(range.startDate, range.endDate);
      
      // 使用与 historySummary 和 filteredHistoryItems 完全相同的计算逻辑（简单时间范围过滤）
      // 这样按钮统计数量和列表筛选数量会完全一致
      const { start: start5_10Days, end: end5_10Days } = parseDateRangeToTs(range.startDate, range.endDate);
      
      // 计算按钮上显示的数字（使用与列表筛选相同的简单时间范围过滤逻辑）
      const buttonCount = fileHistoryItems.filter((item) => {
        // 与 filteredHistoryItems 完全相同的逻辑
        if (start5_10Days !== undefined && item.last_used < start5_10Days) return false;
        if (end5_10Days !== undefined && item.last_used > end5_10Days) return false;
        return true;
      }).length;
      
      console.log('========== 点击5-10天按钮 ==========');
      console.log('按钮信息:', {
        按钮文字: '5-10天',
        按钮显示数字: buttonCount,
        说明: `按钮上显示的数字 ${buttonCount} 表示该时间段内的记录数量（排除已计入近5天的记录）`,
      });
      console.log('查询条件:', {
        时间范围说明: '从10天前 00:00:00 到 5天前 23:59:59',
        开始日期: range.startDate,
        结束日期: range.endDate,
        开始时间: startDate.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        结束时间: endDate.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        开始时间戳: start,
        结束时间戳: end,
      });
      console.log('筛选条件（数字形式）:', {
        条件: `last_used >= ${start} && last_used <= ${end}`,
        条件说明: `last_used >= ${start} (${new Date(start! * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}) && last_used <= ${end} (${new Date(end! * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})`,
        说明: '使用简单时间范围过滤，与按钮统计逻辑一致，数量应完全匹配',
      });
      console.log('====================================');
    }
    setHistoryDaysAgo(""); // 清空天数输入框
    setHistoryStartDate(range.startDate);
    setHistoryEndDate(range.endDate);
  }, [getPeriodDateRange, fileHistoryItems]);

  const filteredHistoryItems = useMemo(() => {
    const { start, end } = parseDateRangeToTs(historyStartDate, historyEndDate);
    // 检查是否是5-10天的筛选范围
    const range5_10Days = getPeriodDateRange('5-10days');
    const { start: start5_10Days, end: end5_10Days } = parseDateRangeToTs(range5_10Days.startDate, range5_10Days.endDate);
    if (start === start5_10Days && end === end5_10Days) {
      console.log('========== 5-10天筛选执行 ==========');
      console.log('筛选参数:', {
        开始日期: historyStartDate,
        结束日期: historyEndDate,
        开始时间: start ? new Date(start * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '无',
        结束时间: end ? new Date(end * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '无',
        开始时间戳: start,
        结束时间戳: end,
        总记录数: fileHistoryItems.length,
      });
      console.log('查询条件（数字形式）:', {
        条件: `last_used >= ${start} && last_used <= ${end}`,
        条件说明: `筛选 last_used 时间戳在 [${start}, ${end}] 范围内的记录`,
      });
    }
    const filtered = fileHistoryItems.filter((item) => {
      // 日期过滤
      if (start && item.last_used < start) return false;
      if (end && item.last_used > end) return false;
      
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
    if (start === start5_10Days && end === end5_10Days) {
      console.log('5-10天筛选结果:', {
        筛选前记录数: fileHistoryItems.length,
        筛选后记录数: filtered.length,
        查询条件: start !== undefined && end !== undefined
          ? `last_used >= ${start} (${new Date(start * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}) && last_used <= ${end} (${new Date(end * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})`
          : '无效的时间范围',
        条件说明: `筛选条件：last_used 时间戳 >= ${start} 且 <= ${end}`,
      });
      console.log('====================================');
    }
    return filtered;
  }, [fileHistoryItems, historyStartDate, historyEndDate, getPeriodDateRange, searchQuery, categoryFilter]);

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

    // 打印 5-10天 的计算参数
    console.log('========== historySummary.tenDaysAgo 计算开始 ==========');
    console.log('5-10天计算参数:', {
      日期范围: {
        开始日期: range5_10Days.startDate,
        结束日期: range5_10Days.endDate,
      },
      时间戳范围: {
        开始时间戳: start5_10Days,
        结束时间戳: end5_10Days,
        开始时间: start5_10Days ? new Date(start5_10Days * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '无',
        结束时间: end5_10Days ? new Date(end5_10Days * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '无',
      },
      筛选条件: `last_used >= ${start5_10Days} && last_used <= ${end5_10Days}`,
      总记录数: fileHistoryItems.length,
      计算方式: '使用与列表筛选完全相同的逻辑（简单时间范围过滤，不使用优先级判断）',
    });

    let count5Days = 0;
    let count5_10Days = 0;
    let count10_30Days = 0;
    let count30DaysOlder = 0;

    // 用于记录 5-10天 的匹配详情（只记录前10条，避免日志过多）
    const matched5_10Days: Array<{ path: string; last_used: number; last_used_str: string }> = [];

    // 使用与 filteredHistoryItems 完全相同的过滤逻辑（简单时间范围过滤，不使用优先级）
    // 这样按钮统计数量和列表筛选数量会完全一致
    // 每个时间段独立计算，只根据时间范围判断，不互相影响
    fileHistoryItems.forEach((item) => {
      // 近5天：使用与 filteredHistoryItems 完全相同的逻辑
      if (start5Days !== undefined && item.last_used < start5Days) {
        // 不在范围内
      } else if (end5Days !== undefined && item.last_used > end5Days) {
        // 不在范围内
      } else {
        // 在范围内（与 filteredHistoryItems 的逻辑一致）
        count5Days++;
      }

      // 5-10天：使用与 filteredHistoryItems 完全相同的逻辑
      if (start5_10Days !== undefined && item.last_used < start5_10Days) {
        // 不在范围内
      } else if (end5_10Days !== undefined && item.last_used > end5_10Days) {
        // 不在范围内
      } else {
        // 在范围内（与 filteredHistoryItems 的逻辑一致）
        count5_10Days++;
        // 记录匹配的详情（只记录前10条）
        if (matched5_10Days.length < 10) {
          matched5_10Days.push({
            path: item.path,
            last_used: item.last_used,
            last_used_str: new Date(item.last_used * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
          });
        }
      }

      // 10-30天：使用与 filteredHistoryItems 完全相同的逻辑
      if (start10_30Days !== undefined && item.last_used < start10_30Days) {
        // 不在范围内
      } else if (end10_30Days !== undefined && item.last_used > end10_30Days) {
        // 不在范围内
      } else {
        // 在范围内（与 filteredHistoryItems 的逻辑一致）
        count10_30Days++;
      }

      // 30天前（只有 end，没有 start）：使用与 filteredHistoryItems 完全相同的逻辑
      if (end30Days !== undefined && item.last_used > end30Days) {
        // 不在范围内
      } else if (end30Days !== undefined) {
        // 在范围内（与 filteredHistoryItems 的逻辑一致）
        count30DaysOlder++;
      }
    });

    // 打印 5-10天 的计算结果
    console.log('5-10天计算结果:', {
      tenDaysAgo: count5_10Days,
      计算说明: `遍历了 ${fileHistoryItems.length} 条记录，找到 ${count5_10Days} 条匹配 5-10天 范围的记录`,
      匹配条件: `与列表筛选逻辑一致：!(last_used < ${start5_10Days}) && !(last_used > ${end5_10Days})`,
      简化条件: `last_used >= ${start5_10Days} && last_used <= ${end5_10Days}`,
      说明: '此数量应与点击按钮后列表筛选的数量完全一致',
    });
    
    // 打印匹配的示例记录（前10条）
    if (matched5_10Days.length > 0) {
      console.log('匹配的示例记录（前10条）:', matched5_10Days);
    }
    
    console.log('========== historySummary.tenDaysAgo 计算完成 ==========');

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

  return (
    <>
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
        {!isLoadingHistory && fileHistoryItems.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => handleClickSummaryPeriod('5days')}
              className="group relative inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md bg-gradient-to-br from-blue-50 to-blue-100/80 text-blue-700 border border-blue-200/70 hover:border-blue-300 hover:from-blue-100 hover:to-blue-200/80 hover:shadow-sm hover:shadow-blue-200/40 active:scale-[0.98] transition-all duration-200 cursor-pointer"
            >
              <span className="font-medium">近5天</span>
              <span className="inline-flex items-center justify-center min-w-[24px] h-5 px-1.5 rounded-full bg-blue-500 text-white text-[10px] font-bold shadow-sm group-hover:bg-blue-600 transition-colors">
                {historySummary.fiveDaysAgo}
              </span>
            </button>
            <button
              onClick={() => handleClickSummaryPeriod('5-10days')}
              className="group relative inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md bg-gradient-to-br from-emerald-50 to-emerald-100/80 text-emerald-700 border border-emerald-200/70 hover:border-emerald-300 hover:from-emerald-100 hover:to-emerald-200/80 hover:shadow-sm hover:shadow-emerald-200/40 active:scale-[0.98] transition-all duration-200 cursor-pointer"
            >
              <span className="font-medium">5-10天</span>
              <span className="inline-flex items-center justify-center min-w-[24px] h-5 px-1.5 rounded-full bg-emerald-500 text-white text-[10px] font-bold shadow-sm group-hover:bg-emerald-600 transition-colors">
                {historySummary.tenDaysAgo}
              </span>
            </button>
            <button
              onClick={() => handleClickSummaryPeriod('10-30days')}
              className="group relative inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md bg-gradient-to-br from-amber-50 to-amber-100/80 text-amber-700 border border-amber-200/70 hover:border-amber-300 hover:from-amber-100 hover:to-amber-200/80 hover:shadow-sm hover:shadow-amber-200/40 active:scale-[0.98] transition-all duration-200 cursor-pointer"
            >
              <span className="font-medium">10-30天</span>
              <span className="inline-flex items-center justify-center min-w-[24px] h-5 px-1.5 rounded-full bg-amber-500 text-white text-[10px] font-bold shadow-sm group-hover:bg-amber-600 transition-colors">
                {historySummary.thirtyDaysAgo}
              </span>
            </button>
            <button
              onClick={() => handleClickSummaryPeriod('30days')}
              className={`group relative inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border transition-all duration-200 ${
                historySummary.older > 0
                  ? 'bg-gradient-to-br from-slate-50 to-slate-100/80 text-slate-700 border-slate-200/70 hover:border-slate-300 hover:from-slate-100 hover:to-slate-200/80 hover:shadow-sm hover:shadow-slate-200/40 active:scale-[0.98] cursor-pointer'
                  : 'bg-gray-50/50 text-gray-400 border-gray-200/40 cursor-not-allowed opacity-60'
              }`}
              disabled={historySummary.older === 0}
            >
              <span className="font-medium">30天前</span>
              <span className={`inline-flex items-center justify-center min-w-[24px] h-5 px-1.5 rounded-full text-[10px] font-bold shadow-sm transition-colors ${
                historySummary.older > 0
                  ? 'bg-slate-500 text-white group-hover:bg-slate-600'
                  : 'bg-gray-300 text-gray-500'
              }`}>
                {historySummary.older}
              </span>
            </button>
          </div>
        )}
        <div className="mt-3 flex flex-col gap-3">
          {/* 第一行：分类筛选和搜索 */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* 分类筛选按钮 */}
            <div className="flex items-center gap-1 bg-gray-50/50 p-1 rounded-lg border border-gray-100">
              <button
                onClick={() => setCategoryFilter("all")}
                className={`px-3 py-1.5 text-xs rounded-md transition-all duration-200 ${
                  categoryFilter === "all"
                    ? "bg-white text-blue-600 font-medium shadow-sm border border-gray-200/50"
                    : "text-gray-500 hover:text-gray-700 hover:bg-gray-100/50"
                }`}
              >
                全部
              </button>
              <button
                onClick={() => setCategoryFilter("url")}
                className={`px-3 py-1.5 text-xs rounded-md transition-all duration-200 ${
                  categoryFilter === "url"
                    ? "bg-white text-blue-600 font-medium shadow-sm border border-gray-200/50"
                    : "text-gray-500 hover:text-gray-700 hover:bg-gray-100/50"
                }`}
              >
                URL
              </button>
              <button
                onClick={() => setCategoryFilter("exe")}
                className={`px-3 py-1.5 text-xs rounded-md transition-all duration-200 ${
                  categoryFilter === "exe"
                    ? "bg-white text-blue-600 font-medium shadow-sm border border-gray-200/50"
                    : "text-gray-500 hover:text-gray-700 hover:bg-gray-100/50"
                }`}
              >
                EXE
              </button>
              <button
                onClick={() => setCategoryFilter("folder")}
                className={`px-3 py-1.5 text-xs rounded-md transition-all duration-200 ${
                  categoryFilter === "folder"
                    ? "bg-white text-blue-600 font-medium shadow-sm border border-gray-200/50"
                    : "text-gray-500 hover:text-gray-700 hover:bg-gray-100/50"
                }`}
              >
                文件夹
              </button>
              <button
                onClick={() => setCategoryFilter("image")}
                className={`px-3 py-1.5 text-xs rounded-md transition-all duration-200 ${
                  categoryFilter === "image"
                    ? "bg-white text-blue-600 font-medium shadow-sm border border-gray-200/50"
                    : "text-gray-500 hover:text-gray-700 hover:bg-gray-100/50"
                }`}
              >
                图片
              </button>
              <button
                onClick={() => setCategoryFilter("other")}
                className={`px-3 py-1.5 text-xs rounded-md transition-all duration-200 ${
                  categoryFilter === "other"
                    ? "bg-white text-blue-600 font-medium shadow-sm border border-gray-200/50"
                    : "text-gray-500 hover:text-gray-700 hover:bg-gray-100/50"
                }`}
              >
                其他
              </button>
            </div>

            {/* 搜索框 */}
            <div className="relative group">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                }}
                placeholder="搜索文件名..."
                className="w-48 px-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 pl-8 transition-all"
              />
              <svg 
                className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-gray-400 group-focus-within:text-blue-500 transition-colors"
                fill="none" 
                viewBox="0 0 24 24" 
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 p-0.5 rounded-full hover:bg-gray-100 transition-all"
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
            <div className="flex items-center gap-2 bg-gray-50/50 p-1 rounded-lg border border-gray-100">
              <div className="flex items-center gap-1.5 px-1">
                <span className="text-xs text-gray-500">最近</span>
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
                  className="w-12 px-1.5 py-0.5 text-xs text-center border border-gray-200 rounded focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 bg-white"
                />
                <span className="text-xs text-gray-500">天</span>
              </div>
              
              <div className="w-px h-4 bg-gray-200 mx-1"></div>

              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={historyStartDate}
                  onChange={(e) => {
                    setHistoryStartDate(e.target.value);
                  }}
                  className="px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 bg-white"
                />
                <span className="text-xs text-gray-400">至</span>
                <input
                  type="date"
                  value={historyEndDate}
                  onChange={(e) => {
                    setHistoryEndDate(e.target.value);
                  }}
                  className="px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 bg-white"
                />
              </div>
            </div>

            <div className="flex-1"></div>

            {(historyStartDate || historyEndDate || historyDaysAgo || searchQuery || categoryFilter !== "all") && (
              <button
                onClick={() => {
                  setHistoryDaysAgo("");
                  setHistoryStartDate("");
                  setHistoryEndDate("");
                  setSearchQuery("");
                  setCategoryFilter("all");
                }}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-all"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                清除筛选
              </button>
            )}

            <button
              onClick={handleOpenDeleteConfirm}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-red-50 text-red-600 border border-red-100 hover:bg-red-100 hover:border-red-200 transition-all shadow-sm"
              disabled={isDeletingHistory}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              {isDeletingHistory ? "删除中..." : "删除结果"}
            </button>
          </div>
          
          {historyMessage && (
            <div className="text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded border border-blue-100 flex items-center gap-1">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {historyMessage}
            </div>
          )}
        </div>
        <div className="mt-3 border-t border-gray-100 pt-3 h-96 overflow-y-auto">
          {isLoadingHistory && <div className="text-xs text-gray-500">加载中...</div>}
          {!isLoadingHistory && filteredHistoryItems.length === 0 && (
            <div className="text-xs text-gray-500">暂无历史记录</div>
          )}
          {!isLoadingHistory && filteredHistoryItems.length > 0 && (
            <div className="space-y-2 text-xs text-gray-700">
              {filteredHistoryItems.map((item, index) => (
                <div
                  key={item.path}
                  className="group p-2.5 rounded-lg border border-gray-100 bg-white hover:border-blue-200 hover:shadow-sm transition-all duration-200 flex items-start gap-3"
                >
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-gray-50 text-gray-400 text-xs font-mono shrink-0 border border-gray-100 mt-0.5">
                    {index + 1}
                  </span>
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <div className="font-medium text-gray-900 truncate text-sm">{item.name}</div>
                      {item.path && (item.path.startsWith("http://") || item.path.startsWith("https://")) && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-100 shrink-0 font-medium uppercase tracking-wide">
                          URL
                        </span>
                      )}
                      {item.path && item.path.toLowerCase().endsWith(".exe") && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-600 border border-purple-100 shrink-0 font-medium uppercase tracking-wide">
                          EXE
                        </span>
                      )}
                      {isItemFolder(item) && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 border border-amber-100 shrink-0 font-medium uppercase tracking-wide">
                          DIR
                        </span>
                      )}
                      {item.path && isImageFile(item.path) && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-pink-50 text-pink-600 border border-pink-100 shrink-0 font-medium uppercase tracking-wide">
                          图片
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 truncate font-mono bg-gray-50/50 px-1.5 py-0.5 rounded w-fit max-w-full" title={item.path}>
                      {item.path}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-400 pt-0.5">
                      <span className="flex items-center gap-1">
                        <svg className="w-3 h-3 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                        {item.use_count} 次
                      </span>
                      <span className="w-0.5 h-0.5 rounded-full bg-gray-300"></span>
                      <span className="flex items-center gap-1">
                        <svg className="w-3 h-3 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        {formatTimestamp(item.last_used)}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleOpenSingleDeleteConfirm(item)}
                    className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 hover:bg-red-50 p-1.5 rounded-md transition-all duration-200"
                    title="删除此记录"
                    disabled={isDeletingHistory}
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              ))}
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
