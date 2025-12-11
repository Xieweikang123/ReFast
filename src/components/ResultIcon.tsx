import type { AppInfo, FileHistoryItem, EverythingResult, MemoItem, SystemFolderItem } from "../types";
import type { ThemeConfig, ResultStyle } from "../utils/themeConfig";
import { isFolderLikePath } from "../utils/launcherUtils";

type SearchResult = {
  type: "app" | "file" | "everything" | "url" | "email" | "memo" | "plugin" | "system_folder" | "history" | "ai" | "json_formatter" | "settings";
  app?: AppInfo;
  file?: FileHistoryItem;
  everything?: EverythingResult;
  url?: string;
  email?: string;
  memo?: MemoItem;
  plugin?: { id: string; name: string; description?: string };
  systemFolder?: SystemFolderItem;
  aiAnswer?: string;
  jsonContent?: string;
  displayName: string;
  path: string;
};

interface ResultIconProps {
  result: SearchResult;
  isSelected: boolean;
  theme: ThemeConfig;
  apps: AppInfo[];
  filteredApps: AppInfo[];
  resultStyle: ResultStyle;
  getPluginIcon: (pluginId: string, className: string) => JSX.Element;
  size?: "horizontal" | "vertical";
}

/**
 * 结果项图标组件
 * 统一处理所有类型结果的图标渲染逻辑
 */
