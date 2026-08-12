/**
 * 搜索结果列表组件
 * 包含横向和纵向结果列表
 */

import React, { useState, useEffect, useMemo } from "react";
import { ResultIcon } from "./ResultIcon";
import { highlightText, formatLastUsedTime, isLnkPath } from "../utils/launcherUtils";
import { getAppResultTooltip, useLnkTargetTooltip } from "../hooks/useLnkTargetTooltip";
import type { SearchResult } from "../utils/resultUtils";
import type { AppInfo } from "../types";
import type { ResultStyle } from "../utils/themeConfig";
import { getThemeConfig } from "../utils/themeConfig";
import { isMacOS } from "../utils/platformUtils";
import { parseSearchFilter } from "../utils/searchFilterUtils";
import {
  SHOW_MORE_EVERYTHING_PATH,
  type VisibleVerticalItem,
} from "../utils/resultGroupUtils";

/** 将浏览器标识格式化为可读名称 */
function formatBrowserName(browser: string): string {
  const lower = browser.toLowerCase();
  switch (lower) {
    case "edge":
      return "Edge";
    case "chrome":
      return "Chrome";
    case "firefox":
      return "Firefox";
    case "default":
      return "默认";
    default:
      // 自定义路径：显示文件名
      const fileName = lower.split(/[\\/]/).pop();
      return fileName ? fileName.replace(/\.exe$/i, "") : "自定义";
  }
}

export interface ResultListProps {
  horizontalResults: SearchResult[];
  selectedHorizontalIndex: number | null;
  selectedVerticalIndex: number | null;
  query: string;
  resultStyle: ResultStyle;
  apps: AppInfo[];
  filteredApps: AppInfo[];
  launchingAppPath: string | null;
  pastedImagePath: string | null;
  pastedImageDataUrl: string | null;
  openHistory: Record<string, number>;
  urlRemarks: Record<string, string>;
  getPluginIcon: (pluginId: string, className: string) => JSX.Element;
  onLaunch: (result: SearchResult) => Promise<void>;
  onContextMenu: (e: React.MouseEvent, result: SearchResult) => void;
  onSaveImageToDownloads: (path: string) => Promise<void>;
  horizontalScrollContainerRef: React.RefObject<HTMLDivElement>;
  listRef: React.RefObject<HTMLDivElement>;
  isInteractive?: boolean;
  onExpandEverything: () => void;
  visibleVerticalItems: VisibleVerticalItem[];
}

/**
 * 横向结果项组件
 */
