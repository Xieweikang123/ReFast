interface MemoListLoadingProps {
  message?: string;
}

/** 列表加载中 */
export function MemoListLoading({
  message = "加载备忘录…",
}: MemoListLoadingProps) {
  return (
    <div className="flex h-full min-h-[220px] flex-col items-center justify-center px-6 text-center">
      <div className="mb-3 h-8 w-8 animate-pulse rounded-full border-2 border-blue-200 border-t-blue-500" />
      <div className="text-sm text-gray-500">{message}</div>
    </div>
  );
}

interface MemoListErrorProps {
  message: string;
  onRetry: () => void;
}

/** 列表加载失败 */
export function MemoListError({ message, onRetry }: MemoListErrorProps) {
  return (
    <div className="flex h-full min-h-[220px] flex-col items-center justify-center px-6 text-center">
      <div className="text-sm font-medium text-red-600">加载失败</div>
      <div className="mt-1.5 max-w-sm text-xs leading-relaxed text-gray-500">
        {message}
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded-lg border border-blue-500 bg-blue-500 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:border-blue-600 hover:bg-blue-600"
      >
        重试
      </button>
    </div>
  );
}

interface MemoListNoMatchProps {
  query: string;
  onClear: () => void;
}

/** 有数据但搜索无结果 */
export function MemoListNoMatch({ query, onClear }: MemoListNoMatchProps) {
  return (
    <div className="flex h-full min-h-[180px] flex-col items-center justify-center px-6 text-center">
      <div className="text-sm font-medium text-gray-700">无匹配备忘录</div>
      <div className="mt-1.5 max-w-xs text-xs leading-relaxed text-gray-500">
        没有找到包含「{query.trim()}」的标题或正文
      </div>
      <button
        type="button"
        onClick={onClear}
        className="mt-3 text-xs font-medium text-blue-600 hover:text-blue-700"
      >
        清除搜索
      </button>
    </div>
  );
}
