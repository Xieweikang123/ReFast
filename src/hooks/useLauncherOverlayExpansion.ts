/**
 * 启动器内浮层（右键菜单、备注弹窗等）打开时临时撑高窗口，全部关闭后恢复
 */

import { useCallback, useEffect, useRef } from "react";
import {
  adjustWindowSize,
  expandWindowForContextMenu,
  expandWindowForOverlayContent,
} from "../utils/windowUtils";

interface UseLauncherOverlayExpansionOptions {
  isActive: boolean;
  windowWidth: number;
  getMainContainer: () => HTMLElement | null;
}

export function useLauncherOverlayExpansion(
  options: UseLauncherOverlayExpansionOptions
) {
  const { isActive, windowWidth, getMainContainer } = options;
  const isExpandedRef = useRef(false);
  const windowWidthRef = useRef(windowWidth);

  windowWidthRef.current = windowWidth;

  const restoreWindowSize = useCallback(() => {
    if (!isExpandedRef.current) {
      return;
    }

    isExpandedRef.current = false;
    adjustWindowSize({
      windowWidth: windowWidthRef.current,
      getContainer: getMainContainer,
    });
  }, [getMainContainer]);

  const markExpanded = useCallback((expanded: boolean) => {
    if (expanded) {
      isExpandedRef.current = true;
    }
  }, []);

  const expandToMenuBottom = useCallback(async (info: { bottom: number }) => {
    const expanded = await expandWindowForContextMenu(
      info.bottom,
      windowWidthRef.current
    );
    markExpanded(expanded);
  }, [markExpanded]);

  const expandForOverlayContent = useCallback(async (info: { height: number }) => {
    const expanded = await expandWindowForOverlayContent(
      info.height,
      windowWidthRef.current
    );
    markExpanded(expanded);
  }, [markExpanded]);

  useEffect(() => {
    if (!isActive) {
      restoreWindowSize();
    }
  }, [isActive, restoreWindowSize]);

  return {
    isOverlayActive: isActive,
    expandToMenuBottom,
    expandForOverlayContent,
  };
}
