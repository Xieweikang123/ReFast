import type { PluginContext } from "../../../types";

export default async function execute(context: PluginContext) {
  // 打开独立的 JSON 格式化窗口
  if (context.tauriApi) {
    await context.tauriApi.showJsonFormatterWindow();
    // 关闭启动器
    await context.hideLauncher();
  }
}

