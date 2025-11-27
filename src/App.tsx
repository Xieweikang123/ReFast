import { useState, useEffect } from "react";
import { RecordControls } from "./components/RecordControls";
import { PlaybackControls } from "./components/PlaybackControls";
import { RecordingList } from "./components/RecordingList";
import { StatusBar } from "./components/StatusBar";
import { tauriApi } from "./api/tauri";
import type { AppStatus, RecordingMeta } from "./types";

function App() {
  const [status, setStatus] = useState<AppStatus>("idle");
  const [message, setMessage] = useState<string>("");
  const [progress, setProgress] = useState<number>(0);
  const [recordings, setRecordings] = useState<RecordingMeta[]>([]);
  const [selectedRecordingPath, setSelectedRecordingPath] = useState<string>("");

  useEffect(() => {
    loadRecordings();
    // Sync recording status on app start
    syncRecordingStatus();
  }, []);

  const syncRecordingStatus = async () => {
    try {
      const isRecording = await tauriApi.getRecordingStatus();
      if (isRecording && status !== "recording") {
        setStatus("recording");
        setMessage("检测到正在录制中...");
      }
    } catch (error) {
      console.error("Failed to sync recording status:", error);
    }
  };

  // Poll playback progress when playing
  useEffect(() => {
    if (status !== "playing") {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const progress = await tauriApi.getPlaybackProgress();
        setProgress(progress);
        
        // If progress is 100%, stop polling
        if (progress >= 100) {
          setStatus("idle");
          setMessage("回放已完成");
        }
      } catch (error) {
        console.error("Failed to get playback progress:", error);
      }
    }, 100); // Update every 100ms

    return () => clearInterval(interval);
  }, [status]);

  const loadRecordings = async () => {
    try {
      const list = await tauriApi.listRecordings();
      setRecordings(list);
    } catch (error) {
      console.error("Failed to load recordings:", error);
      setMessage(`加载录制列表失败: ${error}`);
    }
  };

  const handleStartRecording = async () => {
    try {
      await tauriApi.startRecording();
      setStatus("recording");
      setMessage("录制已开始");
    } catch (error) {
      setMessage(`开始录制失败: ${error}`);
      console.error("Failed to start recording:", error);
    }
  };

  const handleStopRecording = async () => {
    try {
      const path = await tauriApi.stopRecording();
      setStatus("idle");
      setMessage(`录制已保存: ${path}`);
      await loadRecordings();
    } catch (error) {
      setMessage(`停止录制失败: ${error}`);
      console.error("Failed to stop recording:", error);
    }
  };

  const handlePlayRecording = async (path: string, speed: number) => {
    try {
      await tauriApi.playRecording(path, speed);
      setStatus("playing");
      setMessage(`正在回放: ${path} (${speed}x)`);
      setProgress(0);
    } catch (error) {
      setMessage(`开始回放失败: ${error}`);
      console.error("Failed to play recording:", error);
    }
  };

  const handleStopPlayback = async () => {
    try {
      await tauriApi.stopPlayback();
      setStatus("idle");
      setMessage("回放已停止");
      setProgress(0);
    } catch (error) {
      setMessage(`停止回放失败: ${error}`);
      console.error("Failed to stop playback:", error);
    }
  };

  const handleSelectRecording = (recording: RecordingMeta) => {
    // Auto-select in playback controls
    setSelectedRecordingPath(recording.file_path);
  };

  const handleDeleteRecording = async (recording: RecordingMeta) => {
    try {
      await tauriApi.deleteRecording(recording.file_path);
      setMessage(`已删除录制: ${recording.file_name}`);
      // Reload recordings list
      await loadRecordings();
      // Clear selection if deleted recording was selected
      if (selectedRecordingPath === recording.file_path) {
        setSelectedRecordingPath("");
      }
    } catch (error) {
      setMessage(`删除录制失败: ${error}`);
      console.error("Failed to delete recording:", error);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-white">
      <header className="border-b border-gray-300 p-4 bg-gray-50">
        <h1 className="text-2xl font-bold">Input Macro Recorder</h1>
      </header>

      <main className="flex-1 overflow-auto p-4 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <RecordControls
            isRecording={status === "recording"}
            onStart={handleStartRecording}
            onStop={handleStopRecording}
          />
          <PlaybackControls
            isPlaying={status === "playing"}
            recordings={recordings}
            selectedPath={selectedRecordingPath}
            onSelectPath={setSelectedRecordingPath}
            onPlay={handlePlayRecording}
            onStop={handleStopPlayback}
          />
        </div>

        <RecordingList
          recordings={recordings}
          onSelect={handleSelectRecording}
          onDelete={handleDeleteRecording}
        />
      </main>

      <StatusBar
        status={status}
        message={message}
        progress={status === "playing" ? progress : undefined}
      />
    </div>
  );
}

export default App;

