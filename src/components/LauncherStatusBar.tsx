/**
 * Launcher 状态栏组件
 * 显示搜索结果数量、Everything 状态、更新提示等信息
 */

import React from "react";
import type { UpdateCheckResult } from "../types";
import { tauriApi } from "../api/tauri";

export interface LauncherStatusBarProps {
  resultsCount: number;
  showAiAnswer: boolean;
  isEverythingAvailable: boolean;
  everythingError: string | null;
  everythingPath: string | null;
  everythingVersion: string | null;
  isDownloadingEverything: boolean;
  everythingDownloadProgress: number;
  updateInfo?: UpdateCheckResult | null;
  onStartEverything: () => Promise<void>;
  onDownloadEverything: () => Promise<void>;
  onCheckAgain: () => Promise<void>;
  downloadButtonRef: React.RefObject<HTMLButtonElement>;
}

export const LauncherStatusBar = React.memo<LauncherStatusBarProps>(({
  resultsCount,
  showAiAnswer,
  isEverythingAvailable,
  everythingError,
  everythingPath,
  everythingVersion,
  isDownloadingEverything,
  everythingDownloadProgress,
  updateInfo,
  onStartEverything,
  onDownloadEverything,
  onCheckAgain,
  downloadButtonRef,
}) => {
  const handleUpdateClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      console.log("点击更新提示，准备打开应用中心窗口");
      // 设置标志，让应用中心窗口加载时自动跳转到关于页面
      localStorage.setItem("appcenter:open-to-about", "true");
      // 先隐藏启动器
      await tauriApi.hideLauncher();
      console.log("启动器已隐藏");
      // 打开独立的应用中心窗口
      await tauriApi.showPluginListWindow();
      console.log("应用中心窗口已打开");
    } catch (error) {
      console.error("Failed to open app center window:", error);
    }
  };

  return (
    <div 
      className="px-6 py-2 border-t border-gray-100 text-xs text-gray-400 flex justify-between items-center bg-gray-50/50 flex-shrink-0 gap-2 min-w-0"
      onMouseDown={(e) => {
        // 阻止 footer 区域的点击事件被 header 的拖动处理器捕获
        const target = e.target as HTMLElement;
        const isButton = target.tagName === 'BUTTON' || target.closest('button');
        const isUpdateNotice = target.closest('[data-update-notice]');
        if (isButton || isUpdateNotice) {
          // 如果是按钮或更新提示，阻止事件冒泡到 header，让其自己的 onClick 处理
          e.stopPropagation();
        }
      }}
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {!showAiAnswer && resultsCount > 0 && <span className="whitespace-nowrap">{resultsCount} 个结果</span>}
        {showAiAnswer && <span className="whitespace-nowrap">AI 回答模式</span>}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div 
            className="flex items-center gap-1.5 cursor-help whitespace-nowrap" 
            title={everythingPath ? `Everything 路径: ${everythingPath}` : 'Everything 未安装或未在 PATH 中'}
          >
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isEverythingAvailable ? 'bg-emerald-500' : 'bg-gray-300'}`}></div>
            <span className={`text-xs ${isEverythingAvailable ? 'text-emerald-600' : 'text-gray-500'}`}>
              {isEverythingAvailable ? 'Everything 已启用' : (
                everythingError?.startsWith("NOT_INSTALLED") 
                  ? 'Everything 未安装' 
                  : everythingError?.startsWith("SERVICE_NOT_RUNNING")
                  ? 'Everything 服务未运行'
                  : 'Everything 未检测到'
              )}
            </span>
            {everythingError && !isEverythingAvailable && !everythingError.startsWith("NOT_INSTALLED") && !everythingError.startsWith("SERVICE_NOT_RUNNING") && (
              <span className="text-xs text-red-500 ml-2 whitespace-nowrap" title={everythingError}>
                ({everythingError.split(':')[0]})
              </span>
            )}
          </div>
          {!isEverythingAvailable && (
            <div className="flex items-center gap-2 flex-shrink-0">
              {everythingError && everythingError.startsWith("SERVICE_NOT_RUNNING") && (
                <button
                  onClick={onStartEverything}
                  className="px-2 py-1 text-xs bg-green-500 text-white rounded hover:bg-green-600 transition-colors whitespace-nowrap"
                  title="启动 Everything"
                >
                  启动
                </button>
              )}
              {(!everythingError || !everythingError.startsWith("SERVICE_NOT_RUNNING")) && (
                <button
                  ref={downloadButtonRef}
                  onPointerDown={() => {}}
                  onClick={(e) => {
                    if (!isDownloadingEverything) {
                      e.preventDefault();
                      e.stopPropagation();
                      onDownloadEverything().catch(() => {
                        // Error handled
                      });
                    }
                  }}
                  disabled={isDownloadingEverything}
                  className={`px-2 py-1 text-xs rounded transition-colors whitespace-nowrap ${
                    isDownloadingEverything
                      ? 'bg-gray-400 text-white cursor-not-allowed'
                      : 'bg-blue-500 text-white hover:bg-blue-600'
                  }`}
                  style={{ pointerEvents: 'auto', zIndex: 1000, position: 'relative' }}
                  title="下载并安装 Everything"
                  data-testid="download-everything-button"
                >
                  {isDownloadingEverything ? `下载中 ${everythingDownloadProgress}%` : '下载'}
                </button>
              )}
              <button
                onClick={(e) => {
                  console.log("[Everything刷新] onClick 触发");
                  e.preventDefault();
                  e.stopPropagation();
                  console.log("[Everything刷新] 调用 handleCheckAgain");
                  onCheckAgain().catch((error) => {
                    console.error("[Everything刷新] handleCheckAgain 抛出错误:", error);
                  });
                }}
                className="px-2 py-1 text-xs bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors whitespace-nowrap"
                title="重新检测 Everything"
              >
                刷新
              </button>
            </div>
          )}
          {/* 更新提示 - 放在按钮后面 */}
          {updateInfo?.has_update && (
            <div 
              data-update-notice
              className="flex items-center gap-1.5 cursor-pointer whitespace-nowrap hover:opacity-80 transition-opacity" 
              title={`发现新版本 ${updateInfo.latest_version}，点击查看详情`}
              onClick={handleUpdateClick}
            >
              <div className="w-2 h-2 rounded-full flex-shrink-0 bg-orange-500 animate-pulse"></div>
              <span className="text-xs text-orange-600 font-medium">
                发现新版本 {updateInfo.latest_version}
              </span>
            </div>
          )}
        </div>
      </div>
      {!showAiAnswer && resultsCount > 0 && (
        <span className="whitespace-nowrap flex-shrink-0">↑↓ 选择 · Enter 打开 · Esc 关闭</span>
      )}
      {showAiAnswer && (
        <span className="whitespace-nowrap flex-shrink-0">Esc 返回搜索结果</span>
      )}
    </div>
  );
});

LauncherStatusBar.displayName = 'LauncherStatusBar';

