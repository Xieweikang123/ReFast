/**
 * 搜索工具函数
 * 用于处理搜索引擎前缀匹配和 URL 构建
 */

import type React from "react";
import type { SearchEngineConfig, AppInfo, FileHistoryItem, MemoItem } from "../types";
import { containsChinese, processBatchAsync, isValidIcon, normalizePathForHistory } from "./launcherUtils";
import { tauriApi } from "../api/tauri";

/**
 * 搜索结果项类型（简化版，避免循环依赖）
 */
export interface SearchResultItem {
  type: "search";
  displayName: string;
  path: string;
}

/**
 * 检测输入是否匹配某个搜索引擎前缀
 * 如果多个引擎前缀重叠，优先匹配更长的前缀
 */
export function detectSearchIntent(
  query: string,
  engines: SearchEngineConfig[]
): { engine: SearchEngineConfig; keyword: string } | null {
  if (!query || !query.trim() || engines.length === 0) {
    return null;
  }

  // 按前缀长度降序排序，优先匹配更长的前缀
  const sortedEngines = [...engines].sort((a, b) => b.prefix.length - a.prefix.length);

  for (const engine of sortedEngines) {
    const prefix = engine.prefix;
    // 只检查前缀是否为空，不进行 trim（因为前缀可能包含空格）
    if (!prefix) continue;

    // 前缀+空格才视为搜索
    // 如果前缀本身以空格结尾（如 "s "），直接匹配前缀
    // 如果前缀不以空格结尾（如 "s"），要求查询必须以"前缀+空格"开头
    const prefixToMatch = prefix.endsWith(' ') ? prefix : prefix + ' ';
    
    if (query.startsWith(prefixToMatch)) {
      const keyword = query.slice(prefixToMatch.length).trim();
      // 只要匹配到前缀，就返回结果（即使关键词为空，也显示搜索意图）
      return { engine, keyword };
    }
  }

  return null;
}

/**
 * 构建搜索 URL，将 {query} 替换为编码后的关键词
 */
export function buildSearchUrl(urlTemplate: string, keyword: string): string {
  const encodedKeyword = encodeURIComponent(keyword);
  return urlTemplate.replace(/{query}/g, encodedKeyword);
}

/**
 * 生成搜索结果项
 */
export function getSearchResultItem(
  engine: SearchEngineConfig,
  keyword: string
): SearchResultItem {
  const searchUrl = buildSearchUrl(engine.url, keyword);
  
  return {
    type: "search",
    displayName: `在 ${engine.name} 搜索：${keyword}`,
    path: searchUrl,
  };
}

/**
 * 前端搜索应用（基于缓存的应用列表）
 * 异步分批处理，避免阻塞UI
 */
export async function searchApplicationsFrontend(query: string, apps: AppInfo[]): Promise<AppInfo[]> {
  if (!query || query.trim() === "") {
    // 返回前10个应用
    return apps.slice(0, 10);
  }

  const queryLower = query.trim().toLowerCase();
  const queryIsPinyin = !containsChinese(queryLower);

  // 优化：直接同步处理，应用搜索的字符串匹配操作非常快，不需要分批处理
  const scoredResults: Array<{ item: AppInfo; score: number }> = [];
  
  // 同步处理所有应用（对于342个应用的字符串匹配，通常只需要几毫秒）
  for (const app of apps) {
    let score = 0;
    const nameLower = app.name.toLowerCase();

    // 直接文本匹配（最高优先级）
    if (nameLower === queryLower) {
      score += 1000;
    } else if (nameLower.startsWith(queryLower)) {
      score += 500;
    } else if (nameLower.includes(queryLower)) {
      score += 100;
    }

    // 拼音匹配（如果查询是拼音，且应用有拼音字段）
    if (queryIsPinyin && (app.name_pinyin || app.name_pinyin_initials)) {
      // 拼音全拼匹配
      if (app.name_pinyin) {
        if (app.name_pinyin === queryLower) {
          score += 800; // 高分数用于完整拼音匹配
        } else if (app.name_pinyin.startsWith(queryLower)) {
          score += 400;
        } else if (app.name_pinyin.includes(queryLower)) {
          score += 150;
        }
      }

      // 拼音首字母匹配
      if (app.name_pinyin_initials) {
        if (app.name_pinyin_initials === queryLower) {
          score += 600; // 高分数用于首字母匹配
        } else if (app.name_pinyin_initials.startsWith(queryLower)) {
          score += 300;
        } else if (app.name_pinyin_initials.includes(queryLower)) {
          score += 120;
        }
      }
    }

    // 描述匹配
    if (score === 0 && app.description) {
      const descLower = app.description.toLowerCase();
      if (descLower.includes(queryLower)) {
        score += 150;
      }
    }

    if (score > 0) {
      scoredResults.push({ item: app, score });
    }
  }

  // 排序操作（同步执行，排序结果非常快）
  // 按分数排序
  scoredResults.sort((a, b) => b.score - a.score);
  
  // 限制结果数量并返回（最多返回50个）
  return scoredResults.slice(0, 50).map((r) => r.item);
}

