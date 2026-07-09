import type { PluginContext } from "../../../types";
import { isMathExpression } from "../../../utils/launcherUtils";

export default async function execute(context: PluginContext) {
  if (context.tauriApi) {
    const expression =
      context.query && isMathExpression(context.query) ? context.query : undefined;

    await context.tauriApi.showCalculatorPadWindow(expression);
    await context.hideLauncher();
  }
}
