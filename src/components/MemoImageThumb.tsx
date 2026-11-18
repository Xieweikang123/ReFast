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
  size = 48,
  onRemove,
  className = "",
}: MemoImageThumbProps) {
  const { url, loading } = useMemoImageUrl(src);

  return (
    <div
      className={`relative shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-gray-50 shadow-sm ${className}`}
      style={{ width: size, height: size }}
    >
      {/* 浅色内衬：深色截图也不会贴边成一块黑斑 */}
      <div className="absolute inset-[2px] overflow-hidden rounded-md bg-gray-100">
        {loading && (
          <div className="absolute inset-0 flex animate-pulse items-center justify-center bg-gray-100 text-[10px] text-gray-400">
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
            <div className="absolute inset-0 flex items-center justify-center text-[10px] text-gray-400">
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
          className="absolute right-0.5 top-0.5 z-10 h-5 w-5 rounded-full bg-black/55 text-xs leading-5 text-white hover:bg-black/75"
          title="移除图片"
        >
          ×
        </button>
      )}
    </div>
  );
}