/**
 * 前端搜索文件历史（基于缓存的文件历史列表）
 * 异步分批处理，避免阻塞UI
 */
export async function searchFileHistoryFrontend(query: string, fileHistory: FileHistoryItem[]): Promise<FileHistoryItem[]> {
  if (!query || query.trim() === "") {
    // 返回所有文件，按最后使用时间排序（使用异步排序避免阻塞）
    return new Promise((resolve) => {
      const worker = () => {
        const sorted = [...fileHistory].sort((a, b) => b.last_used - a.last_used);
        resolve(sorted.slice(0, 100)); // 限制返回数量
      };
      if (window.requestIdleCallback) {
        window.requestIdleCallback(worker, { timeout: 1000 });
      } else {
        setTimeout(worker, 0);
      }
    });
  }

  const queryLower = query.trim().toLowerCase();

  // 使用分批处理搜索，避免阻塞UI
  const scoredResults = await processBatchAsync<FileHistoryItem, { item: FileHistoryItem; score: number }>(
    fileHistory,
    (item) => {
      const nameLower = item.name.toLowerCase();
      const pathLower = item.path.toLowerCase();
      let score = 0;

      // 名称匹配（最高优先级）
      if (nameLower === queryLower) {
        score += 1000;
      } else if (nameLower.startsWith(queryLower)) {
        score += 500;
      } else if (nameLower.includes(queryLower)) {
        score += 100;
      }

      // 路径匹配（较低优先级）
      if (score === 0 && pathLower.includes(queryLower)) {
        score += 10;
      }

      return score > 0 ? { item, score } : null;
    },
    50, // 每批处理50项
    1000 // 超时时间1秒
  );

  // 排序操作也异步执行
  return new Promise((resolve) => {
    const worker = () => {
      // 按分数排序，然后按最后使用时间排序
      scoredResults.sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return b.item.last_used - a.item.last_used;
      });

      // 限制结果数量并返回
      resolve(scoredResults.slice(0, 100).map((r) => r.item));
    };
    if (window.requestIdleCallback) {
      window.requestIdleCallback(worker, { timeout: 1000 });
    } else {
      setTimeout(worker, 0);
    }
  });
}

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
 * 搜索函数依赖接口
 */
export interface SearchDependencies {
  // 状态更新函数
  updateSearchResults: <T>(setter: (value: T) => void, value: T) => void;
  setFilteredApps: (apps: AppInfo[]) => void;
  setFilteredFiles: (files: FileHistoryItem[]) => void;
  setFilteredMemos: (memos: MemoItem[]) => void;
  setSystemFolders: (folders: SystemFolder[]) => void;
  setApps: (apps: AppInfo[]) => void;
  
  // 当前查询
  currentQuery: string;
  
