/**
 * 窗口管理工具函数
 * 封装窗口大小调整等重复逻辑
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/window";

/**
 * 获取主容器元素
 */
export function getMainContainer(): HTMLElement | null {
  return document.querySelector('.bg-white') as HTMLElement | null;
}

/**
 * 窗口大小调整选项
 */
export interface WindowSizeAdjustOptions {
  windowWidth: number;
  isMemoModalOpen?: boolean;
  maxHeight?: number;
  minHeight?: number;
  getContainer?: () => HTMLElement | null;
}

/**
 * 调整窗口大小
 */
export function adjustWindowSize(options: WindowSizeAdjustOptions): void {
  const {
    windowWidth,
    isMemoModalOpen = false,
    maxHeight,
    minHeight,
    getContainer = getMainContainer,
  } = options;

  const whiteContainer = getContainer();
  if (!whiteContainer || isMemoModalOpen) {
    return;
  }

  // 使用双重 requestAnimationFrame 确保 DOM 完全更新
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const window = getCurrentWindow();
      // 用可见高度对齐透明窗口，避免 scrollHeight 偏大留下底部透明空隙
      const containerHeight = Math.max(
        whiteContainer.getBoundingClientRect().height,
        whiteContainer.offsetHeight
      );

      // 计算目标高度
      const MAX_HEIGHT = maxHeight ?? 600;
      const MIN_HEIGHT = minHeight ?? 200;
      const targetHeight = Math.max(
        MIN_HEIGHT,
        Math.min(Math.ceil(containerHeight), MAX_HEIGHT)
      );

      // 设置窗口大小
      window.setSize(new LogicalSize(windowWidth, targetHeight)).catch(console.error);
    });
  });
}

/**
 * 创建窗口大小调整函数（带延迟）
 */
export function createDelayedWindowSizeAdjuster(
  options: WindowSizeAdjustOptions & { delay?: number }
): () => void {
  const { delay = 100, ...adjustOptions } = options;
  
  return () => {
    setTimeout(() => {
      adjustWindowSize(adjustOptions);
    }, delay);
  };
}

