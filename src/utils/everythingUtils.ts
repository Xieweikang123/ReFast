/**
 * Everything 搜索工具函数
 * 负责处理 Everything 搜索会话、状态检查、启动和下载等功能
 */

import type React from "react";
import { startTransition } from "react";
import type { EverythingResult } from "../types";
import { tauriApi } from "../api/tauri";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Everything 搜索会话的选项接口
 */
export interface EverythingSearchSessionOptions {
  searchQuery: string;
  isEverythingAvailable: boolean;
  
  // 状态更新函数
  setEverythingResults: (results: EverythingResult[]) => void;
  setEverythingTotalCount: (count: number | null) => void;
  setEverythingCurrentCount: (count: number) => void;
  setIsSearchingEverything: (searching: boolean) => void;
  setIsEverythingAvailable: (available: boolean) => void;
  setEverythingError: (error: string | null) => void;
  
  // Refs
  pendingSessionIdRef: React.MutableRefObject<string | null>;
  currentSearchQueryRef: React.MutableRefObject<string>;
  creatingSessionQueryRef: React.MutableRefObject<string | null>;
  displayedSearchQueryRef: React.MutableRefObject<string>;
  
  // 常量
  LAUNCHER_PAGE_SIZE: number;
  LAUNCHER_MAX_RESULTS: number;
  
  // 回调函数
  closeSessionSafe: (id?: string | null) => Promise<void>;
  
  // API
  tauriApi: typeof tauriApi;
}

/**
 * 启动 Everything 搜索会话
 */
