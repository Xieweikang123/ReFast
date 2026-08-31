import { useEffect, useLayoutEffect, useRef, useState } from "react";

interface RemarkEditModalProps {
  isOpen: boolean;
  editingRemarkUrl: string | null;
  remarkText: string;
  setRemarkText: (text: string) => void;
  onClose: () => void;
  onSave: () => void;
  onContentLayout?: (info: { height: number }) => void;
}

export function RemarkEditModal({
  isOpen,
  editingRemarkUrl,
  remarkText,
  setRemarkText,
  onClose,
  onSave,
  onContentLayout,
}: RemarkEditModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onContentLayoutRef = useRef(onContentLayout);
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);

  onContentLayoutRef.current = onContentLayout;

  useEffect(() => {
    const handleResize = () => {
      setViewportHeight(window.innerHeight);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useLayoutEffect(() => {
    if (!isOpen || !panelRef.current) {
      return;
    }

    const height = panelRef.current.getBoundingClientRect().height;
    onContentLayoutRef.current?.({ height });
  }, [isOpen, editingRemarkUrl, viewportHeight]);

  if (!isOpen || !editingRemarkUrl) return null;

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black bg-opacity-50"
      onClick={onClose}
    >
      <div className="flex min-h-full items-start justify-center px-4 py-6">
        <div
          ref={panelRef}
          className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 className="mb-3 text-base font-semibold">修改备注</h2>
          <div className="mb-3">
            <div className="mb-1 text-xs text-gray-600">URL:</div>
            <div className="mb-3 max-h-20 overflow-y-auto break-all text-xs text-gray-800">
              {editingRemarkUrl}
            </div>
            <label className="mb-1 block text-xs font-medium text-gray-700">
              备注:
            </label>
            <textarea
              value={remarkText}
              onChange={(e) => setRemarkText(e.target.value)}
              className="w-full resize-none rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
              rows={3}
              placeholder="输入备注信息..."
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  onClose();
                } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  onSave();
                }
              }}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-md bg-gray-100 px-3 py-1.5 text-xs text-gray-700 transition-colors hover:bg-gray-200"
            >
              取消
            </button>
            <button
              onClick={onSave}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-blue-700"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
