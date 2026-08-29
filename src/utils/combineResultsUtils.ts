/**
 * 组合搜索结果工具函数
 * 负责将所有搜索结果（应用、文件、Everything、URL等）组合并排序
 */

import type React from "react";
import type {
  AppInfo,
  FileHistoryItem,
  EverythingResult,
  MemoItem,
  SearchEngineConfig,
  BrowserRule,
} from "../types";
import {
  type SearchResult,
  compareSearchResults,
  shouldKeepResultForQuery,
} from "./resultUtils";
import {
  normalizePathForHistory,
  normalizeAppName,
  isValidIcon,
  isRecentShortcutPath,
  appSourceRank,
  isUninstallShortcutName,
  isFolderLikePath,
  ensureUrlScheme,
} from "./launcherUtils";
import { detectSearchIntent, getSearchResultItem } from "./searchUtils";
import { resolveBrowserForUrl } from "./browserRules";
import {
  parseSearchFilter,
  hasSearchKeyword,
  shouldSearchSource,
  resultMatchesScope,
} from "./searchFilterUtils";

/** 为 URL 解析路由浏览器标识；未命中规则时返回 undefined（不显示路由标签） */
function browserForUrl(
  url: string,
  rules: BrowserRule[] | undefined
): string | undefined {
  const browser = resolveBrowserForUrl(url, rules);
  return browser === "default" ? undefined : browser;
}

/**
 * 组合搜索结果的选项接口
 */
export interface CombineResultsOptions {
  query: string;
  aiAnswer: string | null;
  filteredApps: AppInfo[];
  filteredFiles: FileHistoryItem[];
  filteredMemos: MemoItem[];
  systemFolders: Array<{
    name: string;
    path: string;
    display_name: string;
    is_folder: boolean;
    icon?: string;
    name_pinyin?: string;
    name_pinyin_initials?: string;
  }>;
  everythingResults: EverythingResult[];
  filteredPlugins: Array<{ id: string; name: string; description?: string }>;
  detectedUrls: string[];
  detectedEmails: string[];
  detectedJson: string | null;
  directPathResult: FileHistoryItem | null;
  openHistory: Record<string, number>;
  urlRemarks: Record<string, string>;
  searchEngines: SearchEngineConfig[];
  apps: AppInfo[];
  /** 浏览器路由规则：命中时可在启动器直接打开对应站点 */
  browserRules?: BrowserRule[];
  extractedFileIconsRef: React.MutableRefObject<Map<string, string>>;
  /** 本次会话内已确认失效的快捷方式，合并结果时排除 */
  suppressedBrokenPathsRef?: React.MutableRefObject<Set<string>>;
}

/** 历史/Everything 结果是否为文件夹：同名应用去重时不应丢掉项目目录 */
function isFolderSearchResult(result: SearchResult): boolean {
  if (result.type === "file") {
    if (result.file?.is_folder !== null && result.file?.is_folder !== undefined) {
      return !!result.file.is_folder;
    }
    return isFolderLikePath(result.path);
  }
  if (result.type === "everything") {
    if (result.everything?.is_folder !== null && result.everything?.is_folder !== undefined) {
      return !!result.everything.is_folder;
    }
    return isFolderLikePath(result.path);
  }
  return false;
}

/**
 * 组合所有搜索结果
 */