export async function startEverythingSearchSession(
  options: EverythingSearchSessionOptions
): Promise<void> {
  const {
    searchQuery,
    isEverythingAvailable,
    setEverythingResults,
    setEverythingTotalCount,
    setEverythingCurrentCount,
    setIsSearchingEverything,
    setIsEverythingAvailable,
    setEverythingError,
    pendingSessionIdRef,
    currentSearchQueryRef,
    creatingSessionQueryRef,
    displayedSearchQueryRef,
    LAUNCHER_PAGE_SIZE,
    LAUNCHER_MAX_RESULTS,
    closeSessionSafe,
    tauriApi,
  } = options;

  if (!searchQuery || searchQuery.trim() === "") {
    const oldSessionId = pendingSessionIdRef.current;
    if (oldSessionId) {
      await closeSessionSafe(oldSessionId);
    }
    pendingSessionIdRef.current = null;
    currentSearchQueryRef.current = "";
    displayedSearchQueryRef.current = "";
    startTransition(() => {
      setEverythingResults([]);
      setEverythingTotalCount(null);
      setEverythingCurrentCount(0);
      setIsSearchingEverything(false);
    });
    return;
  }

  if (!isEverythingAvailable) {
    const oldSessionId = pendingSessionIdRef.current;
    if (oldSessionId) {
      await closeSessionSafe(oldSessionId);
    }
    pendingSessionIdRef.current = null;
    currentSearchQueryRef.current = "";
    displayedSearchQueryRef.current = "";
    startTransition(() => {
      setEverythingResults([]);
      setEverythingTotalCount(null);
      setEverythingCurrentCount(0);
      setIsSearchingEverything(false);
    });
    return;
  }

  const trimmed = searchQuery.trim();
  // 启动器首包尽量小：短词命中量大，限制条数可加快 Everything IPC
  const queryLength = trimmed.length;
  let maxResultsToUse = Math.min(LAUNCHER_MAX_RESULTS, 50);
  if (queryLength === 1) {
    maxResultsToUse = Math.min(LAUNCHER_MAX_RESULTS, 30);
  } else if (queryLength === 2) {
    maxResultsToUse = Math.min(LAUNCHER_MAX_RESULTS, 40);
  }

  // 保存当前搜索的 query
  currentSearchQueryRef.current = trimmed;

  // 如果相同查询的会话正在创建中，直接返回
  if (creatingSessionQueryRef.current === trimmed) {
    return;
  }

  // 检查是否已有相同查询的活跃会话
  if (
    pendingSessionIdRef.current &&
    currentSearchQueryRef.current === trimmed
  ) {
    return;
  }

  // 标记正在创建会话
  creatingSessionQueryRef.current = trimmed;

  // 关闭旧会话（不阻塞，异步执行）
  const oldSessionId = pendingSessionIdRef.current;
  if (oldSessionId) {
    // 不等待关闭完成，立即开始新搜索
    closeSessionSafe(oldSessionId).catch(() => {
      // 静默处理错误
    });
  }
  // 在创建新会话前先清空 pendingSessionIdRef，防止旧的请求使用已失效的会话
  pendingSessionIdRef.current = null;
  // 注意：不要清空 currentSearchQueryRef.current，它应该保持当前查询
  displayedSearchQueryRef.current = "";
  setEverythingResults([]);
  setEverythingTotalCount(null);
  setEverythingCurrentCount(0);
  setIsSearchingEverything(true);

  // 软超时：先结束「搜索中」提示，后台结果晚到仍可合并
  const softTimeoutMs = 4000;
  // 硬超时：彻底放弃本次会话创建
  const hardTimeoutMs = 15000;
  let softTimedOut = false;
  const softTimer = window.setTimeout(() => {
    softTimedOut = true;
    if (creatingSessionQueryRef.current === trimmed) {
      setIsSearchingEverything(false);
    }
  }, softTimeoutMs);

  const clearSoftTimer = () => {
    window.clearTimeout(softTimer);
  };

  try {
    const sessionTimeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`创建搜索会话超时（${hardTimeoutMs}ms）`));
      }, hardTimeoutMs);
    });

    const pageSize = Math.min(LAUNCHER_PAGE_SIZE, maxResultsToUse);
    const sessionPromise = tauriApi.startEverythingSearchSession(trimmed, {
      maxResults: maxResultsToUse,
      chunkSize: pageSize,
    });

    const session = await Promise.race([sessionPromise, sessionTimeoutPromise]);
    clearSoftTimer();

    // 检查查询是否仍然有效
    if (currentSearchQueryRef.current !== trimmed) {
      await closeSessionSafe(session.sessionId);
      pendingSessionIdRef.current = null;
      creatingSessionQueryRef.current = null;
      setIsSearchingEverything(false);
      return;
    }

    pendingSessionIdRef.current = session.sessionId;
    creatingSessionQueryRef.current = null;
    // 保存针对该关键字查询到的实际总数（不受maxResults限制）
    setEverythingTotalCount(session.totalCount ?? 0);

    // 立即获取第一页结果（启动器只需要第一页）
    const offset = 0;
    const currentSessionId = session.sessionId;
    const currentQueryForPage = trimmed;

    const rangeTimeoutMs = 5000;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`获取首屏页超时（${rangeTimeoutMs}ms）`));
      }, rangeTimeoutMs);
    });

    Promise.race([
      tauriApi.getEverythingSearchRange(
        currentSessionId,
        offset,
        pageSize,
        {}
      ),
      timeoutPromise,
    ])
      .then((res) => {
        // 检查会话和查询是否仍然有效
        const currentPendingSessionId = pendingSessionIdRef.current;
        const isSessionStillValid =
          currentPendingSessionId === currentSessionId;
        const isQueryStillValid =
          currentSearchQueryRef.current === currentQueryForPage;

        if (!isSessionStillValid || !isQueryStillValid) {
          if (!pendingSessionIdRef.current) {
            setIsSearchingEverything(false);
          }
          return;
        }

        // 更新结果（使用 startTransition 避免阻塞输入框）
        // 软超时后仍合并晚到结果
        startTransition(() => {
          setEverythingResults(res.items);
          setEverythingCurrentCount(res.items.length);
          setIsSearchingEverything(false);
        });
        displayedSearchQueryRef.current = trimmed;
      })
      .catch((error) => {
        const currentPendingSessionId = pendingSessionIdRef.current;
        const isSessionStillValid =
          currentPendingSessionId === currentSessionId;
        const isQueryStillValid =
          currentSearchQueryRef.current === currentQueryForPage;

        if (!isSessionStillValid || !isQueryStillValid) {
          return;
        }
        const errorStr = typeof error === "string" ? error : String(error);

        // 检查是否是服务不可用错误
        if (
          errorStr.includes("NOT_INSTALLED") ||
          errorStr.includes("SERVICE_NOT_RUNNING") ||
          errorStr.includes("not found") ||
          errorStr.includes("未找到") ||
          errorStr.includes("未运行")
        ) {
          tauriApi
            .getEverythingStatus()
            .then((status) => {
              setIsEverythingAvailable(status.available);
              setEverythingError(status.error || null);
            })
            .catch(() => {
              setIsEverythingAvailable(false);
              setEverythingError("搜索失败后无法重新检查状态");
            });
        }

        startTransition(() => {
          // 软超时后已有本地结果可用，首屏失败时不要强行清空已展示的 Everything 空态以外的状态
          if (!softTimedOut) {
            setEverythingResults([]);
            setEverythingTotalCount(null);
            setEverythingCurrentCount(0);
          }
          setIsSearchingEverything(false);
        });
      });
  } catch (error) {
    clearSoftTimer();
    creatingSessionQueryRef.current = null;
    const errorStr = typeof error === "string" ? error : String(error);
    if (
      errorStr.includes("NOT_INSTALLED") ||
      errorStr.includes("SERVICE_NOT_RUNNING") ||
      errorStr.includes("not found") ||
      errorStr.includes("未找到") ||
      errorStr.includes("未运行")
    ) {
      tauriApi
        .getEverythingStatus()
        .then((status) => {
          setIsEverythingAvailable(status.available);
          setEverythingError(status.error || null);
        })
        .catch(() => {
          setIsEverythingAvailable(false);
          setEverythingError("搜索失败后无法重新检查状态");
        });
    }

    startTransition(() => {
      setEverythingResults([]);
      setEverythingTotalCount(null);
      setEverythingCurrentCount(0);
      setIsSearchingEverything(false);
    });
  }
}

