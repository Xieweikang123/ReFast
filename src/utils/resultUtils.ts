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
  getMatchTier,
  MatchTier,
  isQueryIndependentResultType,
  isLnkPath,
} from "./launcherUtils";
import {
  buildDefaultVisibleVerticalItems,
  type VisibleVerticalItem,
} from "./resultGroupUtils";

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
  /** Extracted file icon (base64 / data URL) for non-app file/everything results */
  icon?: string;
  /** URL 类型：命中浏览器路由规则时记录使用的浏览器标识 */
  browser?: string;
};

/**
 * 结果唯一标识，用于跨结果集匹配同一项。
 * 路径统一小写并规范分隔符，避免 Windows 下因大小写/斜杠差异导致匹配失败。
 */
export function getResultKey(result: SearchResult): string {
  const rawPath = result.url ?? result.path ?? "";
  const path = rawPath.toLowerCase().replace(/\\/g, "/");
  return `${result.type}:${path}`;
}

/**
 * 有查询时：未命中名称/路径/拼音的常规结果应过滤掉
 * 检测型结果（URL/邮箱/AI 等）始终保留
 */
export function shouldKeepResultForQuery(
  result: SearchResult,
  query: string
): boolean {
  const trimmed = query.trim();
  if (!trimmed) return true;
  if (isQueryIndependentResultType(result.type)) return true;

  const tier = getMatchTier(
    result.displayName,
    result.path,
    trimmed,
    result.app?.name_pinyin ?? result.file?.name_pinyin,
    result.app?.name_pinyin_initials ?? result.file?.name_pinyin_initials
  );
  return tier < MatchTier.NONE;
}

export interface CompareSearchResultsOptions {
  query: string;
  openHistory?: Record<string, number>;
  /** 搜索设置相关关键词时，抬高 Windows 设置应用 */
  shouldShowSettings?: boolean;
  /** 是否让 ai/history/settings 类型始终置顶 */
  preferSpecialTypes?: boolean;
}

/**
 * 统一搜索结果比较：
 * - 空查询：最近使用优先
 * - 有查询：匹配档位优先 → 同档内最近使用 → 评分 → 类型 → 次数 → 名称
 */
