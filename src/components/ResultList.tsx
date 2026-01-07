/**
 * 搜索结果列表组件
 * 包含横向和纵向结果列表
 */

import React from "react";
import { ResultIcon } from "./ResultIcon";
import { highlightText, formatLastUsedTime } from "../utils/launcherUtils";
import type { SearchResult } from "../utils/resultUtils";
import type { AppInfo } from "../types";
import type { ResultStyle } from "../utils/themeConfig";
import { getThemeConfig } from "../utils/themeConfig";

export interface ResultListProps {
  horizontalResults: SearchResult[];
  verticalResults: SearchResult[];
  selectedHorizontalIndex: number | null;
  selectedVerticalIndex: number | null;
  query: string;
  resultStyle: ResultStyle;
  apps: AppInfo[];
  filteredApps: AppInfo[];
  launchingAppPath: string | null;
  pastedImagePath: string | null;
  openHistory: Record<string, number>;
  urlRemarks: Record<string, string>;
  getPluginIcon: (pluginId: string, className: string) => JSX.Element;
  onLaunch: (result: SearchResult) => Promise<void>;
  onContextMenu: (e: React.MouseEvent, result: SearchResult) => void;
  onSaveImageToDownloads: (path: string) => Promise<void>;
  horizontalScrollContainerRef: React.RefObject<HTMLDivElement>;
  listRef: React.RefObject<HTMLDivElement>;
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
}>(({ result, index, isSelected, isLaunching, query, resultStyle, theme, apps, filteredApps, getPluginIcon, onLaunch, onContextMenu }) => {
  return (
    <div
      key={`executable-${result.path}-${index}`}
      onMouseDown={async (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        await onLaunch(result);
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onContextMenu={(e) => onContextMenu(e, result)}
      className={`flex flex-col items-center justify-center gap-1.5 p-2 rounded-xl cursor-pointer transition-all duration-200 relative ${
        isSelected 
          ? resultStyle === "soft"
            ? "bg-blue-50 border-2 border-blue-400 shadow-md shadow-blue-200/50 scale-[1.2]"
            : resultStyle === "skeuomorphic"
            ? "bg-gradient-to-br from-[#f0f5fb] to-[#e5edf9] border-2 border-[#a8c0e0] shadow-[0_4px_12px_rgba(20,32,50,0.12)] scale-[1.2]"
            : "bg-indigo-50 border-2 border-indigo-400 shadow-md shadow-indigo-200/50 scale-[1.2]"
          : "bg-white hover:bg-gray-50 border border-gray-200 hover:border-gray-300 hover:shadow-md"
      } ${isLaunching ? 'rocket-launching' : ''}`}
      style={{
        animation: isLaunching 
          ? `launchApp 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards` 
          : `fadeInUp 0.35s cubic-bezier(0.16, 1, 0.3, 1) ${index * 0.04}s both`,
        marginLeft: index === 0 && isSelected ? '10px' : '0px',
        width: '80px',
        height: '80px',
        minWidth: '80px',
        minHeight: '80px',
      }}
      title={result.type === "app" ? result.path : undefined}
    >
      {isSelected && (
        <div 
          className={`absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full ${
            resultStyle === "soft"
              ? "bg-blue-500"
              : resultStyle === "skeuomorphic"
              ? "bg-[#6b8fc4]"
              : "bg-indigo-500"
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
  openHistory: Record<string, number>;
  urlRemarks: Record<string, string>;
  getPluginIcon: (pluginId: string, className: string) => JSX.Element;
  onLaunch: (result: SearchResult) => Promise<void>;
  onContextMenu: (e: React.MouseEvent, result: SearchResult) => void;
  onSaveImageToDownloads: (path: string) => Promise<void>;
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
  openHistory,
  urlRemarks,
  getPluginIcon, 
  onLaunch, 
  onContextMenu,
  onSaveImageToDownloads,
}) => {
  return (
    <div
      key={`${result.type}-${result.path}-${index}`}
      data-item-key={`${result.type}-${result.path}-${index}`}
      onMouseDown={async (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        await onLaunch(result);
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onContextMenu={(e) => onContextMenu(e, result)}
      className={`${theme.card(isSelected)} ${isLaunching ? 'rocket-launching' : ''}`}
      style={{
        animation: isLaunching 
          ? `launchApp 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards` 
          : `fadeInUp 0.35s cubic-bezier(0.16, 1, 0.3, 1) ${index * 0.04}s both`,
      }}
      title={result.type === "app" ? result.path : undefined}
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
            <div
              className={`text-xs truncate mt-0.5 ${theme.pathText(isSelected)}`}
              dangerouslySetInnerHTML={{ __html: highlightText(result.path, query) }}
            />
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
              <span
                className={`text-xs px-2.5 py-1 rounded-md font-medium transition-all ${theme.tag("url", isSelected)}`}
                title="URL 历史记录"
              >
                URL 历史
              </span>
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
                title="来自 Everything 搜索结果"
              >
                Everything
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
  verticalResults,
  selectedHorizontalIndex,
  selectedVerticalIndex,
  query,
  resultStyle,
  apps,
  filteredApps,
  launchingAppPath,
  pastedImagePath,
  openHistory,
  urlRemarks,
  getPluginIcon,
  onLaunch,
  onContextMenu,
  onSaveImageToDownloads,
  horizontalScrollContainerRef,
  listRef,
}) => {
  const theme = React.useMemo(() => getThemeConfig(resultStyle), [resultStyle]);

  return (
    <div
      ref={listRef}
      className="flex-1 min-h-0 results-list-scroll py-2"
      style={{ maxHeight: '500px' }}
    >
      <>
        {/* 可执行文件和插件横向排列在第一行 */}
        {horizontalResults.length > 0 && (
          <div className="px-4 py-3 mb-2 border-b border-gray-200">
            <div
              ref={horizontalScrollContainerRef}
              className="flex gap-3 pb-2 executable-scroll-container"
            >
              {horizontalResults.map((result, execIndex) => (
                <HorizontalResultItem
                  key={`executable-${result.path}-${execIndex}`}
                  result={result}
                  index={execIndex}
                  isSelected={selectedHorizontalIndex === execIndex}
                  isLaunching={result.type === "app" && launchingAppPath === result.path}
                  query={query}
                  resultStyle={resultStyle}
                  theme={theme}
                  apps={apps}
                  filteredApps={filteredApps}
                  getPluginIcon={getPluginIcon}
                  onLaunch={onLaunch}
                  onContextMenu={onContextMenu}
                />
              ))}
            </div>
          </div>
        )}
        {/* 其他结果垂直排列 */}
        {verticalResults.map((result, index) => {
          const verticalIndex = index + 1;
          return (
            <VerticalResultItem
              key={`${result.type}-${result.path}-${index}`}
              result={result}
              index={index}
              verticalIndex={verticalIndex}
              isSelected={selectedVerticalIndex === index}
              isLaunching={result.type === "app" && launchingAppPath === result.path}
              query={query}
              resultStyle={resultStyle}
              theme={theme}
              apps={apps}
              filteredApps={filteredApps}
              pastedImagePath={pastedImagePath}
              openHistory={openHistory}
              urlRemarks={urlRemarks}
              getPluginIcon={getPluginIcon}
              onLaunch={onLaunch}
              onContextMenu={onContextMenu}
              onSaveImageToDownloads={onSaveImageToDownloads}
            />
          );
        })}
      </>
    </div>
  );
});

ResultList.displayName = 'ResultList';

