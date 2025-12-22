/**
 * 键盘导航处理工具函数
 * 负责处理键盘事件，包括方向键导航、Enter 键启动、Escape 键关闭等
 */

import type React from "react";
import type { RefObject } from "react";
import type { SearchResult } from "./resultUtils";
import {
  clearAllResults,
  resetSelectedIndices,
  selectFirstHorizontal,
  selectFirstVertical,
} from "./resultUtils";

/**
 * 键盘导航处理的选项接口
 */
export interface HandleKeyDownOptions {
  // Event
  e: React.KeyboardEvent;

  // Refs
  inputRef: RefObject<HTMLInputElement>;
  isHorizontalNavigationRef: RefObject<boolean>;
  justJumpedToVerticalRef: RefObject<boolean>;
  horizontalResultsRef: RefObject<SearchResult[]>;
  currentLoadResultsRef: RefObject<SearchResult[]>;

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
  verticalResults: SearchResult[];

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

  // Functions
  hideLauncherAndResetState: (options?: {
    resetMemo?: boolean;
    resetAi?: boolean;
  }) => Promise<void>;
  resetMemoState: () => void;
  handleLaunch: (result: SearchResult) => Promise<void>;
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
    verticalResults,
    setContextMenu,
    setErrorMessage,
    setIsPluginListModalOpen,
    setIsMemoModalOpen,
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
    hideLauncherAndResetState,
    resetMemoState,
    handleLaunch,
  } = options;

  if (e.key === "Escape" || e.keyCode === 27) {
    e.preventDefault();
    e.stopPropagation();
    // 如果右键菜单已打开，优先关闭右键菜单
    if (contextMenu) {
      setContextMenu(null);
      return;
    }
    // 如果错误弹窗已打开，关闭错误弹窗（ErrorDialog 内部也会处理 ESC，但这里提前处理以避免其他逻辑执行）
    if (errorMessage) {
      setErrorMessage(null);
      return;
    }
    // 如果应用中心弹窗已打开，关闭应用中心并隐藏窗口（插件像独立软件一样运行）
    if (isPluginListModalOpen) {
      setIsPluginListModalOpen(false);
      // 延迟隐藏窗口，让关闭动画完成
      setTimeout(() => {
        hideLauncherAndResetState();
      }, 100);
      return;
    }
    // 如果备忘录弹窗已打开，关闭备忘录并隐藏窗口（插件像独立软件一样运行）
    if (isMemoModalOpen) {
      resetMemoState();
      // 延迟隐藏窗口，让关闭动画完成
      setTimeout(() => {
        hideLauncherAndResetState();
      }, 100);
      return;
    }
    // 如果备注弹窗已打开，只关闭备注弹窗，不关闭启动器
    if (isRemarkModalOpen) {
      setIsRemarkModalOpen(false);
      setEditingRemarkUrl(null);
      setRemarkText("");
      return;
    }
    await hideLauncherAndResetState({ resetMemo: true });
    return;
  }

  // 处理退格键删除粘贴的图片
  if (e.key === "Backspace") {
    // 如果输入框为空且有粘贴的图片，则删除图片预览
    if (query === "" && pastedImageDataUrl) {
      e.preventDefault();
      setPastedImageDataUrl(null);
      setPastedImagePath(null);
      // 清除搜索结果
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

    // 检查当前焦点是否在输入框
    const isInputFocused = document.activeElement === inputRef.current;

    // 如果当前选中的是横向结果，按ArrowDown应该跳转到第一个纵向结果
    if (selectedHorizontalIndex !== null) {
      if (verticalResults.length > 0) {
        // Mark that we just jumped to vertical to prevent results useEffect from resetting
        justJumpedToVerticalRef.current = true;
        setSelectedHorizontalIndex(null);
        setSelectedVerticalIndex(0);
        // Reset flag after a delay
        setTimeout(() => {
          justJumpedToVerticalRef.current = false;
        }, 200);
        return;
      }
      // No vertical results, stay at horizontal
      return;
    }

    // 如果当前选中的是纵向结果，移动到下一个纵向结果
    if (selectedVerticalIndex !== null) {
      if (selectedVerticalIndex < verticalResults.length - 1) {
        // Ensure horizontal navigation flag is false for vertical navigation
        isHorizontalNavigationRef.current = false;
        setSelectedVerticalIndex(selectedVerticalIndex + 1);
        return;
      }
      // No more vertical results, stay at current position
      return;
    }

    // 如果输入框有焦点，且有横向结果，则选中第一个横向结果
    if (isInputFocused && horizontalResults.length > 0) {
      selectFirstHorizontal(setSelectedHorizontalIndex, setSelectedVerticalIndex);
      return;
    }

    // 如果输入框有焦点，且有纵向结果，则选中第一个纵向结果
    if (isInputFocused && verticalResults.length > 0) {
      selectFirstVertical(setSelectedHorizontalIndex, setSelectedVerticalIndex);
      return;
    }

    return;
  }

  if (e.key === "ArrowUp") {
    e.preventDefault();

    // If we're at the first horizontal result, focus back to the search input
    if (selectedHorizontalIndex === 0) {
      // Focus the input and move cursor to the end
      if (inputRef.current) {
        inputRef.current.focus();
        const length = inputRef.current.value.length;
        inputRef.current.setSelectionRange(length, length);
      }
      resetSelectedIndices(setSelectedHorizontalIndex, setSelectedVerticalIndex);
      return;
    }

    // If we're at the first vertical result, focus back to input or jump to first horizontal
    if (selectedVerticalIndex === 0) {
      if (horizontalResults.length > 0) {
        // Jump to first horizontal result
        selectFirstHorizontal(setSelectedHorizontalIndex, setSelectedVerticalIndex);
        return;
      } else {
        // Focus input
        if (inputRef.current) {
          inputRef.current.focus();
          const length = inputRef.current.value.length;
          inputRef.current.setSelectionRange(length, length);
        }
        resetSelectedIndices(setSelectedHorizontalIndex, setSelectedVerticalIndex);
        return;
      }
    }

    // If current selection is in vertical results, move to previous vertical result
    if (selectedVerticalIndex !== null && selectedVerticalIndex > 0) {
      // Ensure horizontal navigation flag is false for vertical navigation
      isHorizontalNavigationRef.current = false;
      setSelectedVerticalIndex(selectedVerticalIndex - 1);
      return;
    }

    // If current selection is in horizontal results (not first), move to previous horizontal
    if (selectedHorizontalIndex !== null && selectedHorizontalIndex > 0) {
      setSelectedHorizontalIndex(selectedHorizontalIndex - 1);
      setSelectedVerticalIndex(null);
      return;
    }

    return;
  }

  // 横向结果切换（ArrowLeft/ArrowRight）
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    // 检查输入框是否有焦点，以及光标位置
    const isInputFocused = document.activeElement === inputRef.current;
    if (isInputFocused && inputRef.current) {
      const input = inputRef.current;
      const selectionStart = input.selectionStart ?? 0;
      const selectionEnd = input.selectionEnd ?? 0;
      const valueLength = input.value.length;

      // 如果有文本被选中，允许方向键正常处理（用于取消选中或移动光标）
      if (selectionStart !== selectionEnd) {
        return; // 不拦截，让输入框正常处理
      }

      // 对于左箭头：只有当横向列表选中的不是第1个元素时，才优先用于横向列表
      // 如果横向列表选中的是第1个元素（索引0）或没有选中项，允许在输入框内移动光标
      if (e.key === "ArrowLeft") {
        // 如果横向列表选中的不是第1个元素，优先用于横向列表导航
        if (selectedHorizontalIndex !== null && selectedHorizontalIndex !== 0) {
          // 不返回，继续执行横向列表切换逻辑
        } else {
          // 横向列表没有选中项或选中第1个元素，允许在输入框内移动光标
          // 无论光标在哪里，都让输入框处理（即使光标在开头无法移动，也不应该跳到横向列表）
          return; // 让输入框处理左箭头
        }
      }

      // 对于右箭头：如果光标不在最右端，优先用于输入框；否则用于横向列表切换
      if (e.key === "ArrowRight") {
        // 如果光标不在最右端，优先用于输入框移动光标
        if (selectionEnd < valueLength) {
          return; // 光标不在结尾，允许右移
        }
        // 如果光标在最右端，不返回，继续执行横向列表切换逻辑
      }
    }

    // 立即阻止默认行为和事件传播，防止页面滚动
    e.preventDefault();
    e.stopPropagation();

    // 如果横向结果为空，不处理但已阻止默认行为
    if (horizontalResults.length === 0) {
      return;
    }

    // 标记这是横向导航，避免触发 scrollIntoView
    isHorizontalNavigationRef.current = true;

    // 如果当前选中的是横向结果
    if (selectedHorizontalIndex !== null) {
      // 在横向结果之间切换
      if (e.key === "ArrowRight") {
        // 切换到下一个横向结果
        const nextIndex =
          selectedHorizontalIndex < horizontalResults.length - 1
            ? selectedHorizontalIndex + 1
            : 0; // 循环到第一个
        setSelectedHorizontalIndex(nextIndex);
        setSelectedVerticalIndex(null);
      } else if (e.key === "ArrowLeft") {
        // 如果是在第一个横向结果，跳到最后一个横向结果
        if (selectedHorizontalIndex === 0) {
          setSelectedHorizontalIndex(horizontalResults.length - 1);
          setSelectedVerticalIndex(null);
          return;
        }
        // 否则切换到上一个横向结果
        const prevIndex =
          selectedHorizontalIndex > 0
            ? selectedHorizontalIndex - 1
            : horizontalResults.length - 1; // 循环到最后一个
        setSelectedHorizontalIndex(prevIndex);
        setSelectedVerticalIndex(null);
      }
    } else {
      // 当前选中的是纵向结果，切换到横向结果的第一个或最后一个
      if (e.key === "ArrowRight") {
        // 切换到横向结果的第一个
        setSelectedHorizontalIndex(0);
        setSelectedVerticalIndex(null);
      } else if (e.key === "ArrowLeft") {
        // 切换到横向结果的最后一个
        setSelectedHorizontalIndex(horizontalResults.length - 1);
        setSelectedVerticalIndex(null);
      }
    }

    // 在下一个 tick 重置标志，允许后续的垂直导航触发滚动
    setTimeout(() => {
      isHorizontalNavigationRef.current = false;
    }, 0);
    return;
  }

  if (e.key === "Enter") {
    e.preventDefault();
    // Get the selected result from either horizontal or vertical
    let selectedResult: SearchResult | null = null;
    if (
      selectedHorizontalIndex !== null &&
      horizontalResults[selectedHorizontalIndex]
    ) {
      selectedResult = horizontalResults[selectedHorizontalIndex];
    } else if (
      selectedVerticalIndex !== null &&
      verticalResults[selectedVerticalIndex]
    ) {
      selectedResult = verticalResults[selectedVerticalIndex];
    }
    if (selectedResult) {
      await handleLaunch(selectedResult);
    }
    return;
  }
}