export function compareSearchResults(
  a: SearchResult,
  b: SearchResult,
  options: CompareSearchResultsOptions
): number {
  const {
    query,
    openHistory = {},
    shouldShowSettings = false,
    preferSpecialTypes = true,
  } = options;
  const trimmedQuery = query.trim();

  if (preferSpecialTypes) {
    const specialTypes = ["ai", "history", "settings"];
    const aIsSpecial = specialTypes.includes(a.type);
    const bIsSpecial = specialTypes.includes(b.type);
    if (aIsSpecial && !bIsSpecial) return -1;
    if (!aIsSpecial && bIsSpecial) return 1;
    if (aIsSpecial && bIsSpecial) return 0;

    // 浏览器路由直达结果（用户明确配置、查询命中规则的站点）优先显示
    const aIsRuleUrl = a.type === "url" && !!a.browser;
    const bIsRuleUrl = b.type === "url" && !!b.browser;
    if (aIsRuleUrl !== bIsRuleUrl) {
      return aIsRuleUrl ? -1 : 1;
    }
  }

  const aAppName = (a.app?.name || a.displayName || "").toLowerCase();
  const aAppPath = (a.path || "").toLowerCase();
  const aIsSettingsApp =
    a.type === "app" &&
    (aAppName === "设置" ||
      aAppName === "settings" ||
      aAppPath.startsWith("shell:appsfolder") ||
      aAppPath.startsWith("ms-settings:"));
  const bAppName = (b.app?.name || b.displayName || "").toLowerCase();
  const bAppPath = (b.path || "").toLowerCase();
  const bIsSettingsApp =
    b.type === "app" &&
    (bAppName === "设置" ||
      bAppName === "settings" ||
      bAppPath.startsWith("shell:appsfolder") ||
      bAppPath.startsWith("ms-settings:"));

  if (shouldShowSettings) {
    if (aIsSettingsApp && !bIsSettingsApp) return -1;
    if (!aIsSettingsApp && bIsSettingsApp) return 1;
  }

  const aUsage = getResultUsageInfo(a, openHistory);
  const bUsage = getResultUsageInfo(b, openHistory);
  const aUseCount = aUsage.useCount;
  const aLastUsed = aUsage.lastUsed;
  const bUseCount = bUsage.useCount;
  const bLastUsed = bUsage.lastUsed;

  const aScore = calculateRelevanceScore(
    a.displayName,
    a.path,
    trimmedQuery,
    aUseCount,
    aLastUsed,
    a.type === "everything",
    a.type === "app",
    a.app?.name_pinyin,
    a.app?.name_pinyin_initials,
    a.type === "file",
    a.type === "url"
  );
  const bScore = calculateRelevanceScore(
    b.displayName,
    b.path,
    trimmedQuery,
    bUseCount,
    bLastUsed,
    b.type === "everything",
    b.type === "app",
    b.app?.name_pinyin,
    b.app?.name_pinyin_initials,
    b.type === "file",
    b.type === "url"
  );

  // Everything 内部快捷方式 (.lnk) 优先
  if (a.type === "everything" && b.type === "everything") {
    const aLnk = isLnkPath(a.path);
    const bLnk = isLnkPath(b.path);
    if (aLnk !== bLnk) return aLnk ? -1 : 1;
  }

  // 有查询：匹配档位优先于最近使用时间
  if (trimmedQuery) {
    const aTier = getMatchTier(
      a.displayName,
      a.path,
      trimmedQuery,
      a.app?.name_pinyin ?? a.file?.name_pinyin,
      a.app?.name_pinyin_initials ?? a.file?.name_pinyin_initials
    );
    const bTier = getMatchTier(
      b.displayName,
      b.path,
      trimmedQuery,
      b.app?.name_pinyin ?? b.file?.name_pinyin,
      b.app?.name_pinyin_initials ?? b.file?.name_pinyin_initials
    );
    if (aTier !== bTier) {
      return aTier - bTier;
    }

    // 同档内：最近使用优先
    if (aLastUsed > 0 && bLastUsed > 0) {
      if (aLastUsed !== bLastUsed) return bLastUsed - aLastUsed;
    } else if (aLastUsed > 0) {
      return -1;
    } else if (bLastUsed > 0) {
      return 1;
    }

    if (bScore !== aScore) {
      if (shouldShowSettings) {
        const scoreDiff = Math.abs(bScore - aScore);
        if (scoreDiff <= 500) {
          if (aIsSettingsApp && !bIsSettingsApp) return -1;
          if (!aIsSettingsApp && bIsSettingsApp) return 1;
        }
      }
      return bScore - aScore;
    }
  } else {
    // 空查询：最近使用绝对优先
    if (aLastUsed > 0 && bLastUsed > 0) {
      return bLastUsed - aLastUsed;
    } else if (aLastUsed > 0) {
      return -1;
    } else if (bLastUsed > 0) {
      return 1;
    }

    if (bScore !== aScore) {
      return bScore - aScore;
    }
  }

  // 类型优先级
  if (a.type === "app" && b.type !== "app") return -1;
  if (a.type !== "app" && b.type === "app") return 1;
  if (a.type === "file" && b.type === "everything") return -1;
  if (a.type === "everything" && b.type === "file") return 1;

  if (
    aUseCount !== undefined &&
    bUseCount !== undefined &&
    aUseCount !== bUseCount
  ) {
    return bUseCount - aUseCount;
  } else if (aUseCount !== undefined && bUseCount === undefined) {
    return -1;
  } else if (aUseCount === undefined && bUseCount !== undefined) {
    return 1;
  }

  return (a.displayName || "").localeCompare(b.displayName || "");
}

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

/** 与 openHistory 的 key 对齐的路径匹配（见 getResultUsageInfo） */
export function getOpenHistoryTimestamp(
  path: string,
  openHistory: Record<string, number>
): number | undefined {
  const normalized = normalizePathForHistory(path);
  for (const [key, ts] of Object.entries(openHistory)) {
    if (normalizePathForHistory(key) === normalized) {
      return ts;
    }
  }
  return undefined;
}

