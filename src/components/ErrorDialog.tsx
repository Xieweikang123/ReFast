import React from "react";

export type DialogType = "error" | "info" | "success" | "warning";

export interface DialogAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "danger" | "secondary";
}

interface ErrorDialogProps {
  isOpen: boolean;
  type?: DialogType;
  title?: string;
  message: string;
  onClose: () => void;
  actions?: DialogAction[];
  /** 覆盖根遮罩层 class（含 z-index），用于需盖过右键菜单等场景 */
  overlayClassName?: string;
  /** 追加到正文容器的 class（如 break-all 等） */
  messageClassName?: string;
}

export function ErrorDialog({
  isOpen,
  type = "error",
  title,
  message,
  onClose,
  actions,
  overlayClassName,
  messageClassName,
}: ErrorDialogProps) {
  if (!isOpen) return null;

  const overlayClass =
    overlayClassName ??
    "fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50";

  // 根据类型设置样式
  const getTypeStyles = () => {
    switch (type) {
      case "error":
        return {
          iconBg: "bg-red-100",
          iconColor: "text-red-600",
          defaultTitle: "错误",
        };
      case "info":
        return {
          iconBg: "bg-blue-100",
          iconColor: "text-blue-600",
          defaultTitle: "提示",
        };
      case "success":
        return {
          iconBg: "bg-green-100",
          iconColor: "text-green-600",
          defaultTitle: "成功",
        };
      case "warning":
        return {
          iconBg: "bg-yellow-100",
          iconColor: "text-yellow-600",
          defaultTitle: "警告",
        };
      default:
        return {
          iconBg: "bg-red-100",
          iconColor: "text-red-600",
          defaultTitle: "错误",
        };
    }
  };

  const getIcon = () => {
    switch (type) {
      case "error":
        return (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
      case "info":
        return (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
      case "success":
        return (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
      case "warning":
        return (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        );
      default:
        return (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
    }
  };

  const styles = getTypeStyles();
  const displayTitle = title || styles.defaultTitle;

  // ESC 键处理
  React.useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.keyCode === 27) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isOpen, onClose]);

  return (
    <div className={overlayClass} onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 max-h-[calc(100vh-32px)] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-full ${styles.iconBg} flex items-center justify-center flex-shrink-0 ${styles.iconColor}`}>
              {getIcon()}
            </div>
            <div className="text-sm font-semibold text-gray-800">{displayTitle}</div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="关闭"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-5 py-4 flex-1 overflow-y-auto">
          <div
            className={`text-sm text-gray-700 whitespace-pre-wrap break-words ${messageClassName ?? ""}`}
          >
            {message}
          </div>
        </div>
        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-3 bg-gray-50 flex-shrink-0">
          {actions && actions.length > 0 ? (
            <>
              {actions.map((action, index) => {
                const getButtonStyle = () => {
                  switch (action.variant) {
                    case "danger":
                      return "px-4 py-2 text-sm rounded-md bg-red-600 text-white hover:bg-red-700 shadow-sm transition-colors";
                    case "secondary":
                      return "px-4 py-2 text-sm rounded-md border border-gray-300 text-gray-700 hover:bg-gray-100 transition-colors";
                    case "primary":
                    default:
                      return "px-4 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 shadow-sm transition-colors";
                  }
                };
                return (
                  <button
                    key={index}
                    onClick={action.onClick}
                    className={getButtonStyle()}
                  >
                    {action.label}
                  </button>
                );
              })}
            </>
          ) : (
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 shadow-sm transition-colors"
            >
              确定
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

