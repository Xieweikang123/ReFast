/**
 * 系统文件夹初始化相关的自定义 Hook
 * 负责初始化系统文件夹列表缓存
 */

import { useEffect, type MutableRefObject } from "react";
import { prefetchSystemFolders } from "../utils/searchUtils";

/**
 * 系统文件夹类型
 */
export type SystemFolder = {
  name: string;
  path: string;
  display_name: string;
  is_folder: boolean;
  icon?: string;
  name_pinyin?: string;
  name_pinyin_initials?: string;
};

/**
 * 系统文件夹初始化 Hook 的选项接口
 */
export interface UseSystemFoldersInitializationOptions {
  systemFoldersListRef: MutableRefObject<SystemFolder[]>;
  systemFoldersListLoadedRef: MutableRefObject<boolean>;
}

/**
 * 系统文件夹初始化 Hook
 */
export function useSystemFoldersInitialization(
  options: UseSystemFoldersInitializationOptions
): void {
  const { systemFoldersListRef, systemFoldersListLoadedRef } = options;

  // 初始化系统文件夹列表（只加载一次；与首次搜索共享同一 Promise）
  useEffect(() => {
    if (!systemFoldersListLoadedRef.current) {
      void prefetchSystemFolders(
        systemFoldersListRef,
        systemFoldersListLoadedRef
      );
    }
  }, [systemFoldersListRef, systemFoldersListLoadedRef]);
}

