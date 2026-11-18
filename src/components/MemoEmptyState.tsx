/** 备忘录列表空状态 */
export function MemoEmptyState() {
  return (
    <div className="flex h-full min-h-[220px] flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-blue-100 bg-blue-50 text-blue-500 shadow-sm">
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M8 13h8" />
          <path d="M8 17h5" />
        </svg>
      </div>
      <div className="text-sm font-medium text-gray-700">还没有任何备忘录</div>
      <div className="mt-1.5 max-w-xs text-xs leading-relaxed text-gray-500">
        可粘贴图片与文字；笔记保存在「文档\ReFast\memos」。点击上方「新建」开始记录。
      </div>
    </div>
  );
}
