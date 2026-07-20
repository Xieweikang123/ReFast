import { tauriApi } from "../api/tauri";

let cachedOsType: string | null = null;

/**
 * 获取操作系统类型，结果会缓存
 * @returns "windows" | "macos" | "linux" | "unknown"
 */
export async function getOsType(): Promise<string> {
  if (cachedOsType) {
    return cachedOsType;
  }
  try {
    cachedOsType = await tauriApi.getOsType();
    return cachedOsType;
  } catch {
    // Fallback: use navigator.platform
    const platform = navigator.platform.toLowerCase();
    if (platform.includes("mac")) return "macos";
    if (platform.includes("win")) return "windows";
    if (platform.includes("linux")) return "linux";
    return "unknown";
  }
}

/**
 * 是否为 macOS
 */
export async function isMacOS(): Promise<boolean> {
  const os = await getOsType();
  return os === "macos";
}

/**
 * 是否为 Windows
 */
export async function isWindows(): Promise<boolean> {
  const os = await getOsType();
  return os === "windows";
}