/**
 * 在横向/「当前可见」纵向列表中优先选中 openHistory 最新一项。
 * vertical 必须是可见扁平列表（含分组截断），不能对完整 Everything 结果直接取下标，
 * 否则越界校正会夹到最后一项（常为「显示更多」）并滚到底部。
 */
export function pickSelectionIndicesByOpenHistory(
  horizontal: SearchResult[],
  visibleVerticalItems: VisibleVerticalItem[],
  openHistory: Record<string, number>
): { selectedHorizontalIndex: number | null; selectedVerticalIndex: number | null } {
  let bestTs = -1;
  let selectedH: number | null = null;
  let selectedV: number | null = null;

  for (let i = 0; i < horizontal.length; i++) {
    const ts = getOpenHistoryTimestamp(horizontal[i].path, openHistory);
    if (ts !== undefined && ts > bestTs) {
      bestTs = ts;
      selectedH = i;
      selectedV = null;
    }
  }
  for (let i = 0; i < visibleVerticalItems.length; i++) {
    const item = visibleVerticalItems[i];
    if (item.kind !== "result") continue;
    const ts = getOpenHistoryTimestamp(item.result.path, openHistory);
    if (ts !== undefined && ts > bestTs) {
      bestTs = ts;
      selectedH = null;
      selectedV = i;
    }
  }

  if (bestTs >= 0 && (selectedH !== null || selectedV !== null)) {
    return {
      selectedHorizontalIndex: selectedH,
      selectedVerticalIndex: selectedV,
    };
  }

  if (horizontal.length > 0) {
    return { selectedHorizontalIndex: 0, selectedVerticalIndex: null };
  }
  const firstVertical = visibleVerticalItems.findIndex((item) => item.kind === "result");
  if (firstVertical >= 0) {
    return { selectedHorizontalIndex: null, selectedVerticalIndex: firstVertical };
  }
  return { selectedHorizontalIndex: null, selectedVerticalIndex: null };
}

/** 从完整纵向结果生成默认可见列表后再选中，供增量加载使用 */
export function pickSelectionIndicesByOpenHistoryFromVertical(
  horizontal: SearchResult[],
  vertical: SearchResult[],
  openHistory: Record<string, number>
): { selectedHorizontalIndex: number | null; selectedVerticalIndex: number | null } {
  return pickSelectionIndicesByOpenHistory(
    horizontal,
    buildDefaultVisibleVerticalItems(vertical),
    openHistory
  );
}

/**
 * 增量加载时的选中策略：优先保持选中锁定项（存在则选中该项），
 * 锁定项不在可见结果中时回退到按 openHistory 重选。
 * 避免「自动选中 → 锁定 effect 再纠正」造成的选中抖动。
 */
export function pickSelectionIndicesWithPin(
  horizontal: SearchResult[],
  vertical: SearchResult[],
  openHistory: Record<string, number>,
  pinnedKeyRef?: React.MutableRefObject<string | null>
): { selectedHorizontalIndex: number | null; selectedVerticalIndex: number | null } {
  const pinnedKey = pinnedKeyRef?.current;
  if (pinnedKey) {
    const hIndex = horizontal.findIndex((r) => getResultKey(r) === pinnedKey);
    if (hIndex >= 0) {
      return { selectedHorizontalIndex: hIndex, selectedVerticalIndex: null };
    }
    const visible = buildDefaultVisibleVerticalItems(vertical);
    const vIndex = visible.findIndex(
      (item) => item.kind === "result" && getResultKey(item.result) === pinnedKey
    );
    if (vIndex >= 0) {
      return { selectedHorizontalIndex: null, selectedVerticalIndex: vIndex };
    }
  }
  return pickSelectionIndicesByOpenHistoryFromVertical(horizontal, vertical, openHistory);
}

/**
 * 扁平结果列表中优先选中 openHistory 时间戳最新的一项；无匹配时返回 null（由调用方决定默认行为）。
 */
