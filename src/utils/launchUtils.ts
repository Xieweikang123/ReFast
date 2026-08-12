/**
 * 启动处理工具函数
 * 负责处理各种类型结果的启动逻辑（应用、文件、URL、邮箱、插件等）
 */

import type React from "react";
import type { AppInfo, BrowserRule, EverythingResult, FileHistoryItem, PluginContext } from "../types";
import type { SearchResult } from "./resultUtils";
import { normalizePathForHistory } from "./launcherUtils";
import { tauriApi } from "../api/tauri";
import { trackEvent } from "../api/events";
import { executePlugin } from "../plugins";
import { pushQueryHistory } from "./queryHistoryUtils";
import { resolveBrowserForUrl } from "./browserRules";

/** 规范化路径用于比较（Windows 不区分大小写，统一反斜杠） */
function normalizePathForCompare(path: string): string {
  return path.toLowerCase().replace(/\//g, "\\");
}

/** 按浏览器路由规则打开 URL；未命中规则时使用系统默认浏览器 */
async function openUrlSmart(
  url: string,
  browserRules: BrowserRule[],
  api: typeof tauriApi
): Promise<void> {
  const browser = resolveBrowserForUrl(url, browserRules);
  if (browser !== "default") {
    await api.openUrlWithBrowser(url, browser);
  } else {
    await api.openUrl(url);
  }
}

/**
 * 启动处理的选项接口
 */
export interface LaunchOptions {
  result: SearchResult;
  query: string;
  
  // 状态更新函数
  setOpenHistory: (updater: (prev: Record<string, number>) => Record<string, number>) => void;
  setFilteredFiles: (updater: (prev: FileHistoryItem[]) => FileHistoryItem[]) => void;
  setApps: (updater: (prev: AppInfo[]) => AppInfo[]) => void;
  setFilteredApps: (updater: (prev: AppInfo[]) => AppInfo[]) => void;
  setEverythingResults: (updater: (prev: EverythingResult[]) => EverythingResult[]) => void;
  setResults: (updater: (prev: SearchResult[]) => SearchResult[]) => void;
  setHorizontalResults: (updater: (prev: SearchResult[]) => SearchResult[]) => void;
  setLaunchingAppPath: (path: string | null) => void;
  setErrorMessage: (msg: string | null) => void;
  setSuccessMessage: (msg: string | null) => void;
  setIsMemoListMode: (mode: boolean) => void;
  setSelectedMemo: (memo: any) => void;
  setMemoEditTitle: (title: string) => void;
  setMemoEditContent: (content: string) => void;
  setIsEditingMemo: (editing: boolean) => void;
  setIsMemoModalOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  setSelectedIndex: (index: number) => void;
  setContextMenu: (menu: { x: number; y: number; result: SearchResult } | null) => void;
  setIsPluginListModalOpen: (open: boolean) => void;
  
  // Refs
  allFileHistoryCacheRef: React.MutableRefObject<FileHistoryItem[]>;
  allFileHistoryCacheLoadedRef: React.MutableRefObject<boolean>;
  allAppsCacheRef: React.MutableRefObject<AppInfo[]>;
  horizontalResultsRef: React.MutableRefObject<SearchResult[]>;
  /** 本次会话内已确认失效的快捷方式路径，避免 Everything 再次搜出 */
  suppressedBrokenPathsRef: React.MutableRefObject<Set<string>>;
  
  // 回调函数
  hideLauncherAndResetState: (options?: { resetMemo?: boolean; resetAi?: boolean }) => Promise<void>;
  refreshFileHistoryCache: () => Promise<void>;
  searchFileHistoryWrapper: (query: string) => Promise<void>;
  
  // 其他依赖
  errorMessage: string | null;
  tauriApi: typeof tauriApi;
  /** 浏览器路由规则，决定 URL 用哪个浏览器打开 */
  browserRules: BrowserRule[];
}

/**
 * 处理搜索结果启动
 */
export async function handleLaunch(options: LaunchOptions): Promise<void> {
  const {
    result,
    query,
    setOpenHistory,
    setFilteredFiles,
    setApps,
    setFilteredApps,
    setEverythingResults,
    setResults,
    setHorizontalResults,
    setLaunchingAppPath,
    setErrorMessage,
    setSuccessMessage,
    setIsMemoListMode,
    setSelectedMemo,
    setMemoEditTitle,
    setMemoEditContent,
    setIsEditingMemo,
    setIsMemoModalOpen,
    setQuery,
    setSelectedIndex,
    setContextMenu,
    setIsPluginListModalOpen,
    allFileHistoryCacheRef,
    allFileHistoryCacheLoadedRef,
    allAppsCacheRef,
    horizontalResultsRef,
    suppressedBrokenPathsRef,
    hideLauncherAndResetState,
    refreshFileHistoryCache,
    searchFileHistoryWrapper,
    errorMessage,
    tauriApi,
    browserRules,
  } = options;

  try {
    // 成功启动时记录查询历史（短词 / 纯前缀不写）
    pushQueryHistory(query);

    // 统一更新使用历史记录（所有类型统一处理）
    const pathToUpdate = result.path;
    const timestampToUpdate = Date.now() / 1000;

    // 判断是否需要更新历史记录
    const shouldUpdateHistory = (): boolean => {
      if (!pathToUpdate) return false;

      const pathLower = pathToUpdate.toLowerCase();

      // 跳过不需要更新的类型
      if (
        result.type === "ai" ||
        result.type === "email" ||
        result.type === "json_formatter" ||
        result.type === "history" ||
        result.type === "settings" ||
        result.type === "memo" ||
        result.type === "plugin"
      ) {
        return false;
      }

      // 对于应用类型，只更新实际文件路径（.exe, .lnk），跳过 UWP 应用和 Recent 文件夹
      if (result.type === "app") {
        const isRealFilePath =
          pathLower.endsWith(".exe") || pathLower.endsWith(".lnk");
        const isRecentFolder =
          pathLower.includes("\\recent\\") || pathLower.includes("/recent/");
        return isRealFilePath && !isRecentFolder;
      }

      // 其他类型（file、everything、url）都更新
      return true;
    };

    // 如果需要更新，统一处理
    if (shouldUpdateHistory()) {
      // 更新 openHistory 状态（用于排序和显示）
      setOpenHistory((prev) => ({
        ...prev,
        [pathToUpdate]: timestampToUpdate,
      }));

      // 更新前端文件历史缓存（乐观更新）
      const normalizePathForMatch = (path: string) => {
        return path.trim().replace(/[\\/]+$/, "");
      };
      const normalizedPath = normalizePathForMatch(pathToUpdate);

      const existingItem = allFileHistoryCacheRef.current.find((item) => {
        const itemNormalized = normalizePathForMatch(item.path);
        const path1 = normalizePathForHistory(itemNormalized);
        const path2 = normalizePathForHistory(normalizedPath);
        return path1 === path2;
      });

      if (existingItem) {
        // 更新现有项的时间戳（使用次数由后端更新，避免重复计数）
        existingItem.last_used = timestampToUpdate;
        // 注意：不在这里手动增加 use_count，由后端 addFileToHistory 统一处理

        // 立即更新 filteredFiles 状态的时间戳（使用次数会在后端更新后通过 refreshFileHistoryCache 同步）
        setFilteredFiles((prevFiles) => {
          return prevFiles.map((file) => {
            const fileNormalized = normalizePathForMatch(file.path);
            const filePath1 = normalizePathForHistory(fileNormalized);
            const filePath2 = normalizePathForHistory(normalizedPath);
            if (filePath1 === filePath2) {
              return {
                ...file,
                last_used: timestampToUpdate,
                // use_count 不在这里更新，等待后端更新后通过 refreshFileHistoryCache 同步
              };
            }
            return file;
          });
        });
      } else {
        // 添加新项到前端缓存（use_count 由后端决定，这里先设为0，等待后端更新）
        let name: string;
        if (result.type === "url" && result.url) {
          // URL类型：提取域名作为名称
          try {
            const urlObj = new URL(result.url);
            name = urlObj.hostname || result.url;
          } catch {
            name = result.url;
          }
        } else {
          // 文件类型：提取文件名
          name = normalizedPath.split(/[\\/]/).pop() || normalizedPath;
        }

        allFileHistoryCacheRef.current.push({
          path: normalizedPath,
          name,
          last_used: timestampToUpdate,
          use_count: 0, // 先设为0，等待后端 addFileToHistory 更新后通过 refreshFileHistoryCache 同步
          is_folder: result.type === "url" ? false : undefined,
        });
      }
      allFileHistoryCacheLoadedRef.current = true;

      // 异步更新后端数据库，不阻塞应用启动
      console.log(
        `[统一更新] 准备更新 open_history: ${pathToUpdate}, 类型: ${result.type}`
      );
      void tauriApi
        .addFileToHistory(pathToUpdate)
        .then(() => {
          console.log(`[统一更新] ✓ 成功更新 open_history: ${pathToUpdate}`);
          // 刷新文件历史缓存以确保与数据库同步（包括使用次数）
          void refreshFileHistoryCache().then(() => {
            // 如果当前有查询，重新搜索以更新结果列表中的使用次数
            if (query.trim()) {
              void searchFileHistoryWrapper(query);
            }
          });
        })
        .catch((error) => {
          console.warn(
            `[统一更新] ✗ 更新 open_history 失败: ${pathToUpdate}`,
            error
          );
          // 如果后端更新失败，回滚前端缓存（重新从数据库加载）
          void refreshFileHistoryCache();
        });
    }

    // 对所有结果统一提前处理 http/https 链接，避免走文件/应用启动流程
    const pathLower = result.path?.toLowerCase() || "";
    if (/^https?:\/\//.test(pathLower)) {
      await openUrlSmart(result.path, browserRules, tauriApi);
      await hideLauncherAndResetState();
      return;
    }

    // 注意：历史记录的更新已在开头统一处理，各类型不再单独更新

    if (result.type === "ai" && result.aiAnswer) {
      // AI 回答点击时，可以复制到剪贴板或什么都不做
      // 这里暂时不做任何操作，只是显示结果
      return;
    } else if (result.type === "url" && result.url) {
      await openUrlSmart(result.url, browserRules, tauriApi);
      // 注意：历史记录的更新已在开头统一处理
      await hideLauncherAndResetState();
      return;
    } else if (result.type === "search") {
      // 处理搜索类型：打开浏览器进行搜索
      await openUrlSmart(result.path, browserRules, tauriApi);
      await hideLauncherAndResetState();
      return;
    } else if (result.type === "email" && result.email) {
      // 复制邮箱地址到剪贴板
      try {
        await navigator.clipboard.writeText(result.email);
        // 显示成功提示，不隐藏启动器
        setSuccessMessage(`已复制邮箱地址：${result.email}`);
        // 3秒后自动关闭提示
        setTimeout(() => {
          setSuccessMessage(null);
        }, 3000);
      } catch (error) {
        console.error("Failed to copy email to clipboard:", error);
        setErrorMessage("复制邮箱地址失败");
      }
      return;
    } else if (result.type === "json_formatter" && result.jsonContent) {
      await tauriApi.showJsonFormatterWindow(result.jsonContent);
      await hideLauncherAndResetState();
      return;
    } else if (result.type === "history") {
      // 打开历史访问窗口
      await tauriApi.showShortcutsConfig();
      // 不关闭启动器，让用户查看历史访问
      return;
    } else if (result.type === "settings") {
      // 打开应用中心并导航到设置页面
      try {
        // 设置标志，让应用中心窗口加载时自动跳转到设置页面
        localStorage.setItem("appcenter:last-category", "settings");
        // 先隐藏启动器
        await tauriApi.hideLauncher();
        // 打开应用中心窗口
        await tauriApi.showPluginListWindow();
      } catch (error) {
        console.error("Failed to open app center:", error);
        alert("打开应用中心失败，请重试（详情见控制台日志）");
      }
      return;
    } else if (result.type === "app" && result.app) {
      try {
        // 设置正在启动的应用路径，触发动画
        setLaunchingAppPath(result.app.path);

        // 不再人为等待 200ms；后端启动 .lnk 也不再同步跑 PowerShell，应在几十 ms 内返回
        await tauriApi.launchApplication(result.app);
        trackEvent("app_launched", { name: result.app.name });

        // 注意：open_history 的更新已经在 handleLaunch 开头处理了，这里不需要重复更新

        // 清除启动状态
        setLaunchingAppPath(null);
      } catch (launchError: any) {
        // 如果启动失败，清除启动状态
        setLaunchingAppPath(null);
        // 注意：open_history 的更新已经在 handleLaunch 开头处理了，这里不需要重复更新
        const errorMsg =
          launchError?.message || launchError?.toString() || "";
        // 检测是否是文件不存在的错误，自动删除索引
        if (
          errorMsg.includes("快捷方式文件不存在") ||
          errorMsg.includes("快捷方式目标不存在") ||
          errorMsg.includes("应用程序未找到")
        ) {
          try {
            const pathToRemove = result.app.path;

            console.log(`[删除应用] ========== 开始删除流程 ==========`);
            console.log(`[删除应用] 要删除的路径: ${pathToRemove}`);

            // 并行执行删除操作（应用索引 + 打开历史）
            await Promise.all([
              tauriApi.removeAppFromIndex(pathToRemove),
              tauriApi.deleteFileHistory(pathToRemove).catch(() => {
                // open_history 中可能不存在该记录，忽略错误
                console.log(
                  `[清理] open_history 中没有该路径记录: ${pathToRemove}`
                );
              }),
            ]);

            console.log(`[删除应用] 后端删除完成`);

            // 规范化路径用于比较（Windows 路径不区分大小写，统一反斜杠）
            const normalizedPathToRemove = normalizePathForCompare(pathToRemove);
            console.log(`[删除应用] 规范化后的路径: ${normalizedPathToRemove}`);

            // 会话内屏蔽：避免 Everything 再次把失效快捷方式搜出来
            suppressedBrokenPathsRef.current.add(normalizedPathToRemove);

            // 同步前端应用缓存，否则下次前端搜索会从缓存里把该项加回来
            allAppsCacheRef.current = allAppsCacheRef.current.filter((app) => {
              return normalizePathForCompare(app.path) !== normalizedPathToRemove;
            });

            // 从 openHistory 状态移除（后端已 deleteFileHistory，前端也要立刻同步）
            setOpenHistory((prev) => {
              const next = { ...prev };
              for (const key of Object.keys(next)) {
                if (normalizePathForCompare(key) === normalizedPathToRemove) {
                  delete next[key];
                }
              }
              return next;
            });

            // 立即从本地状态和显示结果中移除已删除的应用（使用规范化比较）
            setApps((prevApps) => {
              console.log(
                `[删除应用] setApps 被调用，当前 apps 数量: ${prevApps.length}`
              );
              const filtered = prevApps.filter((app) => {
                const shouldKeep =
                  normalizePathForCompare(app.path) !== normalizedPathToRemove;
                if (!shouldKeep) {
                  console.log(`[删除应用] 从 apps 中找到并删除: ${app.path}`);
                }
                return shouldKeep;
              });
              console.log(`[删除应用] setApps 过滤后数量: ${filtered.length}`);
              return filtered;
            });

            setFilteredApps((prevFiltered) => {
              console.log(
                `[删除应用] setFilteredApps 被调用，当前 filteredApps 数量: ${prevFiltered.length}`
              );

              const filtered = prevFiltered.filter((app) => {
                const shouldKeep =
                  normalizePathForCompare(app.path) !== normalizedPathToRemove;
                if (!shouldKeep) {
                  console.log(
                    `[删除应用] ✅ 从 filteredApps 中找到并删除: ${app.path}`
                  );
                }
                return shouldKeep;
              });

              console.log(
                `[删除应用] setFilteredApps 过滤后数量: ${filtered.length}`
              );
              return filtered;
            });

            // 同时从 filteredFiles 中删除（文件历史中的 .lnk 文件）
            setFilteredFiles((prevFiltered) => {
              console.log(
                `[删除应用] setFilteredFiles 被调用，当前 filteredFiles 数量: ${prevFiltered.length}`
              );

              const filtered = prevFiltered.filter((file) => {
                const shouldKeep =
                  normalizePathForCompare(file.path) !== normalizedPathToRemove;
                if (!shouldKeep) {
                  console.log(
                    `[删除应用] ✅ 从 filteredFiles 中找到并删除: ${file.path}`
                  );
                }
                return shouldKeep;
              });

              console.log(
                `[删除应用] setFilteredFiles 过滤后数量: ${filtered.length}`
              );
              return filtered;
            });

            // Everything 结果中同路径的 .lnk 也要立刻移除，否则索引删了图标仍会留着
            setEverythingResults((prev) =>
              prev.filter(
                (item) =>
                  normalizePathForCompare(item.path) !== normalizedPathToRemove
              )
            );

            // 立刻从当前展示列表移除，不等待 combineResults 的 idle 延迟
            const keepResult = (item: SearchResult) =>
              normalizePathForCompare(item.path || "") !== normalizedPathToRemove;
            setHorizontalResults((prev) => {
              const filtered = prev.filter(keepResult);
              horizontalResultsRef.current = filtered;
              return filtered;
            });
            setResults((prev) => prev.filter(keepResult));

            // 同时从文件历史缓存中移除（如果存在）
            const beforeCount = allFileHistoryCacheRef.current.length;
            allFileHistoryCacheRef.current =
              allFileHistoryCacheRef.current.filter((item) => {
                return (
                  normalizePathForCompare(item.path) !== normalizedPathToRemove
                );
              });
            const afterCount = allFileHistoryCacheRef.current.length;
            console.log(
              `[删除应用] 文件历史缓存: ${beforeCount} -> ${afterCount}`
            );

            // 显示提示信息（立即显示，让用户看到立即的反馈）
            setErrorMessage(`${errorMsg}\n\n已自动删除该无效索引。`);
            console.log(
              `[删除应用] ========== 删除流程完成，弹窗已显示 ==========`
            );

            // 注意：不需要后台刷新搜索，因为：
            // 1. 我们已经手动从 filteredApps / everythingResults / 展示列表中删除
            // 2. 后端也已经删除了（通过 Promise.all 等待完成）
            // 3. 会话内 suppressedBrokenPathsRef 会阻止 Everything 再次带回该项
          } catch (deleteError: any) {
            console.error("Failed to remove app from index:", deleteError);
            // 如果删除失败，仍然显示原始错误
            setErrorMessage(errorMsg);
          }
        } else {
          // 其他错误，正常显示
          setErrorMessage(errorMsg);
        }
        return; // 不继续执行后续的 hideLauncherAndResetState
      }
    } else if (result.type === "file" && result.file) {
      try {
        // 注意：历史记录的更新已在开头统一处理，launchFile 不再更新历史记录
        await tauriApi.launchFile(result.file.path);

        // 刷新文件历史缓存以同步后端更新后的数据（包括使用次数）
        void refreshFileHistoryCache()
          .then(() => {
            // 如果当前有查询，重新搜索以更新结果列表
            if (query.trim()) {
              void searchFileHistoryWrapper(query);
            }
          })
          .catch((error) => {
            console.warn(
              `[文件打开] ✗ 刷新 open_history 缓存失败: ${result.file?.path || "未知路径"}`,
              error
            );
          });
      } catch (fileError: any) {
        const errorMsg = fileError?.message || fileError?.toString() || "";
        // 检测是否是文件不存在的错误，自动删除历史记录
        if (errorMsg.includes("Path not found") || errorMsg.includes("not found")) {
          const filePath = result.file?.path;
          if (filePath) {
            try {
              // 自动删除无效的历史记录
              await tauriApi.deleteFileHistory(filePath);
              // 刷新文件历史缓存
              await refreshFileHistoryCache();
              // 重新搜索以更新结果列表
              if (query.trim()) {
                await searchFileHistoryWrapper(query);
              } else {
                await searchFileHistoryWrapper("");
              }
              // 显示提示信息
              setErrorMessage(
                `文件不存在：${filePath}\n\n已自动从历史记录中删除该文件。`
              );
            } catch (deleteError: any) {
              console.error("Failed to delete file history:", deleteError);
              // 如果删除失败，仍然显示原始错误
              setErrorMessage(`文件不存在：${filePath}\n\n错误：${errorMsg}`);
            }
          }
          return; // 不继续执行后续的 hideLauncherAndResetState
        } else {
          // 其他错误，正常显示
          throw fileError;
        }
      }
    } else if (result.type === "everything" && result.everything) {
      // Launch Everything result and add to file history
      try {
        const everythingPath = result.everything.path;

        // 如果 Everything 返回的是以 http/https 开头的链接，作为 URL 处理，走浏览器打开
        if (everythingPath && /^https?:\/\//i.test(everythingPath)) {
          await openUrlSmart(everythingPath, browserRules, tauriApi);
          // 打开链接后直接隐藏启动器，不再走后续文件历史逻辑
          await hideLauncherAndResetState();
          return;
        }

        // 注意：历史记录的更新已在开头统一处理，launchFile 不再更新历史记录
        await tauriApi.launchFile(everythingPath);

        // 刷新文件历史缓存以确保与数据库同步
        void refreshFileHistoryCache()
          .then(() => {
            // 如果当前有查询，重新搜索以更新结果列表
            if (query.trim()) {
              void searchFileHistoryWrapper(query);
            }
          })
          .catch((error) => {
            console.warn(
              `[Everything 文件打开] ✗ 刷新 open_history 缓存失败: ${everythingPath}`,
              error
            );
          });
      } catch (fileError: any) {
        const errorMsg = fileError?.message || fileError?.toString() || "";
        // 检测是否是文件不存在的错误
        if (errorMsg.includes("Path not found") || errorMsg.includes("not found")) {
          const everythingPath = result.everything?.path || "未知路径";
          setErrorMessage(`文件不存在：${everythingPath}`);
          return; // 不继续执行后续的 hideLauncherAndResetState
        } else {
          // 其他错误，正常显示
          throw fileError;
        }
      }
    } else if (result.type === "memo" && result.memo) {
      // 打开备忘录详情弹窗（单条模式）
      setIsMemoListMode(false);
      setSelectedMemo(result.memo);
      setMemoEditTitle(result.memo.title);
      setMemoEditContent(result.memo.content);
      setIsEditingMemo(false);
      setIsMemoModalOpen(true);
      // 不关闭启动器，让用户查看/编辑备忘录
      return;
    } else if (result.type === "plugin" && result.plugin) {
      // 使用插件系统执行插件
      const pluginContext: PluginContext = {
        query,
        setQuery,
        setSelectedIndex,
        hideLauncher: async () => {
          await tauriApi.hideLauncher();
        },
        setIsMemoModalOpen,
        setIsMemoListMode,
        setSelectedMemo,
        setMemoEditTitle,
        setMemoEditContent,
        setIsEditingMemo,
        setIsPluginListModalOpen,
        tauriApi,
      };

      await executePlugin(result.plugin.id, pluginContext);
      // 插件执行后清理状态
      setQuery("");
      setSelectedIndex(0);
      setContextMenu(null);
      return;
    }

    // 注意：openHistory 的更新已经在 handleLaunch 开头处理了，这里不需要重复更新

    // Hide launcher window after launch
    await hideLauncherAndResetState();
  } catch (error: any) {
    console.error("Failed to launch:", error);
    // 显示友好的错误提示（如果还没有设置错误消息）
    if (!errorMessage) {
      const errorMsg = error?.message || error?.toString() || "未知错误";
      setErrorMessage(errorMsg);
    }
  }
}