const HorizontalResultItem = React.memo<{
  result: SearchResult;
  index: number;
  isSelected: boolean;
  isLaunching: boolean;
  query: string;
  resultStyle: ResultStyle;
  theme: ReturnType<typeof getThemeConfig>;
  apps: AppInfo[];
  filteredApps: AppInfo[];
  getPluginIcon: (pluginId: string, className: string) => JSX.Element;
  onLaunch: (result: SearchResult) => Promise<void>;
  onContextMenu: (e: React.MouseEvent, result: SearchResult) => void;
  isInteractive?: boolean;
}>(({ result, index, isSelected, isLaunching, query, resultStyle, theme, apps, filteredApps, getPluginIcon, onLaunch, onContextMenu, isInteractive = true }) => {
  const { resolvedTarget } = useLnkTargetTooltip(result.path);

  return (
    <div
      key={`executable-${result.path}-${index}`}
      title={getAppResultTooltip(result.path, result.type, resolvedTarget)}
      onMouseDown={async (e) => {
        if (!isInteractive || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        await onLaunch(result);
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onContextMenu={(e) => {
        if (!isInteractive) return;
        onContextMenu(e, result);
      }}
      className={`flex flex-col items-center justify-center gap-1.5 p-2 rounded-xl transition-all duration-200 relative ${
        isInteractive ? "cursor-pointer" : "cursor-default"
      } ${
        isSelected 
          ? resultStyle === "soft"
            ? "bg-blue-50 border-2 border-blue-500 shadow-lg shadow-blue-300/55 ring-2 ring-blue-400/35 scale-[1.2]"
            : resultStyle === "skeuomorphic"
            ? "bg-gradient-to-br from-[#e8f0fb] to-[#dce8f5] border-2 border-[#7a9fd0] shadow-[0_6px_16px_rgba(20,32,50,0.18)] ring-1 ring-[#b8cce8]/80 scale-[1.2]"
            : "bg-indigo-50 border-2 border-indigo-500 shadow-lg shadow-indigo-300/50 ring-2 ring-indigo-400/30 scale-[1.2]"
          : "bg-white hover:bg-gray-50 border border-gray-200 hover:border-gray-300 hover:shadow-md"
      } ${isLaunching ? 'rocket-launching' : ''}`}
      style={{
        '--target-opacity': !isInteractive ? 0.55 : 1,
        animation: isLaunching 
          ? `launchApp 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards` 
          : isInteractive
          ? `fadeInUp 0.35s cubic-bezier(0.16, 1, 0.3, 1) ${index * 0.05}s both`
          : undefined,
        marginLeft: index === 0 && isSelected ? '10px' : '0px',
        width: '80px',
        height: '80px',
        minWidth: '80px',
        minHeight: '80px',
        opacity: !isInteractive ? 0.55 : 1,
        transition: 'opacity 0.2s ease-in-out',
        pointerEvents: !isInteractive ? 'none' : 'auto',
      } as React.CSSProperties}
    >
      {isSelected && (
        <div 
          className={`absolute top-1.5 right-1.5 w-2 h-2 rounded-full ring-2 ring-white/90 shadow-sm ${
            resultStyle === "soft"
              ? "bg-blue-600 shadow-blue-400/50"
              : resultStyle === "skeuomorphic"
              ? "bg-[#4a7fc8] shadow-[#4a7fc8]/40"
              : "bg-indigo-600 shadow-indigo-400/50"
          }`}
        />
      )}
      <div className="flex-shrink-0 flex items-center justify-center">
        <ResultIcon
          result={result}
          isSelected={isSelected}
          theme={theme}
          apps={apps}
          filteredApps={filteredApps}
          resultStyle={resultStyle}
          getPluginIcon={getPluginIcon}
          size="horizontal"
        />
      </div>
      <div 
        className={`text-xs text-center leading-tight ${
          isSelected 
            ? resultStyle === "soft"
              ? "text-blue-700 font-medium"
              : resultStyle === "skeuomorphic"
              ? "text-[#2a3f5f] font-medium"
              : "text-indigo-700 font-medium"
            : "text-gray-700"
        }`}
        style={{ 
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          wordBreak: 'break-word',
          textOverflow: 'ellipsis',
          lineHeight: '1.3',
          maxHeight: '2.4em',
          minHeight: '2.4em',
          width: '65px',
          textAlign: 'center'
        }}
        dangerouslySetInnerHTML={{ __html: highlightText(result.displayName, query) }}
      />
    </div>
  );
});

HorizontalResultItem.displayName = 'HorizontalResultItem';

/**
 * 纵向结果项组件
 */
const VerticalResultItem = React.memo<{
  result: SearchResult;
  index: number;
  verticalIndex: number;
  isSelected: boolean;
  isLaunching: boolean;
  query: string;
  resultStyle: ResultStyle;
  theme: ReturnType<typeof getThemeConfig>;
  apps: AppInfo[];
  filteredApps: AppInfo[];
  pastedImagePath: string | null;
  pastedImageDataUrl: string | null;
  openHistory: Record<string, number>;
  urlRemarks: Record<string, string>;
  getPluginIcon: (pluginId: string, className: string) => JSX.Element;
  onLaunch: (result: SearchResult) => Promise<void>;
  onContextMenu: (e: React.MouseEvent, result: SearchResult) => void;
  onSaveImageToDownloads: (path: string) => Promise<void>;
  isInteractive?: boolean;
}>(({ 
  result, 
  index, 
  verticalIndex, 
  isSelected, 
  isLaunching, 
  query, 
  resultStyle, 
  theme, 
  apps, 
  filteredApps, 
  pastedImagePath,
  pastedImageDataUrl,
  openHistory,
  urlRemarks,
  getPluginIcon, 
  onLaunch, 
  onContextMenu,
  onSaveImageToDownloads,
  isInteractive = true,
}) => {
  const [isMac, setIsMac] = useState(false);
  const isLnk = isLnkPath(result.path);
  const { resolvedTarget, isLoading } = useLnkTargetTooltip(result.path);
  const displayPath =
    isLnk && resolvedTarget ? resolvedTarget : result.path;

  useEffect(() => {
    isMacOS().then(setIsMac);
  }, []);

  return (
    <div
      key={`${result.type}-${result.path}-${index}`}
      data-item-key={`${result.type}-${result.path}-${index}`}
      title={getAppResultTooltip(result.path, result.type, resolvedTarget)}
      onMouseDown={async (e) => {
        if (!isInteractive || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        await onLaunch(result);
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onContextMenu={(e) => {
        if (!isInteractive) return;
        onContextMenu(e, result);
      }}
      className={`${theme.card(isSelected)} ${isLaunching ? 'rocket-launching' : ''} ${isInteractive ? 'cursor-pointer' : 'cursor-default'}`}
      style={{
        opacity: !isInteractive ? 0.55 : 1,
        transition: 'opacity 0.2s ease-in-out',
        pointerEvents: !isInteractive ? 'none' : 'auto',
        animation: isLaunching 
          ? `launchApp 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards` 
          : isInteractive
          ? `fadeInUp 0.35s cubic-bezier(0.16, 1, 0.3, 1) ${index * 0.04}s both`
          : undefined,
      }}
    >
      <div className={theme.indicator(isSelected)} />
      <div className="flex items-center gap-3">
        <div className={theme.indexBadge(isSelected)}>
          {verticalIndex}
        </div>
        <div className={theme.iconWrap(isSelected)}>
          <ResultIcon
            result={result}
            isSelected={isSelected}
            theme={theme}
            apps={apps}
            filteredApps={filteredApps}
            resultStyle={resultStyle}
            getPluginIcon={getPluginIcon}
            size="vertical"
            imagePreviewUrl={
              pastedImagePath && result.path === pastedImagePath
                ? pastedImageDataUrl
                : null
            }
          />
        </div>
        <div className="flex-1 min-w-0">
          <div 
            className={`font-semibold truncate mb-0.5 ${theme.title(isSelected)}`}
            dangerouslySetInnerHTML={{ __html: highlightText(result.displayName, query) }}
          />
          {result.type === "ai" && result.aiAnswer && (
            <div
              className={`text-sm mt-1.5 leading-relaxed ${theme.aiText(isSelected)}`}
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: "200px",
                overflowY: "auto",
              }}
            >
              {result.aiAnswer}
            </div>
          )}
          {result.path && result.type !== "memo" && result.type !== "history" && result.type !== "ai" && (
            <>
              <div
                className={`text-xs truncate mt-0.5 ${theme.pathText(isSelected)}`}
                dangerouslySetInnerHTML={{ __html: highlightText(displayPath, query) }}
              />
              {isLnk && isLoading && !resolvedTarget && (
                <div className={`text-xs mt-0.5 ${theme.metaText(isSelected)}`}>
                  正在解析目标路径...
                </div>
              )}
              {isLnk && resolvedTarget && resolvedTarget !== result.path && (
                <div
                  className={`text-[10px] truncate mt-0.5 ${theme.metaText(isSelected)}`}
                  title={result.path}
                >
                  快捷方式：{result.path}
                </div>
              )}
            </>
          )}
          {result.type === "memo" && result.memo && (
            <div
              className={`text-xs mt-0.5 ${theme.metaText(isSelected)}`}
            >
              {new Date(result.memo.updated_at * 1000).toLocaleDateString("zh-CN")}
            </div>
          )}
          {result.type === "plugin" && result.plugin?.description && (
            <div
              className={`text-xs mt-0.5 leading-relaxed ${theme.descText(isSelected)}`}
              dangerouslySetInnerHTML={{ __html: highlightText(result.plugin.description, query) }}
            />
          )}
          {result.type === "file" && result.file && (() => {
            const lastUsed = (openHistory[result.path] || result.file?.last_used || 0) * 1000;
            const useCount = result.file.use_count || 0;
            
            if (useCount === 0 && lastUsed === 0) {
              return null;
            }
            
            return (
              <div
                className={`text-xs mt-0.5 ${theme.usageText(isSelected)}`}
              >
                {useCount > 0 && `使用 ${useCount} 次`}
                {useCount > 0 && lastUsed > 0 && <span className="mx-1">·</span>}
                {lastUsed > 0 && <span>{formatLastUsedTime(lastUsed)}</span>}
              </div>
            );
          })()}
          {result.type === "file" && result.path === pastedImagePath && (
            <div 
              className="flex items-center gap-2 mt-1.5"
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
              }}
              onMouseDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
              }}
            >
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  await onSaveImageToDownloads(result.path);
                }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                }}
                className="text-xs px-3 py-1.5 rounded-md font-medium transition-all text-white hover:bg-blue-600"
                style={{ backgroundColor: '#3b82f6' }}
                title="保存到下载目录"
              >
                <div className="flex items-center gap-1.5">
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                    />
                  </svg>
                  <span>保存到下载目录</span>
                </div>
              </button>
            </div>
          )}
          {result.type === "url" && (
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              {result.browser ? (
                <span
                  className={`text-xs px-2.5 py-1 rounded-md font-medium transition-all ${theme.tag("url", isSelected)}`}
                  title={`浏览器路由规则：使用 ${formatBrowserName(result.browser)} 打开`}
                >
                  路由 → {formatBrowserName(result.browser)}
                </span>
              ) : (
                <span
                  className={`text-xs px-2.5 py-1 rounded-md font-medium transition-all ${theme.tag("url", isSelected)}`}
                  title="URL 历史记录"
                >
                  URL 历史
                </span>
              )}
              {result.url && urlRemarks[result.url] && (
                <span
                  className={`text-xs px-2 py-1 rounded-md ${theme.metaText(isSelected)} bg-gray-100`}
                  title={`备注: ${urlRemarks[result.url]}`}
                >
                  📝 {urlRemarks[result.url]}
                </span>
              )}
            </div>
          )}
          {result.type === "email" && (
            <div className="flex items-center gap-2 mt-1.5">
              <span
                className={`text-xs px-2.5 py-1 rounded-md font-medium transition-all ${theme.tag("email", isSelected)}`}
                title="可打开的邮箱地址"
              >
                邮箱
              </span>
            </div>
          )}
          {result.type === "json_formatter" && (
            <div className="flex items-center gap-2 mt-1.5">
              <span
                className={`text-xs px-2.5 py-1 rounded-md font-medium transition-all ${theme.tag("json_formatter", isSelected)}`}
                title="JSON 格式化查看器"
              >
                JSON
              </span>
            </div>
          )}
          {result.type === "memo" && result.memo && (
            <div className="flex items-center gap-2 mt-1.5">
              <span
                className={`text-xs px-2.5 py-1 rounded-md font-medium transition-all ${theme.tag("memo", isSelected)}`}
                title="备忘录"
              >
                备忘录
              </span>
              {result.memo.content && (
                <span
                  className={`text-xs truncate ${theme.metaText(isSelected)}`}
                  dangerouslySetInnerHTML={{ 
                    __html: highlightText(
                      result.memo.content.slice(0, 50) + (result.memo.content.length > 50 ? "..." : ""),
                      query
                    )
                  }}
                />
              )}
            </div>
          )}
          {result.type === "everything" && (
            <div className="flex items-center gap-2 mt-1.5">
              <span
                className={`text-xs px-2.5 py-1 rounded-md font-medium transition-all ${theme.tag("everything", isSelected)}`}
                title={isMac ? "来自 Spotlight 搜索结果" : "来自 Everything 搜索结果"}
              >
                {isMac ? "Spotlight" : "Everything"}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

VerticalResultItem.displayName = 'VerticalResultItem';

/**
 * 结果列表组件
 */
export const ResultList = React.memo<ResultListProps>(({
  horizontalResults,
  selectedHorizontalIndex,
  selectedVerticalIndex,
  query,
  resultStyle,
  apps,
  filteredApps,
  launchingAppPath,
  pastedImagePath,
  pastedImageDataUrl,
  openHistory,
  urlRemarks,
  getPluginIcon,
  onLaunch,
  onContextMenu,
  onSaveImageToDownloads,
  horizontalScrollContainerRef,
  listRef,
  isInteractive = true,
  onExpandEverything,
  visibleVerticalItems,
}) => {
  const theme = React.useMemo(() => getThemeConfig(resultStyle), [resultStyle]);
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    isMacOS().then(setIsMac);
  }, []);

  const highlightQuery = useMemo(
    () => parseSearchFilter(query).keyword,
    [query]
  );

  return (
    <div
      ref={listRef}
      className="min-h-0 results-list-scroll py-2"
      style={{ maxHeight: '500px' }}
    >
      <>
        {horizontalResults.length > 0 && (
          <div className="px-4 pt-3 pb-1 mb-2 border-b border-gray-200">
            <div
              ref={horizontalScrollContainerRef}
              className="flex gap-3 executable-scroll-container"
            >
              {horizontalResults.map((result, execIndex) => (
                <HorizontalResultItem
                  key={`executable-${result.path}-${execIndex}`}
                  result={result}
                  index={execIndex}
                  isSelected={selectedHorizontalIndex === execIndex}
                  isLaunching={result.type === "app" && launchingAppPath === result.path}
                  query={highlightQuery}
                  resultStyle={resultStyle}
                  theme={theme}
                  apps={apps}
                  filteredApps={filteredApps}
                  getPluginIcon={getPluginIcon}
                  onLaunch={onLaunch}
                  onContextMenu={onContextMenu}
                  isInteractive={isInteractive}
                />
              ))}
            </div>
          </div>
        )}

        {visibleVerticalItems.map((item, index) => {
          if (item.kind === "show_more") {
            return (
              <div
                key={`${SHOW_MORE_EVERYTHING_PATH}-${index}`}
                data-item-key={`${SHOW_MORE_EVERYTHING_PATH}-${index}`}
                onMouseDown={(e) => {
                  if (!isInteractive || e.button !== 0) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onExpandEverything();
                }}
                className={`mx-3 my-1 px-3 py-2 rounded-lg text-sm text-indigo-600 hover:bg-indigo-50 cursor-pointer border border-dashed ${
                  selectedVerticalIndex === index
                    ? "border-indigo-400 bg-indigo-50"
                    : "border-indigo-200"
                }`}
              >
                显示更多 {isMac ? "Spotlight" : "Everything"} 结果（还有 {item.remaining} 条）
              </div>
            );
          }

          const result = item.result;
          return (
            <VerticalResultItem
              key={`${result.type}-${result.path}-${index}`}
              result={result}
              index={index}
              verticalIndex={index + 1}
              isSelected={selectedVerticalIndex === index}
              isLaunching={result.type === "app" && launchingAppPath === result.path}
              query={highlightQuery}
              resultStyle={resultStyle}
              theme={theme}
              apps={apps}
              filteredApps={filteredApps}
              pastedImagePath={pastedImagePath}
              pastedImageDataUrl={pastedImageDataUrl}
              openHistory={openHistory}
              urlRemarks={urlRemarks}
              getPluginIcon={getPluginIcon}
              onLaunch={onLaunch}
              onContextMenu={onContextMenu}
              onSaveImageToDownloads={onSaveImageToDownloads}
              isInteractive={isInteractive}
            />
          );
        })}
      </>
    </div>
  );
});

ResultList.displayName = 'ResultList';