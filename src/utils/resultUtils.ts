/**
 * 结果处理工具函数
 * 封装结果清空、索引重置等重复逻辑
 */

import type React from "react";
import {
  normalizePathForHistory,
  isSystemFolder,
  shouldShowInHorizontal,
  getResultUsageInfo,
  calculateRelevanceScore,
} from "./launcherUtils";

// SearchResult 类型定义（与 LauncherWindow.tsx 中的定义保持一致）
export type SearchResult = {
  type: "app" | "file" | "everything" | "url" | "email" | "memo" | "plugin" | "history" | "ai" | "json_formatter" | "settings" | "search";
  app?: any;
  file?: any;
  everything?: any;
  url?: string;
  email?: string;
  memo?: any;
  plugin?: { id: string; name: string; description?: string };
  aiAnswer?: string;
  jsonContent?: string;
  displayName: string;
  path: string;
};

/**
 * 清空所有结果状态
 */
export interface ClearResultsOptions {
  setResults: (results: SearchResult[]) => void;
  setHorizontalResults: (results: SearchResult[]) => void;
  setVerticalResults: (results: SearchResult[]) => void;
  setSelectedHorizontalIndex: (index: number | null) => void;
  setSelectedVerticalIndex: (index: number | null) => void;
  horizontalResultsRef?: React.MutableRefObject<SearchResult[]>;
  currentLoadResultsRef?: React.MutableRefObject<SearchResult[]>;
  logMessage?: string;
}

export function clearAllResults(options: ClearResultsOptions): void {
  options.setResults([]);
  options.setHorizontalResults([]);
  options.setVerticalResults([]);
  options.setSelectedHorizontalIndex(null);
  options.setSelectedVerticalIndex(null);
  
  if (options.horizontalResultsRef) {
    options.horizontalResultsRef.current = [];
  }
  
  if (options.currentLoadResultsRef) {
    options.currentLoadResultsRef.current = [];
  }
  
  if (options.logMessage) {
    console.log(options.logMessage);
  }
}

/**
 * 重置选中索引
 */
export function resetSelectedIndices(
  setSelectedHorizontalIndex: (index: number | null) => void,
  setSelectedVerticalIndex: (index: number | null) => void
): void {
  setSelectedHorizontalIndex(null);
  setSelectedVerticalIndex(null);
}

/**
 * 选中第一个横向结果
 */
export function selectFirstHorizontal(
  setSelectedHorizontalIndex: (index: number | null) => void,
  setSelectedVerticalIndex: (index: number | null) => void
): void {
  setSelectedHorizontalIndex(0);
  setSelectedVerticalIndex(null);
}

/**
 * 选中第一个纵向结果
 */
export function selectFirstVertical(
  setSelectedHorizontalIndex: (index: number | null) => void,
  setSelectedVerticalIndex: (index: number | null) => void
): void {
  setSelectedHorizontalIndex(null);
  setSelectedVerticalIndex(0);
}

/**
 * Helper function to split results into horizontal and vertical
 */
