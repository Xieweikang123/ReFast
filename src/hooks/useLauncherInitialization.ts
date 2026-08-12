/**
 * Launcher 初始化相关的自定义 hooks
 * 负责处理组件挂载时的各种初始化逻辑
 */

import type React from "react";
import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { tauriApi } from "../api/tauri";
import type { AppInfo, FileHistoryItem, MemoItem, SearchEngineConfig, BrowserRule, PluginContext } from "../types";
import type { ResultStyle } from "../utils/themeConfig";

// 全局标志，确保整个应用只有一个插件快捷键监听器
let globalPluginHotkeyListenerSetup = false;
let globalUnsubscribeTriggered: (() => void) | null = null;
let globalUnsubscribeUpdated: (() => void) | null = null;
// 使用同步标志 + Promise 锁，确保 setupListeners 只执行一次
let setupListenersInProgress = false; // 同步标志，立即生效
let setupListenersPromise: Promise<void> | null = null;
// 全局执行锁，确保即使有多个监听器，也只有一个能执行插件
// 使用同步标志 + 时间戳，确保原子性
let pluginExecutionInProgress = new Map<string, number>(); // pluginId -> timestamp when execution started

/**
 * 初始化选项接口
 */
export interface LauncherInitializationOptions {
  // 状态设置函数
  setOllamaSettings: (settings: { model: string; base_url: string }) => void;
  setResultStyle: (style: ResultStyle) => void;
  setCloseOnBlur: (close: boolean) => void;
  setSearchEngines: (engines: SearchEngineConfig[]) => void;
  setBrowserRules: (rules: BrowserRule[]) => void;
  setIsEverythingAvailable: (available: boolean) => void;
  setEverythingError: (error: string | null) => void;
  setEverythingPath: (path: string | null) => void;
  setEverythingVersion: (version: string | null) => void;
  setMemos: (memos: MemoItem[]) => void;
  setOpenHistory: (history: Record<string, number>) => void;
  setUrlRemarks: (remarks: Record<string, string>) => void;
  setApps: (apps: AppInfo[]) => void;
  setEverythingDownloadProgress: (progress: number) => void;
  
  // Refs
  allAppsCacheRef: React.MutableRefObject<AppInfo[]>;
  allAppsCacheLoadedRef: React.MutableRefObject<boolean>;
  allFileHistoryCacheRef: React.MutableRefObject<FileHistoryItem[]>;
  allFileHistoryCacheLoadedRef: React.MutableRefObject<boolean>;
  closeOnBlurRef: React.MutableRefObject<boolean>;
  
  // 工具函数
  filterWindowsApps: (apps: AppInfo[]) => AppInfo[];
  
  // 其他依赖
  query: string;
  setQuery: (query: string) => void;
  setSelectedIndex: (index: number) => void;
  isDownloadingEverything: boolean;
}

/**
 * Launcher 初始化 hook
 * 处理所有组件挂载时的初始化逻辑
 */