  // 缓存 ref
  allAppsCacheRef: React.MutableRefObject<AppInfo[]>;
  allAppsCacheLoadedRef: React.MutableRefObject<boolean>;
  allFileHistoryCacheRef: React.MutableRefObject<FileHistoryItem[]>;
  allFileHistoryCacheLoadedRef: React.MutableRefObject<boolean>;
  systemFoldersListRef: React.MutableRefObject<SystemFolder[]>;
  systemFoldersListLoadedRef: React.MutableRefObject<boolean>;
  extractedFileIconsRef: React.MutableRefObject<Map<string, string>>;
  
  // 数据
  memos: MemoItem[];
  apps: AppInfo[];
  
  // 工具函数
  filterWindowsApps: (apps: AppInfo[]) => AppInfo[];
}

/**
 * 搜索备忘录
 */
export async function searchMemos(
  q: string,
  deps: Pick<SearchDependencies, 'memos' | 'currentQuery' | 'updateSearchResults' | 'setFilteredMemos'>
): Promise<void> {
  try {
    // Don't search if query is empty
    if (!q || q.trim() === "") {
      deps.updateSearchResults(deps.setFilteredMemos, []);
      return;
    }
    
    // 简单策略：前端过滤本地 memos，如果需要更复杂的可以调用后端 search_memos
    // 使用分批处理避免阻塞UI
    const lower = q.toLowerCase();
    const filtered = await processBatchAsync(
      deps.memos,
      (m) => {
        if (m.title.toLowerCase().includes(lower) ||
            m.content.toLowerCase().includes(lower)) {
          return m;
        }
        return null;
      },
      50, // 每批处理50项
      1000 // 超时时间1秒
    );
    
    // Only update if query hasn't changed
    if (deps.currentQuery.trim() === q.trim()) {
      deps.updateSearchResults(deps.setFilteredMemos, filtered);
    } else {
      deps.updateSearchResults(deps.setFilteredMemos, []);
    }
  } catch (error) {
    console.error("Failed to search memos:", error);
    if (!q || q.trim() === "") {
      deps.updateSearchResults(deps.setFilteredMemos, []);
    }
  }
}

/**
 * 搜索系统文件夹
 */
export async function searchSystemFolders(
  searchQuery: string,
  deps: Pick<SearchDependencies, 'currentQuery' | 'updateSearchResults' | 'setSystemFolders' | 'systemFoldersListRef' | 'systemFoldersListLoadedRef'>
): Promise<void> {
  try {
    if (!searchQuery || searchQuery.trim() === "") {
      deps.updateSearchResults(deps.setSystemFolders, []);
      return;
    }
    
    // 如果列表未加载，先加载
    if (!deps.systemFoldersListLoadedRef.current) {
      const folders = await tauriApi.searchSystemFolders("");
      deps.systemFoldersListRef.current = folders;
      deps.systemFoldersListLoadedRef.current = true;
    }
    
    // 前端搜索（支持拼音匹配）- 使用分批处理避免阻塞UI
    const queryLower = searchQuery.trim().toLowerCase();
    const queryIsPinyin = !containsChinese(queryLower);
    
    // 使用分批处理过滤，避免阻塞UI
    const results = await processBatchAsync(
      deps.systemFoldersListRef.current,
      (folder) => {
        const nameLower = folder.name.toLowerCase();
        const displayLower = folder.display_name.toLowerCase();
        const pathLower = folder.path.toLowerCase();
        
        // 直接文本匹配
        if (nameLower.includes(queryLower) || 
            displayLower.includes(queryLower) || 
            pathLower.includes(queryLower)) {
          return folder;
        }
        
        // 拼音匹配（如果查询是拼音，且文件夹有拼音字段）
        if (queryIsPinyin && (folder.name_pinyin || folder.name_pinyin_initials)) {
          // 拼音全拼匹配
          if (folder.name_pinyin) {
            if (folder.name_pinyin === queryLower ||
                folder.name_pinyin.startsWith(queryLower) ||
                folder.name_pinyin.includes(queryLower)) {
              return folder;
            }
          }
          
          // 拼音首字母匹配
          if (folder.name_pinyin_initials) {
            if (folder.name_pinyin_initials === queryLower ||
                folder.name_pinyin_initials.startsWith(queryLower) ||
                folder.name_pinyin_initials.includes(queryLower)) {
              return folder;
            }
          }
        }
        
        return null;
      },
      50, // 每批处理50项
      1000 // 超时时间1秒
    );
    
    if (deps.currentQuery.trim() === searchQuery.trim()) {
      deps.updateSearchResults(deps.setSystemFolders, results);
    } else {
      deps.updateSearchResults(deps.setSystemFolders, []);
    }
  } catch (error) {
    console.error("Failed to search system folders:", error);
    deps.updateSearchResults(deps.setSystemFolders, []);
  }
}

