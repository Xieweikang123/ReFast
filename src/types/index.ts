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
}

export interface FileHistoryItem {
  path: string;
  name: string;
  last_used: number;
  use_count: number;
}

export interface EverythingResult {
  path: string;
  name: string;
  size?: number;
  date_modified?: string;
}

export interface EverythingSearchResponse {
  results: EverythingResult[];
  total_count: number;
}

export interface ShortcutItem {
  id: string;
  name: string;
  path: string;
  icon?: string;
  created_at: number;
  updated_at: number;
}

