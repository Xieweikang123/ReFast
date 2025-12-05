import type { Plugin } from "../../types";
import { tauriApi } from "../../api/tauri";

/**
 * 创建内置插件列表
 * 这些插件作为后备方案，如果动态加载失败，会使用这些定义
 */
export function createBuiltinPlugins(): Plugin[] {
  return [
    {
      id: "show_main_window",
      name: "录制动作",
      description: "打开主程序窗口",
      keywords: [
        "录制动作",
        "录制",
        "主窗口",
        "主程序",
        "窗口",
        "luzhidongzuo",
        "lzdz",
        "luzhi",
        "lz",
        "zhuchuangkou",
        "zck",
        "zhuchengxu",
        "zcx",
        "chuangkou",
        "ck",
        "main",
      ],
      execute: async (context) => {
        await tauriApi.showMainWindow();
        await context.hideLauncher();
        context.setQuery("");
        context.setSelectedIndex(0);
      },
    },
    {
      id: "memo_center",
      name: "备忘录",
      description: "查看和编辑已有的备忘录",
      keywords: [
        "备忘录",
        "beiwanglu",
        "bwl",
        "memo",
        "note",
        "记录",
        "jilu",
        "jl",
      ],
      execute: async (context) => {
        // 打开独立的备忘录窗口
        if (context.tauriApi) {
          await context.tauriApi.showMemoWindow();
          // 关闭启动器
          await context.hideLauncher();
        }
      },
    },
    {
      id: "show_plugin_list",
      name: "显示插件列表",
      description: "查看所有可用插件",
      keywords: [
        "显示插件列表",
        "插件列表",
        "插件",
        "列表",
        "所有插件",
        "xianshichajianliebiao",
        "xscjlb",
        "chajianliebiao",
        "cjlb",
        "chajian",
        "cj",
        "suoyouchajian",
        "sycj",
        "plugin",
      ],
      execute: async (context) => {
        // 打开独立的插件列表窗口
        if (context.tauriApi) {
          await context.tauriApi.showPluginListWindow();
          // 关闭启动器
          await context.hideLauncher();
        }
      },
    },
    {
      id: "json_formatter",
      name: "JSON 格式化查看",
      description: "格式化、压缩和验证 JSON 数据",
      keywords: [
        "JSON",
        "格式化",
        "json",
        "geshihua",
        "gsh",
        "格式化查看",
        "geshihuachakan",
        "gshck",
        "json格式化",
        "json查看",
        "json验证",
        "json压缩",
        "formatter",
        "validator",
        "minify",
      ],
      execute: async (context) => {
        // 打开独立的 JSON 格式化窗口
        if (context.tauriApi) {
          await context.tauriApi.showJsonFormatterWindow();
          // 关闭启动器
          await context.hideLauncher();
        }
      },
    },
    {
      id: "file_toolbox",
      name: "文件工具箱",
      description: "文件处理工具集，支持批量查找替换、文件操作等功能",
      keywords: [
        "文件工具箱",
        "文件处理",
        "文件替换",
        "批量替换",
        "字符串替换",
        "wenjiangongjuxiang",
        "wjgjx",
        "wenjianchuli",
        "wjcl",
        "wenjiantihuan",
        "wjth",
        "piliangtihuan",
        "plth",
        "zifuchuantihuan",
        "zfcth",
        "toolbox",
        "file",
        "batch",
        "search",
        "replace",
      ],
      execute: async (context) => {
        // 打开独立的文件工具箱窗口
        if (context.tauriApi) {
          await context.tauriApi.showFileToolboxWindow();
          // 关闭启动器
          await context.hideLauncher();
        }
      },
    },
  ];
}