/**
 * 搜索应用
 */
export async function searchApplications(
  searchQuery: string,
  deps: Pick<SearchDependencies, 'currentQuery' | 'updateSearchResults' | 'setFilteredApps' | 'setApps' | 'allAppsCacheRef' | 'allAppsCacheLoadedRef' | 'apps' | 'filterWindowsApps'>
): Promise<void> {
  try {
    // 清空旧结果，避免显示上一个搜索的结果
    deps.updateSearchResults(deps.setFilteredApps, []);
    
    // 验证查询
    if (!searchQuery || searchQuery.trim() === "") {
      return;
    }

    // 如果缓存未加载，先尝试加载
    if (!deps.allAppsCacheLoadedRef.current || deps.allAppsCacheRef.current.length === 0) {
      // 如果 apps 状态已有数据，使用它
      if (deps.apps.length > 0) {
        deps.allAppsCacheRef.current = deps.apps;
        deps.allAppsCacheLoadedRef.current = true;
      } else {
        // 否则尝试从后端加载
        try {
          const allApps = await tauriApi.scanApplications();
          const filteredApps = deps.filterWindowsApps(allApps);
          deps.allAppsCacheRef.current = filteredApps;
          deps.allAppsCacheLoadedRef.current = true;
          deps.setApps(filteredApps);
        } catch (error) {
          console.error("Failed to load applications for search:", error);
          // 如果加载失败，回退到后端搜索
          const results = await tauriApi.searchApplications(searchQuery);
          if (deps.currentQuery.trim() === searchQuery.trim()) {
            deps.updateSearchResults(deps.setFilteredApps, results);
          } else {
            deps.updateSearchResults(deps.setFilteredApps, []);
          }
          return;
        }
      }
    }

    // 使用前端搜索（异步分批处理）
    const results = await searchApplicationsFrontend(searchQuery, deps.allAppsCacheRef.current);

    // 验证查询未改变，更新结果
    if (deps.currentQuery.trim() === searchQuery.trim()) {
      deps.updateSearchResults(deps.setFilteredApps, results);
      
      // 检查是否有缺少图标的应用，触发图标提取（异步，不阻塞）
      const appsWithoutIcons = results.filter(app => !app.icon);
      if (appsWithoutIcons.length > 0) {
        // 异步触发图标提取，不等待结果
        tauriApi.searchApplications(searchQuery).catch((error) => {
          console.warn("Background icon extraction failed:", error);
        });
      }
    } else {
      deps.updateSearchResults(deps.setFilteredApps, []);
    }
  } catch (error) {
    console.error("Search applications failed:", error);
    deps.updateSearchResults(deps.setFilteredApps, []);
  }
}

/**
 * 搜索文件历史
 */