export function useLauncherInitialization(
  options: LauncherInitializationOptions
): void {
  const {
    setOllamaSettings,
    setResultStyle,
    setCloseOnBlur,
    setSearchEngines,
    setBrowserRules,
    setIsEverythingAvailable,
    setEverythingError,
    setEverythingPath,
    setEverythingVersion,
    setMemos,
    setOpenHistory,
    setUrlRemarks,
    setApps,
    setEverythingDownloadProgress,
    allAppsCacheRef,
    allAppsCacheLoadedRef,
    allFileHistoryCacheRef,
    allFileHistoryCacheLoadedRef,
    closeOnBlurRef,
    filterWindowsApps,
    query,
    setQuery,
    setSelectedIndex,
    isDownloadingEverything,
  } = options;

  // Load settings on mount and reload when settings window closes
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await tauriApi.getSettings();
        setOllamaSettings(settings.ollama);
        const styleFromSettings = (settings.result_style as ResultStyle) || null;
        const styleFromCache = localStorage.getItem("result-style");
        const fallback =
          styleFromSettings && ["compact", "soft", "skeuomorphic"].includes(styleFromSettings)
            ? styleFromSettings
            : styleFromCache && ["compact", "soft", "skeuomorphic"].includes(styleFromCache)
            ? (styleFromCache as ResultStyle)
            : "skeuomorphic";
        setResultStyle(fallback);
        localStorage.setItem("result-style", fallback);
        const closeOnBlurSetting = settings.close_on_blur ?? true;
        setCloseOnBlur(closeOnBlurSetting);
        closeOnBlurRef.current = closeOnBlurSetting;
        // 加载搜索引擎配置
        if (settings.search_engines) {
          setSearchEngines(settings.search_engines);
        }
        // 加载浏览器路由规则
        if (settings.browser_rules) {
          setBrowserRules(settings.browser_rules);
        }
      } catch (error) {
        console.error("Failed to load settings:", error);
      }
    };
    loadSettings();

    // 监听设置窗口关闭事件，重新加载设置
    const unlisten = listen("settings:updated", () => {
      loadSettings();
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [setOllamaSettings, setResultStyle, setCloseOnBlur, setSearchEngines, setBrowserRules, closeOnBlurRef]);

  // Check if Everything is available on mount and periodically if not available
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const checkEverything = async () => {
      try {
        const status = await tauriApi.getEverythingStatus();
        setIsEverythingAvailable(status.available);
        setEverythingError(status.error || null);

        // Get Everything path and version for debugging
        if (status.available) {
          try {
            const path = await tauriApi.getEverythingPath();
            setEverythingPath(path);
            if (path) {
              // Path found
            }

            // Get Everything version
            try {
              const version = await tauriApi.getEverythingVersion();
              setEverythingVersion(version);
              if (version) {
                // Version retrieved
              }
            } catch (error) {
              console.error("Failed to get Everything version:", error);
            }
          } catch (error) {
            console.error("Failed to get Everything path:", error);
          }

          // 如果检测到已安装，清除定时器
          if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
            console.log("[Everything检测] 检测到 Everything 已安装，停止定时检测");
          }

          return true;
        } else {
          console.warn("Everything is not available:", status.error);
          setEverythingPath(null);
          setEverythingVersion(null);
          return false;
        }
      } catch (error) {
        console.error("Failed to check Everything availability:", error);
        setIsEverythingAvailable(false);
        setEverythingPath(null);
        setEverythingVersion(null);
        setEverythingError("检查失败");
        return false;
      }
    };

    // 立即检查一次
    checkEverything().then((isAvailable) => {
      // 如果 Everything 不可用，设置定时检测（每 5 秒检查一次）
      if (!isAvailable) {
        console.log("[Everything检测] Everything 未安装，开始定时检测（每 5 秒）");
        intervalId = setInterval(async () => {
          await checkEverything();
        }, 5000); // 每 5 秒检查一次
      }
    });

    // 组件卸载时清除定时器
    return () => {
      if (intervalId) {
        clearInterval(intervalId);
        console.log("[Everything检测] 组件卸载，清除定时检测");
      }
    };
  }, [
    setIsEverythingAvailable,
    setEverythingError,
    setEverythingPath,
    setEverythingVersion,
  ]);

  // Load all memos on mount (for quick search)
  useEffect(() => {
    const loadMemos = async () => {
      try {
        const list = await tauriApi.getAllMemos();
        setMemos(list);
      } catch (error) {
        console.error("Failed to load memos:", error);
      }
    };
    loadMemos();
  }, [setMemos]);

  // Load open history on mount
  useEffect(() => {
    const loadOpenHistory = async () => {
      try {
        const history = await tauriApi.getOpenHistory();
        setOpenHistory(history);
        // 加载所有 URL 的备注信息（备注存储在 name 字段中）
        const remarks: Record<string, string> = {};
        for (const [key] of Object.entries(history)) {
          if (key.startsWith("http://") || key.startsWith("https://")) {
            try {
              const item = await tauriApi.getOpenHistoryItem(key);
              if (item?.name) {
                remarks[key] = item.name;
              }
            } catch (error) {
              // 忽略单个项加载失败
            }
          }
        }
        setUrlRemarks(remarks);
      } catch (error) {
        console.error("Failed to load open history:", error);
      }
    };
    loadOpenHistory();
  }, [setOpenHistory, setUrlRemarks]);

  // 静默预加载应用列表（组件挂载时，不显示加载状态）
  useEffect(() => {
    let isMounted = true;
    const preloadApplications = async () => {
      try {
        // 静默加载，不设置 isLoading 状态
        const allApps = await tauriApi.scanApplications();
        if (isMounted) {
          const filteredApps = filterWindowsApps(allApps);
          setApps(filteredApps);
          // 同时更新缓存，用于前端搜索
          allAppsCacheRef.current = filteredApps;
          allAppsCacheLoadedRef.current = true;
          // 不设置 filteredApps，等待用户输入查询时再设置
        }
      } catch (error) {
        console.error("Failed to preload applications:", error);
        // 预加载失败不影响用户体验，静默处理
      }
    };
    // 立即加载，移除延迟以提升第一次查询速度
    preloadApplications();
    return () => {
      isMounted = false;
    };
  }, [setApps, filterWindowsApps, allAppsCacheRef, allAppsCacheLoadedRef]);

  // 静默预加载文件历史（组件挂载时，不显示加载状态）
  useEffect(() => {
    let isMounted = true;
    const preloadFileHistory = async () => {
      try {
        // 静默加载所有文件历史到前端缓存
        const allFileHistory = await tauriApi.getAllFileHistory();
        if (isMounted) {
          allFileHistoryCacheRef.current = allFileHistory;
          allFileHistoryCacheLoadedRef.current = true;
        }
      } catch (error) {
        console.error("Failed to preload file history:", error);
        // 预加载失败不影响用户体验，静默处理
      }
    };
    // 延迟一小段时间，避免阻塞初始渲染
    const timer = setTimeout(preloadFileHistory, 200);
    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [allFileHistoryCacheRef, allFileHistoryCacheLoadedRef]);

  // 监听插件快捷键（通过后端全局监听）
  const lastTriggeredRef = useRef<{ pluginId: string; time: number } | null>(null);
  // 使用 useRef 存储最新的值，确保事件处理函数能访问到最新值
  const queryRef = useRef(query);
  const setQueryRef = useRef(setQuery);
  const setSelectedIndexRef = useRef(setSelectedIndex);
  
  // 更新 ref 的值
  queryRef.current = query;
  setQueryRef.current = setQuery;
  setSelectedIndexRef.current = setSelectedIndex;

  useEffect(() => {
    // 如果全局监听器已经设置，直接返回
    if (globalPluginHotkeyListenerSetup) {
      return;
    }

    // 使用同步标志检查，确保原子性（在检查之前就设置标志）
    if (setupListenersInProgress) {
      return;
    }

    // 如果已经有正在进行的 Promise，等待它完成
    if (setupListenersPromise) {
      return;
    }

    // 立即设置同步标志，防止其他 useEffect 同时执行
    setupListenersInProgress = true;
    
    // 立即创建并存储 Promise，防止其他 useEffect 同时执行
    // 必须在检查之后立即赋值，确保原子性
    setupListenersPromise = (async () => {
      // 再次检查全局标志（在异步函数内部，可能已经被其他调用设置了）
      if (globalPluginHotkeyListenerSetup) {
        return;
      }
      
      try {
        // 先清理旧的全局监听器（如果存在）
        // 注意：即使已经设置了标志，也要清理，以防有残留的监听器
        if (globalUnsubscribeTriggered) {
          globalUnsubscribeTriggered();
          globalUnsubscribeTriggered = null;
        }
        if (globalUnsubscribeUpdated) {
          globalUnsubscribeUpdated();
          globalUnsubscribeUpdated = null;
        }
      
      // 监听插件快捷键触发事件（从后端发送）
      const unsubscribeTriggered = await listen<string>("plugin-hotkey-triggered", async (event) => {
        const pluginId = event.payload;
        const now = Date.now();

        // 全局执行锁：使用同步检查-设置模式，确保只有一个监听器能执行
        // 第一步：检查是否正在执行（1秒内）
        const existingStartTime = pluginExecutionInProgress.get(pluginId);
        if (existingStartTime && now - existingStartTime < 1000) {
          console.log(
            `[PluginHotkeys] ⏭️  Ignored duplicate trigger for plugin: ${pluginId} (execution in progress, started ${now - existingStartTime}ms ago)`
          );
          return;
        }
        
        // 第二步：立即设置执行标志（同步操作，确保原子性）
        pluginExecutionInProgress.set(pluginId, now);
        
        // 第三步：再次验证我们是否第一个（防止竞态条件）
        // 如果在我们设置之后，有其他监听器也设置了，那么时间戳会不同
        const verifyStartTime = pluginExecutionInProgress.get(pluginId);
        if (verifyStartTime !== now) {
          // 有其他监听器在我们之后设置了标志，说明我们不是第一个，应该退出
          console.log(
            `[PluginHotkeys] ⏭️  Ignored duplicate trigger for plugin: ${pluginId} (race condition detected, our time: ${now}, actual time: ${verifyStartTime})`
          );
          return;
        }

        // 前端防抖：检查是否在 500ms 内重复触发同一个插件
        // 增加防抖时间，防止重复打开窗口
        if (lastTriggeredRef.current) {
          const { pluginId: lastId, time: lastTime } = lastTriggeredRef.current;
          if (lastId === pluginId && now - lastTime < 500) {
            console.log(
              `[PluginHotkeys] ⏭️  Ignored duplicate trigger for plugin: ${pluginId} (within 500ms)`
            );
            // 清除全局执行标志（只清除我们自己的）
            if (pluginExecutionInProgress.get(pluginId) === now) {
              pluginExecutionInProgress.delete(pluginId);
            }
            return;
          }
        }

        // 记录触发时间和插件 ID
        lastTriggeredRef.current = { pluginId, time: now };

        console.log(`[PluginHotkeys] ✅ Hotkey triggered for plugin: ${pluginId}`);

        try {
          const { executePlugin } = await import("../plugins");
          const pluginContext: PluginContext = {
            query: queryRef.current,
            setQuery: setQueryRef.current,
            setSelectedIndex: setSelectedIndexRef.current,
            hideLauncher: async () => {
              await tauriApi.hideLauncher();
            },
            tauriApi,
          };
          await executePlugin(pluginId, pluginContext);
        } catch (error) {
          console.error(`[PluginHotkeys] ❌ Failed to execute plugin ${pluginId}:`, error);
        } finally {
          // 清除全局执行标志（只清除我们自己的）
          // 立即清除锁，允许其他插件或同一插件的后续执行
          // 防抖机制（500ms）已经在上面的 lastTriggeredRef 中处理了
          if (pluginExecutionInProgress.get(pluginId) === now) {
            pluginExecutionInProgress.delete(pluginId);
          }
        }
      });
      
      // 存储 unsubscribe 函数到全局变量
      globalUnsubscribeTriggered = unsubscribeTriggered;
      // 标志已经在 useEffect 开始时设置，这里不需要再次设置

      // 监听插件快捷键更新事件
      const unsubscribeUpdated = await listen<Record<string, { modifiers: string[]; key: string }>>(
        "plugin-hotkeys-updated",
        () => {
          // 插件快捷键更新事件处理（当前为空）
        }
      );
      
      // 存储 unsubscribe 函数到全局变量
      globalUnsubscribeUpdated = unsubscribeUpdated;
      // 设置全局标志
      globalPluginHotkeyListenerSetup = true;
      } catch (error) {
        console.error("[PluginHotkeys] Failed to setup listeners:", error);
        globalPluginHotkeyListenerSetup = false;
        globalUnsubscribeTriggered = null;
        globalUnsubscribeUpdated = null;
      } finally {
        // 清除同步标志和 Promise，允许后续重试
        setupListenersInProgress = false;
        setupListenersPromise = null;
      }
    })().catch((error) => {
      console.error("[PluginHotkeys] Failed to setup listeners:", error);
      globalPluginHotkeyListenerSetup = false;
      globalUnsubscribeTriggered = null;
      globalUnsubscribeUpdated = null;
      setupListenersInProgress = false;
      setupListenersPromise = null;
    });

    return () => {
      // 注意：我们不在这里清理全局监听器，因为可能有多个组件实例
      // 全局监听器应该在应用关闭时清理，或者使用单例模式
      // 但为了安全，如果这是最后一个组件实例，我们可以清理
      // 这里我们保持全局监听器，因为它应该在整个应用生命周期内存在
    };
  }, []); // 移除依赖项，只在组件挂载时注册一次

  // Listen for Everything download progress events
  useEffect(() => {
    if (!isDownloadingEverything) return;

    let unlistenFn: (() => void) | null = null;

    const setupProgressListener = async () => {
      const unlisten = await listen<number>("everything-download-progress", (event) => {
        setEverythingDownloadProgress(event.payload);
      });
      unlistenFn = unlisten;
    };

    setupProgressListener();

    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, [isDownloadingEverything, setEverythingDownloadProgress]);
}

