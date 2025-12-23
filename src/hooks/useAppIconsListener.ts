/**
 * 应用图标更新监听相关的自定义 Hook
 * 负责监听图标更新事件并更新应用列表中的图标
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
}

/**
 * 应用图标更新监听 Hook
 */
export function useAppIconsListener(
  options: UseAppIconsListenerOptions
): void {
  const { setFilteredApps, setApps, allAppsCacheRef } = options;

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
}

