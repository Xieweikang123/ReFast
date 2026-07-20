/**
 * Launcher Window 主题配置
 * 从 LauncherWindow.tsx 提取的主题和布局配置
 */

export type ResultStyle = "compact" | "soft" | "skeuomorphic";

export type ThemeConfig = {
  card: (selected: boolean) => string;
  indicator: (selected: boolean) => string;
  indexBadge: (selected: boolean) => string;
  iconWrap: (selected: boolean) => string;
  iconColor: (selected: boolean, defaultColor: string) => string;
  title: (selected: boolean) => string;
  aiText: (selected: boolean) => string;
  pathText: (selected: boolean) => string;
  metaText: (selected: boolean) => string;
  descText: (selected: boolean) => string;
  usageText: (selected: boolean) => string;
  tag: (type: string, selected: boolean) => string;
};

export type LayoutConfig = {
  wrapperBg: string;
  container: string;
  header: string;
  searchIcon: string;
  dragHandleIcon: string;
  input: string;
  pluginIcon: (hovering: boolean) => string;
};

/**
 * 获取主题配置
 */
export function getThemeConfig(style: ResultStyle): ThemeConfig {
  const compact: ThemeConfig = {
    card: (selected: boolean) =>
      `group relative mx-2 my-1 px-3.5 py-2.5 rounded-lg border cursor-pointer transition-colors duration-150 ${
        selected
          ? "bg-indigo-50 text-gray-900 border-indigo-400 shadow-md shadow-indigo-200/60"
          : "bg-white text-gray-800 border-gray-100 hover:bg-gray-50 hover:border-gray-200"
      }`,
    indicator: (selected: boolean) =>
      `absolute left-0 top-2 bottom-2 w-[3px] rounded-full transition-opacity ${
        selected ? "bg-indigo-600 opacity-100 shadow-[0_0_8px_rgba(79,70,229,0.45)]" : "bg-indigo-300 opacity-0 group-hover:opacity-70"
      }`,
    indexBadge: (selected: boolean) =>
      `text-[11px] font-semibold flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-colors ${
        selected ? "bg-indigo-600 text-white shadow-sm shadow-indigo-500/40" : "bg-gray-100 text-gray-500 group-hover:bg-gray-200"
      }`,
    iconWrap: (selected: boolean) =>
      `w-9 h-9 rounded-md flex items-center justify-center flex-shrink-0 overflow-hidden transition-colors duration-150 ${
        selected ? "" : ""
      }`,
    iconColor: (selected: boolean, defaultColor: string) => (selected ? "text-indigo-600" : defaultColor),
    title: (selected: boolean) => (selected ? "text-indigo-900" : "text-gray-900"),
    aiText: (selected: boolean) => (selected ? "text-indigo-800" : "text-gray-600"),
    pathText: (selected: boolean) => (selected ? "text-indigo-700" : "text-gray-500"),
    metaText: (selected: boolean) => (selected ? "text-indigo-700" : "text-gray-500"),
    descText: (selected: boolean) => (selected ? "text-indigo-800" : "text-gray-600"),
    usageText: (selected: boolean) => (selected ? "text-indigo-700" : "text-gray-500"),
    tag: (_type: string, selected: boolean) =>
      selected
        ? "bg-indigo-100 text-indigo-700 border border-indigo-200"
        : "bg-gray-100 text-gray-600 border border-gray-200",
  };

  const skeuo: ThemeConfig = {
    card: (selected: boolean) =>
      `group relative mx-2 my-1.5 px-4 py-3 rounded-xl border cursor-pointer transition-all duration-200 ${
        selected
          ? "bg-gradient-to-b from-[#eef3fb] to-[#d9e6f5] text-[#1f2a44] border-[#9eb8dc] shadow-[0_10px_26px_rgba(20,32,50,0.2)] ring-2 ring-[#c5d8ee]/90"
          : "bg-gradient-to-b from-[#f9fbfe] to-[#f1f5fb] text-[#222b3a] border-[#e2e8f1] shadow-[0_6px_14px_rgba(20,32,50,0.10)] hover:-translate-y-[1px] hover:shadow-[0_9px_18px_rgba(20,32,50,0.14)]"
      }`,
    indicator: (selected: boolean) =>
      `absolute left-0 top-2 bottom-2 w-[3px] rounded-full transition-opacity ${
        selected ? "bg-[#5a8ad4] opacity-100 shadow-[0_0_10px_rgba(90,138,212,0.55)]" : "bg-[#c6d6ed] opacity-0 group-hover:opacity-80"
      }`,
    indexBadge: (selected: boolean) =>
      `text-[11px] font-semibold flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-all shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_2px_6px_rgba(20,32,50,0.12)] ${
        selected
          ? "bg-gradient-to-b from-[#e5edf9] to-[#d4e1f2] text-[#22365b]"
          : "bg-gradient-to-b from-[#f1f6fc] to-[#e2eaf6] text-[#2e3f5f]"
      }`,
    iconWrap: (selected: boolean) =>
      `w-9 h-9 rounded-md flex items-center justify-center flex-shrink-0 overflow-hidden transition-all duration-200 ${
        selected ? "" : ""
      }`,
    iconColor: (selected: boolean, defaultColor: string) => (selected ? "text-[#2f4670]" : defaultColor),
    title: (selected: boolean) => (selected ? "text-[#1f2a44]" : "text-[#222b3a]"),
    aiText: (selected: boolean) => (selected ? "text-[#2e446a]" : "text-[#3c4c64]"),
    pathText: (selected: boolean) => (selected ? "text-[#3a5174]" : "text-[#4a5a70]"),
    metaText: (selected: boolean) => (selected ? "text-[#4a6185]" : "text-[#5a6a80]"),
    descText: (selected: boolean) => (selected ? "text-[#1f2a44]" : "text-[#3b4b63]"),
    usageText: (selected: boolean) => (selected ? "text-[#3a5174]" : "text-[#5a6a80]"),
    tag: (_type: string, selected: boolean) =>
      selected
        ? "bg-gradient-to-b from-[#e7eef9] to-[#d7e3f3] text-[#1f2a44] border border-[#c1cfe6] shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_1px_3px_rgba(20,32,50,0.1)]"
        : "bg-gradient-to-b from-[#f4f7fc] to-[#e9eef7] text-[#2c3a54] border border-[#d7e1ef] shadow-[inset_0_1px_0_rgba(255,255,255,0.65)]",
  };

  const soft: ThemeConfig = {
    card: (selected: boolean) =>
      `group relative mx-2 my-1.5 px-4 py-3 rounded-xl cursor-pointer transition-all duration-200 ${
        selected
          ? "bg-gradient-to-r from-blue-500 to-blue-600 text-white shadow-xl shadow-blue-600/45 ring-2 ring-blue-300/50 scale-[1.02]"
          : "hover:bg-gray-50 text-gray-700 hover:shadow-md"
      }`,
    indicator: (selected: boolean) =>
      `absolute left-0 top-2 bottom-2 w-1 rounded-full transition-opacity ${
        selected ? "bg-white opacity-95 shadow-[0_0_6px_rgba(255,255,255,0.9)]" : "opacity-0"
      }`,
    indexBadge: (selected: boolean) =>
      `text-xs font-semibold flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center transition-all ${
        selected ? "bg-white/20 text-white backdrop-blur-sm" : "bg-gray-100 text-gray-500 group-hover:bg-gray-200"
      }`,
    iconWrap: (selected: boolean) =>
      `w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden transition-all duration-200 ${
        selected ? "" : ""
      }`,
    iconColor: (selected: boolean, defaultColor: string) => (selected ? "text-white" : defaultColor),
    title: (selected: boolean) => (selected ? "text-white" : "text-gray-900"),
    aiText: (selected: boolean) => (selected ? "text-blue-50" : "text-gray-600"),
    pathText: (selected: boolean) => (selected ? "text-blue-100/70" : "text-gray-500"),
    metaText: (selected: boolean) => (selected ? "text-blue-100/60" : "text-gray-400"),
    descText: (selected: boolean) => (selected ? "text-blue-50/80" : "text-gray-500"),
    usageText: (selected: boolean) => (selected ? "text-blue-100/60" : "text-gray-400"),
    tag: (type: string, selected: boolean) => {
      const map: Record<string, string> = {
        url: selected ? "bg-blue-400 text-white" : "bg-blue-100 text-blue-700 border border-blue-200",
        json_formatter: selected ? "bg-indigo-400 text-white" : "bg-indigo-100 text-indigo-700 border border-indigo-200",
        memo: selected ? "bg-purple-400 text-white" : "bg-purple-100 text-purple-700 border border-purple-200",
        everything: selected ? "bg-green-400 text-white" : "bg-green-100 text-green-700 border border-green-200",
        default: selected ? "bg-white/20 text-white backdrop-blur-sm" : "bg-gray-50 text-gray-600 border border-gray-200",
      };
      return map[type] || map.default;
    },
  };

  if (style === "soft") return soft;
  if (style === "skeuomorphic") return skeuo;
  return compact;
}

