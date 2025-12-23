/**
 * 窗口大小调整相关的自定义 Hook
 * 负责处理窗口大小的自动调整和手动调整
 */

import { useEffect, type RefObject, type MutableRefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/window";
import { adjustWindowSize } from "../utils/windowUtils";
import type { SearchResult } from "../utils/resultUtils";

/**
 * 窗口大小调整 Hook 的选项接口
 */
export interface UseWindowSizeAdjustmentOptions {
  // Refs
  shouldPreserveScrollRef: MutableRefObject<boolean>;
  listRef: RefObject<HTMLElement>;
  resizeRafId: MutableRefObject<number | null>;
  resizeStartX: MutableRefObject<number>;
  resizeStartWidth: MutableRefObject<number>;

  // States
  isMemoModalOpen: boolean;
  isPluginListModalOpen: boolean;
  isResizing: boolean;
  windowWidth: number;
  debouncedCombinedResults: SearchResult[];
  results: SearchResult[];

  // Functions
  getMainContainer: () => HTMLElement | null;
  setWindowWidth: (width: number) => void;
  setIsResizing: (resizing: boolean) => void;
}

/**
 * 窗口大小调整 Hook
 */
export function useWindowSizeAdjustment(
  options: UseWindowSizeAdjustmentOptions
): void {
  const {
    shouldPreserveScrollRef,
    listRef,
    resizeRafId,
    resizeStartX,
    resizeStartWidth,
    isMemoModalOpen,
    isPluginListModalOpen,
    isResizing,
    windowWidth,
    debouncedCombinedResults,
    results,
    getMainContainer,
    setWindowWidth,
    setIsResizing,
  } = options;

  // 调整窗口大小的辅助函数
  const adjustWindowSizeInternal = (
    useScrollHeight: boolean = false,
    delay: number = 100
  ) => {
    setTimeout(() => {
      const window = getCurrentWindow();
      const whiteContainer = getMainContainer();
      if (whiteContainer && !isMemoModalOpen) {
        // Use double requestAnimationFrame to ensure DOM is fully updated
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            let containerHeight: number;
            if (useScrollHeight) {
              // Use scrollWidth/scrollHeight to get the full content size
              containerHeight = whiteContainer.scrollHeight;
            } else {
              const containerRect = whiteContainer.getBoundingClientRect();
              containerHeight = containerRect.height;
            }

            // Use saved window width
            const targetWidth = windowWidth;

            // 限制最大高度，避免窗口突然撑高导致不丝滑
            const MAX_HEIGHT = 600; // 最大高度600px
            const MIN_HEIGHT = 200; // 最小高度200px，默认主界面更高
            const targetHeight = Math.max(
              MIN_HEIGHT,
              Math.min(containerHeight, MAX_HEIGHT)
            );

            // 直接设置窗口大小（简化版本，不使用动画过渡以避免复杂性）
            window
              .setSize(new LogicalSize(targetWidth, targetHeight))
              .catch(console.error);
          });
        });
      }
    }, delay);
  };

  // 保存滚动位置并调整窗口大小（当 debouncedCombinedResults 变化时）
  useEffect(() => {
    // 保存当前滚动位置（如果需要保持）
    const needPreserveScroll = shouldPreserveScrollRef.current;
    const savedScrollTop =
      needPreserveScroll && listRef.current
        ? listRef.current.scrollTop
        : null;
    const savedScrollHeight =
      needPreserveScroll && listRef.current
        ? listRef.current.scrollHeight
        : null;

    // 如果需要保持滚动位置，在 DOM 更新后恢复
    if (
      needPreserveScroll &&
      savedScrollTop !== null &&
      savedScrollHeight !== null
    ) {
      // 使用多个 requestAnimationFrame 确保 DOM 完全更新
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (listRef.current) {
              const newScrollHeight = listRef.current.scrollHeight;
              // 计算新的滚动位置（保持相对位置）
              const scrollRatio = savedScrollTop / savedScrollHeight;
              const newScrollTop = newScrollHeight * scrollRatio;
              listRef.current.scrollTop = newScrollTop;
              shouldPreserveScrollRef.current = false;
            }
          });
        });
      });
    } else if (!needPreserveScroll && listRef.current) {
      // 如果不是保持滚动位置，且列表有滚动，不要重置滚动位置
      // 这样可以避免意外的滚动重置
    }

    // 使用节流优化窗口大小调整，避免频繁调用导致卡顿
    // 如果正在保持滚动位置，延迟窗口大小调整，让滚动位置先恢复
    // 如果备忘录模态框打开，不在这里调整窗口大小（由专门的 useEffect 处理）
    if (isMemoModalOpen) {
      return;
    }

    const delay = needPreserveScroll ? 600 : 100; // 减少延迟，让响应更快
    adjustWindowSizeInternal(true, delay);
  }, [debouncedCombinedResults, isMemoModalOpen, windowWidth]);

  // 调整窗口大小（当 results 状态更新时）
  useEffect(() => {
    // 如果备忘录模态框打开，不在这里调整窗口大小
    if (isMemoModalOpen) {
      return;
    }

    adjustWindowSizeInternal(false, 100);
  }, [results, isMemoModalOpen, windowWidth]);

  // 当 windowWidth 变化时更新窗口大小（但不包括调整大小过程中）
  useEffect(() => {
    if (isMemoModalOpen || isPluginListModalOpen || isResizing) {
      return;
    }

    setTimeout(() => {
      adjustWindowSize({
        windowWidth,
        isMemoModalOpen,
        getContainer: getMainContainer,
      });
    }, 50);
  }, [windowWidth, isMemoModalOpen, isPluginListModalOpen, isResizing]);

  // 处理窗口宽度调整（鼠标拖拽）
  useEffect(() => {
    if (!isResizing) return;

    const whiteContainer = getMainContainer();
    if (!whiteContainer) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Cancel any pending animation frame
      if (resizeRafId.current !== null) {
        cancelAnimationFrame(resizeRafId.current);
      }

      // Use requestAnimationFrame to smooth out updates
      resizeRafId.current = requestAnimationFrame(() => {
        // Calculate new width based on mouse movement from start position
        const deltaX = e.clientX - resizeStartX.current;
        const newWidth = Math.max(
          400,
          Math.min(1200, resizeStartWidth.current + deltaX)
        );

        // Update window size directly without triggering state update during drag
        const window = getCurrentWindow();
        const containerHeight = whiteContainer.scrollHeight;
        const MAX_HEIGHT = 600;
        const MIN_HEIGHT = 200;
        const targetHeight = Math.max(
          MIN_HEIGHT,
          Math.min(containerHeight, MAX_HEIGHT)
        );

        // Update container width directly for immediate visual feedback
        whiteContainer.style.width = `${newWidth}px`;

        // Update window size
        window
          .setSize(new LogicalSize(newWidth, targetHeight))
          .catch(console.error);
      });
    };

    const handleMouseUp = () => {
      // Cancel any pending animation frame
      if (resizeRafId.current !== null) {
        cancelAnimationFrame(resizeRafId.current);
        resizeRafId.current = null;
      }

      // Get final width from container
      const whiteContainer = getMainContainer();
      if (whiteContainer) {
        const finalWidth = whiteContainer.offsetWidth;
        setWindowWidth(finalWidth);
        localStorage.setItem("launcher-window-width", finalWidth.toString());
      }

      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      if (resizeRafId.current !== null) {
        cancelAnimationFrame(resizeRafId.current);
      }
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing]);
}