export function splitResults(
  allResults: SearchResult[],
  openHistoryData: Record<string, number> = {},
  searchQuery: string = ""
): { horizontal: SearchResult[]; vertical: SearchResult[] } {
  const executableResults = allResults.filter(result => {
    if (result.type === "app") {
      const pathLower = result.path.toLowerCase();
      // 包含可执行文件、快捷方式，以及 UWP 应用 URI（shell:AppsFolder 和 ms-settings:）
      return pathLower.endsWith('.exe') || 
             pathLower.endsWith('.lnk') ||
             pathLower.startsWith('shell:appsfolder') ||
             pathLower.startsWith('ms-settings:');
    }
    return false;
  });
  
  
  // 对应用结果按规范化路径去重（统一路径分隔符）
  // 对于"设置"应用，需要特殊处理：即使路径不同，也只保留一个
  const normalizedPathMap = new Map<string, SearchResult>();
  let hasSettingsApp = false;
  
  for (const result of executableResults) {
    if (result.type === "app") {
      const currentName = (result.app?.name || result.displayName || '').toLowerCase();
      const currentPath = result.path.toLowerCase();
      // 只对名称完全匹配"设置"/"Settings"或路径是 Windows 系统设置的应用进行特殊处理
      const isSettingsApp = (currentName === '设置' || currentName === 'settings') || 
                           currentPath.startsWith('shell:appsfolder') || 
                           currentPath.startsWith('ms-settings:');
      
      // 对于"设置"应用，只保留第一个（优先 shell:AppsFolder，其次 ms-settings:）
      if (isSettingsApp) {
        if (!hasSettingsApp) {
          // 第一个"设置"应用，直接添加
          const normalizedPath = normalizePathForHistory(result.path);
          normalizedPathMap.set(normalizedPath, result);
          hasSettingsApp = true;
        } else {
          // 已经有"设置"应用了，检查当前这个是否更好
          const existingSettings = Array.from(normalizedPathMap.values()).find(r => {
            const name = (r.app?.name || r.displayName || '').toLowerCase();
            const path = r.path.toLowerCase();
            return (name === '设置' || name === 'settings') || 
                   path.startsWith('shell:appsfolder') || 
                   path.startsWith('ms-settings:');
          });
          
          if (existingSettings) {
            const existingPath = existingSettings.path.toLowerCase();
            const currentPath = result.path.toLowerCase();
            
            // 优先保留 shell:AppsFolder，其次 ms-settings:
            const currentIsShell = currentPath.startsWith('shell:appsfolder');
            const existingIsMsSettings = existingPath.startsWith('ms-settings:');
            
            // 如果当前是 shell:AppsFolder 而已有的是 ms-settings:，替换
            if (currentIsShell && existingIsMsSettings) {
              const existingNormalizedPath = normalizePathForHistory(existingSettings.path);
              normalizedPathMap.delete(existingNormalizedPath);
              const normalizedPath = normalizePathForHistory(result.path);
              normalizedPathMap.set(normalizedPath, result);
            }
            // 否则跳过（已有更好的版本）
          }
        }
        continue; // 跳过后续的普通去重逻辑
      }
      
      // 普通应用的去重逻辑
      // 规范化路径：统一使用正斜杠，转小写
      const normalizedPath = result.path;
      
      if (!normalizedPathMap.has(normalizedPath)) {
        // 路径不存在，直接添加
        normalizedPathMap.set(normalizedPath, result);
      } else {
        // 路径已存在，比较并保留更好的版本
        const existing = normalizedPathMap.get(normalizedPath)!;
        const existingName = existing.app?.name || existing.displayName;
        
        // 优先保留名称不包含 .lnk 后缀的（更简洁）
        const currentHasLnkSuffix = currentName.toLowerCase().endsWith('.lnk');
        const existingHasLnkSuffix = existingName.toLowerCase().endsWith('.lnk');
        
        if (!currentHasLnkSuffix && existingHasLnkSuffix) {
          normalizedPathMap.set(normalizedPath, result);
        }
        // 如果名称后缀相同，优先保留有图标的
        else if (currentHasLnkSuffix === existingHasLnkSuffix) {
          if (result.app?.icon && !existing.app?.icon) {
            normalizedPathMap.set(normalizedPath, result);
          }
        }
      }
    }
  }
  
  const deduplicatedExecutableResults = Array.from(normalizedPathMap.values());
  
  // 系统文件夹（如回收站、设置等）也应该显示在横向列表中
  const systemFolderResults = allResults.filter(result => {
    if (result.type === "file" && result.file) {
      return isSystemFolder(result.path, result.file.is_folder);
    }
    return false;
  });
  
  const pluginResults = allResults.filter(result => result.type === "plugin");
  const horizontalUnsorted = [...deduplicatedExecutableResults, ...systemFolderResults, ...pluginResults];
  
  // 对横向列表按相关性评分、使用频率和最近使用时间排序
  const horizontal = horizontalUnsorted.sort((a, b) => {
    // 插件不再有特殊优先级，和应用一起按最近使用时间排序
    
    // 获取使用频率和最近使用时间
    // 优先使用 openHistoryData（最新的实时数据），如果没有才使用 file.last_used（数据库中的历史数据）
    // 注意：需要规范化路径以确保匹配（统一大小写和斜杠方向）
    // 对于所有类型（应用、插件、文件等），都尝试从 openHistory 中获取最近使用时间
    const aUsage = getResultUsageInfo(a, openHistoryData);
    const bUsage = getResultUsageInfo(b, openHistoryData);
    const aUseCount = aUsage.useCount;
    const aLastUsed = aUsage.lastUsed;
    const bUseCount = bUsage.useCount;
    const bLastUsed = bUsage.lastUsed;
    
    // 第一优先级：最近使用时间（最近打开的始终排在前面，无论是否有查询）
    // 只要两个项目都有使用时间，就严格按时间排序，不受评分影响
    if (aLastUsed > 0 && bLastUsed > 0) {
      // 两个都有使用时间，严格按时间降序排序（最近的在前面）
      // 即使时间非常接近，也按时间排序，确保刚刚使用的项目排在最前面
      return bLastUsed - aLastUsed;
    } else if (aLastUsed > 0) {
      // 只有 a 有使用时间，a 排在前面
      return -1;
    } else if (bLastUsed > 0) {
      // 只有 b 有使用时间，b 排在前面
      return 1;
    }
    
    // 如果有查询，第二优先级：按相关性评分排序（评分高的在前）
    if (searchQuery.trim()) {
      const aScore = calculateRelevanceScore(
        a.displayName,
        a.path,
        searchQuery,
        aUseCount,
        aLastUsed,
        a.type === "everything",
        a.type === "app",
        a.app?.name_pinyin,
        a.app?.name_pinyin_initials,
        a.type === "file"
      );
      const bScore = calculateRelevanceScore(
        b.displayName,
        b.path,
        searchQuery,
        bUseCount,
        bLastUsed,
        b.type === "everything",
        b.type === "app",
        b.app?.name_pinyin,
        b.app?.name_pinyin_initials,
        b.type === "file"
      );
      
      // 第二优先级：按评分降序排序（分数高的在前）
      if (bScore !== aScore) {
        return bScore - aScore;
      }
    }
    
    // 再次按使用频率排序（使用次数多的在前）
    if (aUseCount !== undefined && bUseCount !== undefined) {
      if (aUseCount !== bUseCount) {
        return bUseCount - aUseCount; // 降序：使用次数多的在前
      }
    } else if (aUseCount !== undefined && bUseCount === undefined) {
      return -1; // a 有使用次数，b 没有，a 在前
    } else if (aUseCount === undefined && bUseCount !== undefined) {
      return 1; // b 有使用次数，a 没有，b 在前
    }
    
    // 最后按名称排序（保持稳定排序）
    return (a.displayName || "").localeCompare(b.displayName || "");
  });
  
  
  const vertical = allResults.filter(result => {
    // 排除应该显示在横向列表中的结果（可执行文件、快捷方式、UWP 应用、系统文件夹、插件）
    return !shouldShowInHorizontal(result);
  });
  
  
  return { horizontal, vertical };
}

