import { invoke } from "@tauri-apps/api/core";
import type {
  RecordingMeta,
  AppInfo,
  FileHistoryItem,
  EverythingSearchResponse,
  ShortcutItem,
  MemoItem,
  SystemFolderItem,
} from "../types";

export const tauriApi = {
  async getRecordingStatus(): Promise<boolean> {
    return invoke("get_recording_status");
  },

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

  async getPlaybackStatus(): Promise<boolean> {
    return invoke("get_playback_status");
  },

  async getPlaybackProgress(): Promise<number> {
    return invoke("get_playback_progress");
  },

  async scanApplications(): Promise<AppInfo[]> {
    return invoke("scan_applications");
  },

  async rescanApplications(): Promise<AppInfo[]> {
    return invoke("rescan_applications");
  },

  async searchApplications(query: string): Promise<AppInfo[]> {
    return invoke("search_applications", { query });
  },

  async launchApplication(app: AppInfo): Promise<void> {
    return invoke("launch_application", { app });
  },

  async toggleLauncher(): Promise<void> {
    return invoke("toggle_launcher");
  },

  async hideLauncher(): Promise<void> {
    return invoke("hide_launcher");
  },

  async addFileToHistory(path: string): Promise<void> {
    return invoke("add_file_to_history", { path });
  },

  async searchFileHistory(query: string): Promise<FileHistoryItem[]> {
    return invoke("search_file_history", { query });
  },

  async getAllFileHistory(): Promise<FileHistoryItem[]> {
    return invoke("get_all_file_history");
  },

  async deleteFileHistory(path: string): Promise<void> {
    return invoke("delete_file_history", { path });
  },

  async updateFileHistoryName(path: string, newName: string): Promise<FileHistoryItem> {
    return invoke("update_file_history_name", { path, newName });
  },

  async launchFile(path: string): Promise<void> {
    return invoke("launch_file", { path });
  },

  async checkPathExists(path: string): Promise<FileHistoryItem | null> {
    return invoke("check_path_exists", { path });
  },

  async getClipboardFilePath(): Promise<string | null> {
    return invoke("get_clipboard_file_path");
  },

  async getClipboardText(): Promise<string | null> {
    return invoke("get_clipboard_text");
  },

  async searchEverything(query: string): Promise<EverythingSearchResponse> {
    return invoke("search_everything", { query });
  },

  async isEverythingAvailable(): Promise<boolean> {
    return invoke("is_everything_available");
  },

  async getEverythingStatus(): Promise<{ available: boolean; error?: string }> {
    const result = await invoke<[boolean, string | null]>("get_everything_status");
    return {
      available: result[0],
      error: result[1] || undefined,
    };
  },

  async getEverythingPath(): Promise<string | null> {
    return invoke("get_everything_path");
  },

  async getEverythingVersion(): Promise<string | null> {
    return invoke("get_everything_version");
  },

  async getEverythingLogFilePath(): Promise<string | null> {
    return invoke("get_everything_log_file_path");
  },

  async openEverythingDownload(): Promise<void> {
    return invoke("open_everything_download");
  },

  async downloadEverything(): Promise<string> {
    return invoke("download_everything");
  },


  async startEverything(): Promise<void> {
    return invoke("start_everything");
  },

  async getAllShortcuts(): Promise<ShortcutItem[]> {
    return invoke("get_all_shortcuts");
  },

  async addShortcut(name: string, path: string, icon?: string): Promise<ShortcutItem> {
    return invoke("add_shortcut", { name, path, icon });
  },

  async updateShortcut(
    id: string,
    name?: string,
    path?: string,
    icon?: string
  ): Promise<ShortcutItem> {
    return invoke("update_shortcut", { id, name, path, icon });
  },

  async deleteShortcut(id: string): Promise<void> {
    return invoke("delete_shortcut", { id });
  },

  async showShortcutsConfig(): Promise<void> {
    return invoke("show_shortcuts_config");
  },

  async openUrl(url: string): Promise<void> {
    return invoke("open_url", { url });
  },

  async revealInFolder(path: string): Promise<void> {
    return invoke("reveal_in_folder", { path });
  },

  // Memo APIs
  async getAllMemos(): Promise<MemoItem[]> {
    return invoke("get_all_memos");
  },

  async addMemo(title: string, content: string): Promise<MemoItem> {
    return invoke("add_memo", { title, content });
  },

  async updateMemo(
    id: string,
    title?: string,
    content?: string
  ): Promise<MemoItem> {
    return invoke("update_memo", { id, title, content });
  },

  async deleteMemo(id: string): Promise<void> {
    return invoke("delete_memo", { id });
  },

  async searchMemos(query: string): Promise<MemoItem[]> {
    return invoke("search_memos", { query });
  },

  async showMainWindow(): Promise<void> {
    return invoke("show_main_window");
  },

  // Open history APIs
  async recordOpenHistory(key: string): Promise<void> {
    return invoke("record_open_history", { key });
  },

  async getOpenHistory(): Promise<Record<string, number>> {
    return invoke("get_open_history");
  },

  async showMemoWindow(): Promise<void> {
    return invoke("show_memo_window");
  },

  async showPluginListWindow(): Promise<void> {
    return invoke("show_plugin_list_window");
  },

  async showJsonFormatterWindow(): Promise<void> {
    return invoke("show_json_formatter_window");
  },

  async showFileToolboxWindow(): Promise<void> {
    return invoke("show_file_toolbox_window");
  },

  async previewFileReplace(params: {
    folderPath: string;
    searchText: string;
    replaceText: string;
    fileExtensions: string[];
    useRegex: boolean;
    caseSensitive: boolean;
    backupFolder: boolean;
    replaceFileName: boolean;
  }): Promise<{
    results: Array<{
      filePath: string;
      matches: number;
      success: boolean;
      error?: string;
    }>;
    totalMatches: number;
    totalFiles: number;
  }> {
    return invoke("preview_file_replace", {
      folderPath: params.folderPath,
      searchText: params.searchText,
      replaceText: params.replaceText,
      fileExtensions: params.fileExtensions,
      useRegex: params.useRegex,
      caseSensitive: params.caseSensitive,
      backupFolder: params.backupFolder,
      replaceFileName: params.replaceFileName,
    });
  },

  async executeFileReplace(params: {
    folderPath: string;
    searchText: string;
    replaceText: string;
    fileExtensions: string[];
    useRegex: boolean;
    caseSensitive: boolean;
    backupFolder: boolean;
    replaceFileName: boolean;
  }): Promise<{
    results: Array<{
      filePath: string;
      matches: number;
      success: boolean;
      error?: string;
    }>;
    totalMatches: number;
    totalFiles: number;
  }> {
    return invoke("execute_file_replace", {
      folderPath: params.folderPath,
      searchText: params.searchText,
      replaceText: params.replaceText,
      fileExtensions: params.fileExtensions,
      useRegex: params.useRegex,
      caseSensitive: params.caseSensitive,
      backupFolder: params.backupFolder,
      replaceFileName: params.replaceFileName,
    });
  },

  async selectFolder(): Promise<string | null> {
    return invoke("select_folder");
  },

  // Plugin APIs
  async getPluginDirectory(): Promise<string> {
    return invoke("get_plugin_directory");
  },

  async scanPluginDirectory(directory: string): Promise<string[]> {
    return invoke("scan_plugin_directory", { directory });
  },

  async readPluginManifest(pluginDir: string): Promise<string> {
    return invoke("read_plugin_manifest", { pluginDir });
  },

  async searchSystemFolders(query: string): Promise<SystemFolderItem[]> {
    return invoke("search_system_folders", { query });
  },

  // Settings APIs
  async getSettings(): Promise<{ ollama: { model: string; base_url: string }; startup_enabled?: boolean }> {
    return invoke("get_settings");
  },

  async saveSettings(settings: { ollama: { model: string; base_url: string }; startup_enabled?: boolean }): Promise<void> {
    return invoke("save_settings", { settings });
  },

  async showSettingsWindow(): Promise<void> {
    return invoke("show_settings_window");
  },

  // Startup APIs
  async isStartupEnabled(): Promise<boolean> {
    return invoke("is_startup_enabled");
  },

  async setStartupEnabled(enabled: boolean): Promise<void> {
    return invoke("set_startup_enabled", { enabled });
  },
};

