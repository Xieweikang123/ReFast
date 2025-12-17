import { useState, useMemo, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { tauriApi } from "../api/tauri";
import type { AppInfo } from "../types";

// Icon extraction failure marker (must match backend constant)
const ICON_EXTRACTION_FAILED_MARKER = "__ICON_EXTRACTION_FAILED__";

// Check if an icon value represents a failed extraction
const isIconExtractionFailed = (icon: string | null | undefined): boolean => {
  return icon === ICON_EXTRACTION_FAILED_MARKER;
};

// Check if an icon is valid (not empty and not failed)
const isValidIcon = (icon: string | null | undefined): boolean => {
  return icon !== null && icon !== undefined && icon.trim() !== '' && !isIconExtractionFailed(icon);
};

interface AppIndexListProps {
  isOpen: boolean;
  onClose: () => void;
  appHotkeys: Record<string, { modifiers: string[]; key: string }>;
  onHotkeysChange: (hotkeys: Record<string, { modifiers: string[]; key: string }>) => void;
}

export function AppIndexList({ isOpen, onClose, appHotkeys, onHotkeysChange }: AppIndexListProps) {
  const [appIndexLoading, setAppIndexLoading] = useState(false);
  const [appIndexError, setAppIndexError] = useState<string | null>(null);
  const [appIndexList, setAppIndexList] = useState<AppInfo[]>([]);
  const [appIconErrorMap, setAppIconErrorMap] = useState<Record<string, boolean>>({});
  const [appIndexSearch, setAppIndexSearch] = useState("");
  const [appIndexProgress, setAppIndexProgress] = useState<{ progress: number; message: string } | null>(null);
  const [extractingIcons, setExtractingIcons] = useState<Set<string>>(new Set());
  
  // 批量提取图标相关状态
  const [isBatchExtracting, setIsBatchExtracting] = useState(false);
  const [batchExtractProgress, setBatchExtractProgress] = useState<{
    current: number;
    total: number;
    currentAppName: string;
  } | null>(null);
  const batchExtractCancelRef = useRef(false);
  
  // 应用快捷键录制相关状态
  const [recordingAppPath, setRecordingAppPath] = useState<string | null>(null);
  const [appRecordingKeys, setAppRecordingKeys] = useState<string[]>([]);
  const appRecordingRef = useRef(false);
  const appLastModifierRef = useRef<string | null>(null);
  const appLastModifierTimeRef = useRef(0);
  const appIsCompletingRef = useRef(false);
  const appFinalKeysRef = useRef<string[] | null>(null);

  // 加载应用索引列表
  const loadAppIndexList = async (forceRescan = false) => {
    if (appIndexLoading) return;
    try {
      setAppIndexLoading(true);
      setAppIndexError(null);

      // Yield to UI so loading状态能先渲染，避免感觉"卡住"
      await new Promise((resolve) => setTimeout(resolve, 0));

      if (forceRescan) {
        // 重新扫描：立即返回，通过事件通知结果，避免阻塞 UI
        // 初始化进度状态
        setAppIndexProgress({ progress: 0, message: "准备开始扫描..." });
        await tauriApi.rescanApplications();
        // 不在这里等待结果，事件监听器会处理
      } else {
        // 普通扫描：等待结果
        const data = await tauriApi.scanApplications();
        console.log("[应用结果列表] 加载完成，总数:", data.length);
        console.log("[应用结果列表] 应用数据:", data);
        setAppIndexList(data);
        setAppIndexLoading(false);
        // 不再自动提取图标，避免打开列表时的延迟
      }
    } catch (error: any) {
      console.error("获取应用索引列表失败:", error);
      setAppIndexError(error?.message || "获取应用索引列表失败");
      setAppIndexLoading(false);
    }
  };

  // 当模态框打开时，如果没有数据则加载
  useEffect(() => {
    if (isOpen && appIndexList.length === 0 && !appIndexLoading) {
      loadAppIndexList();
    }
  }, [isOpen]);

  // 监听应用重新扫描进度和完成事件
  useEffect(() => {
    if (!isOpen) return;

    let unlistenProgress: (() => void) | undefined;
    let unlistenComplete: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    let unlistenIconsUpdated: (() => void) | undefined;

    const setupListeners = async () => {
      // 监听扫描进度
      unlistenProgress = await listen<{ progress: number; message: string }>("app-rescan-progress", (event) => {
        setAppIndexProgress(event.payload);
      });

      // 监听扫描完成
      unlistenComplete = await listen<{ apps: AppInfo[] }>("app-rescan-complete", (event) => {
        const { apps } = event.payload;
        console.log("[应用结果列表] 扫描完成，收到数据:", apps.length);
        setAppIndexList(apps);
        setAppIndexLoading(false);
        setAppIndexProgress(null);
      });

      // 监听扫描错误
      unlistenError = await listen<{ error: string }>("app-rescan-error", (event) => {
        const { error } = event.payload;
        console.error("应用重新扫描失败:", error);
        setAppIndexError(error);
        setAppIndexLoading(false);
        setAppIndexProgress(null);
      });

      // 监听图标更新事件
      unlistenIconsUpdated = await listen<Array<[string, string]>>("app-icons-updated", (event) => {
        const iconUpdates = event.payload;
        console.log("[应用结果列表] 图标已更新:", iconUpdates);
        // 清除错误标记并更新应用列表中的图标
        setAppIconErrorMap((prev) => {
          const newMap = { ...prev };
          iconUpdates.forEach(([path]) => {
            delete newMap[path];
          });
          return newMap;
        });
        setAppIndexList((prevList) => {
          const updatedList = prevList.map((app) => {
            const update = iconUpdates.find(([path]) => path === app.path);
            if (update) {
              return { ...app, icon: update[1] };
            }
            return app;
          });
          return updatedList;
        });
        // 移除正在提取的状态
        setExtractingIcons((prev) => {
          const newSet = new Set(prev);
          iconUpdates.forEach(([path]) => {
            newSet.delete(path);
          });
          return newSet;
        });
      });
    };

    setupListeners().catch(console.error);

    return () => {
      unlistenProgress?.();
      unlistenComplete?.();
      unlistenError?.();
      unlistenIconsUpdated?.();
    };
  }, [isOpen]);

  // 处理关闭模态框
  const handleClose = () => {
    setAppIndexSearch("");
    onClose();
  };

  // 格式化快捷键显示
  const formatHotkey = (config: { modifiers: string[]; key: string }): string => {
    const mods = config.modifiers.join(" + ");
    if (config.modifiers.length === 2 && 
        config.modifiers[0] === config.modifiers[1] && 
        config.modifiers[0] === config.key) {
      return mods;
    }
    return `${mods} + ${config.key}`;
  };

  // 提取应用图标（单个）
  const handleExtractIcon = async (appPath: string) => {
    // 如果正在提取，直接返回
    if (extractingIcons.has(appPath)) {
      return;
    }

    // 添加到正在提取的集合
    setExtractingIcons((prev) => new Set(prev).add(appPath));

    try {
      console.log("[应用索引列表] 开始提取图标:", appPath);
      const icon = await tauriApi.extractIconFromPath(appPath);
      
      if (icon) {
        console.log("[应用索引列表] 图标提取成功:", appPath);
        // 清除之前的错误标记（如果有）
        setAppIconErrorMap((prev) => {
          const newMap = { ...prev };
          delete newMap[appPath];
          return newMap;
        });
        // 更新应用列表中的图标
        setAppIndexList((prevList) => {
          return prevList.map((app) => {
            if (app.path === appPath) {
              return { ...app, icon };
            }
            return app;
          });
        });
      } else {
        console.log("[应用索引列表] 图标提取失败:", appPath);
        // 标记为提取失败
        setAppIndexList((prevList) => {
          return prevList.map((app) => {
            if (app.path === appPath) {
              return { ...app, icon: ICON_EXTRACTION_FAILED_MARKER };
            }
            return app;
          });
        });
      }
    } catch (error) {
      console.error("[应用索引列表] 图标提取错误:", appPath, error);
      // 标记为提取失败
      setAppIndexList((prevList) => {
        return prevList.map((app) => {
          if (app.path === appPath) {
            return { ...app, icon: ICON_EXTRACTION_FAILED_MARKER };
          }
          return app;
        });
      });
    } finally {
      // 从正在提取的集合中移除
      setExtractingIcons((prev) => {
        const newSet = new Set(prev);
        newSet.delete(appPath);
        return newSet;
      });
    }
  };

  // 批量提取图标
  const handleBatchExtractIcons = async () => {
    // 如果正在批量提取，直接返回
    if (isBatchExtracting) {
      return;
    }

    // 获取需要提取图标的应用（没有图标或图标提取失败的）
    const appsToExtract = filteredAppIndexList.filter(app => 
      !isValidIcon(app.icon)
    );

    if (appsToExtract.length === 0) {
      alert("所有应用都已提取图标，无需批量提取");
      return;
    }

    setIsBatchExtracting(true);
    batchExtractCancelRef.current = false;
    setBatchExtractProgress({
      current: 0,
      total: appsToExtract.length,
      currentAppName: "",
    });

    // 使用异步处理，避免阻塞UI
    // 限制并发数量，避免同时提取太多图标
    const CONCURRENT_LIMIT = 3;
    let currentIndex = 0;
    let completedCount = 0;
    let failedCount = 0;

    const extractNextBatch = async () => {
      // 如果已取消，停止提取
      if (batchExtractCancelRef.current) {
        setIsBatchExtracting(false);
        setBatchExtractProgress(null);
        return;
      }

      // 如果已完成所有提取
      if (currentIndex >= appsToExtract.length) {
        setIsBatchExtracting(false);
        setBatchExtractProgress(null);
        alert(`批量提取完成！成功: ${completedCount}，失败: ${failedCount}`);
        return;
      }

      // 获取当前批次的应用
      const batch = appsToExtract.slice(currentIndex, currentIndex + CONCURRENT_LIMIT);
      currentIndex += CONCURRENT_LIMIT;

      // 并发提取当前批次
      const promises = batch.map(async (app) => {
        // 更新进度（显示当前正在提取的应用）
        setBatchExtractProgress((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            currentAppName: app.name,
          };
        });

        // 添加到正在提取的集合（避免与单个提取冲突）
        setExtractingIcons((prev) => new Set(prev).add(app.path));

        try {
          const icon = await tauriApi.extractIconFromPath(app.path);
          
          if (icon) {
            // 清除错误标记
            setAppIconErrorMap((prev) => {
              const newMap = { ...prev };
              delete newMap[app.path];
              return newMap;
            });
            // 更新应用列表中的图标
            setAppIndexList((prevList) => {
              return prevList.map((item) => {
                if (item.path === app.path) {
                  return { ...item, icon };
                }
                return item;
              });
            });
            completedCount++;
          } else {
            // 标记为提取失败
            setAppIndexList((prevList) => {
              return prevList.map((item) => {
                if (item.path === app.path) {
                  return { ...item, icon: ICON_EXTRACTION_FAILED_MARKER };
                }
                return item;
              });
            });
            failedCount++;
          }
        } catch (error) {
          console.error("[批量提取图标] 提取失败:", app.path, error);
          // 标记为提取失败
          setAppIndexList((prevList) => {
            return prevList.map((item) => {
              if (item.path === app.path) {
                return { ...item, icon: ICON_EXTRACTION_FAILED_MARKER };
              }
              return item;
            });
          });
          failedCount++;
        } finally {
          // 从正在提取的集合中移除
          setExtractingIcons((prev) => {
            const newSet = new Set(prev);
            newSet.delete(app.path);
            return newSet;
          });
        }

        // 更新进度
        const newCurrent = completedCount + failedCount;
        setBatchExtractProgress((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            current: newCurrent,
          };
        });

        // 让UI有机会更新（使用 setTimeout 让出控制权）
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // 等待当前批次完成
      await Promise.all(promises);

      // 短暂延迟，让UI更新
      await new Promise((resolve) => setTimeout(resolve, 50));

      // 继续下一批次
      extractNextBatch();
    };

    // 开始提取
    extractNextBatch();
  };

  // 取消批量提取
  const handleCancelBatchExtract = () => {
    batchExtractCancelRef.current = true;
    setIsBatchExtracting(false);
    setBatchExtractProgress(null);
  };

  // 保存应用快捷键
  const saveAppHotkey = async (appPath: string, config: { modifiers: string[]; key: string } | null) => {
    try {
      await tauriApi.saveAppHotkey(appPath, config);
      const newHotkeys = { ...appHotkeys };
      if (config) {
        newHotkeys[appPath] = config;
      } else {
        delete newHotkeys[appPath];
      }
      onHotkeysChange(newHotkeys);
    } catch (error) {
      console.error("Failed to save app hotkey:", error);
      alert("保存应用快捷键失败");
    }
  };

  // 应用快捷键录制逻辑
  useEffect(() => {
    if (!recordingAppPath) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!appRecordingRef.current || appIsCompletingRef.current || e.repeat) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }

      if (appFinalKeysRef.current) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }

      const keyMap: Record<string, string> = {
        "Control": "Ctrl",
        "Alt": "Alt",
        "Shift": "Shift",
        "Meta": "Meta",
      };

      let key = e.key;

      if (keyMap[key]) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const mappedKey = keyMap[key];
        const now = Date.now();

        const isSameModifier = appLastModifierRef.current === mappedKey;
        const hasPreviousPress = appLastModifierTimeRef.current > 0;
        const timeSinceLastPress = hasPreviousPress ? now - appLastModifierTimeRef.current : Infinity;
        const isDoubleTapTime = timeSinceLastPress < 500;

        if (isSameModifier && hasPreviousPress && isDoubleTapTime) {
          appIsCompletingRef.current = true;
          appRecordingRef.current = false;

          const finalModifiers: string[] = [mappedKey, mappedKey];
          appFinalKeysRef.current = finalModifiers;

          const newHotkey: { modifiers: string[]; key: string } = {
            modifiers: finalModifiers,
            key: mappedKey,
          };

          appLastModifierRef.current = null;
          appLastModifierTimeRef.current = 0;

          setAppRecordingKeys(finalModifiers);
          saveAppHotkey(recordingAppPath, newHotkey);
          setRecordingAppPath(null);

          window.removeEventListener("keydown", handleKeyDown, true);
          window.removeEventListener("keyup", handleKeyUp, true);

          setTimeout(() => {
            appIsCompletingRef.current = false;
          }, 300);

          return;
        }

        if (appFinalKeysRef.current) {
          return;
        }

        if (!hasPreviousPress || !isSameModifier || timeSinceLastPress >= 500) {
          appLastModifierRef.current = mappedKey;
          appLastModifierTimeRef.current = now;
          setAppRecordingKeys([mappedKey]);
        }

        return;
      }

      appLastModifierRef.current = null;
      appLastModifierTimeRef.current = 0;

      e.preventDefault();
      e.stopPropagation();

      const modifiers: string[] = [];
      if (e.ctrlKey) modifiers.push("Ctrl");
      if (e.altKey) modifiers.push("Alt");
      if (e.shiftKey) modifiers.push("Shift");
      if (e.metaKey) modifiers.push("Meta");

      if (key === " ") key = "Space";
      if (key.length === 1) key = key.toUpperCase();

      if (modifiers.length === 0) {
        setAppRecordingKeys([key]);
        return;
      }

      const newHotkey: { modifiers: string[]; key: string } = {
        modifiers: modifiers,
        key: key,
      };

      setAppRecordingKeys([...modifiers, key]);
      saveAppHotkey(recordingAppPath, newHotkey);
      setRecordingAppPath(null);
      appRecordingRef.current = false;
    };

    const handleKeyUp = () => {
      if (!appRecordingRef.current) return;
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
    };
  }, [recordingAppPath, appHotkeys, onHotkeysChange]);

  // ESC 键处理（取消应用快捷键录制 或 关闭应用索引模态框）
  useEffect(() => {
    if (!isOpen) return;
    
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // 优先处理快捷键录制
        if (recordingAppPath) {
          e.preventDefault();
          e.stopPropagation();
          setRecordingAppPath(null);
          appRecordingRef.current = false;
          setAppRecordingKeys([]);
          appLastModifierRef.current = null;
          appLastModifierTimeRef.current = 0;
          appIsCompletingRef.current = false;
          appFinalKeysRef.current = null;
        }
        // 如果应用索引模态框打开，关闭它（阻止事件冒泡，避免关闭应用中心窗口）
        else {
          e.preventDefault();
          e.stopPropagation();
          handleClose();
        }
      }
    };
    // 使用 capture 阶段捕获事件，确保在父组件之前处理
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [recordingAppPath, isOpen]);

  // 筛选应用列表
  const filteredAppIndexList = useMemo(() => {
    if (!appIndexSearch.trim()) {
      console.log("[应用结果列表] 无搜索条件，返回全部列表，数量:", appIndexList.length);
      return appIndexList;
    }
    const query = appIndexSearch.toLowerCase();
    const filtered = appIndexList.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        item.path.toLowerCase().includes(query)
    );
    console.log("[应用结果列表] 筛选结果 - 搜索词:", appIndexSearch, "原始数量:", appIndexList.length, "筛选后数量:", filtered.length);
    console.log("[应用结果列表] 筛选后的应用:", filtered);
    return filtered;
  }, [appIndexList, appIndexSearch]);

  // 计算图标统计信息
  const iconStats = useMemo(() => {
    const withIcon = filteredAppIndexList.filter(item => isValidIcon(item.icon)).length;
    const withoutIcon = filteredAppIndexList.length - withIcon;
    return { withIcon, withoutIcon };
  }, [filteredAppIndexList]);

  // 渲染应用图标，加载失败时显示占位图标
  const renderAppIcon = (app: AppInfo) => {
    const showFallbackIcon = !app.icon || isIconExtractionFailed(app.icon) || appIconErrorMap[app.path];
    
    // 处理图标格式：如果是纯 base64 字符串，添加 data:image/png;base64, 前缀
    // 如果已经包含前缀，保持不变
    const iconSrc = app.icon && !showFallbackIcon
      ? (app.icon.startsWith('data:image') 
          ? app.icon 
          : `data:image/png;base64,${app.icon}`)
      : undefined;

    return (
      <div className="w-10 h-10 rounded-lg bg-gray-50 border border-gray-200 flex items-center justify-center overflow-hidden flex-shrink-0">
        {!showFallbackIcon && iconSrc ? (
          <img
            src={iconSrc}
            alt={app.name}
            className="w-8 h-8 object-contain"
            onError={() =>
              setAppIconErrorMap((prev) => ({
                ...prev,
                [app.path]: true,
              }))
            }
          />
        ) : (
          <svg
            className="w-5 h-5 text-gray-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 6a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V6z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 10h8m-8 4h5m-5-7h.01"
            />
          </svg>
        )}
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[80vh] flex flex-col border border-gray-200">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <div className="text-lg font-semibold text-gray-900">应用索引列表</div>
            <div className="text-sm text-gray-500">
              共 {appIndexList.length} 条{appIndexSearch ? `，筛选后 ${filteredAppIndexList.length} 条` : ""}
              {filteredAppIndexList.length > 0 && (
                <span className="ml-2">
                  · 有图标: <span className="text-green-600 font-medium">{iconStats.withIcon}</span>
                  · 无图标: <span className="text-orange-600 font-medium">{iconStats.withoutIcon}</span>
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleBatchExtractIcons}
              className="px-3 py-2 text-xs rounded-lg bg-purple-50 text-purple-700 border border-purple-200 hover:border-purple-300 hover:shadow-sm transition"
              disabled={appIndexLoading || isBatchExtracting || filteredAppIndexList.length === 0}
              title="批量提取所有无图标应用的图标"
            >
              {isBatchExtracting ? "批量提取中..." : "批量提取图标"}
            </button>
            <button
              onClick={() => loadAppIndexList(true)}
              className="px-3 py-2 text-xs rounded-lg bg-green-50 text-green-700 border border-green-200 hover:border-green-300 hover:shadow-sm transition"
              disabled={appIndexLoading || isBatchExtracting}
            >
              {appIndexLoading ? "扫描中..." : "重新扫描"}
            </button>
            <button
              onClick={handleClose}
              className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-500 transition"
              disabled={isBatchExtracting}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="px-6 py-3 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <input
                value={appIndexSearch}
                onChange={(e) => setAppIndexSearch(e.target.value)}
                placeholder="按名称或路径过滤..."
                className="w-full px-4 py-2.5 pl-10 pr-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-400 focus:border-green-400 bg-white text-sm text-gray-900 placeholder-gray-400"
              />
              <svg
                className="absolute left-3 top-2.5 w-4 h-4 text-gray-400 pointer-events-none"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            {appIndexSearch && (
              <button
                onClick={() => setAppIndexSearch("")}
                className="px-3 py-2 text-xs rounded-lg bg-white border border-gray-200 hover:border-gray-300 transition"
              >
                清空
              </button>
            )}
          </div>
          {appIndexProgress && (
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between text-xs text-gray-600">
                <span>{appIndexProgress.message}</span>
                <span>{appIndexProgress.progress}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                <div
                  className="bg-green-500 h-2 rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${appIndexProgress.progress}%` }}
                />
              </div>
            </div>
          )}
              {appIndexError && (
                <div className="mt-3 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                  {appIndexError}
                </div>
              )}
              {batchExtractProgress && (
                <div className="mt-3 space-y-2">
                  <div className="flex items-center justify-between text-xs text-gray-600">
                    <span>
                      批量提取中: {batchExtractProgress.currentAppName || "准备中..."} 
                      ({batchExtractProgress.current}/{batchExtractProgress.total})
                    </span>
                    <button
                      onClick={handleCancelBatchExtract}
                      className="px-2 py-1 text-xs rounded bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 transition"
                    >
                      取消
                    </button>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-purple-500 h-2 rounded-full transition-all duration-300 ease-out"
                      style={{ width: `${(batchExtractProgress.current / batchExtractProgress.total) * 100}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

        <div className="flex-1 overflow-y-auto">
          {appIndexLoading && !appIndexProgress ? (
            <div className="flex items-center justify-center py-12 text-gray-600 text-sm">加载中...</div>
          ) : appIndexLoading && appIndexProgress ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-center space-y-3 w-full px-6">
                <div className="text-sm text-gray-600">{appIndexProgress.message}</div>
                <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden max-w-md mx-auto">
                  <div
                    className="bg-green-500 h-3 rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${appIndexProgress.progress}%` }}
                  />
                </div>
                <div className="text-xs text-gray-500">{appIndexProgress.progress}%</div>
              </div>
            </div>
          ) : filteredAppIndexList.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-gray-500 text-sm">暂无索引数据</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {filteredAppIndexList.map((item, idx) => {
                const appHotkey = appHotkeys[item.path];
                const isRecordingThis = recordingAppPath === item.path;
                return (
                  <div key={`${item.path}-${idx}`} className="px-6 py-3 flex items-center gap-4 hover:bg-gray-50 group relative">
                    <div className="w-6 h-6 rounded bg-green-50 text-green-700 flex items-center justify-center text-xs flex-shrink-0">
                      {idx + 1}
                    </div>
                    {renderAppIcon(item)}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-900">{item.name}</div>
                      <div className="text-xs text-gray-500 break-all mt-1">{item.path}</div>
                      {appHotkey && (
                        <div className="text-xs font-mono text-blue-600 mt-1">
                          {formatHotkey(appHotkey)}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {!isRecordingThis ? (
                        <>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleExtractIcon(item.path);
                            }}
                            disabled={extractingIcons.has(item.path) || isBatchExtracting}
                            className="opacity-0 group-hover:opacity-100 px-2 py-1 text-xs rounded border border-purple-300 text-purple-600 hover:bg-purple-50 transition disabled:opacity-50 disabled:cursor-not-allowed"
                            title={isBatchExtracting ? "批量提取中，请稍候..." : "提取图标"}
                          >
                            {extractingIcons.has(item.path) ? "提取中..." : "提取图标"}
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setRecordingAppPath(item.path);
                              appRecordingRef.current = true;
                              setAppRecordingKeys([]);
                              appFinalKeysRef.current = null;
                            }}
                            className="opacity-0 group-hover:opacity-100 px-2 py-1 text-xs rounded border border-blue-300 text-blue-600 hover:bg-blue-50 transition"
                            title="设置快捷键"
                          >
                            {appHotkey ? "修改" : "设置"}
                          </button>
                          {appHotkey && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                saveAppHotkey(item.path, null);
                              }}
                              className="opacity-0 group-hover:opacity-100 px-2 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-100 transition"
                              title="清除快捷键"
                            >
                              清除
                            </button>
                          )}
                        </>
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setRecordingAppPath(null);
                            appRecordingRef.current = false;
                            setAppRecordingKeys([]);
                            appLastModifierRef.current = null;
                            appLastModifierTimeRef.current = 0;
                            appIsCompletingRef.current = false;
                            appFinalKeysRef.current = null;
                          }}
                          className="px-2 py-1 text-xs rounded border border-gray-500 text-gray-700 hover:bg-gray-100 transition"
                        >
                          取消
                        </button>
                      )}
                    </div>
                    {isRecordingThis && (
                      <div className="absolute left-0 right-0 top-full mt-1 px-6 py-2 bg-yellow-50 border border-yellow-200 rounded-md text-xs text-yellow-800 z-10">
                        正在录制... 请按下您想要设置的快捷键组合
                        {appRecordingKeys.length > 0 && (
                          <div className="mt-1 text-yellow-600">
                            已按下: {appRecordingKeys.join(" + ")}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
