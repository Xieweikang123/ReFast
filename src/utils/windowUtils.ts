/**
 * 窗口管理工具函数
 * 封装窗口大小调整等重复逻辑
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/window";

export const LAUNCHER_MAX_HEIGHT = 600;
export const LAUNCHER_MIN_HEIGHT = 200;
export const CONTEXT_MENU_VIEWPORT_PADDING = 8;

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
      const MAX_HEIGHT = maxHeight ?? LAUNCHER_MAX_HEIGHT;
      const MIN_HEIGHT = minHeight ?? LAUNCHER_MIN_HEIGHT;
      const targetHeight = Math.max(
        MIN_HEIGHT,
        Math.min(Math.ceil(containerHeight), MAX_HEIGHT)
      );

      // 设置窗口大小
      window.setSize(new LogicalSize(windowWidth, targetHeight)).catch(console.error);
    });
  });
}

/** 计算需要临时撑高的目标窗口高度；无需撑高时返回 null */
export function computeExpandedWindowHeight(
  requiredHeight: number,
  currentViewportHeight: number,
  maxHeight: number = LAUNCHER_MAX_HEIGHT
): number | null {
  const normalizedRequired = Math.ceil(requiredHeight);
  if (normalizedRequired <= currentViewportHeight) {
    return null;
  }

  const targetHeight = Math.min(maxHeight, normalizedRequired);
  if (targetHeight <= currentViewportHeight) {
    return null;
  }

  return targetHeight;
}

/** 计算右键菜单打开时窗口需要临时撑到的高度；无需撑高时返回 null */
export function computeContextMenuWindowHeight(
  menuBottom: number,
  currentViewportHeight: number,
  maxHeight: number = LAUNCHER_MAX_HEIGHT,
  padding: number = CONTEXT_MENU_VIEWPORT_PADDING
): number | null {
  return computeExpandedWindowHeight(
    menuBottom + padding,
    currentViewportHeight,
    maxHeight
  );
}

/** 计算居中弹层内容所需的窗口高度 */
export function computeOverlayWindowHeight(
  contentHeight: number,
  currentViewportHeight: number,
  verticalPadding: number = 32,
  maxHeight: number = LAUNCHER_MAX_HEIGHT
): number | null {
  return computeExpandedWindowHeight(
    contentHeight + verticalPadding,
    currentViewportHeight,
    maxHeight
  );
}

/** 将启动器窗口临时撑到指定内容高度 */
export async function expandWindowToHeight(
  requiredHeight: number,
  windowWidth: number
): Promise<boolean> {
  const targetHeight = computeExpandedWindowHeight(
    requiredHeight,
    window.innerHeight
  );
  if (targetHeight === null) {
    return false;
  }

  await getCurrentWindow().setSize(new LogicalSize(windowWidth, targetHeight));
  return true;
}

/** 为右键菜单临时撑高启动器窗口 */
export async function expandWindowForContextMenu(
  menuBottom: number,
  windowWidth: number
): Promise<boolean> {
  return expandWindowToHeight(
    menuBottom + CONTEXT_MENU_VIEWPORT_PADDING,
    windowWidth
  );
}

/** 为居中弹层临时撑高启动器窗口 */
export async function expandWindowForOverlayContent(
  contentHeight: number,
  windowWidth: number,
  verticalPadding: number = 32
): Promise<boolean> {
  return expandWindowToHeight(contentHeight + verticalPadding, windowWidth);
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

