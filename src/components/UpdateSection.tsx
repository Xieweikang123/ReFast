import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import { ReleaseNotesMarkdown } from "./ReleaseNotesMarkdown";
import { tauriApi } from "../api/tauri";
import type { UpdateCheckResult, DownloadProgress } from "../types";
import { formatDateString } from "../utils/dateUtils";

interface UpdateSectionProps {
  currentVersion: string;
}

export function UpdateSection({ currentVersion }: UpdateSectionProps) {
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [autoCheckCompleted, setAutoCheckCompleted] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [ignoredVersion, setIgnoredVersion] = useState<string | null>(null);

  // 页面加载时自动检查更新
  useEffect(() => {
    const autoCheckUpdate = async () => {
      try {
        setIsChecking(true);
        const result = await tauriApi.checkUpdate();
        
        // 检查是否已忽略此版本
        const ignored = localStorage.getItem("ignored_update_version");
        setIgnoredVersion(ignored);
        
        if (ignored === result.latest_version) {
          setUpdateInfo({ ...result, has_update: false });
        } else {
          setUpdateInfo(result);
        }
        
        setAutoCheckCompleted(true);
      } catch (error) {
        console.error("自动检查更新失败:", error);
        setAutoCheckCompleted(true);
      } finally {
        setIsChecking(false);
      }
    };
    
    // 延迟1秒后检查，确保版本号已加载
    const timer = setTimeout(() => {
      autoCheckUpdate();
    }, 1000);
    
    return () => clearTimeout(timer);
  }, []);

  // 监听下载进度
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      unlisten = await listen<DownloadProgress>("download-progress", (event) => {
        setDownloadProgress(event.payload);
      });
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  const handleCheckUpdate = async () => {
    setIsChecking(true);
    setAutoCheckCompleted(false);
    try {
      const result = await tauriApi.checkUpdate();
      
      // 检查是否已忽略此版本
      const ignored = localStorage.getItem("ignored_update_version");
      setIgnoredVersion(ignored);
      
      if (ignored === result.latest_version) {
        setUpdateInfo({ ...result, has_update: false });
      } else {
        setUpdateInfo(result);
      }
      
      setAutoCheckCompleted(true);
    } catch (error) {
      console.error("检查更新失败:", error);
      alert("检查更新失败，请稍后重试或前往 GitHub 查看");
      setAutoCheckCompleted(true);
    } finally {
      setIsChecking(false);
    }
  };

  const handleDownload = async () => {
    if (!updateInfo?.download_url) {
      // 如果没有直接下载链接，打开发布页面
      await tauriApi.openUrl(updateInfo?.release_url || "https://github.com/Xieweikang123/ReFast/releases");
      return;
    }

    try {
      setIsDownloading(true);
      setDownloadProgress(null);

      // 调用后端下载
      const filePath = await tauriApi.downloadUpdate(updateInfo.download_url);
      
      // 下载完成，使用 Tauri 原生对话框询问用户是否立即安装
      const userChoice = await confirm(
        `是否立即安装更新？\n\n点击"是"将启动安装程序并关闭当前应用。\n点击"否"可稍后手动安装。`,
        {
          title: "下载完成",
          kind: "info",
          okLabel: "立即安装",
          cancelLabel: "稍后安装",
        }
      );
      
      if (userChoice) {
        // 用户确认后才执行安装
        try {
          // 先启动安装程序
          await tauriApi.installUpdate(filePath);
          
          // 显示提示信息
          await message("安装程序已启动，应用即将退出。", {
            title: "提示",
            kind: "info",
          });
          
          // 退出应用
          await tauriApi.quitApp();
        } catch (error) {
          console.error("启动安装程序失败:", error);
          await message(`启动安装程序失败: ${error}\n\n已为您打开文件所在目录，请手动运行安装程序。`, {
            title: "错误",
            kind: "error",
          });
          await tauriApi.revealInFolder(filePath);
        }
      } else {
        // 用户选择稍后安装，打开文件所在目录
        await tauriApi.revealInFolder(filePath);
      }
    } catch (error) {
      console.error("下载失败:", error);
      alert(`下载失败: ${error}\n\n请尝试使用浏览器下载或前往 GitHub 手动下载。`);
    } finally {
      setIsDownloading(false);
      setDownloadProgress(null);
    }
  };

  const handleBrowserDownload = async () => {
    // 使用浏览器下载
    if (updateInfo?.download_url) {
      await tauriApi.openUrl(updateInfo.download_url);
    } else {
      await tauriApi.openUrl(updateInfo?.release_url || "https://github.com/Xieweikang123/ReFast/releases");
    }
  };

  const handleOpenReleasePage = async () => {
    await tauriApi.openUrl(updateInfo?.release_url || "https://github.com/Xieweikang123/ReFast/releases");
  };

  const handleIgnoreVersion = () => {
    if (updateInfo) {
      localStorage.setItem("ignored_update_version", updateInfo.latest_version);
      setIgnoredVersion(updateInfo.latest_version);
      setUpdateInfo({ ...updateInfo, has_update: false });
    }
  };

  const handleUnignoreVersion = async () => {
    // 清除忽略的版本
    localStorage.removeItem("ignored_update_version");
    setIgnoredVersion(null);
    // 重新检查更新
    await handleCheckUpdate();
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
    <div className="space-y-4">
      {/* 忽略版本提示 */}
      {ignoredVersion && updateInfo?.latest_version === ignoredVersion && (
        <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 flex-1">
              <div className="text-xl">🔕</div>
              <div className="flex-1">
                <p className="text-sm font-medium text-yellow-800 mb-1">
                  已忽略版本 {ignoredVersion}
                </p>
                <p className="text-xs text-yellow-700">
                  您已选择忽略此版本的更新提醒。如需查看此版本的更新内容，可以点击右侧按钮取消忽略。
                </p>
              </div>
            </div>
            <button
              onClick={handleUnignoreVersion}
              disabled={isChecking}
              className="px-3 py-1.5 text-xs font-medium text-yellow-700 border border-yellow-400 rounded-md hover:bg-yellow-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              取消忽略
            </button>
          </div>
        </div>
      )}

      {/* 更新检查状态提示 */}
      {isChecking && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center gap-3">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
          <span className="text-sm text-blue-700">正在检查更新...</span>
        </div>
      )}

      {/* 有新版本详细信息 */}
      {autoCheckCompleted && updateInfo?.has_update && (
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-300 rounded-lg overflow-hidden">
          {/* 标题栏 */}
          <div className="bg-gradient-to-r from-blue-500 to-blue-600 text-white px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="text-2xl">🚀</div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold">发现新版本</h3>
                <p className="text-sm text-blue-100 mt-1">
                  当前版本: {currentVersion} → 最新版本: {updateInfo.latest_version}
                </p>
              </div>
            </div>
          </div>

          {/* 内容区域 */}
          <div className="px-6 py-4">
            <div className="space-y-4">
              <div>
                <h4 className="font-semibold text-gray-800 mb-2">
                  {updateInfo.release_name || `版本 ${updateInfo.latest_version}`}
                </h4>
                <p className="text-sm text-gray-500">
                  发布时间: {formatDateString(updateInfo.published_at)}
                </p>
              </div>

              {updateInfo.release_notes && (
                <div>
                  <h5 className="text-sm font-medium text-gray-700 mb-2">更新内容:</h5>
                  <div className="bg-white rounded-lg p-4 text-sm text-gray-700 max-h-48 overflow-y-auto border border-gray-200">
                    <ReleaseNotesMarkdown markdown={updateInfo.release_notes} />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 下载进度显示 */}
          {isDownloading && downloadProgress && (
            <div className="border-t border-blue-200 px-6 py-4 bg-blue-50">
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

          {/* 操作按钮 */}
          <div className="border-t border-blue-200 px-6 py-4 bg-gray-50 flex items-center justify-between">
            <button
              onClick={handleIgnoreVersion}
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
      )}

      {/* 已是最新版本提示 */}
      {autoCheckCompleted && updateInfo && !updateInfo.has_update && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="text-xl">✓</div>
            <span className="text-sm text-gray-700">
              当前已是最新版本 ({currentVersion})
            </span>
          </div>
          <button
            onClick={handleCheckUpdate}
            disabled={isChecking}
            className="px-4 py-2 text-sm text-blue-600 hover:text-blue-700 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isChecking ? "检查中..." : "重新检查"}
          </button>
        </div>
      )}

      {/* 手动检查更新按钮（未自动检查时显示） */}
      {!autoCheckCompleted && !isChecking && (
        <button
          onClick={handleCheckUpdate}
          className="w-full px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors text-sm font-medium"
        >
          检查更新
        </button>
      )}
    </div>
  );
}
