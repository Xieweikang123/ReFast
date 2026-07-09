import React, { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ResultList } from "./ResultList";
import type {
  AppInfo,
  EverythingResult
} from "../types";
import type { SearchResult } from "../utils/resultUtils";
import type { ResultStyle } from "../utils/themeConfig";
import type { SearchStatusDetail } from "../hooks/useResultsInteractivity";
import { isMacOS } from "../utils/platformUtils";

interface SearchResultAreaProps {
  showAiAnswer: boolean;
  isAiLoading: boolean;
  aiAnswer: string | null;
  setAiAnswer: (val: string | null) => void;
  setShowAiAnswer: (val: boolean) => void;
  results: SearchResult[];
  query: string;
  isSearchingEverything: boolean;
  isEverythingAvailable: boolean;
  everythingTotalCount: number | null;
  everythingCurrentCount: number;
  everythingVersion: string | null;
  everythingResults: EverythingResult[];
  listRef: React.RefObject<HTMLDivElement>;
  horizontalResults: SearchResult[];
  verticalResults: SearchResult[];
  selectedHorizontalIndex: number | null;
  selectedVerticalIndex: number | null;
  resultStyle: ResultStyle;
  apps: AppInfo[];
  filteredApps: AppInfo[];
  launchingAppPath: string | null;
  pastedImagePath: string | null;
  openHistory: Record<string, number>;
  urlRemarks: Record<string, string>;
  getPluginIcon: (id: string, className: string) => JSX.Element;
  handleLaunch: (result: SearchResult) => Promise<void>;
  handleContextMenu: (e: React.MouseEvent, result: SearchResult) => void;
  handleSaveImageToDownloads: (path: string) => Promise<void>;
  horizontalScrollContainerRef: React.RefObject<HTMLDivElement>;
  isInteractive: boolean;
  isSearching: boolean;
  searchStatus: SearchStatusDetail;
}

