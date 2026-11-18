/** 备忘录列表空状态 */
export function MemoEmptyState() {
  return (
    <div className="flex h-full min-h-[260px] flex-col items-center justify-center px-6 text-center">
      <div className="relative mb-6">
        <div
          aria-hidden
          className="absolute -inset-4 rounded-full bg-sky-400/15 blur-2xl"
        />
        <div className="relative flex h-20 w-20 items-center justify-center rounded-[1.35rem] border border-sky-200/80 bg-gradient-to-br from-sky-50 via-white to-sky-100/80 text-sky-600 shadow-[0_12px_32px_rgba(14,165,233,0.18),0_0_0_1px_rgba(255,255,255,0.8)_inset]">
          <svg
            width="34"
            height="34"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
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
      </div>
      <div className="text-lg font-bold tracking-tight text-slate-900">
        还没有任何备忘录
      </div>
      <div className="mt-2 max-w-sm text-[13px] leading-relaxed text-slate-500">
        可粘贴图片与文字；笔记保存在「文档\ReFast\memos」。点击上方「新建」开始记录。
      </div>
    </div>
  );
}
