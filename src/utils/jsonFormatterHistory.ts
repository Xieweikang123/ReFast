import { tauriApi } from "../api/tauri";

export interface RecentJsonEntry {
  id: string;
  preview: string;
  content: string;
  lastOpened: number;
}

export async function getRecentJsonEntries(): Promise<RecentJsonEntry[]> {
  try {
    return await tauriApi.getJsonFormatterRecentEntries();
  } catch (error) {
    console.error("读取 JSON 最近记录失败:", error);
    return [];
  }
}

export async function addRecentJsonEntry(content: string): Promise<void> {
  try {
    await tauriApi.addJsonFormatterRecentEntry(content);
  } catch (error) {
    console.warn("保存 JSON 最近记录失败:", error);
  }
}

export async function removeRecentJsonEntry(id: string): Promise<void> {
  try {
    await tauriApi.removeJsonFormatterRecentEntry(id);
  } catch (error) {
    console.error("删除 JSON 最近记录失败:", error);
  }
}
