import type {
  AppInfo,
  FileHistoryItem,
  EverythingResult,
  MemoItem,
  ShortcutItem,
  WordRecord,
} from "../types";

// Mock implementation of tauriApi
// This file is used by Vitest to mock the tauri API
export const tauriApi = {
  // Recording APIs
  getRecordingStatus: async () => false,
  startRecording: async () => {},
  stopRecording: async () => "",
  listRecordings: async () => [],
  deleteRecording: async () => {},
  playRecording: async () => {},
  stopPlayback: async () => {},
  getPlaybackStatus: async () => false,
  getPlaybackProgress: async () => 0,

  // Application APIs
  scanApplications: async () => [] as AppInfo[],
  rescanApplications: async () => {},
  testUwpAppsScan: async () => [] as AppInfo[],
  populateAppIcons: async () => [] as AppInfo[],
  searchApplications: async () => [] as AppInfo[],
  searchSystemFolders: async () => [],
  launchApplication: async () => {},
  removeAppFromIndex: async () => {},
  addAppToIndex: async () =>
    ({
      name: "mock",
      path: "C:\\mock.exe",
    }) as AppInfo,
  debugAppIcon: async () => "",
  extractIconFromPath: async () => null as string | null,
  resolveLnkTarget: async (lnkPath: string) => lnkPath,
  testAllIconExtractionMethods: async () => [] as Array<[string, string | null]>,

  // Launcher APIs
  toggleLauncher: async () => {},
  hideLauncher: async () => {},

  // File History APIs
  addFileToHistory: async () => {},
  searchFileHistory: async () => [] as FileHistoryItem[],
  getAllFileHistory: async () => [] as FileHistoryItem[],
  purgeFileHistory: async () => 0,
  deleteFileHistory: async () => {},
  updateFileHistoryName: async () => ({} as FileHistoryItem),
  deleteFileHistoryByRange: async () => 0,
  launchFile: async () => {},
  checkPathExists: async () => null as FileHistoryItem | null,

  // Clipboard APIs
  getClipboardFilePath: async () => null as string | null,
  getClipboardText: async () => null as string | null,
  saveClipboardImage: async () => "",
  writeDebugLog: async () => {},
  pasteTextToCursor: async () => {},
  getDownloadsFolder: async () => "",
  copyFileToDownloads: async () => "",

  // Everything Search APIs
  searchEverything: async () => ({ results: [], totalCount: 0 }),
  startEverythingSearchSession: async () => ({ sessionId: "", totalCount: 0 }),
  getEverythingSearchRange: async () => ({ offset: 0, items: [] as EverythingResult[] }),
  closeEverythingSearchSession: async () => {},
  cancelEverythingSearch: async () => {},
  isEverythingAvailable: async () => false,
  getEverythingStatus: async () => ({ available: false }),
  getEverythingCustomFilters: async () => [],
  saveEverythingCustomFilters: async () => {},
  getIndexStatus: async () => ({ total: 0, indexed: 0 }),
  checkDatabaseHealth: async () => ({ healthy: true }),
  getEverythingPath: async () => null as string | null,
  getEverythingVersion: async () => null as string | null,
  getEverythingLogFilePath: async () => null as string | null,
  openEverythingDownload: async () => {},
  downloadEverything: async () => "",
  startEverything: async () => {},

  // Shortcut APIs
  getAllShortcuts: async () => [] as ShortcutItem[],
  addShortcut: async () => ({} as ShortcutItem),
  updateShortcut: async () => ({} as ShortcutItem),
  deleteShortcut: async () => {},
  showShortcutsConfig: async () => {},

  // Utility APIs
  openUrl: async () => {},
  revealInFolder: async () => {},

  // Memo APIs
  getAllMemos: async () => [] as MemoItem[],
  addMemo: async () => ({} as MemoItem),
  updateMemo: async () => ({} as MemoItem),
  deleteMemo: async () => {},
  searchMemos: async () => [] as MemoItem[],

  // Window APIs
  showMainWindow: async () => {},
  showMemoWindow: async () => {},
  showPluginListWindow: async () => {},
  showJsonFormatterWindow: async () => {},
  takeJsonFormatterContent: async () => null as string | null,
  getJsonFormatterRecentEntries: async () =>
    [] as Array<{ id: string; preview: string; content: string; lastOpened: number }>,
  addJsonFormatterRecentEntry: async () => {},
  removeJsonFormatterRecentEntry: async () => {},
  showFileToolboxWindow: async () => {},
  showCalculatorPadWindow: async () => {},
  takeCalculatorPadExpression: async () => null as string | null,
  showEverythingSearchWindow: async () => {},
  showTranslationWindow: async () => {},
  showHexConverterWindow: async () => {},
  showColorPickerWindow: async () => {},
  pickColorFromScreen: async () => null as string | null,

  // File Replace APIs
  previewFileReplace: async () => ({ results: [], totalMatches: 0, totalFiles: 0 }),
  executeFileReplace: async () => ({ results: [], totalMatches: 0, totalFiles: 0 }),
  selectFolder: async () => null as string | null,

  // Plugin APIs
  recordPluginUsage: async () => ({} as any),
  getPluginUsage: async () => [],
  getPluginDirectory: async () => "",
  scanPluginDirectory: async () => [],
  readPluginManifest: async () => "",

  // Settings APIs
  getSettings: async () => ({
    ollama: { model: "llama2", base_url: "http://localhost:11434" },
  }),
  saveSettings: async () => {},

  // Startup APIs
  isStartupEnabled: async () => false,
  setStartupEnabled: async () => {},

  // Hotkey APIs
  getHotkeyConfig: async () => null,
  saveHotkeyConfig: async () => {},
  showHotkeySettings: async () => {},
  restartApp: async () => {},
  getPluginHotkeys: async () => ({}),
  savePluginHotkeys: async () => {},
  savePluginHotkey: async () => {},
  getAppHotkeys: async () => ({}),
  saveAppHotkey: async () => {},
  getAppCenterHotkey: async () => null,
  saveAppCenterHotkey: async () => {},

  // Version APIs
  getAppVersion: async () => "1.0.0",
  checkUpdate: async () => ({ hasUpdate: false, version: "", downloadUrl: "" }),
  downloadUpdate: async () => "",
  installUpdate: async () => {},
  quitApp: async () => {},

  // Clipboard APIs
  getAllClipboardItems: async () => [],
  addClipboardItem: async () => ({} as any),
  updateClipboardItem: async () => ({} as any),
  toggleFavoriteClipboardItem: async () => ({} as any),
  deleteClipboardItem: async () => {},
  clearClipboardHistory: async () => {},
  searchClipboardItems: async () => [],
  showClipboardWindow: async () => {},
  getClipboardImageData: async () => new Uint8Array(),
  copyImageToClipboard: async () => {},

  // Word Record APIs
  getAllWordRecords: async () => [] as WordRecord[],
  addWordRecord: async () => ({} as WordRecord),
  updateWordRecord: async () => ({} as WordRecord),
  deleteWordRecord: async () => {},
  searchWordRecords: async () => [] as WordRecord[],

  // Open History APIs
  recordOpenHistory: async () => {},
  getOpenHistory: async () => ({}),
  deleteOpenHistory: async () => {},
  getOpenHistoryItem: async () => null,
  updateOpenHistoryRemark: async () => ({} as any),
};
