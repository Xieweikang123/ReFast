/**
 * 应用图标更新 / 索引重扫监听
 * 同步启动器前端应用缓存（allAppsCacheRef）
 */

import { useEffect, type MutableRefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import type { AppInfo } from "../types";

/**
 * 应用图标更新监听 Hook 的选项接口
 */
export interface UseAppIconsListenerOptions {
  setFilteredApps: React.Dispatch<React.SetStateAction<AppInfo[]>>;
  setApps: React.Dispatch<React.SetStateAction<AppInfo[]>>;
  allAppsCacheRef: MutableRefObject<AppInfo[]>;
  allAppsCacheLoadedRef?: MutableRefObject<boolean>;
  filterWindowsApps?: (apps: AppInfo[]) => AppInfo[];
  /** 索引更新后刷新当前查询下的应用结果（避免横条仍显示旧列表） */
  onAppsIndexUpdated?: (apps: AppInfo[]) => void;
}

/**
 * 应用图标更新监听 Hook
 */
export function useAppIconsListener(
  options: UseAppIconsListenerOptions
): void {
  const {
    setFilteredApps,
    setApps,
    allAppsCacheRef,
    allAppsCacheLoadedRef,
    filterWindowsApps,
    onAppsIndexUpdated,
  } = options;

  // 监听图标更新事件，收到后刷新搜索结果中的图标
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupListener = async () => {
      try {
        unlisten = await listen<Array<[string, string]>>(
          "app-icons-updated",
          (event) => {
            const iconUpdates = event.payload;

            // 更新 filteredApps 中的图标
            setFilteredApps((prevApps) => {
              const updatedApps = prevApps.map((app) => {
                const iconUpdate = iconUpdates.find(
                  ([path]) => path === app.path
                );
                if (iconUpdate) {
                  return { ...app, icon: iconUpdate[1] };
                }
                return app;
              });
              return updatedApps;
            });

            // 同时更新 apps 状态和缓存中的图标
            setApps((prevApps) => {
              const updatedApps = prevApps.map((app) => {
                const iconUpdate = iconUpdates.find(
                  ([path]) => path === app.path
                );
                if (iconUpdate) {
                  return { ...app, icon: iconUpdate[1] };
                }
                return app;
              });
              // 同步更新缓存
              if (allAppsCacheRef.current) {
                allAppsCacheRef.current = updatedApps;
              }
              return updatedApps;
            });
          }
        );
      } catch (error) {
        console.error("Failed to setup app-icons-updated listener:", error);
      }
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [setFilteredApps, setApps, allAppsCacheRef]);

  // 重扫/静默刷新完成后，同步启动器前端应用缓存（否则仍用旧 allAppsCacheRef）
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupListener = async () => {
      try {
        unlisten = await listen<{ apps: AppInfo[] }>(
          "app-rescan-complete",
          (event) => {
            const apps = event.payload?.apps;
            if (!Array.isArray(apps)) return;
            const filtered = filterWindowsApps
              ? filterWindowsApps(apps)
              : apps;
            setApps(filtered);
            allAppsCacheRef.current = filtered;
            if (allAppsCacheLoadedRef) {
              allAppsCacheLoadedRef.current = true;
            }
            onAppsIndexUpdated?.(filtered);
          }
        );
      } catch (error) {
        console.error("Failed to setup app-rescan-complete listener:", error);
      }
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [
    setApps,
    allAppsCacheRef,
    allAppsCacheLoadedRef,
    filterWindowsApps,
    onAppsIndexUpdated,
  ]);
}

