export enum EventType {
  MouseMove = "MouseMove",
  MouseDown = "MouseDown",
  MouseUp = "MouseUp",
  MouseWheel = "MouseWheel",
  KeyDown = "KeyDown",
  KeyUp = "KeyUp",
}

export enum MouseButton {
  Left = "Left",
  Right = "Right",
  Middle = "Middle",
}

export interface RecordedEvent {
  event_type: EventType;
  x?: number;
  y?: number;
  time_offset_ms: number;
}

export interface RecordingMeta {
  file_path: string;
  file_name: string;
  duration_ms: number;
  event_count: number;
  created_at: string;
}

export type AppStatus = "idle" | "recording" | "playing";

export interface AppInfo {
  name: string;
  path: string;
  icon?: string;
  description?: string;
  name_pinyin?: string; // 拼音全拼（用于拼音搜索）
  name_pinyin_initials?: string; // 拼音首字母（用于拼音首字母搜索）
}

export interface FileHistoryItem {
  path: string;
  name: string;
  last_used: number;
  use_count: number;
  is_folder?: boolean | null; // 是否为文件夹
  source?: string | null; // 数据来源: "file_history" 或 "open_history"
}

export interface EverythingResult {
  path: string;
  name: string;
  size?: number;
  date_modified?: string;
  // 是否为文件夹（包括磁盘、根目录等目录类型）
  is_folder?: boolean | null;
}

export interface EverythingSearchResponse {
  results: EverythingResult[];
  total_count: number;
}

export interface EverythingSearchOptions {
  extensions?: string[];
  excludeExtensions?: string[];
  onlyFiles?: boolean;
  onlyFolders?: boolean;
  maxResults?: number;
  matchWholeWord?: boolean;
  matchFolderNameOnly?: boolean;
}

export interface IndexEverythingStatus {
  available: boolean;
  error?: string | null;
  version?: string | null;
  path?: string | null;
}

export interface IndexApplicationsStatus {
  total: number;
  cache_file?: string | null;
  cache_mtime?: number | null;
}

export interface IndexFileHistoryStatus {
  total: number;
  path?: string | null;
  mtime?: number | null;
}

export interface IndexStatus {
  everything: IndexEverythingStatus;
  applications: IndexApplicationsStatus;
  file_history: IndexFileHistoryStatus;
}

export interface DatabaseBackupInfo {
  name: string;
  path: string;
  size: number;
  modified?: number | null;
}

export interface DatabaseBackupList {
  dir: string;
  items: DatabaseBackupInfo[];
}

export type FilePreviewKind =
  | "text"
  | "image"
  | "media"
  | "binary"
  | "folder"
  | "unsupported"
  | "error";

export interface FilePreviewMetadata {
  duration_ms?: number;
  width?: number;
  height?: number;
}

export interface FilePreview {
  kind: FilePreviewKind;
  size?: number;
  modified?: string;
  extension?: string;
  mime?: string;
  content?: string;
  imageDataUrl?: string;
  truncated?: boolean;
  metadata?: FilePreviewMetadata;
  error?: string;
}


export interface ShortcutItem {
  id: string;
  name: string;
  path: string;
  icon?: string;
  created_at: number;
  updated_at: number;
}

export interface MemoItem {
  id: string;
  title: string;
  content: string;
  created_at: number;
  updated_at: number;
}

// 插件系统类型定义
export interface PluginContext {
  // 可以传递给插件执行函数的上下文信息
  query?: string; // 当前搜索查询内容
  setQuery: (query: string) => void;
  setSelectedIndex: (index: number) => void;
  hideLauncher: () => Promise<void>;
  // 备忘录相关状态设置函数
  setIsMemoModalOpen?: (open: boolean) => void;
  setIsMemoListMode?: (mode: boolean) => void;
  setSelectedMemo?: (memo: MemoItem | null) => void;
  setMemoEditTitle?: (title: string) => void;
  setMemoEditContent?: (content: string) => void;
  setIsEditingMemo?: (editing: boolean) => void;
  setMemos?: (memos: MemoItem[]) => void;
  // 插件列表相关状态
  setIsPluginListModalOpen?: (open: boolean) => void;
  // Tauri API
  tauriApi?: any;
}

export interface Plugin {
  id: string;
  name: string;
  description?: string;
  keywords: string[];
  // 执行函数：插件被触发时调用
  execute: (context: PluginContext) => Promise<void> | void;
}

export interface PluginUsage {
  pluginId: string;
  name?: string | null;
  openCount: number;
  lastOpened: number;
}

export interface UpdateCheckResult {
  has_update: boolean;
  current_version: string;
  latest_version: string;
  release_url: string;
  release_name: string;
  release_notes: string;
  download_url: string | null;
  published_at: string;
}

export interface DownloadProgress {
  downloaded: number;
  total: number;
  percentage: number;
  speed: string;
}

export interface DatabaseHealthStatus {
  accessible: boolean;
  error_message?: string | null;
  db_path?: string | null;
  db_size_bytes?: number | null;
  file_history_count?: number | null;
  shortcuts_count?: number | null;
  memos_count?: number | null;
}

export interface ClipboardItem {
  id: string;
  content: string;
  content_type: string; // "text", "image", "file"
  created_at: number;
  is_favorite: boolean;
}