/**
 * 获取布局配置
 */
export function getLayoutConfig(style: ResultStyle): LayoutConfig {
  if (style === "skeuomorphic") {
    return {
      wrapperBg: "linear-gradient(145deg, #eef2f8 0%, #e2e8f3 50%, #f6f8fc 100%)",
      container: "flex flex-col rounded-2xl shadow-[0_18px_48px_rgba(24,38,62,0.18)] border border-[#c8d5eb] ring-1 ring-[#d7e2f2]/80 bg-gradient-to-b from-[#f8fbff] via-[#eef3fb] to-[#e1e9f5]",
      header: "px-6 py-4 border-b border-[#dfe6f2] bg-gradient-to-r from-[#f4f7fc] via-[#eef3fb] to-[#f9fbfe] flex-shrink-0 rounded-t-2xl",
      searchIcon: "w-5 h-5 text-[#6f84aa]",
      dragHandleIcon: "w-4 h-4 text-[#6f84aa] opacity-60 hover:opacity-100 transition-opacity flex-shrink-0",
      input: "flex-1 text-lg border-none outline-none bg-transparent placeholder-[#95a6c2] text-[#1f2a44]",
      pluginIcon: (hovering: boolean) => `w-5 h-5 transition-all ${hovering ? "text-[#4468a2] opacity-100 drop-shadow-[0_2px_6px_rgba(68,104,162,0.35)]" : "text-[#7f93b3] opacity-85"}`,
    };
  }
  if (style === "soft") {
    return {
      wrapperBg: "transparent",
      container: "bg-white flex flex-col rounded-lg shadow-xl",
      header: "px-6 py-4 border-b border-gray-100 flex-shrink-0",
      searchIcon: "w-5 h-5 text-gray-400",
      dragHandleIcon: "w-4 h-4 text-gray-400 opacity-60 hover:opacity-100 transition-opacity flex-shrink-0",
      input: "flex-1 text-lg border-none outline-none bg-transparent placeholder-gray-400 text-gray-700",
      pluginIcon: (hovering: boolean) => `w-5 h-5 transition-all ${hovering ? "text-blue-600 opacity-100" : "text-gray-400 opacity-70"}`,
    };
  }
  return {
    wrapperBg: "transparent",
    container: "bg-white flex flex-col rounded-lg shadow-xl",
    header: "px-6 py-4 border-b border-gray-100 flex-shrink-0",
    searchIcon: "w-5 h-5 text-gray-400",
    dragHandleIcon: "w-4 h-4 text-gray-400 opacity-60 hover:opacity-100 transition-opacity cursor-move flex-shrink-0",
    input: "flex-1 text-lg border-none outline-none bg-transparent placeholder-gray-400 text-gray-700",
    pluginIcon: (hovering: boolean) => `w-5 h-5 transition-all ${hovering ? "text-indigo-600 opacity-100" : "text-gray-400 opacity-70"}`,
  };
}