export function ResultIcon({
  result,
  isSelected,
  theme,
  apps,
  filteredApps,
  resultStyle,
  getPluginIcon,
  size = "vertical",
}: ResultIconProps) {
  // 根据 size 确定图标大小
  const getIconSize = () => {
    if (size === "horizontal") {
      return isSelected ? "w-9 h-9" : "w-7 h-7";
    }
    // vertical
    if (result.type === "app") {
      return "w-8 h-8";
    }
    return "w-5 h-5";
  };

  const iconSize = getIconSize();

  // 处理应用图标
  if (result.type === "app") {
    // 检查是否是 Windows 设置应用，如果是则使用齿轮图标
    const appName = (result.app?.name || result.displayName || '').toLowerCase();
    const appPath = (result.path || '').toLowerCase();
    const isSettingsApp = (appName === '设置' || appName === 'settings') || 
                         appPath.startsWith('shell:appsfolder') || 
                         appPath.startsWith('ms-settings:');
    
    if (isSettingsApp) {
      // Windows 设置应用使用齿轮图标
      const className = size === "horizontal"
        ? `${isSelected ? "w-9 h-9" : "w-7 h-7"} ${isSelected 
            ? (resultStyle === "soft" ? "text-blue-600" : resultStyle === "skeuomorphic" ? "text-[#4a6fa5]" : "text-indigo-600")
            : (resultStyle === "skeuomorphic" ? "text-gray-700" : "text-gray-600")}`
        : `${iconSize} ${theme.iconColor(isSelected, "text-gray-600")}`;
      return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
      );
    }
    
    let iconToUse = result.app?.icon;
    if (!iconToUse && result.path) {
      const matchedApp = apps.find((app) => app.path === result.path);
      if (matchedApp && matchedApp.icon) {
        iconToUse = matchedApp.icon;
      }
    }

    if (iconToUse) {
      return (
        <img
          src={iconToUse}
          alt={result.displayName}
          className={`${iconSize} object-contain`}
          style={{ imageRendering: "auto" as const }}
          onError={(e) => {
            const target = e.target as HTMLImageElement;
            target.style.display = "none";
            const parent = target.parentElement;
            if (parent && !parent.querySelector("svg")) {
              const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
              const fallbackSize = size === "horizontal" 
                ? (isSelected ? "w-7 h-7" : "w-5 h-5")
                : "w-5 h-5";
              const fallbackColor = size === "horizontal"
                ? (isSelected ? "text-white" : "text-gray-500")
                : (isSelected ? "text-white" : "text-gray-500");
              svg.setAttribute("class", `${fallbackSize} ${fallbackColor}`);
              svg.setAttribute("fill", "none");
              svg.setAttribute("stroke", "currentColor");
              svg.setAttribute("viewBox", "0 0 24 24");
              const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
              path.setAttribute("stroke-linecap", "round");
              path.setAttribute("stroke-linejoin", "round");
              path.setAttribute("stroke-width", "2");
              // 根据 size 使用不同的 fallback 图标
              if (size === "horizontal") {
                path.setAttribute("d", "M4 6a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V6z");
              } else {
                path.setAttribute("d", "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z");
              }
              svg.appendChild(path);
              parent.appendChild(svg);
            }
          }}
        />
      );
    } else {
      // 应用类型但没有图标，显示占位图标
      const className = size === "horizontal"
        ? `${isSelected ? "w-7 h-7" : "w-5 h-5"} ${isSelected ? "text-white" : "text-gray-500"}`
        : `w-5 h-5 ${theme.iconColor(isSelected, "text-gray-500")}`;
      return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
      );
    }
  }

  // 处理插件图标
  if (result.type === "plugin" && result.plugin) {
    const className = size === "horizontal"
      ? `${isSelected ? "w-7 h-7" : "w-5 h-5"} ${isSelected 
          ? (resultStyle === "soft" ? "text-blue-600" : resultStyle === "skeuomorphic" ? "text-[#4a6fa5]" : "text-indigo-600")
          : "text-purple-500"}`
      : `w-5 h-5 ${theme.iconColor(isSelected, "text-purple-500")}`;
    return getPluginIcon(result.plugin.id, className);
  }

  // 处理 URL 图标
  if (result.type === "url") {
    return (
      <svg className={`w-5 h-5 ${theme.iconColor(isSelected, "text-blue-500")}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
        />
      </svg>
    );
  }

  // 处理邮箱图标
  if (result.type === "email") {
    return (
      <svg className={`w-5 h-5 ${theme.iconColor(isSelected, "text-green-500")}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
        />
      </svg>
    );
  }

  // 处理备忘录图标
  if (result.type === "memo") {
    return (
      <svg className={`w-5 h-5 ${theme.iconColor(isSelected, "text-purple-500")}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </svg>
    );
  }

  // 处理历史记录图标
  if (result.type === "history") {
    return (
      <svg className={`w-5 h-5 ${theme.iconColor(isSelected, "text-orange-500")}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
        />
      </svg>
    );
  }

  // 处理设置图标
  if (result.type === "settings") {
    const className = size === "horizontal"
      ? `${isSelected ? "w-9 h-9" : "w-7 h-7"} ${isSelected 
          ? (resultStyle === "soft" ? "text-white" : resultStyle === "skeuomorphic" ? "text-white" : "text-indigo-600")
          : (resultStyle === "skeuomorphic" ? "text-gray-700" : "text-gray-600")}`
      : `${iconSize} ${theme.iconColor(isSelected, "text-gray-600")}`;
    return (
      <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
        />
      </svg>
    );
  }

  // 处理 AI 图标
  if (result.type === "ai") {
    return (
      <svg className={`w-5 h-5 ${theme.iconColor(isSelected, "text-blue-500")}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
        />
        <circle cx="9" cy="9" r="1" fill="currentColor" />
        <circle cx="15" cy="9" r="1" fill="currentColor" />
      </svg>
    );
  }

  // 处理 JSON 格式化器图标
  if (result.type === "json_formatter") {
    return (
      <svg className={`w-5 h-5 ${theme.iconColor(isSelected, "text-indigo-500")}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
        />
      </svg>
    );
  }

  // 处理系统文件夹：回收站显示垃圾桶图标
  if (result.type === "system_folder" && result.systemFolder) {
    const folderName = result.systemFolder.name || "";
    // 检查是否是回收站（支持中文和英文名称）
    if (folderName === "回收站" || folderName.toLowerCase().includes("recycle")) {
      return (
        <svg
          className={`${iconSize} ${theme.iconColor(isSelected, "text-gray-600")}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
          />
        </svg>
      );
    }
  }

  // 处理文件夹（系统文件夹、文件历史、Everything 结果）
  const isFolder =
    (result.type === "system_folder" && result.systemFolder?.is_folder) ||
    (result.type === "file" &&
      ((result.file?.is_folder ?? null) !== null ? !!result.file?.is_folder : isFolderLikePath(result.path))) ||
    (result.type === "everything" &&
      ((result.everything?.is_folder ?? null) !== null ? !!result.everything?.is_folder : isFolderLikePath(result.path)));

  if (isFolder) {
    return (
      <svg
        className={`w-5 h-5 ${theme.iconColor(isSelected, "text-amber-500")}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M3 7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
        />
      </svg>
    );
  }

  // 处理文件（file、everything、system_folder 但不是文件夹的情况）
  if (result.type === "file" || result.type === "everything" || result.type === "system_folder") {
    const filePath = result.path || "";
    const isLnkOrExe = filePath.toLowerCase().endsWith(".lnk") || filePath.toLowerCase().endsWith(".exe");
    
    if (isLnkOrExe) {
      // 尝试在应用列表中查找匹配的应用（通过路径匹配）
      const matchedApp = filteredApps.find((app) => app.path === filePath);
      if (matchedApp && matchedApp.icon) {
        return (
          <img
            src={matchedApp.icon}
            alt={result.displayName}
            className="w-8 h-8 object-contain"
            style={{ imageRendering: "auto" as const }}
            onError={(e) => {
              const target = e.target as HTMLImageElement;
              target.style.display = "none";
              const parent = target.parentElement;
              if (parent && !parent.querySelector("svg")) {
                const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                svg.setAttribute("class", `w-5 h-5 ${isSelected ? "text-white" : "text-gray-500"}`);
                svg.setAttribute("fill", "none");
                svg.setAttribute("stroke", "currentColor");
                svg.setAttribute("viewBox", "0 0 24 24");
                const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
                path.setAttribute("stroke-linecap", "round");
                path.setAttribute("stroke-linejoin", "round");
                path.setAttribute("stroke-width", "2");
                path.setAttribute("d", "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z");
                svg.appendChild(path);
                parent.appendChild(svg);
              }
            }}
          />
        );
      }
    }
    
    // 默认显示文档图标
    return (
      <svg className={`w-5 h-5 ${theme.iconColor(isSelected, "text-gray-500")}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </svg>
    );
  }

  // 默认图标
  return (
    <svg className={`w-5 h-5 ${theme.iconColor(isSelected, "text-gray-500")}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