export function computeCombinedResults(options: CombineResultsOptions): SearchResult[] {
  const {
    query: rawQuery,
    aiAnswer,
    openHistory,
    urlRemarks,
    searchEngines,
    apps,
    extractedFileIconsRef,
  } = options;

  const parsed = parseSearchFilter(rawQuery);
  const query = parsed.keyword;
  const scope = parsed.scope;

  // 纯前缀或空查询：无关键词时不显示结果（AI 回答除外）
  if (!hasSearchKeyword(parsed) && !aiAnswer) {
    return [];
  }

  const suppressed = options.suppressedBrokenPathsRef?.current;
  const isSuppressed = (path: string) =>
    !!suppressed?.has(path.toLowerCase().replace(/\//g, "\\"));

  const filteredApps = (
    shouldSearchSource(scope, "app") ? options.filteredApps : []
  ).filter((app) => !isSuppressed(app.path));
  const filteredFiles = (
    shouldSearchSource(scope, "file") ? options.filteredFiles : []
  ).filter((file) => !isSuppressed(file.path));
  const systemFolders = shouldSearchSource(scope, "systemFolder")
    ? options.systemFolders
    : [];
  const everythingResultsRaw = shouldSearchSource(scope, "everything")
    ? options.everythingResults
    : [];
  // 排除本会话已确认失效的快捷方式（目标不存在等），避免 Everything 再次带回
  const everythingResults = suppressed?.size
    ? everythingResultsRaw.filter((item) => !isSuppressed(item.path))
    : everythingResultsRaw;
  const filteredMemos = shouldSearchSource(scope, "memo")
    ? options.filteredMemos
    : [];
  const filteredPlugins = shouldSearchSource(scope, "plugin")
    ? options.filteredPlugins
    : [];
  const detectedUrls = shouldSearchSource(scope, "url")
    ? options.detectedUrls.map(ensureUrlScheme)
    : [];
  const detectedEmails = shouldSearchSource(scope, "email")
    ? options.detectedEmails
    : [];
  const detectedJson = shouldSearchSource(scope, "json")
    ? options.detectedJson
    : null;
  const directPathResult = shouldSearchSource(scope, "path")
    ? options.directPathResult
    : null;

  // 先对 everythingResults 进行去重（基于路径），防止重复触发 useMemo 重新计算
  const seenEverythingPaths = new Set<string>();
  const deduplicatedEverythingResults: EverythingResult[] = [];
  for (const everything of everythingResults) {
    const normalizedPath = normalizePathForHistory(everything.path);
    if (!seenEverythingPaths.has(normalizedPath)) {
      seenEverythingPaths.add(normalizedPath);
      deduplicatedEverythingResults.push(everything);
    }
  }

  // 使用去重后的 everythingResults
  const uniqueEverythingResults = deduplicatedEverythingResults;

  // 预处理 Everything 结果：分离可执行文件和普通文件，并统计过滤情况
  const executableEverythingResults = uniqueEverythingResults.filter((everything) => {
    const pathLower = everything.path.toLowerCase();
    return pathLower.endsWith(".exe") || pathLower.endsWith(".lnk");
  });

  let recycleBinFilteredCount = 0;
  let duplicateFilteredCount = 0;

  // 已存在的应用名称集合（含 filteredApps）
  const normalizedAppNameSet = new Set<string>(
    filteredApps.map((app) => normalizeAppName(app.name))
  );

  const filteredExecutableEverything = executableEverythingResults
    .filter((everything) => {
      // 过滤掉回收站中的文件（$RECYCLE.BIN）
      const pathLower = everything.path.toLowerCase();
      if (pathLower.includes("$recycle.bin")) {
        recycleBinFilteredCount++;
        return false;
      }
      // Recent 快捷方式不当作应用
      if (isRecentShortcutPath(everything.path)) {
        recycleBinFilteredCount++;
        return false;
      }
      return true;
    })
    .filter((everything) => {
      // 检查是否已经在 filteredApps 或 filteredFiles 中，如果已存在则过滤掉
      const normalizedEverythingPath = normalizePathForHistory(everything.path);
      const normalizedEverythingName = normalizeAppName(
        everything.name || normalizedEverythingPath.split("/").pop() || ""
      );
      const isInFilteredApps = filteredApps.some((app) => {
        const normalizedAppPath = normalizePathForHistory(app.path);
        return normalizedAppPath === normalizedEverythingPath;
      });
      const isInFilteredFiles = filteredFiles.some((file) => {
        const normalizedFilePath = normalizePathForHistory(file.path);
        return normalizedFilePath === normalizedEverythingPath;
      });
      // 额外通过名称去重，避免同名的 exe 与 lnk 同时出现
      const isDuplicateByName = normalizedAppNameSet.has(normalizedEverythingName);
      const shouldInclude = !isInFilteredApps && !isInFilteredFiles && !isDuplicateByName;
      if (!shouldInclude) {
        duplicateFilteredCount++;
      }
      if (shouldInclude) {
        normalizedAppNameSet.add(normalizedEverythingName);
      }
      return shouldInclude;
    })
    .map(
      (everything): SearchResult => {
        // 尝试从提取的图标缓存中获取图标
        const extractedIcon = extractedFileIconsRef.current.get(everything.path);
        
        // 如果没有提取的图标，尝试从应用列表中匹配
        let icon = extractedIcon;
        if (!icon || !isValidIcon(icon)) {
          const normalizedEverythingPath = normalizePathForHistory(everything.path);
          const matchedApp = filteredApps.find((app) => {
            const normalizedAppPath = normalizePathForHistory(app.path);
            return normalizedAppPath === normalizedEverythingPath;
          }) || apps.find((app) => {
            const normalizedAppPath = normalizePathForHistory(app.path);
            return normalizedAppPath === normalizedEverythingPath;
          });
          
          if (matchedApp && matchedApp.icon && isValidIcon(matchedApp.icon)) {
            icon = matchedApp.icon;
          }
        }
        
        return {
          type: "app" as const,
          app: {
            name: everything.name,
            path: everything.path,
            icon: icon || undefined,
            description: undefined,
            name_pinyin: undefined,
            name_pinyin_initials: undefined,
          },
          displayName: everything.name,
          path: everything.path,
        };
      }
    );

  const nonExecutableEverythingResults = uniqueEverythingResults.filter((everything) => {
    const pathLower = everything.path.toLowerCase();
    return !pathLower.endsWith(".exe") && !pathLower.endsWith(".lnk");
  });

  let recycleBinFilteredCount2 = 0;
  const filteredNonExecutableEverything = nonExecutableEverythingResults
    .filter((everything) => {
      // 过滤掉回收站中的文件（$RECYCLE.BIN）
      const pathLower = everything.path.toLowerCase();
      if (pathLower.includes("$recycle.bin")) {
        recycleBinFilteredCount2++;
        return false;
      }
      return true;
    })
    .map((everything) => {
      const extractedIcon = extractedFileIconsRef.current.get(everything.path);
      return {
        type: "everything" as const,
        everything,
        displayName: everything.name,
        path: everything.path,
        icon: isValidIcon(extractedIcon) ? extractedIcon : undefined,
      };
    });

  // 从 openHistory 中提取 URL 历史记录（仅在查询不为空时）
  const historyUrls: Array<{ url: string; timestamp: number }> = [];
  const queryLower = query.toLowerCase().trim();
  const detectedUrlsSet = new Set(detectedUrls.map((url) => url.toLowerCase()));

  // 只在有查询时才从历史记录中搜索 URL
  if (queryLower) {
    // 遍历 openHistory，提取所有 URL（以 http:// 或 https:// 开头）
    for (const [key, timestamp] of Object.entries(openHistory)) {
      const keyLower = key.toLowerCase();
      if (
        (keyLower.startsWith("http://") || keyLower.startsWith("https://")) &&
        !detectedUrlsSet.has(keyLower)
      ) {
        // URL 包含查询内容，或者备注包含查询内容，则添加到历史 URL 列表
        const urlMatches = keyLower.includes(queryLower);
        const remark = urlRemarks[key];
        const remarkMatches = remark && remark.toLowerCase().includes(queryLower);

        if (urlMatches || remarkMatches) {
          historyUrls.push({ url: key, timestamp });
        }
      }
    }

    // 按最近使用时间排序（最新的在前）
    historyUrls.sort((a, b) => b.timestamp - a.timestamp);
  }

  // 从浏览器路由规则生成可搜索的直达结果：查询命中规则模式时，
  // 显示该站点并直接使用规则指定的浏览器打开
  const ruleBaseUrls: string[] = [];
  if (queryLower && shouldSearchSource(scope, "url")) {
    for (const rule of options.browserRules || []) {
      if (!rule.enabled) continue;
      const pattern = rule.pattern.trim();
      if (!pattern) continue;
      const patternLower = pattern.toLowerCase().replace(/\/+$/, "");
      const queryMatches =
        patternLower.includes(queryLower) || queryLower.includes(patternLower);
      if (!queryMatches) continue;
      const baseUrl = patternLower.includes("://")
        ? pattern.replace(/\/+$/, "")
        : `https://${patternLower.replace(/^\/+/, "")}`;
      ruleBaseUrls.push(baseUrl);
    }
  }

  // 合并检测到的 URL 和历史 URL，去重（检测到的 URL 优先）
  const allUrlsSet = new Set(detectedUrls.map((url) => url.toLowerCase()));
  const allUrls: string[] = [...detectedUrls];

  // 添加历史 URL（避免重复）
  for (const { url } of historyUrls) {
    if (!allUrlsSet.has(url.toLowerCase())) {
      allUrls.push(url);
      allUrlsSet.add(url.toLowerCase());
    }
  }

  // 添加浏览器路由规则命中的站点（避免重复）
  for (const baseUrl of ruleBaseUrls) {
    if (!allUrlsSet.has(baseUrl.toLowerCase())) {
      allUrls.push(baseUrl);
      allUrlsSet.add(baseUrl.toLowerCase());
    }
  }

  const urlResults: SearchResult[] = allUrls.map((url) => ({
    type: "url" as const,
    url,
    displayName: url,
    path: url,
    browser: browserForUrl(url, options.browserRules),
  }));

  // 邮箱结果
  const emailResults: SearchResult[] = detectedEmails.map((email) => ({
    type: "email" as const,
    email,
    displayName: email,
    path: `mailto:${email}`,
  }));

  // JSON 格式化选项
  const jsonFormatterResult: SearchResult[] = detectedJson
    ? [
        {
          type: "json_formatter" as const,
          jsonContent: detectedJson,
          displayName: "打开 JSON 格式化查看器",
          path: "json://formatter",
        },
      ]
    : [];

  // 检查是否应该显示"历史访问"结果（只在明确搜索相关关键词时显示）
  const lowerQuery = query.toLowerCase().trim();
  const historyKeywords = ["历史访问", "历史", "访问历史", "ls", "history"];
  const shouldShowHistory = historyKeywords.some(
    (keyword) =>
      lowerQuery.includes(keyword.toLowerCase()) ||
      keyword.toLowerCase().includes(lowerQuery)
  );

  // 检查是否应该显示"设置"结果（只在明确搜索相关关键词时显示）
  const settingsKeywords = ["设置", "settings", "配置", "config", "preferences"];
  const shouldShowSettings = settingsKeywords.some(
    (keyword) =>
      lowerQuery.includes(keyword.toLowerCase()) ||
      keyword.toLowerCase().includes(lowerQuery)
  );

  // 检查是否是启动相关关键词（这些应该优先显示系统启动文件夹，而不是软件设置）
  const startupKeywords = ["开机启动", "自启动", "启动项", "startup", "autostart"];
  const isStartupQuery = startupKeywords.some(
    (keyword) =>
      lowerQuery.includes(keyword.toLowerCase()) ||
      keyword.toLowerCase().includes(lowerQuery)
  );

  // 创建文件历史记录的映射，用于关联应用的使用频率数据
  const fileHistoryMap = new Map<string, FileHistoryItem>();
  filteredFiles.forEach((file) => {
    const normalizedPath = normalizePathForHistory(file.path);
    fileHistoryMap.set(normalizedPath, file);
  });

  // 调试日志：检查系统文件夹
  if (query.trim() && systemFolders.length > 0) {
    systemFolders.forEach((folder) => {
      const normalizedPath = normalizePathForHistory(folder.path);
      fileHistoryMap.get(normalizedPath);
    });
  }

  // 检测搜索意图：过滤器前缀优先，已命中过滤器时不再走搜索引擎
  // 搜索引擎前缀基于原始输入匹配（如 "g keyword"）
  const searchIntent =
    !parsed.hasFilter && shouldSearchSource(scope, "searchEngine")
      ? detectSearchIntent(rawQuery, searchEngines)
      : null;

  // 如果检测到搜索引擎前缀，只返回搜索引擎结果，屏蔽其他所有搜索
  if (searchIntent) {
    const searchResultItem = getSearchResultItem(searchIntent.engine, searchIntent.keyword);
    const searchResult: SearchResult = {
      ...searchResultItem,
      type: "search" as const,
    };
    return [searchResult];
  }

  let otherResults: SearchResult[] = [
    // 如果有 AI 回答，将其添加到结果列表的前面
    ...(aiAnswer
      ? [
          {
            type: "ai" as const,
            aiAnswer: aiAnswer,
            displayName: "AI 回答",
            path: "ai://answer",
          },
        ]
      : []),
    // 如果查询匹配历史访问关键词，添加历史访问结果
    ...(shouldShowHistory
      ? [
          {
            type: "history" as const,
            displayName: "历史访问",
            path: "history://shortcuts-config",
          },
        ]
      : []),
    // 绝对路径直达结果（如果存在）
    ...(directPathResult
      ? [
          {
            type: "file" as const,
            file: directPathResult,
            displayName: directPathResult.name || directPathResult.path,
            path: directPathResult.path,
          },
        ]
      : []),
    // 如果查询匹配启动相关关键词，添加 Windows 系统启动设置页面
    ...(isStartupQuery
      ? [
          {
            type: "url" as const,
            url: "ms-settings:startupapps",
            displayName: "系统启动设置",
            path: "ms-settings:startupapps",
          },
        ]
      : []),
    // 系统文件夹结果，优先显示
    ...systemFolders.map((folder) => {
      // 尝试从文件历史记录中查找对应的使用频率数据
      const normalizedFolderPath = folder.path;
      const fileHistory = fileHistoryMap.get(normalizedFolderPath);

      // 如果找到文件历史记录，使用历史记录的数据；否则使用默认值
      const fileData = fileHistory || {
        path: folder.path,
        name: folder.name,
        last_used: 0,
        use_count: 0,
        is_folder: folder.is_folder,
      };

      return {
        type: "file" as const,
        file: fileData,
        displayName: folder.name,
        path: folder.path,
      };
    }),
    // 如果查询匹配设置关键词，优先显示 Windows 设置应用（通过提高其优先级实现）
    ...filteredApps.map((app) => {
      // 尝试从文件历史记录中查找对应的使用频率数据
      const normalizedAppPath = normalizePathForHistory(app.path);
      const fileHistory = fileHistoryMap.get(normalizedAppPath);

      // 如果应用没有图标，尝试从 apps 状态中查找匹配的应用并获取图标
      let appWithIcon = app;
      if (!isValidIcon(app.icon)) {
        const matchedApp = apps.find((a) => {
          const normalizedPath = normalizePathForHistory(a.path);
          return normalizedPath === normalizedAppPath;
        });

        if (matchedApp && isValidIcon(matchedApp.icon)) {
          appWithIcon = { ...app, icon: matchedApp.icon! };
        }
      }

      return {
        type: "app" as const,
        app: appWithIcon,
        // 如果找到对应的文件历史记录，设置 file 字段以便排序时使用 use_count 和 last_used
        file: fileHistory,
        displayName: app.name,
        path: app.path,
      };
    }),
    // 从文件历史记录中分离可执行文件
    ...filteredFiles
      .filter((file) => {
        const pathLower = file.path.toLowerCase();
        // 过滤掉 WindowsApps 路径
        if (pathLower.includes("windowsapps")) {
          return false;
        }
        // Recent 快捷方式不当作应用（常指向文件夹，会挤掉同名开始菜单应用）
        if (isRecentShortcutPath(file.path)) {
          return false;
        }
        return pathLower.endsWith(".exe") || pathLower.endsWith(".lnk");
      })
      .filter((file) => {
        // 检查是否已经在 filteredApps 中，如果已存在则过滤掉
        // 不仅要检查路径完全相同，还要检查 .lnk 文件是否指向已存在的 .exe 文件
        const normalizedFilePath = file.path;
        const filePathLower = file.path.toLowerCase();

        // 首先检查是否有完全相同的路径
        const hasExactMatch = filteredApps.some((app) => {
          const normalizedAppPath = app.path;
          return normalizedAppPath === normalizedFilePath;
        });
        if (hasExactMatch) return false;

        // 如果是 .lnk 文件，检查是否有对应的 .exe 文件在 filteredApps 中
        if (filePathLower.endsWith(".lnk")) {
          // 提取 .lnk 文件的关键信息用于匹配
          // 策略：提取路径中的公司目录和产品名称，检查是否有 .exe 文件包含这些信息
          const lnkNormalized = normalizedFilePath;

          // 查找 "programs/" 之后的目录结构
          const programsIdx = lnkNormalized.indexOf("/programs/");
          if (programsIdx !== -1) {
            const afterPrograms = lnkNormalized.substring(
              programsIdx + "/programs/".length
            );
            const productPart = afterPrograms.replace(/\.lnk$/, "");

            // 提取公司目录和产品名称
            const slashIdx = productPart.indexOf("/");
            if (slashIdx !== -1) {
              const companyDir = productPart.substring(0, slashIdx);
              const productName = productPart.substring(slashIdx + 1);

              // 检查 filteredApps 中是否有 .exe 文件包含这些信息
              const hasMatchingExe = filteredApps.some((app) => {
                const appPathLower = app.path;
                if (!appPathLower.endsWith(".exe")) return false;
                // 检查 .exe 路径是否同时包含公司目录和产品名称
                return (
                  appPathLower.includes(companyDir) &&
                  appPathLower.includes(productName)
                );
              });
              if (hasMatchingExe) return false;
            } else {
              // 单层目录结构，检查名称匹配
              const companyOrProduct = productPart;
              const lnkNameLower = file.name.toLowerCase().replace(/\.lnk$/, "");
              const hasMatchingExe = filteredApps.some((app) => {
                const appPathLower = app.path;
                if (!appPathLower.endsWith(".exe")) return false;
                // 检查路径包含目录名，且路径包含 .lnk 名称的核心部分
                return (
                  appPathLower.includes(companyOrProduct) &&
                  appPathLower.includes(lnkNameLower)
                );
              });
              if (hasMatchingExe) return false;
            }
          }
        }

        return true;
      })
      // 在 filteredFiles 内部去重：对于 .lnk 文件，检查是否存在对应的 .exe 文件
      // 优先保留 .exe 文件，如果 .lnk 文件指向相同的应用，则过滤掉 .lnk
      .reduce((acc: typeof filteredFiles, file) => {
        const pathLower = file.path.toLowerCase();
        if (pathLower.endsWith(".exe")) {
          // 直接添加 .exe 文件
          acc.push(file);
        } else if (pathLower.endsWith(".lnk")) {
          // 对于 .lnk 文件，检查是否已有对应的 .exe 文件
          const lnkPathLower = file.path.toLowerCase();
          const lnkName = file.name.toLowerCase().replace(/\.lnk$/, "").trim();

          // 检查是否已有对应的 .exe 文件（通过名称和路径判断）
          const hasCorrespondingExe = acc.some((existingFile) => {
            const existingPathLower = existingFile.path.toLowerCase();
            if (!existingPathLower.endsWith(".exe")) return false;

            // 提取 .exe 文件的基本名称（不含扩展名）
            const exeName = existingFile.name.toLowerCase().replace(/\.exe$/, "").trim();

            // 方法1：名称匹配 - 如果 .lnk 名称包含 .exe 名称，或者 .exe 名称包含 .lnk 名称的核心部分
            // 例如："Navicat Premium 17.lnk" 包含 "navicat"
            if (
              lnkName.includes(exeName) ||
              exeName.includes(lnkName.split(" ")[0])
            ) {
              return true;
            }

            // 方法2：路径匹配 - 检查路径中的目录结构是否匹配
            // 提取路径中的关键目录名（通常是软件公司名或产品名）
            // 例如：C:\Program Files\PremiumSoft\Navicat Premium 17\navicat.exe
            //      C:\ProgramData\Microsoft\Windows\Start Menu\Programs\PremiumSoft\Navicat Premium 17.lnk
            // 两个路径都包含 "PremiumSoft"，说明可能是同一应用

            // 从 .exe 路径中提取目录名（排除常见系统目录）
            // 尝试匹配 Program Files\公司名 或 Program Files\公司名\产品名 的模式
            const exeDirMatches = existingPathLower.match(
              /(?:program files|program files \(x86\))\\([^\\/]+)(?:\\[^\\/]+)?\\/i
            );
            if (exeDirMatches && exeDirMatches[1]) {
              const exeDirName = exeDirMatches[1].toLowerCase();
              // 检查 .lnk 路径中是否也包含这个目录名
              if (lnkPathLower.includes(exeDirName)) {
                // 进一步检查：如果路径中都包含相同的目录名，且 .lnk 名称与 .exe 所在路径相关
                // 例如：.exe 在 PremiumSoft\Navicat Premium 17 目录下，.lnk 名称是 "Navicat Premium 17"
                const exePathContainsLnkName = existingPathLower.includes(lnkName);
                const lnkNameContainsExeDir = lnkName.includes(exeDirName);
                if (
                  exePathContainsLnkName ||
                  lnkNameContainsExeDir ||
                  existingPathLower.includes(lnkName.split(" ")[0])
                ) {
                  return true;
                }
              }
            }

            // 方法3：反向检查 - 从 .lnk 路径中提取目录名（在 Start Menu 中，通常在 Programs 子目录下）
            // 例如：Programs\PremiumSoft\Navicat Premium 17.lnk
            const lnkDirMatches = lnkPathLower.match(/programs\\([^\\/]+)/i);
            if (lnkDirMatches && lnkDirMatches[1]) {
              const lnkDirName = lnkDirMatches[1].toLowerCase();
              // 检查 .exe 路径中是否也包含这个目录名
              // 如果包含，且名称也相关，则认为是同一应用
              if (existingPathLower.includes(lnkDirName)) {
                // 进一步检查名称相关性
                const exePathContainsLnkName = existingPathLower.includes(lnkName);
                const lnkNameContainsExeName = lnkName.includes(exeName);
                if (exePathContainsLnkName || lnkNameContainsExeName) {
                  return true;
                }
              }
            }

            return false;
          });

          // 如果没有对应的 .exe 文件，添加该 .lnk 文件
          if (!hasCorrespondingExe) {
            acc.push(file);
          }
        } else {
          // 其他类型的文件，直接添加
          acc.push(file);
        }
        return acc;
      }, [])
      .filter((file) => {
        // 同名去重：避免 file history 与 Everything/应用列表名称重复
        const normalizedName = normalizeAppName(file.name);
        if (normalizedAppNameSet.has(normalizedName)) {
          duplicateFilteredCount++;
          return false;
        }
        normalizedAppNameSet.add(normalizedName);
        return true;
      })
      .map(
        (file): SearchResult => {
          // 尝试从提取的图标缓存中获取图标
          const extractedIcon = extractedFileIconsRef.current.get(file.path);
          return {
            type: "app" as const,
            app: {
              name: file.name,
              path: file.path,
              icon: extractedIcon, // 优先使用提取的图标，如果没有则尝试从应用列表获取
              description: undefined,
              name_pinyin: undefined,
              name_pinyin_initials: undefined,
            },
            displayName: file.name,
            path: file.path,
          };
        }
      ),
    // 普通文件（非可执行文件）
    ...filteredFiles
      .filter((file) => {
        const pathLower = file.path.toLowerCase();
        return !pathLower.endsWith(".exe") && !pathLower.endsWith(".lnk");
      })
      .map((file) => {
        // 检查是否是 URL（从历史记录中获取的）
        const isUrl =
          file.path.startsWith("http://") || file.path.startsWith("https://");

        if (isUrl) {
          return {
            type: "url" as const,
            url: file.path,
            file,
            displayName: file.name,
            path: file.path,
            browser: browserForUrl(file.path, options.browserRules),
          };
        }

        const extractedIcon = extractedFileIconsRef.current.get(file.path);
        return {
          type: "file" as const,
          file,
          displayName: file.name,
          path: file.path,
          icon: isValidIcon(extractedIcon) ? extractedIcon : undefined,
        };
      }),
    ...filteredMemos.map((memo) => ({
      type: "memo" as const,
      memo,
      displayName: memo.title || memo.content.slice(0, 50),
      path: memo.id,
    })),
    // 将文件工具箱插件单独提取，优先显示
    ...filteredPlugins
      .filter((plugin) => plugin.id === "file_toolbox")
      .map((plugin) => ({
        type: "plugin" as const,
        plugin,
        displayName: plugin.name,
        path: plugin.id,
      })),
    // 其他插件
    ...filteredPlugins
      .filter((plugin) => plugin.id !== "file_toolbox")
      .map((plugin) => ({
        type: "plugin" as const,
        plugin,
        displayName: plugin.name,
        path: plugin.id,
      })),
    // 从 Everything 结果中分离可执行文件（已在数组外预处理）
    ...filteredExecutableEverything,
    // 普通 Everything 结果（非可执行文件，已在数组外预处理）
    ...filteredNonExecutableEverything,
  ];

  // 对结果进行去重：如果同一个路径出现在多个结果源中，只保留一个
  // 优先保留历史文件结果（因为历史记录包含使用频率和最近使用时间，排序更准确）
  // 先收集历史文件结果的路径集合
  const historyFilePaths = new Set<string>();
  const normalizeNameForResult = (result: SearchResult): string => {
    const base =
      result.displayName ||
      result.path.split(/[\\/]/).pop() ||
      result.path;
    return normalizeAppName(base);
  };
  // 记录已保留的应用名，用于后续过滤同名的非应用结果（避免"同名文档"覆盖/混淆应用）
  const seenAppNames = new Set<string>();
  for (const result of otherResults) {
    if (result.type === "file") {
      const normalizedPath = normalizePathForHistory(result.path);
      historyFilePaths.add(normalizedPath);
    }
  }

  // 过滤掉 Everything 结果中与历史文件结果重复的路径
  const deduplicatedResults: SearchResult[] = [];
  const addedHistoryPaths = new Set<string>(); // 用于跟踪已添加的历史文件路径，防止历史文件结果之间的重复
  const addedAppPaths = new Set<string>(); // 用于跟踪已添加的应用路径，防止应用结果之间的重复
  let everythingFilteredByHistoryCount = 0; // 统计因与历史文件重复而被过滤的 Everything 结果数
  let appFilteredByHistoryCount = 0; // 统计因与历史文件重复而被过滤的 app 结果数

  for (const result of otherResults) {
    // 对于特殊类型（AI、历史、设置等）和 URL，不需要去重
    if (
      result.type === "ai" ||
      result.type === "history" ||
      result.type === "settings" ||
      result.type === "url" ||
      result.type === "email" ||
      result.type === "json_formatter" ||
      result.type === "plugin"
    ) {
      deduplicatedResults.push(result);
      continue;
    }

    // 对于历史文件类型，检查是否已经添加过（防止历史文件结果之间的重复）
    if (result.type === "file") {
      const normalizedPath = normalizePathForHistory(result.path);
      if (!addedHistoryPaths.has(normalizedPath)) {
        addedHistoryPaths.add(normalizedPath);
        // 如果已存在同名应用，跳过同名文档，但保留文件夹（如 GitLite.exe 与项目目录 GitLite）
        const normalizedName = normalizeNameForResult(result);
        if (seenAppNames.has(normalizedName) && !isFolderSearchResult(result)) {
          continue;
        }
        deduplicatedResults.push(result);
      }
      // 如果路径已添加过，跳过（保留第一次出现的，通常使用频率更高）
      continue;
    }

    // 对于 Everything 类型，检查是否已在历史文件结果中
    if (result.type === "everything") {
      const normalizedPath = normalizePathForHistory(result.path);
      const normalizedName = normalizeNameForResult(result);
      // 如果已有同名应用，跳过同名文档，但保留同名文件夹
      if (seenAppNames.has(normalizedName) && !isFolderSearchResult(result)) {
        everythingFilteredByHistoryCount++; // 复用统计
        continue;
      }
      if (!historyFilePaths.has(normalizedPath)) {
        deduplicatedResults.push(result);
      } else {
        everythingFilteredByHistoryCount++;
      }
      // 如果路径已在历史文件结果中，跳过（不添加 Everything 结果）
      continue;
    }

    // 对于 app 类型，检查路径是否重复（包括与其他 app 类型结果的重复）
    if (result.type === "app") {
      const normalizedPath = normalizePathForHistory(result.path);
      const isInHistoryFilePaths = historyFilePaths.has(normalizedPath);
      const isInAddedAppPaths = addedAppPaths.has(normalizedPath);
      const normalizedName = normalizeNameForResult(result);
      // 检查是否已在历史文件结果中，或者是否已经添加过（防止重复）
      // 注意：如果同一个路径在 otherResults 中出现多次（比如来自 filteredFiles 和 Everything），只保留第一个
      if (!isInHistoryFilePaths && !isInAddedAppPaths) {
        addedAppPaths.add(normalizedPath);
        seenAppNames.add(normalizedName);
        deduplicatedResults.push(result);
      } else {
        if (isInHistoryFilePaths) {
          appFilteredByHistoryCount++;
        }
      }
      continue;
    }

    // 对于其他类型，检查路径是否重复
    const normalizedPath = normalizePathForHistory(result.path);
    if (!historyFilePaths.has(normalizedPath)) {
      deduplicatedResults.push(result);
    }
  }

  // 使用去重后的结果
  otherResults = deduplicatedResults;

  // 统计最终结果列表中的应用数量（包括来自 filteredApps 和 filteredFiles 的应用）
  let finalAppResults = otherResults.filter((r) => r.type === "app");

  // 对最终应用结果按名称去重：优先保留开始菜单/桌面/exe，剔除 Recent 等低质量项
  const seenFinalAppNames = new Set<string>();
  const deduplicatedAppResults = finalAppResults.reduce(
    (acc: typeof finalAppResults, app) => {
      // Recent 快捷方式直接丢弃（不应出现在应用横条）
      if (isRecentShortcutPath(app.path)) {
        return acc;
      }

      const displayName =
        app.displayName || app.path.split(/[\\/]/).pop() || "";
      // 卸载类快捷方式不进横条（避免「Uninstall AIALL」盖过真应用观感）
      if (isUninstallShortcutName(displayName)) {
        return acc;
      }

      const normalizedName = normalizeAppName(displayName);
      const pathLower = app.path.toLowerCase();
      const isExe = pathLower.endsWith(".exe");
      const rank = appSourceRank(app.path);

      if (!seenFinalAppNames.has(normalizedName)) {
        // 第一次遇到这个名称，直接添加
        seenFinalAppNames.add(normalizedName);
        acc.push(app);
      } else {
        // 已经存在同名应用，检查是否应该替换为更高质量来源
        const existingIndex = acc.findIndex((existing) => {
          const existingNormalizedName = normalizeAppName(
            existing.displayName || existing.path.split(/[\\/]/).pop() || ""
          );
          return existingNormalizedName === normalizedName;
        });

        if (existingIndex !== -1) {
          const existing = acc[existingIndex];
          const existingPathLower = existing.path.toLowerCase();
          const existingIsLnk = existingPathLower.endsWith(".lnk");
          const existingRank = appSourceRank(existing.path);

          // 来源更好（开始菜单 > 桌面 > … > Recent）则替换
          if (rank < existingRank) {
            acc[existingIndex] = app;
          } else if (rank === existingRank && isExe && existingIsLnk) {
            // 同来源时：.exe 优先于 .lnk
            acc[existingIndex] = app;
          }
        }
      }

      return acc;
    },
    []
  );

  // 将去重后的应用结果更新回 otherResults
  // 移除原来的应用结果，然后添加去重后的应用结果
  otherResults = [
    ...otherResults.filter((r) => r.type !== "app"),
    ...deduplicatedAppResults,
  ];

  finalAppResults = deduplicatedAppResults;

  // 有查询时过滤未命中项；排序：匹配档位优先，同档内最近使用
  // 性能优化：结果过多时只对前 1000 条常规结果排序
  const MAX_SORT_COUNT = 1000;
  otherResults = otherResults.filter(
    (result) =>
      resultMatchesScope(result.type, scope) &&
      shouldKeepResultForQuery(result, query)
  );
  const needsTruncatedSort = otherResults.length > MAX_SORT_COUNT;
  const sortOptions = {
    query,
    openHistory,
    shouldShowSettings,
    preferSpecialTypes: true,
  };

  if (needsTruncatedSort) {
    const specialTypes = ["ai", "history", "settings"];
    const specialResults: SearchResult[] = [];
    const regularResults: SearchResult[] = [];

    for (const result of otherResults) {
      if (specialTypes.includes(result.type)) {
        specialResults.push(result);
      } else {
        regularResults.push(result);
      }
    }

    const toSort = regularResults.slice(0, MAX_SORT_COUNT);
    const rest = regularResults.slice(MAX_SORT_COUNT);
    toSort.sort((a, b) =>
      compareSearchResults(a, b, { ...sortOptions, preferSpecialTypes: false })
    );
    otherResults = [...specialResults, ...toSort, ...rest];
  } else {
    otherResults.sort((a, b) => compareSearchResults(a, b, sortOptions));
  }

  // 合并所有结果，然后统一排序
  const urlPathsInOtherResults = new Set<string>();
  for (const result of otherResults) {
    if (result.type === "url" && result.url) {
      urlPathsInOtherResults.add(result.url.toLowerCase());
    }
  }

  // 优先保留 otherResults 中的 URL（含更完整的 file 信息）
  const deduplicatedUrlResults = urlResults.filter((result) => {
    if (result.type === "url" && result.url) {
      return !urlPathsInOtherResults.has(result.url.toLowerCase());
    }
    return true;
  });

  const allResultsToSort = [
    ...otherResults,
    ...deduplicatedUrlResults,
    ...emailResults,
    ...jsonFormatterResult,
  ].filter(
    (result) =>
      resultMatchesScope(result.type, scope) &&
      shouldKeepResultForQuery(result, query)
  );

  allResultsToSort.sort((a, b) => compareSearchResults(a, b, sortOptions));

  return allResultsToSort;
}

