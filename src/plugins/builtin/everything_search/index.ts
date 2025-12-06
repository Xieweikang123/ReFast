import type { PluginContext } from "../../../types";

export default async function execute(context: PluginContext) {
  if (context.tauriApi) {
    await context.tauriApi.showEverythingSearchWindow();
    await context.hideLauncher();
  }
}

