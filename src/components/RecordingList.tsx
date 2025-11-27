import type { RecordingMeta } from "../types";

interface RecordingListProps {
  recordings: RecordingMeta[];
  onSelect?: (recording: RecordingMeta) => void;
  onDelete?: (recording: RecordingMeta) => void;
}

export const RecordingList: React.FC<RecordingListProps> = ({
  recordings,
  onSelect,
  onDelete,
}) => {
  const formatDuration = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
  };

  if (recordings.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">录制列表</h2>
        <div className="text-gray-500 text-sm">暂无录制文件</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">录制列表</h2>
      <div className="border border-gray-300 rounded divide-y divide-gray-200">
        {recordings.map((rec) => (
          <div
            key={rec.file_path}
            className="p-3 hover:bg-gray-50 flex items-start justify-between group"
          >
            <div
              className="flex-1 cursor-pointer"
              onClick={() => onSelect?.(rec)}
            >
              <div className="font-medium">{rec.file_name}</div>
              <div className="text-sm text-gray-500 mt-1">
                时长: {formatDuration(rec.duration_ms)} | 事件数: {rec.event_count}
              </div>
              <div className="text-xs text-gray-400 mt-1">
                创建时间: {rec.created_at}
              </div>
            </div>
            {onDelete && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`确定要删除录制文件 "${rec.file_name}" 吗？`)) {
                    onDelete(rec);
                  }
                }}
                className="ml-4 px-3 py-1 text-sm text-red-600 hover:text-red-800 hover:bg-red-50 rounded border border-red-300 hover:border-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                title="删除录制"
              >
                删除
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

