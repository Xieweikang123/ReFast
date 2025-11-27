
interface RecordControlsProps {
  isRecording: boolean;
  onStart: () => void;
  onStop: () => void;
}

export const RecordControls: React.FC<RecordControlsProps> = ({
  isRecording,
  onStart,
  onStop,
}) => {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">录制控制</h2>
      <div className="flex gap-2">
        <button
          onClick={onStart}
          disabled={isRecording}
          className={`px-4 py-2 rounded ${
            isRecording
              ? "bg-gray-300 cursor-not-allowed"
              : "bg-red-500 hover:bg-red-600 text-white"
          }`}
        >
          开始录制
        </button>
        <button
          onClick={onStop}
          {...(!isRecording && { disabled: true })}
          className={`px-4 py-2 rounded transition-colors ${
            !isRecording
              ? "bg-gray-300 text-gray-500 cursor-not-allowed opacity-50"
              : "bg-gray-600 hover:bg-gray-700 active:bg-gray-800 text-white cursor-pointer font-medium"
          }`}
        >
          停止录制
        </button>
      </div>
      {isRecording && (
        <div className="flex items-center gap-2 text-red-500">
          <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
          <span>正在录制...</span>
        </div>
      )}
    </div>
  );
};