/**
 * 增量加载结果的依赖接口
 */
export interface LoadResultsIncrementallyOptions {
  allResults: SearchResult[];
  currentQuery: string;
  openHistory: Record<string, number>;
  
  // 状态更新函数
  setResults: (results: SearchResult[]) => void;
  setHorizontalResults: (results: SearchResult[]) => void;
  setVerticalResults: (results: SearchResult[]) => void;
  setSelectedHorizontalIndex: (index: number | null) => void;
  setSelectedVerticalIndex: (index: number | null) => void;
  
  // Refs
  queryRef: React.MutableRefObject<string>;
  lastLoadQueryRef: React.MutableRefObject<string>;
  incrementalLoadRef: React.MutableRefObject<number | null>;
  incrementalTimeoutRef: React.MutableRefObject<number | null>;
  currentLoadResultsRef: React.MutableRefObject<SearchResult[]>;
  horizontalResultsRef: React.MutableRefObject<SearchResult[]>;
}

/**
 * 分批加载结果的函数
 */
export function loadResultsIncrementally(options: LoadResultsIncrementallyOptions): void {
  const {
    allResults,
    currentQuery,
    openHistory,
    setResults,
    setHorizontalResults,
    setVerticalResults,
    setSelectedHorizontalIndex,
    setSelectedVerticalIndex,
    queryRef,
    lastLoadQueryRef,
    incrementalLoadRef,
    incrementalTimeoutRef,
    currentLoadResultsRef,
    horizontalResultsRef,
  } = options;
  
  // 重要：如果查询已经变化，说明这些结果是过时的，不应该加载
  // 这样可以避免快速输入时使用旧查询的结果导致卡顿和显示错误
  // 注意：如果 lastLoadQueryRef 为空字符串，说明是第一次加载，应该允许
  if (lastLoadQueryRef.current !== "" && currentQuery.trim() !== lastLoadQueryRef.current.trim()) {
    return;
  }
  
  // 更新最后一次加载的查询（在检查之后更新，确保下次检查能正确工作）
  lastLoadQueryRef.current = currentQuery;
  
  // 取消之前的增量加载（包括 animationFrame 和 setTimeout）
  if (incrementalLoadRef.current !== null) {
    cancelAnimationFrame(incrementalLoadRef.current);
    incrementalLoadRef.current = null;
  }
  if (incrementalTimeoutRef.current !== null) {
    clearTimeout(incrementalTimeoutRef.current);
    incrementalTimeoutRef.current = null;
  }

  // 如果 query 为空且没有结果（包括 AI 回答），直接清空结果并返回
  if (currentQuery.trim() === "" && allResults.length === 0) {
    clearAllResults({
      setResults,
      setHorizontalResults,
      setVerticalResults,
      setSelectedHorizontalIndex,
      setSelectedVerticalIndex,
      horizontalResultsRef,
      currentLoadResultsRef,
      logMessage: '[horizontalResults] 清空横向结果 (查询为空)',
    });
    return;
  }

  // 如果查询不为空但结果为空，可能是搜索还在进行中（防抖导致 debouncedCombinedResults 尚未更新）
  // 在这种情况下，清空旧结果，等待新的 debouncedCombinedResults 更新
  if (queryRef.current.trim() !== "" && allResults.length === 0) {
    // 清空结果，避免显示旧查询的结果
    clearAllResults({
      setResults,
      setHorizontalResults,
      setVerticalResults,
      setSelectedHorizontalIndex,
      setSelectedVerticalIndex,
      horizontalResultsRef,
      currentLoadResultsRef,
    });
    return;
  }

  // 保存当前要加载的结果引用，用于后续验证
  currentLoadResultsRef.current = allResults;

  // Split results into horizontal and vertical
  // 再次检查查询是否仍然匹配（可能在 splitResults 计算期间查询已变化）
  if (queryRef.current.trim() !== currentQuery.trim()) {
    return;
  }
  const { horizontal, vertical } = splitResults(allResults, openHistory, currentQuery);

  const INITIAL_COUNT = 100; // 初始显示100条
  const INCREMENT = 50; // 每次增加50条
  const DELAY_MS = 16; // 每帧延迟（约60fps）
  // 如果结果数量少于或等于初始数量，直接设置所有结果（避免先设置初始结果再覆盖）
  if (allResults.length <= INITIAL_COUNT) {
    // 如果当前已经有横向结果，且新的结果中没有横向结果，保留当前的横向结果
    // 这样可以确保应用结果（通常是横向结果）不会被Everything结果覆盖
    // 重要：始终使用新排序的 horizontal，不要使用旧的 currentHorizontalRef
    // 这样可以确保横向列表始终按照最新的排序显示
    const finalHorizontal = horizontal; // 直接使用排序后的结果，不使用旧的引用
    
    setResults(allResults);
    setHorizontalResults(finalHorizontal);
    setVerticalResults(vertical);
    // 更新ref以跟踪当前的横向结果
    horizontalResultsRef.current = finalHorizontal;
    // Auto-select first horizontal result if available
    if (finalHorizontal.length > 0) {
      setSelectedHorizontalIndex(0);
      setSelectedVerticalIndex(null);
    } else if (vertical.length > 0) {
      setSelectedHorizontalIndex(null);
      setSelectedVerticalIndex(0);
    }
    currentLoadResultsRef.current = [];
    // 成功加载后，更新 lastLoadQueryRef 为当前查询
    // 这样下次查询变化时，检查才能正确工作
    lastLoadQueryRef.current = currentQuery;
    return;
  }

  // 重置显示数量（如果有结果就显示，即使查询为空）
  // 只有在结果数量 > INITIAL_COUNT 时才需要增量加载
  if (allResults.length > 0) {
    // 重要：使用完整的 allResults 进行排序，而不是只使用前100条
    // 这样可以确保横向列表的排序是基于所有结果的，而不是部分结果
    // 横向列表应该显示所有应用，按最近使用时间排序
    const finalHorizontal = horizontal; // 使用完整排序后的横向结果
    const initialResults = allResults.slice(0, INITIAL_COUNT);
    const { vertical: initialVertical } = splitResults(initialResults, openHistory, currentQuery);
    const finalVertical = initialVertical.length > 0 ? initialVertical : vertical;
    setResults(initialResults);
    // 使用完整排序后的横向结果，而不是只基于前100条的结果
    setHorizontalResults(finalHorizontal);
    setVerticalResults(finalVertical);
    // 更新ref以跟踪当前的横向结果
    horizontalResultsRef.current = finalHorizontal;
    
    // Auto-select first horizontal result if available
    if (finalHorizontal.length > 0) {
      setSelectedHorizontalIndex(0);
      setSelectedVerticalIndex(null);
    } else if (finalVertical.length > 0) {
      setSelectedHorizontalIndex(null);
      setSelectedVerticalIndex(0);
    }
  }

  // 逐步加载更多结果
  let currentCount = INITIAL_COUNT;
  const loadMore = () => {
    // 在每次更新前检查：query 是否为空，以及结果是否已过时
    if (queryRef.current.trim() === "" || 
        currentLoadResultsRef.current !== allResults) {
      // 结果已过时或查询已清空，停止加载
      clearAllResults({
        setResults,
        setHorizontalResults,
        setVerticalResults,
        setSelectedHorizontalIndex,
        setSelectedVerticalIndex,
        currentLoadResultsRef,
        logMessage: '[horizontalResults] 清空横向结果 (结果已过时或查询已清空)',
      });
      incrementalLoadRef.current = null;
      incrementalTimeoutRef.current = null;
      return;
    }

    if (currentCount < allResults.length) {
      currentCount = Math.min(currentCount + INCREMENT, allResults.length);
      
      // 再次检查结果是否仍然有效
      if (queryRef.current.trim() !== "" && 
          currentLoadResultsRef.current === allResults) {
        const currentResults = allResults.slice(0, currentCount);
        // 重要：横向列表应该始终使用完整排序后的结果，而不是只基于当前加载的部分结果
        // 这样可以确保横向列表的排序是基于所有结果的，保持一致性
        const { vertical: currentVertical } = splitResults(currentResults, openHistory, currentQuery);
        setResults(currentResults);
        // 横向列表使用完整排序后的结果（horizontal），而不是只基于当前加载的部分结果
        // 这样可以确保横向列表的排序不会因为增量加载而改变
        setHorizontalResults(horizontal);
        setVerticalResults(currentVertical);
        // 更新ref以跟踪当前的横向结果
        horizontalResultsRef.current = horizontal;
        // 打印横向结果列表（增量加载中）
      } else {
        // 结果已过时，停止加载
        clearAllResults({
          setResults,
          setHorizontalResults,
          setVerticalResults,
          setSelectedHorizontalIndex,
          setSelectedVerticalIndex,
          currentLoadResultsRef,
          logMessage: '[horizontalResults] 清空横向结果 (增量加载中结果已过时)',
        });
        incrementalLoadRef.current = null;
        incrementalTimeoutRef.current = null;
        return;
      }
      
      if (currentCount < allResults.length) {
        // 使用嵌套的 requestAnimationFrame 和 setTimeout 来确保正确的取消机制
        incrementalLoadRef.current = requestAnimationFrame(() => {
          // 再次检查是否仍然有效
          if (currentLoadResultsRef.current !== allResults) {
            incrementalLoadRef.current = null;
            return;
          }
          incrementalTimeoutRef.current = setTimeout(loadMore, DELAY_MS) as unknown as number;
        });
      } else {
        // 加载完成
        incrementalLoadRef.current = null;
        incrementalTimeoutRef.current = null;
        currentLoadResultsRef.current = [];
      }
    } else {
      // 加载完成
      incrementalLoadRef.current = null;
      incrementalTimeoutRef.current = null;
      currentLoadResultsRef.current = [];
      // 成功加载后，更新 lastLoadQueryRef 为当前查询
      lastLoadQueryRef.current = currentQuery;
    }
  };

  // 开始增量加载
  incrementalLoadRef.current = requestAnimationFrame(() => {
    // 再次检查结果是否仍然有效
    if (currentLoadResultsRef.current !== allResults) {
      incrementalLoadRef.current = null;
      return;
    }
    incrementalTimeoutRef.current = setTimeout(loadMore, DELAY_MS) as unknown as number;
  });
}

