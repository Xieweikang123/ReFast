import type { Plugin, PluginContext } from "../../types";
import { tauriApi } from "../../../api/tauri";
import manifest from "./manifest.json";

export const recordingPlugin: Plugin = {
  id: manifest.id,
  name: manifest.name,
  description: manifest.description,
  keywords: manifest.keywords,
  execute: async (context: PluginContext) => {
    // 打开录制回放窗口
    await tauriApi.showMainWindow();
    // 关闭启动器
    await context.hideLauncher();
    // 清空搜索内容
    context.setQuery("");
    context.setSelectedIndex(0);
  },
};
