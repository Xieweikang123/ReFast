import { useMemoImageUrl } from "../hooks/useMemoImageUrl";

interface MemoImageThumbProps {
  src: string;
  size?: number;
  onRemove?: () => void;
  className?: string;
}

/** 备忘录本地图片缩略图 */
export function MemoImageThumb({
  src,
  size = 56,
  onRemove,
  className = "",
}: MemoImageThumbProps) {
  const { url, loading } = useMemoImageUrl(src);

  return (
    <div
      className={`relative shrink-0 overflow-hidden rounded-xl border border-slate-200/90 bg-gradient-to-br from-slate-50 to-slate-100/90 shadow-[0_4px_14px_rgba(15,23,42,0.1),0_0_0_1px_rgba(255,255,255,0.7)_inset] ${className}`}
      style={{ width: size, height: size }}
    >
      {/* 浅色内衬：深色截图也不会贴边成一块黑斑 */}
      <div className="absolute inset-[3px] overflow-hidden rounded-[10px] bg-slate-100 ring-1 ring-black/[0.04]">
        {loading && (
          <div className="absolute inset-0 flex animate-pulse items-center justify-center bg-slate-100 text-[10px] text-slate-400">
            …
          </div>
        )}
        {url ? (
          <img
            src={url}
            alt=""
            className="h-full w-full object-cover object-center"
            draggable={false}
          />
        ) : (
          !loading && (
            <div className="absolute inset-0 flex items-center justify-center text-[10px] font-medium text-slate-400">
              图
            </div>
          )
        )}
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
          className="absolute right-0.5 top-0.5 z-10 h-5 w-5 rounded-full bg-slate-900/70 text-xs leading-5 text-white shadow-sm hover:bg-slate-900/90"
          title="移除图片"
        >
          ×
        </button>
      )}
    </div>
  );
}
