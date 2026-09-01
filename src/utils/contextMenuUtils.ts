/**
 * 上下文菜单处理工具函数
 * 负责处理右键菜单的显示、操作等功能
 */

import type React from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AppInfo } from "../types";
import type { SearchResult } from "./resultUtils";
import { tauriApi } from "../api/tauri";
import { getUrlHistoryDisplay } from "./urlDisplayUtils";
import { isLnkPath } from "./launcherUtils";
import { getRevealPath } from "../hooks/useLnkTargetTooltip";

function normalizePathForCompare(path: string): string {
  return path.toLowerCase().replace(/\//g, "\\");
}

const CONTEXT_MENU_MIN_WIDTH = 212;
const CONTEXT_MENU_VIEWPORT_PADDING = 8;

/** 根据结果类型估算菜单高度，用于首次定位（渲染后会再按实际尺寸校正） */
export function estimateContextMenuHeight(result: SearchResult | null): number {
  if (!result) return 50;

  switch (result.type) {
    case "url":
      return 360;
    case "memo":
      return 90;
    case "app":
      return 120;
    case "file":
    case "everything": {
      const path =
        result.file?.path ?? result.everything?.path ?? result.path ?? "";
      const ext = path.split(/[/\\]/).pop()?.split(".").pop()?.toLowerCase();
      const isConfigurable =
        ext === "md" || ext === "markdown";
      return isConfigurable ? 120 : 45;
    }
    default:
      return 50;
  }
}

/** 将菜单位置限制在视口内，避免被窗口裁切 */
export function clampContextMenuPosition(
  x: number,
  y: number,
  menuSize: { width: number; height: number },
  viewport: { width: number; height: number } = {
    width: window.innerWidth,
    height: window.innerHeight,
  }
): { x: number; y: number } {
  const padding = CONTEXT_MENU_VIEWPORT_PADDING;
  let clampedX = x;
  let clampedY = y;

  if (clampedX + menuSize.width > viewport.width - padding) {
    clampedX = Math.max(padding, viewport.width - menuSize.width - padding);
  }
  if (clampedY + menuSize.height > viewport.height - padding) {
    clampedY = Math.max(padding, viewport.height - menuSize.height - padding);
  }
  if (clampedX < padding) clampedX = padding;
  if (clampedY < padding) clampedY = padding;

  return { x: clampedX, y: clampedY };
}

function computeInitialContextMenuPosition(
  clientX: number,
  clientY: number,
  menuWidth: number,
  menuHeight: number
): { x: number; y: number } {
  let x = clientX;
  let y = clientY;

  if (x + menuWidth > window.innerWidth) {
    x = clientX - menuWidth;
  }

  if (y + menuHeight > window.innerHeight) {
    y = Math.max(CONTEXT_MENU_VIEWPORT_PADDING, clientY - menuHeight);
  }

  return clampContextMenuPosition(
    x,
    y,
    { width: menuWidth, height: menuHeight },
    { width: window.innerWidth, height: window.innerHeight }
  );
}

/**
 * 处理上下文菜单的选项接口
 */
export interface HandleContextMenuOptions {
  e: React.MouseEvent;
  setContextMenu: (menu: { x: number; y: number; result: SearchResult } | null) => void;
}

/**
 * 处理上下文菜单显示
 */
export function handleContextMenu(options: HandleContextMenuOptions): void {
  const { e, setContextMenu } = options;

  e.preventDefault();
  e.stopPropagation();

  const menuWidth = CONTEXT_MENU_MIN_WIDTH;
  const menuHeight = estimateContextMenuHeight(null);
  const { x, y } = computeInitialContextMenuPosition(
    e.clientX,
    e.clientY,
    menuWidth,
    menuHeight
  );

  setContextMenu({ x, y, result: (e.currentTarget as any).dataset?.result || null });
}

/**
 * 处理上下文菜单的选项接口（带 result）
 */
export interface HandleContextMenuWithResultOptions {
  e: React.MouseEvent;
  result: SearchResult;
  setContextMenu: (menu: { x: number; y: number; result: SearchResult } | null) => void;
}

/**
 * 处理上下文菜单显示（带 result 参数）
 */
export function handleContextMenuWithResult(
  options: HandleContextMenuWithResultOptions
): void {
  const { e, result, setContextMenu } = options;

  e.preventDefault();
  e.stopPropagation();

  const menuWidth = CONTEXT_MENU_MIN_WIDTH;
  const menuHeight = estimateContextMenuHeight(result);
  const { x, y } = computeInitialContextMenuPosition(
    e.clientX,
    e.clientY,
    menuWidth,
    menuHeight
  );

  setContextMenu({ x, y, result });
}

/**
 * 在文件夹中显示文件的选项接口
 */
export interface RevealInFolderOptions {
  contextMenu: { x: number; y: number; result: SearchResult } | null;
  query: string;
  setContextMenu: (menu: { x: number; y: number; result: SearchResult } | null) => void;
  setErrorMessage: (message: string | null) => void;
  refreshFileHistoryCache: () => Promise<void>;
  searchFileHistoryWrapper: (query: string) => Promise<void>;
  tauriApi: typeof tauriApi;
}

/**
 * 在文件夹中显示文件
 */
export async function revealInFolder(
  options: RevealInFolderOptions
): Promise<void> {
  const {
    contextMenu,
    query,
    setContextMenu,
    setErrorMessage,
    refreshFileHistoryCache,
    searchFileHistoryWrapper,
    tauriApi,
  } = options;

  if (!contextMenu) return;

  try {
    let target = contextMenu.result;
    let path = isLnkPath(target.path)
      ? await getRevealPath(target.path)
      : target.path;

    console.log("Revealing in folder:", path);
    // 为应用、文件和 Everything 结果都提供"打开所在文件夹"
    if (
      target.type === "file" ||
      target.type === "everything" ||
      target.type === "app"
    ) {
      // 对于文件类型，先检查文件是否存在
      if (target.type === "file" || target.type === "everything") {
        const pathItem = await tauriApi.checkPathExists(path);
        if (!pathItem) {
          // 文件不存在，自动删除历史记录
          // 先关闭右键菜单
          setContextMenu(null);

          try {
            await tauriApi.deleteFileHistory(path);
            // 刷新文件历史缓存
            await refreshFileHistoryCache();
            // 重新搜索以更新结果列表
            if (query.trim()) {
              await searchFileHistoryWrapper(query);
            } else {
              await searchFileHistoryWrapper("");
            }
            // 显示提示信息
            setErrorMessage(`文件不存在，已自动从历史记录中删除该文件。`);
          } catch (deleteError: any) {
            console.error("Failed to delete file history:", deleteError);
            setErrorMessage(`文件不存在，但删除历史记录失败：${deleteError}`);
          }
          return;
        }
      }

      // Use custom reveal_in_folder command to handle shell: protocol paths
      await tauriApi.revealInFolder(path);
      console.log("Reveal in folder called successfully");
    }
    setContextMenu(null);
  } catch (error) {
    console.error("Failed to reveal in folder:", error);
    const errorMsg = error instanceof Error ? error.message : String(error);
    // 检查是否是父目录不存在的错误
    if (errorMsg.includes("Parent directory does not exist")) {
      alert(`无法打开文件夹：父目录不存在\n\n${errorMsg}`);
    } else {
      alert(`打开文件夹失败: ${errorMsg}`);
    }
    setContextMenu(null);
  }
}

/**
 * 从应用索引移除（不删除磁盘文件）
 */
export interface RemoveAppFromIndexOptions {
  appPath: string;
  allAppsCacheRef: MutableRefObject<AppInfo[]>;
  setApps: Dispatch<SetStateAction<AppInfo[]>>;
  setFilteredApps: Dispatch<SetStateAction<AppInfo[]>>;
  query: string;
  searchApplicationsWrapper: (searchQuery: string) => Promise<void>;
}

export async function removeAppFromIndexMenu(
  options: RemoveAppFromIndexOptions
): Promise<void> {
  const {
    appPath,
    allAppsCacheRef,
    setApps,
    setFilteredApps,
    query,
    searchApplicationsWrapper,
  } = options;

  const normalized = normalizePathForCompare(appPath);

  try {
    await tauriApi.removeAppFromIndex(appPath);
    try {
      await tauriApi.saveAppHotkey(appPath, null);
    } catch (hotkeyErr) {
      console.warn("清除应用快捷键失败（可忽略）:", hotkeyErr);
    }

    allAppsCacheRef.current = allAppsCacheRef.current.filter(
      (a) => normalizePathForCompare(a.path) !== normalized
    );

    setApps((prev) =>
      prev.filter((a) => normalizePathForCompare(a.path) !== normalized)
    );
    setFilteredApps((prev) =>
      prev.filter((a) => normalizePathForCompare(a.path) !== normalized)
    );

    const q = query.trim();
    if (q) {
      await searchApplicationsWrapper(q);
    }
  } catch (error) {
    console.error("Failed to remove app from index:", error);
    const msg = error instanceof Error ? error.message : String(error);
    alert(`从应用索引删除失败: ${msg}`);
    throw error;
  }
}

/**
 * 删除历史记录的选项接口
 */
export interface DeleteHistoryOptions {
  key: string;
  setOpenHistory: (history: Record<string, number>) => void;
  setUrlRemarks: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  tauriApi: typeof tauriApi;
}

/**
 * 删除历史记录
 */
export async function deleteHistory(
  options: DeleteHistoryOptions
): Promise<void> {
  const { key, setOpenHistory, setUrlRemarks, tauriApi } = options;

  try {
    await tauriApi.deleteOpenHistory(key);
    // 重新加载 open history
    const history = await tauriApi.getOpenHistory();
    setOpenHistory(history);
    // 删除备注
    setUrlRemarks((prev) => {
      const newRemarks = { ...prev };
      delete newRemarks[key];
      return newRemarks;
    });
    // combinedResults 会自动使用新的 openHistory，所以结果列表会自动更新
  } catch (error) {
    console.error("Failed to delete open history:", error);
    throw error;
  }
}

/**
 * 编辑备注的选项接口
 */
export interface EditRemarkOptions {
  url: string;
  setEditingRemarkUrl: (url: string | null) => void;
  setRemarkText: (text: string) => void;
  setIsRemarkModalOpen: (open: boolean) => void;
  tauriApi: typeof tauriApi;
}

/**
 * 编辑备注
 */
export async function editRemark(options: EditRemarkOptions): Promise<void> {
  const {
    url,
    setEditingRemarkUrl,
    setRemarkText,
    setIsRemarkModalOpen,
    tauriApi,
  } = options;

  try {
    // 获取当前的备注（存储在 name 字段中）
    const item = await tauriApi.getOpenHistoryItem(url);
    setEditingRemarkUrl(url);
    setRemarkText(item?.name || "");
    setIsRemarkModalOpen(true);
  } catch (error) {
    console.error("Failed to get open history item:", error);
    alert(`获取备注失败: ${error}`);
  }
}

/**
 * 保存备注的选项接口
 */
export interface SaveRemarkOptions {
  editingRemarkUrl: string | null;
  remarkText: string;
  setOpenHistory: (history: Record<string, number>) => void;
  setUrlRemarks: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setIsRemarkModalOpen: (open: boolean) => void;
  setEditingRemarkUrl: (url: string | null) => void;
  setRemarkText: (text: string) => void;
  tauriApi: typeof tauriApi;
  onSaved?: () => void | Promise<void>;
}

/**
 * 保存备注
 */
export async function saveRemark(options: SaveRemarkOptions): Promise<void> {
  const {
    editingRemarkUrl,
    remarkText,
    setOpenHistory,
    setUrlRemarks,
    setIsRemarkModalOpen,
    setEditingRemarkUrl,
    setRemarkText,
    tauriApi,
    onSaved,
  } = options;

  if (!editingRemarkUrl) return;
  try {
    const remark = remarkText.trim() || null;
    const updatedItem = await tauriApi.updateOpenHistoryRemark(
      editingRemarkUrl,
      remark
    );
    // 更新本地备注状态（备注存储在 name 字段中）
    setUrlRemarks((prev) => {
      const newRemarks = { ...prev };
      const { remark } = getUrlHistoryDisplay({
        path: editingRemarkUrl,
        name: updatedItem.name ?? "",
      });
      if (remark) {
        newRemarks[editingRemarkUrl] = remark;
      } else {
        delete newRemarks[editingRemarkUrl];
      }
      return newRemarks;
    });
    // 刷新 openHistory 以更新时间戳
    const history = await tauriApi.getOpenHistory();
    setOpenHistory(history);
    setIsRemarkModalOpen(false);
    setEditingRemarkUrl(null);
    setRemarkText("");
    await onSaved?.();
  } catch (error) {
    console.error("Failed to update remark:", error);
    alert(`保存备注失败: ${error}`);
  }
}

