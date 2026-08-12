/**
 * 键盘导航处理工具函数
 * 负责处理键盘事件，包括方向键导航、Enter 键启动、Escape 键关闭等
 */

import type React from "react";
import type { RefObject, MutableRefObject } from "react";
import type { SearchResult } from "./resultUtils";
import {
  clearAllResults,
  getResultKey,
  resetSelectedIndices,
  selectFirstHorizontal,
  selectFirstVertical,
} from "./resultUtils";
import { getQueryHistory } from "./queryHistoryUtils";
import {
  type VisibleVerticalItem,
  getResultFromVisibleItem,
} from "./resultGroupUtils";

/**
 * 键盘导航处理的选项接口
 */
export interface HandleKeyDownOptions {
  // Event
  e: React.KeyboardEvent;

  // Refs
  inputRef: RefObject<HTMLInputElement>;
  isHorizontalNavigationRef: MutableRefObject<boolean>;
  justJumpedToVerticalRef: MutableRefObject<boolean>;
  horizontalResultsRef: MutableRefObject<SearchResult[]>;
  currentLoadResultsRef: MutableRefObject<SearchResult[]>;
  /** 查询历史浏览索引，-1 表示未在浏览 */
  queryHistoryIndexRef: MutableRefObject<number>;
  isBrowsingQueryHistoryRef: MutableRefObject<boolean>;

  // States
  query: string;
  contextMenu: { x: number; y: number; result: SearchResult } | null;
  errorMessage: string | null;
  isPluginListModalOpen: boolean;
  isMemoModalOpen: boolean;
  isRemarkModalOpen: boolean;
  pastedImageDataUrl: string | null;
  selectedHorizontalIndex: number | null;
  selectedVerticalIndex: number | null;
  horizontalResults: SearchResult[];
  /** 可键盘导航的纵向可见项（含「显示更多」） */
  visibleVerticalItems: VisibleVerticalItem[];
  isResultsInteractive: boolean;
  /** 选中锁定：用户手动选中结果后记录，结果刷新时保持该行不跳走 */
  pinnedResultRef: MutableRefObject<SearchResult | null>;
  /** 记录/清除选中锁定 */
  setPinnedResult: (result: SearchResult | null) => void;

  // Setters
  setContextMenu: (
    menu: { x: number; y: number; result: SearchResult } | null
  ) => void;
  setErrorMessage: (message: string | null) => void;
  setIsPluginListModalOpen: (open: boolean) => void;
  setIsMemoModalOpen: (open: boolean) => void;
  setIsRemarkModalOpen: (open: boolean) => void;
  setEditingRemarkUrl: (url: string | null) => void;
  setRemarkText: (text: string) => void;
  setPastedImageDataUrl: (url: string | null) => void;
  setPastedImagePath: (path: string | null) => void;
  setSelectedHorizontalIndex: (index: number | null) => void;
  setSelectedVerticalIndex: (index: number | null) => void;
  setResults: (results: SearchResult[]) => void;
  setHorizontalResults: (results: SearchResult[]) => void;
  setVerticalResults: (results: SearchResult[]) => void;
  setQuery: (query: string) => void;
  /** 从历史填入查询（保持浏览模式） */
  applyQueryFromHistory: (query: string, historyIndex: number) => void;
  /** 展开 Everything「显示更多」 */
  onExpandEverything?: () => void;

  // Functions
  hideLauncherAndResetState: (options?: {
    resetMemo?: boolean;
    resetAi?: boolean;
  }) => Promise<void>;
  resetMemoState: () => void;
  handleLaunch: (result: SearchResult) => Promise<void>;
}

function canBrowseQueryHistory(
  query: string,
  isBrowsing: boolean,
  selectedHorizontalIndex: number | null,
  selectedVerticalIndex: number | null,
  horizontalCount: number,
  verticalCount: number,
  direction: "up" | "down"
): boolean {
  if (selectedHorizontalIndex !== null || selectedVerticalIndex !== null) {
    return false;
  }
  const hasResults = horizontalCount > 0 || verticalCount > 0;
  // 有结果时 ↓ 优先进入结果列表，不继续翻历史
  if (direction === "down" && hasResults) {
    return false;
  }
  return query === "" || isBrowsing;
}

/**
 * 处理键盘按下事件
 */