export async function searchFileHistory(
  searchQuery: string,
  deps: Pick<SearchDependencies, 'currentQuery' | 'updateSearchResults' | 'setFilteredFiles' | 'allFileHistoryCacheRef' | 'allFileHistoryCacheLoadedRef' | 'extractedFileIconsRef' | 'apps'>
): Promise<void> {
  try {
    // Don't search if query is empty
    if (!searchQuery || searchQuery.trim() === "") {
      deps.updateSearchResults(deps.setFilteredFiles, []);
      return;
    }

    // 如果缓存未加载，先加载所有文件历史
    if (!deps.allFileHistoryCacheLoadedRef.current || deps.allFileHistoryCacheRef.current.length === 0) {
      try {
        const allFileHistory = await tauriApi.getAllFileHistory();
        deps.allFileHistoryCacheRef.current = allFileHistory;
        deps.allFileHistoryCacheLoadedRef.current = true;
      } catch (error) {
        console.error("Failed to load file history for search:", error);
        // 如果加载失败，回退到后端搜索
        const results = await tauriApi.searchFileHistory(searchQuery);
        if (deps.currentQuery.trim() === searchQuery.trim()) {
          deps.updateSearchResults(deps.setFilteredFiles, results);
        } else {
          deps.updateSearchResults(deps.setFilteredFiles, []);
        }
        return;
      }
    }

    // 使用前端搜索（异步分批处理）
    const results = await searchFileHistoryFrontend(searchQuery, deps.allFileHistoryCacheRef.current);

    // Only update if query hasn't changed
    const currentQueryTrimmed = deps.currentQuery.trim();
    const searchQueryTrimmed = searchQuery.trim();
    if (currentQueryTrimmed === searchQueryTrimmed) {
      deps.updateSearchResults(deps.setFilteredFiles, results);
      
      // 检查 filteredFiles 中是否有可执行文件（.exe/.lnk），如果有，触发图标提取
      const executableFiles = results.filter(file => {
        const pathLower = file.path.toLowerCase();
        return (pathLower.endsWith('.exe') || pathLower.endsWith('.lnk')) && 
               !pathLower.includes("windowsapps");
      });
      
      if (executableFiles.length > 0) {
        // 过滤出需要提取图标的文件（没有图标或图标无效的文件）
        const filesToExtract = executableFiles
          .slice(0, 10) // 限制最多提取前10个文件，避免过多请求
          .filter((file) => {
            // 检查 extractedFileIconsRef 中是否已有图标
            const extractedIcon = deps.extractedFileIconsRef.current.get(file.path);
            if (isValidIcon(extractedIcon)) {
              return false;
            }
            
            // 检查应用列表中是否已有该路径的应用及其有效图标
            const normalizedPath = normalizePathForHistory(file.path);
            const matchedApp = deps.apps.find((app) => {
              const appPath = normalizePathForHistory(app.path);
              return appPath === normalizedPath;
            });
            
            if (matchedApp && isValidIcon(matchedApp.icon)) {
              // 将应用列表中的图标也保存到 extractedFileIconsRef，避免重复检查
              deps.extractedFileIconsRef.current.set(file.path, matchedApp.icon!);
              return false;
            }
            
            return true; // 需要提取图标
          });
        
        if (filesToExtract.length > 0) {
          filesToExtract.forEach((file) => {
            tauriApi.extractIconFromPath(file.path)
              .then((icon) => {
                if (icon) {
                  // 将提取的图标保存到缓存中
                  deps.extractedFileIconsRef.current.set(file.path, icon);
                  // 更新 filteredFiles 中对应文件的显示（通过重新设置 filteredFiles 触发重新渲染）
                  // 注意：这里需要触发重新渲染，所以使用函数式更新
                  const currentFiles = deps.allFileHistoryCacheRef.current.filter(f => 
                    results.some(r => r.path === f.path)
                  );
                  deps.setFilteredFiles([...currentFiles]);
                }
              })
              .catch(() => {
                // 忽略错误
              });
          });
        }
        
        // 注意：不再调用后端搜索，避免重复调用
        // 后端搜索会在 searchApplications 函数中统一调用
      }
    } else {
      deps.setFilteredFiles([]);
    }
  } catch (error) {
    console.error("Failed to search file history:", error);
    if (!searchQuery || searchQuery.trim() === "") {
      deps.setFilteredFiles([]);
    }
  }
}

