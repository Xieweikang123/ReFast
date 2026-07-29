import { pluginRegistry } from "./registry";
import { tauriApi } from "../api/tauri";
import type { Plugin, PluginContext } from "../types";
import { isMathExpression } from "../utils/launcherUtils";

// 向后兼容：导出旧的 API
export let plugins: Plugin[] = [];
export let searchPlugins: (query: string) => Plugin[];
export let getPluginById: (id: string) => Plugin | undefined;
export let executePlugin: (
  pluginId: string,
  context: PluginContext
) => Promise<void>;

// 初始化状态
let initializationPromise: Promise<void> | null = null;

const safeRecordPluginUsage = async (pluginId: string, name?: string) => {
  try {
    await tauriApi.recordPluginUsage(pluginId, name ?? null);
  } catch (error) {
    console.warn("[PluginUsage] record failed", error);
  }
};

/**
 * 初始化插件系统
 * 这个函数应该在应用启动时调用
 */
export async function initializePlugins(): Promise<void> {
  // 如果已经在初始化或已初始化，返回现有的 promise
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    try {
      await pluginRegistry.initialize();

      // 更新导出的函数和变量
      plugins = pluginRegistry.getAllPlugins();
      searchPlugins = (query: string) => pluginRegistry.searchPlugins(query);
      getPluginById = (id: string) => pluginRegistry.getPluginById(id);
      executePlugin = (pluginId: string, context: PluginContext) =>
        pluginRegistry.executePlugin(pluginId, context);

      console.log("Plugins initialized successfully");
    } catch (error) {
      console.error("Failed to initialize plugins:", error);
      // 即使初始化失败，也使用后备实现（使用内置插件）
      // 不要清空 plugins，保持后备实现
      // searchPlugins 等函数已经在文件底部定义为后备实现，不需要重新赋值
      throw error;
    }
  })();

  return initializationPromise;
}

// 导出新的 API
export { pluginRegistry };
export type { LoadedPlugin, PluginManifest } from "./types";

// 如果插件系统还没有初始化，提供一个同步的后备实现
// 这确保了向后兼容性
// 使用同步导入作为后备
import { createBuiltinPlugins } from "./builtin";
const builtinPlugins = createBuiltinPlugins();
plugins = builtinPlugins;
searchPlugins = (query: string) => {
  const lower = query.toLowerCase();
  const results = plugins.filter(
    (plugin) =>
      plugin.name.toLowerCase().includes(lower) ||
      plugin.description?.toLowerCase().includes(lower) ||
      plugin.keywords.some((keyword) => keyword.toLowerCase().includes(lower))
  );

  // 如果输入是数学表达式，自动添加计算稿纸插件
  if (isMathExpression(query)) {
    const calculatorPadPlugin = plugins.find((p) => p.id === "calculator_pad");
    if (calculatorPadPlugin) {
      const alreadyInResults = results.some((p) => p.id === "calculator_pad");
      if (!alreadyInResults) {
        results.unshift(calculatorPadPlugin);
      }
    }
  }

  console.log(`[Plugin Search Fallback] Query: "${query}", Total plugins: ${plugins.length}, Results: ${results.length}`);
  return results;
};
getPluginById = (id: string) => plugins.find((p) => p.id === id);
executePlugin = async (pluginId: string, context: PluginContext) => {
  const plugin = getPluginById(pluginId);
  if (!plugin) {
    console.error(`Plugin not found: ${pluginId}`);
    return;
  }
  try {
    await plugin.execute(context);
    void safeRecordPluginUsage(pluginId, plugin.name);
  } catch (error) {
    console.error(`Failed to execute plugin ${pluginId}:`, error);
  }
};
