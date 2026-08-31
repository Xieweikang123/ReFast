/**
 * 窗口大小调整相关的自定义 Hook
 * 负责处理窗口大小的自动调整和手动调整
 */

import { useEffect, useRef, type RefObject, type MutableRefObject } from "react";
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
  containerRef?: RefObject<HTMLElement | null>;
  resizeRafId: MutableRefObject<number | null>;
  resizeStartX: MutableRefObject<number>;
  resizeStartWidth: MutableRefObject<number>;

  // States
  isMemoModalOpen: boolean;
  isPluginListModalOpen: boolean;
  isOverlayActive?: boolean;
  isResizing: boolean;
  windowWidth: number;
  debouncedCombinedResults: SearchResult[];
  results: SearchResult[];

  // Functions
  getMainContainer: () => HTMLElement | null;
  setWindowWidth: (width: number) => void;
  setIsResizing: (resizing: boolean) => void;
}

const MAX_HEIGHT = 600;
const MIN_HEIGHT = 200;

/**
 * 窗口大小调整 Hook
 */
export function useWindowSizeAdjustment(
  options: UseWindowSizeAdjustmentOptions
): void {
  const {
    shouldPreserveScrollRef,
    listRef,
    containerRef,
    resizeRafId,
    resizeStartX,
    resizeStartWidth,
    isMemoModalOpen,
    isPluginListModalOpen,
    isOverlayActive = false,
    isResizing,
    windowWidth,
    debouncedCombinedResults,
    results,
    getMainContainer,
    setWindowWidth,
    setIsResizing,
  } = options;

  const pendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRafRef = useRef<number | null>(null);
  const lastAppliedHeightRef = useRef<number | null>(null);
  const windowWidthRef = useRef(windowWidth);
  const isMemoModalOpenRef = useRef(isMemoModalOpen);
  const isOverlayActiveRef = useRef(isOverlayActive);

  windowWidthRef.current = windowWidth;
  isMemoModalOpenRef.current = isMemoModalOpen;
  isOverlayActiveRef.current = isOverlayActive;

  const clearPendingAdjust = () => {
    if (pendingTimeoutRef.current !== null) {
      clearTimeout(pendingTimeoutRef.current);
      pendingTimeoutRef.current = null;
    }
    if (pendingRafRef.current !== null) {
      cancelAnimationFrame(pendingRafRef.current);
      pendingRafRef.current = null;
    }
  };

  const measureContainerHeight = (el: HTMLElement): number => {
    // Prefer visible layout height so the transparent window matches the opaque card.
    // scrollHeight can be larger than the painted card when children overflow.
    const rectHeight = el.getBoundingClientRect().height;
    const offsetHeight = el.offsetHeight;
    return Math.max(rectHeight, offsetHeight);
  };

  const applyWindowSize = (container: HTMLElement) => {
    if (isMemoModalOpenRef.current || isOverlayActiveRef.current) {
      return;
    }

    const containerHeight = measureContainerHeight(container);
    const targetWidth = windowWidthRef.current;
    const targetHeight = Math.max(
      MIN_HEIGHT,
      Math.min(Math.ceil(containerHeight), MAX_HEIGHT)
    );

    if (
      lastAppliedHeightRef.current !== null &&
      Math.abs(lastAppliedHeightRef.current - targetHeight) < 1
    ) {
      return;
    }

    lastAppliedHeightRef.current = targetHeight;
    getCurrentWindow()
      .setSize(new LogicalSize(targetWidth, targetHeight))
      .catch(console.error);
  };

  // 调整窗口大小的辅助函数（带取消，避免旧的延迟回调把窗口撑回过高）
  const adjustWindowSizeInternal = (delay: number = 100) => {
    clearPendingAdjust();

    pendingTimeoutRef.current = setTimeout(() => {
      pendingTimeoutRef.current = null;
      const whiteContainer = getMainContainer();
      if (!whiteContainer || isMemoModalOpenRef.current) {
        return;
      }

      pendingRafRef.current = requestAnimationFrame(() => {
        pendingRafRef.current = requestAnimationFrame(() => {
          pendingRafRef.current = null;
          applyWindowSize(whiteContainer);
        });
      });
    }, delay);
  };

  // 用 ResizeObserver 跟踪内容卡片真实高度，避免结果变少后窗口仍保持过大
  useEffect(() => {
    if (isMemoModalOpen || isPluginListModalOpen || isOverlayActive) {
      return;
    }

    const whiteContainer =
      containerRef?.current ?? getMainContainer();
    if (!whiteContainer) {
      return;
    }

    lastAppliedHeightRef.current = null;

    const observer = new ResizeObserver(() => {
      applyWindowSize(whiteContainer);
    });
    observer.observe(whiteContainer);
    applyWindowSize(whiteContainer);

    return () => {
      observer.disconnect();
    };
    // containerRef / getMainContainer 是稳定引用或闭包读取最新值；只在模态态切换时重绑
  }, [isMemoModalOpen, isPluginListModalOpen, isOverlayActive]);

  // 结果数量变化时强制再测一次（分组折叠等不一定触发 ResizeObserver 同元素尺寸变化时的兜底）
  useEffect(() => {
    if (isMemoModalOpen || isPluginListModalOpen || isOverlayActive) {
      return;
    }
    const whiteContainer = containerRef?.current ?? getMainContainer();
    if (whiteContainer) {
      lastAppliedHeightRef.current = null;
      adjustWindowSizeInternal(50);
    }
  }, [results.length, debouncedCombinedResults.length, isOverlayActive]);

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
    }

    // 如果备忘录模态框打开，不在这里调整窗口大小（由专门的 useEffect 处理）
    if (isMemoModalOpen || isOverlayActive) {
      return;
    }

    const delay = needPreserveScroll ? 600 : 100;
    adjustWindowSizeInternal(delay);

    return () => {
      clearPendingAdjust();
    };
  }, [debouncedCombinedResults, isMemoModalOpen, isOverlayActive, windowWidth]);

  // 调整窗口大小（当 results 状态更新时）
  useEffect(() => {
    if (isMemoModalOpen || isOverlayActive) {
      return;
    }

    adjustWindowSizeInternal(100);

    return () => {
      clearPendingAdjust();
    };
  }, [results, isMemoModalOpen, isOverlayActive, windowWidth]);

  // 当 windowWidth 变化时更新窗口大小（但不包括调整大小过程中）
  useEffect(() => {
    if (isMemoModalOpen || isPluginListModalOpen || isResizing || isOverlayActive) {
      return;
    }

    lastAppliedHeightRef.current = null;
    const timer = setTimeout(() => {
      adjustWindowSize({
        windowWidth,
        isMemoModalOpen,
        getContainer: getMainContainer,
      });
    }, 50);

    return () => {
      clearTimeout(timer);
    };
  }, [windowWidth, isMemoModalOpen, isPluginListModalOpen, isResizing, isOverlayActive]);

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
        const containerHeight = measureContainerHeight(whiteContainer);
        const targetHeight = Math.max(
          MIN_HEIGHT,
          Math.min(Math.ceil(containerHeight), MAX_HEIGHT)
        );

        // Update container width directly for immediate visual feedback
        whiteContainer.style.width = `${newWidth}px`;

        // Update window size
        lastAppliedHeightRef.current = targetHeight;
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