export function findBestFlatResultIndexFromOpenHistory(
  results: SearchResult[],
  openHistory: Record<string, number>
): number | null {
  let bestIdx: number | null = null;
  let bestTs = -1;
  for (let i = 0; i < results.length; i++) {
    const ts = getOpenHistoryTimestamp(results[i].path, openHistory);
    if (ts !== undefined && ts > bestTs) {
      bestTs = ts;
      bestIdx = i;
    }
  }
  return bestIdx;
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
  const horizontalUnsorted = [...deduplicatedExecutableResults, ...systemFolderResults, ...pluginResults]
    .filter((result) => shouldKeepResultForQuery(result, searchQuery));
  
  // 有查询：匹配档位优先；空查询：最近使用优先
  const horizontal = horizontalUnsorted.sort((a, b) =>
    compareSearchResults(a, b, {
      query: searchQuery,
      openHistory: openHistoryData,
      preferSpecialTypes: false,
    })
  );
  
  const vertical = allResults.filter(result => {
    // 排除应该显示在横向列表中的结果（可执行文件、快捷方式、UWP 应用、系统文件夹、插件）
    if (shouldShowInHorizontal(result)) return false;
    return shouldKeepResultForQuery(result, searchQuery);
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
  setIsIncrementalLoading?: (loading: boolean) => void;
  /** 选中锁定键：存在时优先保持该行选中，而非按 openHistory 重选 */
  pinnedKeyRef?: React.MutableRefObject<string | null>;
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
    setIsIncrementalLoading,
    pinnedKeyRef,
  } = options;

  const setIncrementalLoading = (loading: boolean) => {
    setIsIncrementalLoading?.(loading);
  };
  
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
    const sel = pickSelectionIndicesWithPin(
      finalHorizontal,
      vertical,
      openHistory,
      pinnedKeyRef
    );
    setSelectedHorizontalIndex(sel.selectedHorizontalIndex);
    setSelectedVerticalIndex(sel.selectedVerticalIndex);
    currentLoadResultsRef.current = [];
    // 成功加载后，更新 lastLoadQueryRef 为当前查询
    // 这样下次查询变化时，检查才能正确工作
    lastLoadQueryRef.current = currentQuery;
    setIncrementalLoading(false);
    return;
  }

  // 重置显示数量（如果有结果就显示，即使查询为空）
  // 只有在结果数量 > INITIAL_COUNT 时才需要增量加载
  setIncrementalLoading(true);
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
    
    const selInitial = pickSelectionIndicesWithPin(
      finalHorizontal,
      finalVertical,
      openHistory,
      pinnedKeyRef
    );
    setSelectedHorizontalIndex(selInitial.selectedHorizontalIndex);
    setSelectedVerticalIndex(selInitial.selectedVerticalIndex);
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
        horizontalResultsRef,
        logMessage: '[horizontalResults] 清空横向结果 (结果已过时或查询已清空)',
      });
      incrementalLoadRef.current = null;
      incrementalTimeoutRef.current = null;
      setIncrementalLoading(false);
      return;
    }

    if (currentCount < allResults.length) {
      currentCount = Math.min(currentCount + INCREMENT, allResults.length);
      
      // 再次检查结果是否仍然有效
      if (queryRef.current.trim() !== "" && 
          currentLoadResultsRef.current === allResults) {
        const currentResults = allResults.slice(0, currentCount);
        // 重要：横向列表已经在初始加载时设置过了（基于完整排序后的结果）
        // 增量加载时只需要更新纵向列表，不需要重复设置横向列表
        const { vertical: currentVertical } = splitResults(currentResults, openHistory, currentQuery);
        setResults(currentResults);
        // 横向列表不需要在增量加载时重复设置，避免不必要的刷新
        // 横向列表已经在第449行设置过了，使用的是完整排序后的结果
        setVerticalResults(currentVertical);
        // 更新ref以跟踪当前的横向结果（保持引用一致）
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
          horizontalResultsRef,
          logMessage: '[horizontalResults] 清空横向结果 (增量加载中结果已过时)',
        });
        incrementalLoadRef.current = null;
        incrementalTimeoutRef.current = null;
        setIncrementalLoading(false);
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
        setIncrementalLoading(false);
      }
    } else {
      // 加载完成
      incrementalLoadRef.current = null;
      incrementalTimeoutRef.current = null;
      currentLoadResultsRef.current = [];
      setIncrementalLoading(false);
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

