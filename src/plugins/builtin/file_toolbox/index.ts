import type { PluginContext } from "../../../types";

export default async function execute(context: PluginContext) {
  // 打开独立的文件工具箱窗口
  if (context.tauriApi) {
    await context.tauriApi.showFileToolboxWindow();
    // 关闭启动器
    await context.hideLauncher();
  }
}

