/**
 * 判断搜索结果是否已稳定，可用于控制是否允许点击/启动
 */

import { useEffect, useMemo, useState } from "react";

export interface SearchStatusDetail {
  primary: string;
  items: string[];
}

export interface UseResultsInteractivityOptions {
  query: string;
  combinedResultsQuery: string;
  resultsCount: number;
  horizontalCount: number;
  verticalCount: number;
  isSearchingEverything: boolean;
  isEverythingAvailable: boolean;
  everythingCurrentCount: number;
  everythingTotalCount: number | null;
  everythingLabel: string;
  isCombinedStable: boolean;
  isIncrementalLoading: boolean;
  isDebouncePending: boolean;
  isLocalSearchPending: boolean;
  /** 结果停止变化后额外等待的时间（ms） */
  settleDelayMs?: number;
}

function buildSearchStatus(options: {
  query: string;
  combinedResultsQuery: string;
  resultsCount: number;
  isSearchingEverything: boolean;
  isEverythingAvailable: boolean;
  everythingCurrentCount: number;
  everythingTotalCount: number | null;
  everythingLabel: string;
  isCombinedStable: boolean;
  isIncrementalLoading: boolean;
  isDebouncePending: boolean;
  isLocalSearchPending: boolean;
  isSettling: boolean;
}): SearchStatusDetail {
  const {
    query,
    combinedResultsQuery,
    resultsCount,
    isSearchingEverything,
    isEverythingAvailable,
    everythingCurrentCount,
    everythingTotalCount,
    everythingLabel,
    isCombinedStable,
    isIncrementalLoading,
    isDebouncePending,
    isLocalSearchPending,
    isSettling,
  } = options;

  const trimmedQuery = query.trim();
  const items: string[] = [];

  if (isDebouncePending) {
    items.push("等待输入稳定");
  }

  if (isLocalSearchPending) {
    items.push("应用与文件历史");
  }

  if (isEverythingAvailable && isSearchingEverything) {
    if (everythingTotalCount != null && everythingTotalCount > 0) {
      items.push(
        `${everythingLabel} ${everythingCurrentCount.toLocaleString()}/${everythingTotalCount.toLocaleString()} 条`
      );
    } else if (everythingCurrentCount > 0) {
      items.push(`${everythingLabel} 已加载 ${everythingCurrentCount.toLocaleString()} 条`);
    } else {
      items.push(`${everythingLabel} 搜索中`);
    }
  }

  if (
    trimmedQuery !== "" &&
    combinedResultsQuery.trim() !== trimmedQuery &&
    !isDebouncePending
  ) {
    items.push(`匹配「${trimmedQuery}」`);
  }

  if (!isCombinedStable) {
    items.push("整理排序");
  }

  if (isIncrementalLoading) {
    items.push(`列表已显示 ${resultsCount.toLocaleString()} 条`);
  }

  if (isSettling) {
    items.push("即将完成");
  }

  const primary =
    items.length > 0
      ? "结果更新中"
      : trimmedQuery !== ""
        ? `正在搜索「${trimmedQuery}」`
        : "搜索中";

  return { primary, items };
}

export function useResultsInteractivity(
  options: UseResultsInteractivityOptions
): {
  isInteractive: boolean;
  isSearching: boolean;
  searchStatus: SearchStatusDetail;
} {
  const {
    query,
    combinedResultsQuery,
    resultsCount,
    horizontalCount,
    verticalCount,
    isSearchingEverything,
    isEverythingAvailable,
    everythingCurrentCount,
    everythingTotalCount,
    everythingLabel,
    isCombinedStable,
    isIncrementalLoading,
    isDebouncePending,
    isLocalSearchPending,
    settleDelayMs = 350,
  } = options;

  const [isInteractive, setIsInteractive] = useState(true);
  const [isSettling, setIsSettling] = useState(false);
  const hasQuery = query.trim().length > 0;

  useEffect(() => {
    if (!hasQuery) {
      setIsInteractive(true);
      setIsSettling(false);
      return;
    }

    setIsInteractive(false);

    const busy =
      isDebouncePending ||
      isLocalSearchPending ||
      isSearchingEverything ||
      !isCombinedStable ||
      isIncrementalLoading ||
      combinedResultsQuery.trim() !== query.trim();

    if (busy) {
      setIsSettling(false);
      return;
    }

    setIsSettling(true);
    const timer = window.setTimeout(() => {
      setIsInteractive(true);
      setIsSettling(false);
    }, settleDelayMs);

    return () => {
      window.clearTimeout(timer);
      setIsSettling(false);
    };
  }, [
    hasQuery,
    query,
    combinedResultsQuery,
    resultsCount,
    horizontalCount,
    verticalCount,
    isDebouncePending,
    isLocalSearchPending,
    isSearchingEverything,
    isCombinedStable,
    isIncrementalLoading,
    settleDelayMs,
  ]);

  const searchStatus = useMemo(
    () =>
      buildSearchStatus({
        query,
        combinedResultsQuery,
        resultsCount,
        isSearchingEverything,
        isEverythingAvailable,
        everythingCurrentCount,
        everythingTotalCount,
        everythingLabel,
        isCombinedStable,
        isIncrementalLoading,
        isDebouncePending,
        isLocalSearchPending,
        isSettling,
      }),
    [
      query,
      combinedResultsQuery,
      resultsCount,
      isSearchingEverything,
      isEverythingAvailable,
      everythingCurrentCount,
      everythingTotalCount,
      everythingLabel,
      isCombinedStable,
      isIncrementalLoading,
      isDebouncePending,
      isLocalSearchPending,
      isSettling,
    ]
  );

  return {
    isInteractive,
    isSearching: hasQuery && !isInteractive,
    searchStatus,
  };
}