/**
 * 关闭 Everything 搜索会话的选项接口
 */
export interface CloseSessionOptions {
  sessionId?: string | null;
  pendingSessionIdRef: React.MutableRefObject<string | null>;
  tauriApi: typeof tauriApi;
}

/**
 * 关闭 Everything 搜索会话（安全方法）
 */
export async function closeEverythingSession(
  options: CloseSessionOptions
): Promise<void> {
  const { sessionId, pendingSessionIdRef, tauriApi } = options;
  const target = sessionId ?? pendingSessionIdRef.current;
  if (!target) return;
  try {
    await tauriApi.closeEverythingSearchSession(target);
  } catch (error) {
    // 静默处理错误
  }
}

/**
 * 检查 Everything 状态的选项接口
 */
export interface CheckEverythingStatusOptions {
  setIsEverythingAvailable: (available: boolean) => void;
  setEverythingError: (error: string | null) => void;
  setEverythingPath: (path: string | null) => void;
  tauriApi: typeof tauriApi;
}

/**
 * 检查 Everything 状态（带自动启动功能）
 */
export async function checkEverythingStatus(
  options: CheckEverythingStatusOptions
): Promise<void> {
  const {
    setIsEverythingAvailable,
    setEverythingError,
    setEverythingPath,
    tauriApi,
  } = options;

  try {
    // Force a fresh check with detailed status
    const status = await tauriApi.getEverythingStatus();

    // 如果服务未运行，尝试自动启动
    if (!status.available && status.error === "SERVICE_NOT_RUNNING") {
      try {
        await tauriApi.startEverything();
        // 等待一下让 Everything 启动并初始化
        await new Promise((resolve) => setTimeout(resolve, 2000));
        // 重新检查状态
        const newStatus = await tauriApi.getEverythingStatus();
        setIsEverythingAvailable(newStatus.available);
        setEverythingError(newStatus.error || null);

        if (!newStatus.available) {
          console.warn("Everything 启动后仍未可用:", newStatus.error);
        }
        return;
      } catch (error) {
        console.error("自动启动 Everything 失败:", error);
        setIsEverythingAvailable(false);
        setEverythingError("无法自动启动 Everything，请手动启动");
        return;
      }
    }

    setIsEverythingAvailable(status.available);
    setEverythingError(status.error || null);

    if (status.available) {
      const path = await tauriApi.getEverythingPath();
      setEverythingPath(path);
    }
  } catch (error) {
    console.error("Failed to check Everything:", error);
    alert(`检测失败: ${error}`);
  }
}

/**
 * 启动 Everything 的选项接口
 */
export interface StartEverythingOptions {
  checkEverythingStatus: () => Promise<void>;
  tauriApi: typeof tauriApi;
}

/**
 * 启动 Everything 服务
 */
export async function startEverythingService(
  options: StartEverythingOptions
): Promise<void> {
  const { checkEverythingStatus, tauriApi } = options;

  try {
    await tauriApi.startEverything();
    // 等待一下让 Everything 启动并初始化
    await new Promise((resolve) => setTimeout(resolve, 2000));
    // 重新检查状态
    await checkEverythingStatus();
  } catch (error) {
    console.error("启动 Everything 失败:", error);
    alert(`启动失败: ${error}`);
  }
}

/**
 * 下载 Everything 的选项接口
 */
export interface DownloadEverythingOptions {
  setIsDownloadingEverything: (downloading: boolean) => void;
  setEverythingDownloadProgress: (progress: number) => void;
  tauriApi: typeof tauriApi;
}

/**
 * 下载 Everything 安装程序
 */
export async function downloadEverythingInstaller(
  options: DownloadEverythingOptions
): Promise<void> {
  const {
    setIsDownloadingEverything,
    setEverythingDownloadProgress,
    tauriApi,
  } = options;

  try {
    setIsDownloadingEverything(true);
    setEverythingDownloadProgress(0);

    const installerPath = await tauriApi.downloadEverything();

    setEverythingDownloadProgress(100);

    // 下载完成后，临时取消窗口置顶，确保安装程序显示在启动器之上
    const window = getCurrentWindow();
    await window.setAlwaysOnTop(false);

    // 自动打开安装程序
    await tauriApi.launchFile(installerPath);

    // 下载逻辑结束，重置下载状态（不再弹出遮挡安装向导的提示框）
    setIsDownloadingEverything(false);
    setEverythingDownloadProgress(0);
  } catch (error) {
    setIsDownloadingEverything(false);
    setEverythingDownloadProgress(0);
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    alert(`下载失败: ${errorMessage}`);
  }
}