export async function handleKeyDown(
  options: HandleKeyDownOptions
): Promise<void> {
  const {
    e,
    inputRef,
    isHorizontalNavigationRef,
    justJumpedToVerticalRef,
    horizontalResultsRef,
    currentLoadResultsRef,
    queryHistoryIndexRef,
    isBrowsingQueryHistoryRef,
    query,
    contextMenu,
    errorMessage,
    isPluginListModalOpen,
    isMemoModalOpen,
    isRemarkModalOpen,
    pastedImageDataUrl,
    selectedHorizontalIndex,
    selectedVerticalIndex,
    horizontalResults,
    visibleVerticalItems,
    isResultsInteractive,
    pinnedResultRef,
    setPinnedResult,
    setContextMenu,
    setErrorMessage,
    setIsPluginListModalOpen,
    setIsRemarkModalOpen,
    setEditingRemarkUrl,
    setRemarkText,
    setPastedImageDataUrl,
    setPastedImagePath,
    setSelectedHorizontalIndex,
    setSelectedVerticalIndex,
    setResults,
    setHorizontalResults,
    setVerticalResults,
    setQuery,
    applyQueryFromHistory,
    onExpandEverything,
    hideLauncherAndResetState,
    resetMemoState,
    handleLaunch,
  } = options;

  const verticalLen = visibleVerticalItems.length;

  /** 根据目标索引记录选中锁定（未选中任何行时清除） */
  const pinAt = (hIndex: number | null, vIndex: number | null) => {
    if (hIndex !== null && horizontalResults[hIndex]) {
      setPinnedResult(horizontalResults[hIndex]);
      return;
    }
    if (vIndex !== null) {
      const item = visibleVerticalItems[vIndex];
      setPinnedResult(item && item.kind === "result" ? item.result : null);
      return;
    }
    setPinnedResult(null);
  };

  if (e.key === "Escape" || e.keyCode === 27) {
    e.preventDefault();
    e.stopPropagation();
    if (contextMenu) {
      setContextMenu(null);
      return;
    }
    if (errorMessage) {
      setErrorMessage(null);
      return;
    }
    if (isPluginListModalOpen) {
      setIsPluginListModalOpen(false);
      setTimeout(() => {
        hideLauncherAndResetState();
      }, 100);
      return;
    }
    if (isMemoModalOpen) {
      resetMemoState();
      setTimeout(() => {
        hideLauncherAndResetState();
      }, 100);
      return;
    }
    if (isRemarkModalOpen) {
      setIsRemarkModalOpen(false);
      setEditingRemarkUrl(null);
      setRemarkText("");
      return;
    }
    await hideLauncherAndResetState({ resetMemo: true });
    return;
  }

  if (e.key === "Backspace") {
    if (query === "" && pastedImageDataUrl) {
      e.preventDefault();
      setPastedImageDataUrl(null);
      setPastedImagePath(null);
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
  }

  if (e.key === "ArrowDown") {
    e.preventDefault();

    if (
      canBrowseQueryHistory(
        query,
        isBrowsingQueryHistoryRef.current,
        selectedHorizontalIndex,
        selectedVerticalIndex,
        horizontalResults.length,
        verticalLen,
        "down"
      )
    ) {
      const history = getQueryHistory();
      if (isBrowsingQueryHistoryRef.current) {
        const idx = queryHistoryIndexRef.current;
        if (idx <= 0) {
          isBrowsingQueryHistoryRef.current = false;
          queryHistoryIndexRef.current = -1;
          setQuery("");
          return;
        }
        const nextIdx = idx - 1;
        applyQueryFromHistory(history[nextIdx] ?? "", nextIdx);
        return;
      }
      if (history.length > 0 && query === "") {
        applyQueryFromHistory(history[0], 0);
        return;
      }
    }

    const isInputFocused = document.activeElement === inputRef.current;

    if (selectedHorizontalIndex !== null) {
      if (verticalLen > 0) {
        justJumpedToVerticalRef.current = true;
        setSelectedHorizontalIndex(null);
        setSelectedVerticalIndex(0);
        pinAt(null, 0);
        setTimeout(() => {
          justJumpedToVerticalRef.current = false;
        }, 200);
        return;
      }
      return;
    }

    if (selectedVerticalIndex !== null) {
      if (selectedVerticalIndex < verticalLen - 1) {
        isHorizontalNavigationRef.current = false;
        const next = selectedVerticalIndex + 1;
        setSelectedVerticalIndex(next);
        pinAt(null, next);
        return;
      }
      return;
    }

    if (isInputFocused && horizontalResults.length > 0) {
      selectFirstHorizontal(setSelectedHorizontalIndex, setSelectedVerticalIndex);
      pinAt(0, null);
      return;
    }

    if (isInputFocused && verticalLen > 0) {
      selectFirstVertical(setSelectedHorizontalIndex, setSelectedVerticalIndex);
      pinAt(null, 0);
      return;
    }

    return;
  }

  if (e.key === "ArrowUp") {
    e.preventDefault();

    if (
      canBrowseQueryHistory(
        query,
        isBrowsingQueryHistoryRef.current,
        selectedHorizontalIndex,
        selectedVerticalIndex,
        horizontalResults.length,
        verticalLen,
        "up"
      )
    ) {
      const history = getQueryHistory();
      if (history.length > 0) {
        if (!isBrowsingQueryHistoryRef.current || query === "") {
          applyQueryFromHistory(history[0], 0);
          return;
        }
        const idx = queryHistoryIndexRef.current;
        const nextIdx = Math.min(idx + 1, history.length - 1);
        applyQueryFromHistory(history[nextIdx], nextIdx);
        return;
      }
    }

    if (selectedHorizontalIndex === 0) {
      if (inputRef.current) {
        inputRef.current.focus();
        const length = inputRef.current.value.length;
        inputRef.current.setSelectionRange(length, length);
      }
      resetSelectedIndices(setSelectedHorizontalIndex, setSelectedVerticalIndex);
      pinAt(null, null);
      return;
    }

    if (selectedVerticalIndex === 0) {
      if (horizontalResults.length > 0) {
        selectFirstHorizontal(setSelectedHorizontalIndex, setSelectedVerticalIndex);
        pinAt(0, null);
        return;
      } else {
        if (inputRef.current) {
          inputRef.current.focus();
          const length = inputRef.current.value.length;
          inputRef.current.setSelectionRange(length, length);
        }
        resetSelectedIndices(setSelectedHorizontalIndex, setSelectedVerticalIndex);
        pinAt(null, null);
        return;
      }
    }

    if (selectedVerticalIndex !== null && selectedVerticalIndex > 0) {
      isHorizontalNavigationRef.current = false;
      const prev = selectedVerticalIndex - 1;
      setSelectedVerticalIndex(prev);
      pinAt(null, prev);
      return;
    }

    if (selectedHorizontalIndex !== null && selectedHorizontalIndex > 0) {
      const prev = selectedHorizontalIndex - 1;
      setSelectedHorizontalIndex(prev);
      setSelectedVerticalIndex(null);
      pinAt(prev, null);
      return;
    }

    return;
  }

  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const isInputFocused = document.activeElement === inputRef.current;
    if (isInputFocused && inputRef.current) {
      const input = inputRef.current;
      const selectionStart = input.selectionStart ?? 0;
      const selectionEnd = input.selectionEnd ?? 0;
      const valueLength = input.value.length;

      if (selectionStart !== selectionEnd) {
        return;
      }

      if (e.key === "ArrowLeft") {
        // 仅在光标位于文本开头时才进入横向导航，避免编辑中间文本时箭头被劫持
        if (selectionStart === 0 && selectedHorizontalIndex !== null && selectedHorizontalIndex !== 0) {
          // continue to horizontal nav
        } else {
          return;
        }
      }

      if (e.key === "ArrowRight") {
        if (selectionEnd < valueLength) {
          return;
        }
      }
    }

    e.preventDefault();
    e.stopPropagation();

    if (horizontalResults.length === 0) {
      return;
    }

    isHorizontalNavigationRef.current = true;

    if (selectedHorizontalIndex !== null) {
      if (e.key === "ArrowRight") {
        const nextIndex =
          selectedHorizontalIndex < horizontalResults.length - 1
            ? selectedHorizontalIndex + 1
            : 0;
        setSelectedHorizontalIndex(nextIndex);
        setSelectedVerticalIndex(null);
        pinAt(nextIndex, null);
      } else if (e.key === "ArrowLeft") {
        if (selectedHorizontalIndex === 0) {
          const lastIndex = horizontalResults.length - 1;
          setSelectedHorizontalIndex(lastIndex);
          setSelectedVerticalIndex(null);
          pinAt(lastIndex, null);
          return;
        }
        const prevIndex =
          selectedHorizontalIndex > 0
            ? selectedHorizontalIndex - 1
            : horizontalResults.length - 1;
        setSelectedHorizontalIndex(prevIndex);
        setSelectedVerticalIndex(null);
        pinAt(prevIndex, null);
      }
    } else {
      if (e.key === "ArrowRight") {
        setSelectedHorizontalIndex(0);
        setSelectedVerticalIndex(null);
        pinAt(0, null);
      } else if (e.key === "ArrowLeft") {
        const lastIndex = horizontalResults.length - 1;
        setSelectedHorizontalIndex(lastIndex);
        setSelectedVerticalIndex(null);
        pinAt(lastIndex, null);
      }
    }

    setTimeout(() => {
      isHorizontalNavigationRef.current = false;
    }, 0);
    return;
  }

  if (e.key === "Enter") {
    e.preventDefault();
    let selectedResult: SearchResult | null = null;
    if (
      selectedHorizontalIndex !== null &&
      horizontalResults[selectedHorizontalIndex]
    ) {
      selectedResult = horizontalResults[selectedHorizontalIndex];
    } else if (
      selectedVerticalIndex !== null &&
      visibleVerticalItems[selectedVerticalIndex]
    ) {
      const item = visibleVerticalItems[selectedVerticalIndex];
      if (item.kind === "show_more") {
        onExpandEverything?.();
        return;
      }
      selectedResult = getResultFromVisibleItem(item);
    }
    if (!isResultsInteractive) {
      // 选中锁定：用户手动选中的行即使结果仍在刷新也可立即启动
      const pinned = pinnedResultRef.current;
      if (
        !pinned ||
        !selectedResult ||
        getResultKey(selectedResult) !== getResultKey(pinned)
      ) {
        return;
      }
    }
    if (selectedResult) {
      await handleLaunch(selectedResult);
    }
    return;
  }
}