export function SearchResultArea({
  showAiAnswer,
  isAiLoading,
  aiAnswer,
  setAiAnswer,
  setShowAiAnswer,
  results,
  query,
  isSearchingEverything,
  isEverythingAvailable,
  everythingTotalCount,
  everythingCurrentCount,
  everythingVersion,
  everythingResults,
  listRef,
  horizontalResults,
  verticalResults,
  selectedHorizontalIndex,
  selectedVerticalIndex,
  resultStyle,
  apps,
  filteredApps,
  launchingAppPath,
  pastedImagePath,
  openHistory,
  urlRemarks,
  getPluginIcon,
  handleLaunch,
  handleContextMenu,
  handleSaveImageToDownloads,
  horizontalScrollContainerRef,
  isInteractive,
  isSearching,
  searchStatus,
}: SearchResultAreaProps) {
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    isMacOS().then(setIsMac);
  }, []);

  const renderSearchStatusBanner = () => (
    <div className="mx-4 mt-2 mb-0 flex flex-col gap-1 rounded-lg border border-blue-100 bg-blue-50/90 px-3 py-1.5 text-xs text-blue-700">
      <div className="flex items-center gap-2">
        <div className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600" />
        <span className="font-medium">{searchStatus.primary}</span>
      </div>
      {searchStatus.items.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pl-5">
          {searchStatus.items.map((item) => (
            <span
              key={item}
              className="rounded-md bg-blue-100/80 px-1.5 py-0.5 text-[11px] text-blue-700"
            >
              {item}
            </span>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {showAiAnswer ? (
        // AI 回答模式
        <div className="flex-1 overflow-y-auto min-h-0" style={{ maxHeight: '500px' }}>
          <div className="px-6 py-4">
            {isAiLoading && !aiAnswer ? (
              // 只在完全没有内容时显示加载状态
              <div className="flex items-center justify-center py-12">
                <div className="flex flex-col items-center gap-3">
                  <svg
                    className="w-8 h-8 text-blue-500 animate-spin"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                  <div className="text-gray-600">AI 正在思考中...</div>
                </div>
              </div>
            ) : aiAnswer ? (
              // 显示 AI 回答（包括流式接收中的内容）
              <div className="bg-white rounded-lg border border-gray-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <svg
                      className="w-5 h-5 text-blue-500"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                      />
                      <circle cx="9" cy="9" r="1" fill="currentColor"/>
                      <circle cx="15" cy="9" r="1" fill="currentColor"/>
                    </svg>
                    <h3 className="text-lg font-semibold text-gray-800">AI 回答</h3>
                    {isAiLoading && (
                      <svg
                        className="w-4 h-4 text-blue-500 animate-spin ml-2"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                        />
                      </svg>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      setShowAiAnswer(false);
                      setAiAnswer(null);
                    }}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                    title="返回搜索结果"
                  >
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
                <div className="text-gray-700 break-words leading-relaxed prose prose-sm max-w-none">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      // 自定义样式
                      p: ({ children }: any) => <p className="mb-3 last:mb-0">{children}</p>,
                      h1: ({ children }: any) => <h1 className="text-2xl font-bold mb-3 mt-4 first:mt-0">{children}</h1>,
                      h2: ({ children }: any) => <h2 className="text-xl font-bold mb-2 mt-4 first:mt-0">{children}</h2>,
                      h3: ({ children }: any) => <h3 className="text-lg font-semibold mb-2 mt-3 first:mt-0">{children}</h3>,
                      ul: ({ children }: any) => <ul className="list-disc list-inside mb-3 space-y-1">{children}</ul>,
                      ol: ({ children }: any) => <ol className="list-decimal list-inside mb-3 space-y-1">{children}</ol>,
                      li: ({ children }: any) => <li className="ml-2">{children}</li>,
                      code: ({ inline, children }: any) => 
                        inline ? (
                          <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono">{children}</code>
                        ) : (
                          <code className="block bg-gray-100 p-3 rounded text-sm font-mono overflow-x-auto mb-3">{children}</code>
                        ),
                      pre: ({ children }: any) => <pre className="mb-3">{children}</pre>,
                      blockquote: ({ children }: any) => (
                        <blockquote className="border-l-4 border-gray-300 pl-4 italic my-3">{children}</blockquote>
                      ),
                      table: ({ children }: any) => (
                        <div className="overflow-x-auto mb-3">
                          <table className="min-w-full border-collapse border border-gray-300">
                            {children}
                          </table>
                        </div>
                      ),
                      thead: ({ children }: any) => <thead className="bg-gray-100">{children}</thead>,
                      tbody: ({ children }: any) => <tbody>{children}</tbody>,
                      tr: ({ children }: any) => <tr className="border-b border-gray-200">{children}</tr>,
                      th: ({ children }: any) => (
                        <th className="border border-gray-300 px-3 py-2 text-left font-semibold">
                          {children}
                        </th>
                      ),
                      td: ({ children }: any) => (
                        <td className="border border-gray-300 px-3 py-2">{children}</td>
                      ),
                      strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
                      em: ({ children }: any) => <em className="italic">{children}</em>,
                      a: ({ href, children }: any) => (
                        <a href={href} className="text-blue-600 hover:underline" target="_blank" rel="noopener noreferrer">
                          {children}
                        </a>
                      ),
                      hr: () => <hr className="my-4 border-gray-300" />,
                    }}
                  >
                    {aiAnswer || ""}
                  </ReactMarkdown>
                  {isAiLoading && (
                    <span className="inline-block w-2 h-4 bg-blue-500 animate-pulse ml-1 align-middle" />
                  )}
                </div>
              </div>
            ) : (
              <div className="text-center py-12 text-gray-500">
                暂无 AI 回答
              </div>
            )}
          </div>
        </div>
      ) : (isSearchingEverything && results.length === 0 && query.trim()) ? (
        // 骨架屏：搜索中时显示，模拟结果列表样式
        <div
          ref={listRef}
          className="flex-1 min-h-0 results-list-scroll"
          style={{ maxHeight: '500px' }}
        >
          {Array.from({ length: 8 }).map((_, index) => {
            // 为每个骨架项生成固定的宽度，避免每次渲染都变化
            const titleWidth = 60 + (index % 4) * 8;
            const pathWidth = 40 + (index % 3) * 6;
            return (
              <div
                key={`skeleton-${index}`}
                className="px-6 py-3"
              >
                <div className="flex items-center gap-3">
                  {/* 序号骨架 */}
                  <div className="text-sm font-medium flex-shrink-0 w-8 text-center text-gray-300">
                    {index + 1}
                  </div>
                  {/* 图标骨架 */}
                  <div className="w-8 h-8 rounded bg-gray-200 animate-pulse flex-shrink-0" />
                  {/* 内容骨架 */}
                  <div className="flex-1 min-w-0">
                    <div 
                      className="h-4 bg-gray-200 rounded animate-pulse mb-2" 
                      style={{ width: `${titleWidth}%` }} 
                    />
                    <div 
                      className="h-3 bg-gray-100 rounded animate-pulse" 
                      style={{ width: `${pathWidth}%` }} 
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : results.length > 0 ? (
        <div className="relative flex-1 min-h-0 flex flex-col">
          {isSearching && renderSearchStatusBanner()}
          <ResultList
            horizontalResults={horizontalResults}
            verticalResults={verticalResults}
            selectedHorizontalIndex={selectedHorizontalIndex}
            selectedVerticalIndex={selectedVerticalIndex}
            query={query}
            resultStyle={resultStyle}
            apps={apps}
            filteredApps={filteredApps}
            launchingAppPath={launchingAppPath}
            pastedImagePath={pastedImagePath}
            openHistory={openHistory}
            urlRemarks={urlRemarks}
            getPluginIcon={getPluginIcon}
            onLaunch={handleLaunch}
            onContextMenu={handleContextMenu}
            onSaveImageToDownloads={handleSaveImageToDownloads}
            horizontalScrollContainerRef={horizontalScrollContainerRef}
            listRef={listRef}
            isInteractive={isInteractive}
          />
        </div>
      ) : null}

      {/* Loading or Empty State */}
      {!showAiAnswer && results.length === 0 && query && !isSearching && (
        <div className="px-6 py-8 text-center text-gray-500 flex-1 flex items-center justify-center">
          未找到匹配的应用或文件
        </div>
      )}

      {!showAiAnswer && results.length === 0 && query && isSearching && (
        <div className="px-6 py-8 text-center text-gray-500 flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 max-w-sm">
            <div className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-gray-200 border-t-blue-500" />
            <div className="text-sm font-medium text-gray-700">{searchStatus.primary}</div>
            {searchStatus.items.length > 0 && (
              <div className="flex flex-wrap justify-center gap-1.5">
                {searchStatus.items.map((item) => (
                  <span
                    key={item}
                    className="rounded-md bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                  >
                    {item}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Everything Search Status */}
      {!showAiAnswer && query.trim() && isEverythingAvailable && (
        <div className="px-6 py-2 border-t border-gray-200 bg-gray-50">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs text-gray-600">
              <div className="flex items-center gap-2">
                {isSearchingEverything ? (
                  <>
                    <div className="inline-block animate-spin rounded-full h-3 w-3 border-b-2 border-blue-500"></div>
                    <span className="text-blue-600">Everything 搜索中...</span>
                  </>
                ) : (
                  <>
                    <svg className="w-3 h-3 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    <span>
                      {isMac ? "Spotlight" : "Everything"}: {everythingTotalCount !== null
                        ? `${everythingResults.length.toLocaleString()}/${everythingTotalCount.toLocaleString()}`
                        : everythingResults.length > 0
                        ? `${everythingResults.length.toLocaleString()}/?`
                        : "无结果"}
                    </span>
                  </>
                )}
              </div>
              {everythingVersion && (
                <div className="text-gray-500 text-xs">
                  {isMac ? "macOS" : `v${everythingVersion}`}
                </div>
              )}
            </div>
            
            {/* 流式加载进度条 */}
            {isSearchingEverything && everythingTotalCount !== null && everythingTotalCount > 0 && (
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>
                    已加载 {everythingCurrentCount.toLocaleString()} / {everythingTotalCount.toLocaleString()} 条
                  </span>
                  <span className="font-medium text-blue-600">
                    {Math.round((everythingCurrentCount / everythingTotalCount) * 100)}%
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-1.5 overflow-hidden">
                  <div
                    className="bg-blue-500 h-1.5 rounded-full transition-all duration-300 ease-out"
                    style={{
                      width: `${Math.min((everythingCurrentCount / everythingTotalCount) * 100, 100)}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {!showAiAnswer && results.length === 0 && !query && (
        <div className="px-6 py-8 text-center text-gray-400 text-sm flex-1 flex items-center justify-center">
          输入关键词搜索应用，或粘贴文件路径
        </div>
      )}
    </div>
  );
}
