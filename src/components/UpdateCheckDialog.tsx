import { tauriApi } from "../api/tauri";
import type { UpdateCheckResult } from "../types";

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
  if (!isOpen || !updateInfo || !updateInfo.has_update) {
    return null;
  }

  const handleDownload = async () => {
    if (updateInfo.download_url) {
      // 直接打开下载链接
      await tauriApi.openUrl(updateInfo.download_url);
    } else {
      // 如果没有直接下载链接，打开发布页面
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

  // 格式化日期
  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch {
      return dateString;
    }
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
                发布时间: {formatDate(updateInfo.published_at)}
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

        {/* 操作按钮 */}
        <div className="border-t border-gray-200 px-6 py-4 flex items-center justify-between bg-gray-50">
          <button
            onClick={handleIgnore}
            className="px-4 py-2 text-gray-600 hover:text-gray-800 transition-colors text-sm"
          >
            忽略此版本
          </button>
          <div className="flex gap-3">
            <button
              onClick={handleOpenReleasePage}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-100 transition-colors text-sm"
            >
              查看详情
            </button>
            <button
              onClick={handleDownload}
              className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors text-sm font-medium"
            >
              {updateInfo.download_url ? "立即下载" : "前往下载"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
