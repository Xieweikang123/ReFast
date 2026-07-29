import type { Plugin, PluginContext } from "../types";
import type { LoadedPlugin, PluginManifest } from "./types";
import { PluginLoader } from "./loader";
import { tauriApi } from "../api/tauri";
import { isMathExpression } from "../utils/launcherUtils";

// 内置插件定义（从旧的 index.ts 迁移）
import { createBuiltinPlugins } from "./builtin";

export class PluginRegistry {
  private loader: PluginLoader;
  private plugins: Map<string, LoadedPlugin> = new Map();
  private builtinPlugins: Plugin[] = [];
  private initialized = false;

  constructor() {
    this.loader = new PluginLoader();
  }

  /**
   * 注册内置插件（向后兼容）
   */
  registerBuiltin(plugin: Plugin): void {
    this.builtinPlugins.push(plugin);
  }

  /**
   * 初始化插件系统
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      console.warn("Plugin registry already initialized");
      return;
    }

    try {
      // 1. 加载内置插件
      const builtinPlugins = createBuiltinPlugins();
      
      // 将内置插件转换为 LoadedPlugin 并注册
      for (const plugin of builtinPlugins) {
        const manifest: PluginManifest = {
          id: plugin.id,
          name: plugin.name,
          version: "1.0.0",
          description: plugin.description,
          keywords: plugin.keywords,
          entry: "./index.ts",
          enabled: true,
        };

        // 根据插件 ID 确定路径
        const pluginPath = this.getBuiltinPluginPath(plugin.id);
        if (pluginPath) {
          try {
            const loadedPlugin = await this.loader.loadPlugin(pluginPath, manifest);
            this.plugins.set(plugin.id, loadedPlugin);
          } catch (error) {
            console.error(`Failed to load builtin plugin ${plugin.id}:`, error);
            // 如果加载失败，使用原始插件对象作为后备
            this.builtinPlugins.push(plugin);
          }
        } else {
          // 如果找不到路径，使用原始插件对象
          this.builtinPlugins.push(plugin);
        }
      }

      // 2. 加载外部插件（如果目录存在）
      try {
        const externalPath = await this.getExternalPluginPath();
        const externalPlugins = await this.loader.loadPluginsFromDirectory(externalPath, false);
        externalPlugins.forEach((plugin) => {
          if (plugin.loaded) {
            this.plugins.set(plugin.id, plugin);
          }
        });
      } catch (error) {
        console.warn("Failed to load external plugins:", error);
      }

      this.initialized = true;
      console.log(`Plugin system initialized: ${this.plugins.size} plugins loaded`);
    } catch (error) {
      console.error("Failed to initialize plugin system:", error);
      throw error;
    }
  }

  /**
   * 获取内置插件路径
   */
  private getBuiltinPluginPath(pluginId: string): string | null {
    const pathMap: Record<string, string> = {
      show_main_window: "plugins/builtin/show_main_window",
      memo_center: "plugins/builtin/memo_center",
      show_plugin_list: "plugins/builtin/show_plugin_list",
      json_formatter: "plugins/builtin/json_formatter",
      calculator_pad: "plugins/builtin/calculator_pad",
      everything_search: "plugins/builtin/everything_search",
    };
    return pathMap[pluginId] || null;
  }

  /**
   * 获取所有插件（包括内置和外部）
   */
  getAllPlugins(): Plugin[] {
    const loadedPlugins = Array.from(this.plugins.values())
      .filter((p) => p.loaded)
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        keywords: p.keywords,
        execute: p.execute,
      }));

    // 合并内置插件和已加载的插件，去重（如果插件已加载，优先使用已加载的版本）
    const pluginMap = new Map<string, Plugin>();
    
    // 先添加内置插件
    for (const plugin of this.builtinPlugins) {
      pluginMap.set(plugin.id, plugin);
    }
    
    // 再添加已加载的插件（会覆盖同名内置插件）
    for (const plugin of loadedPlugins) {
      pluginMap.set(plugin.id, plugin);
    }

    return Array.from(pluginMap.values());
  }

  /**
   * 根据 ID 获取插件
   */
  getPluginById(id: string): Plugin | undefined {
    // 先查找已加载的插件
    const loadedPlugin = this.plugins.get(id);
    if (loadedPlugin && loadedPlugin.loaded) {
      return {
        id: loadedPlugin.id,
        name: loadedPlugin.name,
        description: loadedPlugin.description,
        keywords: loadedPlugin.keywords,
        execute: loadedPlugin.execute,
      };
    }

    // 再查找内置插件
    return this.builtinPlugins.find((p) => p.id === id);
  }

  /**
   * 获取已加载的插件详情（包括元数据）
   */
  getLoadedPluginById(id: string): LoadedPlugin | undefined {
    return this.plugins.get(id);
  }

  /**
   * 搜索插件
   */
  searchPlugins(query: string): Plugin[] {
    const lower = query.toLowerCase();
    const allPlugins = this.getAllPlugins();

    const results = allPlugins.filter(
      (plugin) =>
        plugin.name.toLowerCase().includes(lower) ||
        plugin.description?.toLowerCase().includes(lower) ||
        plugin.keywords.some((keyword) => keyword.toLowerCase().includes(lower))
    );
    
    // 如果输入是数学表达式，自动添加计算稿纸插件
    if (isMathExpression(query)) {
      const calculatorPadPlugin = this.getPluginById("calculator_pad");
      if (calculatorPadPlugin) {
        // 检查是否已经在结果中，避免重复
        const alreadyInResults = results.some(p => p.id === "calculator_pad");
        if (!alreadyInResults) {
          // 将计算稿纸插件添加到结果的最前面
          results.unshift(calculatorPadPlugin);
        }
      }
    }

    return results;
  }

  /**
   * 执行插件
   */
  async executePlugin(
    pluginId: string,
    context: PluginContext
  ): Promise<void> {
    const plugin = this.getPluginById(pluginId);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }

    try {
      await plugin.execute(context);
      void tauriApi
        .recordPluginUsage(pluginId, plugin.name)
        .catch((error: unknown) =>
          console.warn("[PluginUsage] failed to record plugin usage", error)
        );
    } catch (error) {
      console.error(`Failed to execute plugin ${pluginId}:`, error);
      throw error;
    }
  }

  /**
   * 获取外部插件目录路径
   */
  private async getExternalPluginPath(): Promise<string> {
    try {
      const { tauriApi } = await import("../api/tauri");
      return await tauriApi.getPluginDirectory();
    } catch (error) {
      console.warn("Failed to get plugin directory, using fallback:", error);
      // 返回一个默认路径（实际使用时需要确保目录存在）
      return "";
    }
  }

  /**
   * 重新加载插件
   */
  async reloadPlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }

    const reloaded = await this.loader.reloadPlugin(
      pluginId,
      plugin.path,
      plugin.manifest
    );
    this.plugins.set(pluginId, reloaded);
  }

  /**
   * 获取所有已加载插件的详细信息
   */
  getAllLoadedPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }
}

// 单例
export const pluginRegistry = new PluginRegistry();


