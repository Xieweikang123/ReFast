import type { PluginManifest, LoadedPlugin } from "./types";
import type { Plugin } from "../types";

export class PluginLoader {
  private loadedPlugins = new Map<string, LoadedPlugin>();

  /**
   * 从插件目录加载插件（使用动态导入）
   */
  async loadPlugin(pluginPath: string, manifest: PluginManifest): Promise<LoadedPlugin> {
    try {
      // 验证 manifest
      this.validateManifest(manifest);

      // 动态导入插件入口文件
      // 注意：pluginPath 应该是相对于 src 的路径，例如 "plugins/builtin/show_main_window"
      const entryPath = `${pluginPath}/${manifest.entry.replace(/^\.\//, "")}`.replace(/\.ts$/, "");
      
      let pluginModule: any;
      try {
        // 对于内置插件，使用已知的导入映射
        if (pluginPath.startsWith("plugins/builtin/")) {
          pluginModule = await this.importBuiltinPlugin(manifest.id);
        } else {
          // 外部插件使用动态导入
          pluginModule = await import(/* @vite-ignore */ `../${entryPath}`);
        }
      } catch (importError) {
        // 如果导入失败，尝试其他路径格式
        console.warn(`Failed to import plugin from ${entryPath}, trying alternative path`, importError);
        const altPath = entryPath.replace(/\.ts$/, "");
        pluginModule = await import(/* @vite-ignore */ `../${altPath}`);
      }
      
      // 获取插件导出（支持多种导出方式）
      const pluginExport = pluginModule.default || pluginModule.plugin || pluginModule;
      
      if (typeof pluginExport !== "function" && !pluginExport.execute) {
        throw new Error(`Plugin ${manifest.id} must export a function or an object with execute method`);
      }

      // 创建插件对象
      const plugin: Plugin = typeof pluginExport === "function"
        ? {
            id: manifest.id,
            name: manifest.name,
            description: manifest.description,
            keywords: manifest.keywords,
            execute: pluginExport,
          }
        : {
            id: manifest.id,
            name: manifest.name,
            description: manifest.description,
            keywords: manifest.keywords,
            execute: pluginExport.execute,
          };

      // 创建 LoadedPlugin
      const loadedPlugin: LoadedPlugin = {
        ...plugin,
        manifest,
        path: pluginPath,
        loaded: true,
      };

      this.loadedPlugins.set(manifest.id, loadedPlugin);
      return loadedPlugin;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Failed to load plugin from ${pluginPath}:`, error);
      
      // 返回一个错误状态的插件
      const errorPlugin: LoadedPlugin = {
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        keywords: manifest.keywords,
        execute: async () => {
          throw new Error(`Plugin ${manifest.id} failed to load: ${errorMessage}`);
        },
        manifest,
        path: pluginPath,
        loaded: false,
        error: errorMessage,
      };
      
      this.loadedPlugins.set(manifest.id, errorPlugin);
      return errorPlugin;
    }
  }

  /**
   * 从目录加载所有插件（使用 Tauri API 扫描外部插件目录）
   */
  async loadPluginsFromDirectory(
    directory: string,
    isBuiltin: boolean = false
  ): Promise<LoadedPlugin[]> {
    const plugins: LoadedPlugin[] = [];
    
    if (isBuiltin) {
      // 内置插件：使用预定义的插件列表
      // 这些插件会在 registry 中注册
      return plugins;
    } else {
      // 外部插件：使用 Tauri API 扫描目录
      try {
        const { tauriApi } = await import("../api/tauri");
        const pluginDirs = await tauriApi.scanPluginDirectory(directory);
        
        for (const dir of pluginDirs) {
          try {
            // 读取 manifest.json
            const manifestContent = await tauriApi.readPluginManifest(dir);
            const manifest: PluginManifest = JSON.parse(manifestContent);
            
            if (manifest.enabled !== false) {
              // 对于外部插件，需要特殊处理导入路径
              // 这里暂时跳过，因为外部插件的动态导入比较复杂
              // 可以考虑使用 eval 或其他方式
              console.warn(`External plugin loading not fully implemented yet: ${dir}`);
            }
          } catch (error) {
            console.error(`Failed to load plugin from ${dir}:`, error);
          }
        }
      } catch (error) {
        console.error(`Failed to scan plugin directory ${directory}:`, error);
      }
    }
    
    return plugins;
  }

  /**
   * 卸载插件
   */
  unloadPlugin(pluginId: string): void {
    this.loadedPlugins.delete(pluginId);
  }

  /**
   * 重新加载插件
   */
  async reloadPlugin(pluginId: string, pluginPath: string, manifest: PluginManifest): Promise<LoadedPlugin> {
    this.unloadPlugin(pluginId);
    return this.loadPlugin(pluginPath, manifest);
  }

  /**
   * 验证 manifest
   */
  private validateManifest(manifest: any): asserts manifest is PluginManifest {
    if (!manifest.id || !manifest.name || !manifest.version) {
      throw new Error("Invalid manifest: missing required fields (id, name, version)");
    }
    if (!Array.isArray(manifest.keywords)) {
      throw new Error("Invalid manifest: keywords must be an array");
    }
    if (!manifest.entry) {
      throw new Error("Invalid manifest: entry is required");
    }
  }

  /**
   * 获取所有已加载的插件
   */
  getLoadedPlugins(): LoadedPlugin[] {
    return Array.from(this.loadedPlugins.values());
  }

  /**
   * 检查插件是否已加载
   */
  isLoaded(pluginId: string): boolean {
    return this.loadedPlugins.has(pluginId);
  }

  /**
   * 导入内置插件（使用静态导入映射）
   */
  private async importBuiltinPlugin(pluginId: string): Promise<any> {
    // 使用静态导入映射，确保 Vite 可以正确打包
    // 注意：从 src/plugins/loader.ts 到 src/plugins/builtin/xxx/index.ts，路径应该是 ./builtin/...
    type ImportFn = () => Promise<any>;
    const pluginMap: Record<string, ImportFn> = {
      show_main_window: () => import("./builtin/show_main_window/index"),
      memo_center: () => import("./builtin/memo_center/index"),
      show_plugin_list: () => import("./builtin/show_plugin_list/index"),
      // JSON 格式化查看插件
      json_formatter: () => import("./builtin/json_formatter/index"),
    };

    const importFn = pluginMap[pluginId];
    if (!importFn) {
      throw new Error(`Builtin plugin ${pluginId} not found in import map`);
    }

    return importFn();
  }
}

