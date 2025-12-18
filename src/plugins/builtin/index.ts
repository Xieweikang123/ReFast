import type { Plugin } from "../../types";
import { tauriApi } from "../../api/tauri";

/**
 * 创建内置插件列表
 * 这些插件作为后备方案，如果动态加载失败，会使用这些定义
 */
export function createBuiltinPlugins(): Plugin[] {
  return [
    {
      id: "everything_search",
      name: "Everything 文件搜索",
      description: "使用 Everything 进行快速文件搜索",
      keywords: [
        "everything",
        "文件搜索",
        "文件",
        "搜索",
        "wenjiansousuo",
        "wjss",
        "wenjian",
        "wj",
        "sousuo",
        "ss",
        "everything搜索",
        "everything文件搜索",
      ],
      execute: async (context) => {
        // 打开独立的 Everything 搜索窗口
        if (context.tauriApi) {
          await context.tauriApi.showEverythingSearchWindow();
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
      id: "calculator_pad",
      name: "计算稿纸",
      description: "多行记录：像写草稿一样写多行算式",
      keywords: [
        "计算稿纸",
        "计算",
        "稿纸",
        "算式",
        "计算器",
        "jisuangaozhi",
        "jsgz",
        "jisuan",
        "js",
        "gaozhi",
        "gz",
        "suanshi",
        "ss",
        "jisuanqi",
        "jsq",
        "calculator",
        "pad",
        "calc",
      ],
      execute: async (context) => {
        // 打开独立的计算稿纸窗口
        if (context.tauriApi) {
          await context.tauriApi.showCalculatorPadWindow();
          // 关闭启动器
          await context.hideLauncher();
        }
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
      id: "recording",
      name: "录制回放工具",
      description: "录制鼠标键盘操作并回放，支持变速播放",
      keywords: [
        "录制",
        "回放",
        "宏",
        "自动化",
        "录制回放",
        "luzhi",
        "lz",
        "huifang",
        "hf",
        "hong",
        "zidonghua",
        "zdh",
        "recording",
        "playback",
        "macro",
        "automation",
        "录制动作",
        "luzhidongzuo",
        "lzdz",
      ],
      execute: async (context) => {
        await tauriApi.showMainWindow();
        await context.hideLauncher();
        context.setQuery("");
        context.setSelectedIndex(0);
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
    {
      id: "translation",
      name: "翻译工具",
      description: "多语言翻译工具，支持自动检测语言",
      keywords: [
        "翻译",
        "fanyi",
        "fy",
        "translate",
        "translation",
        "多语言",
        "duoyuyan",
        "dyy",
        "语言",
        "yuyan",
        "yy",
      ],
      execute: async (context) => {
        // 打开独立的翻译窗口
        if (context.tauriApi) {
          await context.tauriApi.showTranslationWindow();
          // 关闭启动器
          await context.hideLauncher();
        }
      },
    },
    {
      id: "hex_converter",
      name: "ASCII 十六进制转换器",
      description: "ASCII 文本与十六进制相互转换工具",
      keywords: [
        "ASCII",
        "十六进制",
        "hex",
        "转换",
        "converter",
        "shiliujinzhi",
        "sljjz",
        "zhuanhuan",
        "zh",
        "ascii转hex",
        "hex转ascii",
        "hex转换器",
        "ascii",
        "hexadecimal",
      ],
      execute: async (context) => {
        // 打开独立的 ASCII 十六进制转换器窗口
        if (context.tauriApi) {
          await context.tauriApi.showHexConverterWindow();
          // 关闭启动器
          await context.hideLauncher();
        }
      },
    },
    // {
    //   id: "color_picker",
    //   name: "拾色器",
    //   description: "颜色选择、格式转换、屏幕取色工具",
    //   keywords: [
    //     "拾色器",
    //     "颜色",
    //     "取色",
    //     "颜色选择",
    //     "color",
    //     "picker",
    //     "shiseqi",
    //     "ssq",
    //     "yanse",
    //     "ys",
    //     "quse",
    //     "qs",
    //     "yansexuanze",
    //     "ysxz",
    //     "取色器",
    //     "quseqi",
    //     "屏幕取色",
    //     "pingmuquse",
    //     "pmqs",
    //     "色彩",
    //     "secai",
    //     "sc",
    //     "color picker",
    //     "eyedropper",
    //     "颜色工具",
    //     "yansegongju",
    //     "ysgj",
    //   ],
    //   execute: async (context) => {
    //     // 打开独立的拾色器窗口
    //     if (context.tauriApi) {
    //       await context.tauriApi.showColorPickerWindow();
    //       // 关闭启动器
    //       await context.hideLauncher();
    //     }
    //   },
    // },
    {
      id: "clipboard",
      name: "剪切板历史",
      description: "查看、搜索和管理剪切板历史记录",
      keywords: [
        "剪切板",
        "clipboard",
        "剪贴板",
        "历史",
        "jianqieban",
        "jqb",
        "jiantieban",
        "jtb",
        "lishi",
        "ls",
        "剪切板历史",
        "剪贴板历史",
        "jianqiebanlishi",
        "jqbls",
        "复制",
        "fuzhi",
        "fz",
        "粘贴",
        "zhantie",
        "zt",
        "copy",
        "paste",
      ],
      execute: async (context) => {
        // 打开独立的剪切板窗口
        if (context.tauriApi) {
          await context.tauriApi.showClipboardWindow();
          // 关闭启动器
          await context.hideLauncher();
        }
      },
    },
  ];
}


