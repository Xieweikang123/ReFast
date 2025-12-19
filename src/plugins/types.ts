import type { Plugin, PluginContext } from "../types";

// Re-export Plugin types for use in plugin files
export type { Plugin, PluginContext };

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  keywords: string[];
  entry: string; // 相对于插件目录的入口文件路径
  dependencies?: Record<string, string>;
  enabled?: boolean;
  icon?: string; // 插件图标路径
}

export interface LoadedPlugin extends Plugin {
  manifest: PluginManifest;
  path: string; // 插件目录路径
  loaded: boolean;
  error?: string;
}

export interface PluginLoader {
  loadPlugin(pluginPath: string): Promise<LoadedPlugin>;
  unloadPlugin(pluginId: string): void;
  reloadPlugin(pluginId: string): Promise<LoadedPlugin>;
}

