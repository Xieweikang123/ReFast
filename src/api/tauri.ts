import { invoke } from "@tauri-apps/api/core";
import type { RecordingMeta } from "../types";

export const tauriApi = {
  async startRecording(): Promise<void> {
    return invoke("start_recording");
  },

  async stopRecording(): Promise<string> {
    return invoke("stop_recording");
  },

  async listRecordings(): Promise<RecordingMeta[]> {
    return invoke("list_recordings");
  },

  async deleteRecording(path: string): Promise<void> {
    return invoke("delete_recording", { path });
  },

  async playRecording(path: string, speed: number): Promise<void> {
    return invoke("play_recording", { path, speed });
  },

  async stopPlayback(): Promise<void> {
    return invoke("stop_playback");
  },

  async getPlaybackProgress(): Promise<number> {
    return invoke("get_playback_progress");
  },
};

