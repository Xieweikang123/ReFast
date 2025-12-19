import { invoke } from "@tauri-apps/api/core";
import type {
  RecordingMeta,
  AppInfo,
  FileHistoryItem,
  EverythingSearchResponse,
  EverythingSearchOptions,
  EverythingResult,
  ShortcutItem,
  MemoItem,
  IndexStatus,
  FilePreview,
  DatabaseBackupList,
  PluginUsage,
  UpdateCheckResult,
  DatabaseHealthStatus,
  ClipboardItem,
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

  async rescanApplications(): Promise<void> {
    return invoke("rescan_applications");
  },

  async testUwpAppsScan(): Promise<AppInfo[]> {
    return invoke("test_uwp_apps_scan");
  },


  async populateAppIcons(limit?: number): Promise<AppInfo[]> {
    return invoke("populate_app_icons", { limit });
  },

  async searchApplications(query: string): Promise<AppInfo[]> {
    return invoke("search_applications", { query });
  },

  async searchSystemFolders(query: string): Promise<Array<{ name: string; path: string; display_name: string; is_folder: boolean }>> {
    return invoke("search_system_folders", { query });
  },

  async launchApplication(app: AppInfo): Promise<void> {
    return invoke("launch_application", { app });
  },

  async removeAppFromIndex(appPath: string): Promise<void> {
    return invoke("remove_app_from_index", { appPath });
  },

  async debugAppIcon(appName: string): Promise<string> {
    return invoke("debug_app_icon", { appName });
  },

  async extractIconFromPath(filePath: string): Promise<string | null> {
    return invoke("extract_icon_from_path", { filePath });
  },

  async testAllIconExtractionMethods(filePath: string): Promise<Array<[string, string | null]>> {
    return invoke("test_all_icon_extraction_methods", { filePath });
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

  async purgeFileHistory(days?: number): Promise<number> {
    return invoke("purge_file_history", { days });
  },

  async deleteFileHistory(path: string): Promise<void> {
    return invoke("delete_file_history", { path });
  },

  async updateFileHistoryName(path: string, newName: string): Promise<FileHistoryItem> {
    return invoke("update_file_history_name", { path, newName });
  },

  async deleteFileHistoryByRange(start_ts?: number, end_ts?: number): Promise<number> {
    return invoke("delete_file_history_by_range", { start_ts, end_ts });
  },

  async launchFile(path: string): Promise<void> {
    // 注意：历史记录更新已由统一更新逻辑处理，这里不再更新
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

  async saveClipboardImage(imageData: Uint8Array, extension: string): Promise<string> {
    return invoke("save_clipboard_image", { imageData: Array.from(imageData), extension });
  },

  async writeDebugLog(message: string): Promise<void> {
    return invoke("write_debug_log", { message });
  },

  async pasteTextToCursor(text: string): Promise<void> {
    return invoke("paste_text_to_cursor", { text });
  },

  async getDownloadsFolder(): Promise<string> {
    return invoke("get_downloads_folder");
  },

  async copyFileToDownloads(sourcePath: string): Promise<string> {
    return invoke("copy_file_to_downloads", { sourcePath });
  },

  async searchEverything(
    query: string,
    options?: EverythingSearchOptions
  ): Promise<EverythingSearchResponse> {
    return invoke("search_everything", { query, options });
  },

  async startEverythingSearchSession(
    searchQuery: string,
    opts: {
      extensions?: string[];
      maxResults?: number;
      sortKey?: "modified" | "size" | "type" | "name";
      sortOrder?: "asc" | "desc";
      matchWholeWord?: boolean;
      matchFolderNameOnly?: boolean;
      chunkSize?: number;
    }
  ): Promise<{ sessionId: string; totalCount: number; truncated?: boolean }> {
    return invoke("start_everything_search_session", {
      searchQuery,
      options: opts,
    });
  },

  async getEverythingSearchRange(
    sessionId: string,
    offset: number,
    limit: number,
    opts: {
      sortKey?: "modified" | "size" | "type" | "name";
      sortOrder?: "asc" | "desc";
      extensions?: string[];
      matchWholeWord?: boolean;
      matchFolderNameOnly?: boolean;
    }
  ): Promise<{ offset: number; items: EverythingResult[]; totalCount?: number }> {
    return invoke("get_everything_search_range", {
      sessionId,
      offset,
      limit,
      options: opts,
    });
  },

  async closeEverythingSearchSession(sessionId: string): Promise<void> {
    return invoke("close_everything_search_session", { sessionId });
  },

  async cancelEverythingSearch(): Promise<void> {
    return invoke("cancel_everything_search");
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

  async getEverythingCustomFilters(): Promise<Array<{ id: string; label: string; extensions: string[] }>> {
    return invoke("get_everything_custom_filters");
  },

  async saveEverythingCustomFilters(filters: Array<{ id: string; label: string; extensions: string[] }>): Promise<void> {
    return invoke("save_everything_custom_filters", { filters });
  },

  async getIndexStatus(): Promise<IndexStatus> {
    return invoke("get_index_status");
  },

  async checkDatabaseHealth(): Promise<DatabaseHealthStatus> {
    return invoke("check_database_health");
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

  async backupDatabase(): Promise<string> {
    return invoke("backup_database");
  },

  async getDatabaseBackups(): Promise<DatabaseBackupList> {
    return invoke("list_backups");
  },

  async deleteDatabaseBackup(path: string): Promise<void> {
    return invoke("delete_backup", { path });
  },

  async restoreDatabaseBackup(path: string): Promise<string> {
    return invoke("restore_backup", { path });
  },

  async getFilePreview(path: string): Promise<FilePreview> {
    return invoke("get_file_preview", { path });
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

  async deleteOpenHistory(key: string): Promise<void> {
    return invoke("delete_open_history", { key });
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

  async showCalculatorPadWindow(): Promise<void> {
    return invoke("show_calculator_pad_window");
  },

  async showEverythingSearchWindow(): Promise<void> {
    return invoke("show_everything_search_window");
  },

  async showTranslationWindow(): Promise<void> {
    return invoke("show_translation_window");
  },

  async showHexConverterWindow(): Promise<void> {
    return invoke("show_hex_converter_window");
  },

  async showColorPickerWindow(): Promise<void> {
    return invoke("show_color_picker_window");
  },

  async pickColorFromScreen(): Promise<string | null> {
    return invoke("pick_color_from_screen");
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
  async recordPluginUsage(pluginId: string, name?: string | null): Promise<PluginUsage> {
    return invoke("record_plugin_usage", { pluginId, name });
  },

  async getPluginUsage(): Promise<PluginUsage[]> {
    return invoke("get_plugin_usage");
  },

  async getPluginDirectory(): Promise<string> {
    return invoke("get_plugin_directory");
  },

  async scanPluginDirectory(directory: string): Promise<string[]> {
    return invoke("scan_plugin_directory", { directory });
  },

  async readPluginManifest(pluginDir: string): Promise<string> {
    return invoke("read_plugin_manifest", { pluginDir });
  },


  // Settings APIs
  async getSettings(): Promise<{ ollama: { model: string; base_url: string }; startup_enabled?: boolean; result_style?: "compact" | "soft" | "skeuomorphic"; close_on_blur?: boolean; auto_check_update?: boolean; clipboard_max_items?: number }> {
    return invoke("get_settings");
  },

  async saveSettings(settings: { ollama: { model: string; base_url: string }; startup_enabled?: boolean; result_style?: "compact" | "soft" | "skeuomorphic"; close_on_blur?: boolean; clipboard_max_items?: number }): Promise<void> {
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

  // Hotkey APIs
  async getHotkeyConfig(): Promise<{ modifiers: string[]; key: string } | null> {
    return invoke("get_hotkey_config");
  },

  async saveHotkeyConfig(config: { modifiers: string[]; key: string }): Promise<void> {
    return invoke("save_hotkey_config", { config });
  },

  async showHotkeySettings(): Promise<void> {
    return invoke("show_hotkey_settings");
  },

  async restartApp(): Promise<void> {
    return invoke("restart_app");
  },

  // Plugin hotkey APIs
  async getPluginHotkeys(): Promise<Record<string, { modifiers: string[]; key: string }>> {
    return invoke("get_plugin_hotkeys");
  },

  async savePluginHotkeys(pluginHotkeys: Record<string, { modifiers: string[]; key: string }>): Promise<void> {
    return invoke("save_plugin_hotkeys", { pluginHotkeys });
  },

  async savePluginHotkey(pluginId: string, config: { modifiers: string[]; key: string } | null): Promise<void> {
    return invoke("save_plugin_hotkey", { pluginId, config });
  },

  // App hotkey APIs
  async getAppHotkeys(): Promise<Record<string, { modifiers: string[]; key: string }>> {
    return invoke("get_app_hotkeys");
  },

  async saveAppHotkey(appPath: string, config: { modifiers: string[]; key: string } | null): Promise<void> {
    return invoke("save_app_hotkey", { appPath, config });
  },

  // App center hotkey APIs
  async getAppCenterHotkey(): Promise<{ modifiers: string[]; key: string } | null> {
    return invoke("get_app_center_hotkey");
  },

  async saveAppCenterHotkey(config: { modifiers: string[]; key: string } | null): Promise<void> {
    return invoke("save_app_center_hotkey", { config });
  },

  // App version API
  async getAppVersion(): Promise<string> {
    return invoke("get_app_version");
  },

  // Update check API
  async checkUpdate(): Promise<UpdateCheckResult> {
    return invoke("check_update");
  },

  // Download update API
  async downloadUpdate(downloadUrl: string): Promise<string> {
    return invoke("download_update", { downloadUrl });
  },

  // Install update API
  async installUpdate(installerPath: string): Promise<void> {
    return invoke("install_update", { installerPath });
  },

  // Quit app API
  async quitApp(): Promise<void> {
    return invoke("quit_app");
  },

  // Clipboard APIs
  async getAllClipboardItems(): Promise<ClipboardItem[]> {
    return invoke("get_all_clipboard_items");
  },

  async addClipboardItem(content: string, contentType: string): Promise<ClipboardItem> {
    return invoke("add_clipboard_item", { content, contentType });
  },

  async updateClipboardItem(id: string, content: string): Promise<ClipboardItem> {
    return invoke("update_clipboard_item", { id, content });
  },

  async toggleFavoriteClipboardItem(id: string): Promise<ClipboardItem> {
    return invoke("toggle_favorite_clipboard_item", { id });
  },

  async deleteClipboardItem(id: string): Promise<void> {
    return invoke("delete_clipboard_item", { id });
  },

  async clearClipboardHistory(): Promise<void> {
    return invoke("clear_clipboard_history");
  },

  async searchClipboardItems(query: string): Promise<ClipboardItem[]> {
    return invoke("search_clipboard_items", { query });
  },

  async showClipboardWindow(): Promise<void> {
    return invoke("show_clipboard_window");
  },

  async getClipboardImageData(imagePath: string): Promise<Uint8Array> {
    return invoke("get_clipboard_image_data", { imagePath });
  },

  async copyImageToClipboard(imagePath: string): Promise<void> {
    return invoke("copy_image_to_clipboard", { imagePath });
  },
};

