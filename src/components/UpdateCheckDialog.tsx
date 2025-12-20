import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { tauriApi } from "../api/tauri";
import type { UpdateCheckResult, DownloadProgress } from "../types";
import { formatDateString } from "../utils/dateUtils";

interface UpdateCheckDialogProps {
  isOpen: boolean;
  onClose: () => void;
  updateInfo: UpdateCheckResult | null;
  onDownload?: () => void;
  onIgnore?: () => void;
}

export function UpdateCheckDialog({
  isOpen,
  onClose,
  updateInfo,
  onDownload,
  onIgnore,
}: UpdateCheckDialogProps) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // 监听下载进度事件
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      unlisten = await listen<DownloadProgress>("download-progress", (event) => {
        setDownloadProgress(event.payload);
      });
    };

    if (isOpen) {
      setupListener();
    }

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [isOpen]);

  if (!isOpen || !updateInfo || !updateInfo.has_update) {
    return null;
  }

  const handleDownload = async () => {
    if (!updateInfo.download_url) {
      // 如果没有直接下载链接，打开发布页面
      await tauriApi.openUrl(updateInfo.release_url);
      return;
    }

    try {
      setIsDownloading(true);
      setDownloadError(null);
      setDownloadProgress(null);

      // 调用后端下载
      const filePath = await tauriApi.downloadUpdate(updateInfo.download_url);
      
      // 下载完成，打开文件所在目录或直接运行安装程序
      alert(`下载完成！\n文件保存在：${filePath}\n\n请手动运行安装程序完成更新。`);
      
      // 打开文件所在目录
      await tauriApi.openUrl(`file://${filePath}`);
      
      if (onDownload) {
        onDownload();
      }
    } catch (error) {
      console.error("下载失败:", error);
      setDownloadError(error as string);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleBrowserDownload = async () => {
    // 使用浏览器下载
    if (updateInfo.download_url) {
      await tauriApi.openUrl(updateInfo.download_url);
    } else {
      await tauriApi.openUrl(updateInfo.release_url);
    }
    if (onDownload) {
      onDownload();
    }
  };

  const handleOpenReleasePage = async () => {
    await tauriApi.openUrl(updateInfo.release_url);
  };

  const handleIgnore = () => {
    if (onIgnore) {
      onIgnore();
    }
    onClose();
  };


  // 格式化字节大小
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="bg-gradient-to-r from-blue-500 to-blue-600 text-white px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="text-2xl">🚀</div>
            <div>
              <h2 className="text-xl font-semibold">发现新版本</h2>
              <p className="text-sm text-blue-100">
                当前版本: {updateInfo.current_version} → 最新版本: {updateInfo.latest_version}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-white hover:bg-blue-700 rounded-full p-1 transition-colors"
            aria-label="关闭"
          >
            <svg
              className="w-6 h-6"
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

        {/* 内容区域 */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold text-gray-800 mb-2">
                {updateInfo.release_name || `版本 ${updateInfo.latest_version}`}
              </h3>
              <p className="text-sm text-gray-500 mb-4">
                发布时间: {formatDateString(updateInfo.published_at)}
              </p>
            </div>

            {updateInfo.release_notes && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-2">更新内容:</h4>
                <div className="bg-gray-50 rounded-lg p-4 text-sm text-gray-700 whitespace-pre-wrap max-h-64 overflow-y-auto">
                  {updateInfo.release_notes}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 下载进度显示 */}
        {isDownloading && downloadProgress && (
          <div className="border-t border-gray-200 px-6 py-4 bg-blue-50">
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-700 font-medium">正在下载更新...</span>
                <span className="text-blue-600 font-semibold">
                  {downloadProgress.percentage.toFixed(1)}%
                </span>
              </div>
              
              {/* 进度条 */}
              <div className="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
                <div
                  className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${downloadProgress.percentage}%` }}
                ></div>
              </div>
              
              <div className="flex items-center justify-between text-xs text-gray-600">
                <span>
                  {formatBytes(downloadProgress.downloaded)} / {formatBytes(downloadProgress.total)}
                </span>
                <span className="text-blue-600 font-medium">{downloadProgress.speed}</span>
              </div>
            </div>
          </div>
        )}

        {/* 下载错误提示 */}
        {downloadError && (
          <div className="border-t border-gray-200 px-6 py-4 bg-red-50">
            <div className="flex items-start gap-2">
              <span className="text-red-600 text-lg">⚠️</span>
              <div className="flex-1">
                <p className="text-sm text-red-800 font-medium mb-1">下载失败</p>
                <p className="text-xs text-red-600">{downloadError}</p>
              </div>
            </div>
          </div>
        )}

        {/* 操作按钮 */}
        <div className="border-t border-gray-200 px-6 py-4 flex items-center justify-between bg-gray-50">
          <button
            onClick={handleIgnore}
            disabled={isDownloading}
            className="px-4 py-2 text-gray-600 hover:text-gray-800 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            忽略此版本
          </button>
          <div className="flex gap-3">
            <button
              onClick={handleOpenReleasePage}
              disabled={isDownloading}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-100 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              查看详情
            </button>
            {updateInfo.download_url && (
              <button
                onClick={handleBrowserDownload}
                disabled={isDownloading}
                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-100 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                浏览器下载
              </button>
            )}
            <button
              onClick={handleDownload}
              disabled={isDownloading}
              className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors text-sm font-medium disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              {isDownloading ? "下载中..." : updateInfo.download_url ? "软件内下载" : "前往下载"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
