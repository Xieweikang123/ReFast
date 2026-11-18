/**
 * Launcher Window 事件处理工具函数
 * 封装重复的事件处理逻辑
 */

/**
 * Escape 键处理函数
 */
export interface EscapeHandlerOptions {
  isPluginListModalOpen: boolean | (() => boolean);
  isMemoModalOpen: boolean | (() => boolean);
  /** 备忘录正在编辑时由 MemoModal 自行处理 ESC（含脏检查） */
  isMemoEditing?: boolean | (() => boolean);
  /**
   * 是否处于备忘录列表模式。预览/编辑（非列表）时 ESC 交给 MemoModal
   *（与 keyboardUtils：`isEditingMemo || !isMemoListMode` 一致）。
   * 未传入时视为列表模式，保持旧行为。
   */
  isMemoListMode?: boolean | (() => boolean);
  showAiAnswer: boolean;
  setIsPluginListModalOpen: (value: boolean) => void;
  resetMemoState: () => void;
  setShowAiAnswer: (value: boolean) => void;
  setAiAnswer: (value: string | null) => void;
  hideLauncherAndResetState: (options?: { resetMemo?: boolean; resetAi?: boolean }) => Promise<void>;
}

export function handleEscapeKey(
  e: KeyboardEvent | React.KeyboardEvent,
  options: EscapeHandlerOptions
): boolean {
  if (e.key !== "Escape" && e.keyCode !== 27) {
    return false;
  }

  const isPluginListModalOpen = typeof options.isPluginListModalOpen === 'function' 
    ? options.isPluginListModalOpen() 
    : options.isPluginListModalOpen;
  const isMemoModalOpen = typeof options.isMemoModalOpen === 'function'
    ? options.isMemoModalOpen()
    : options.isMemoModalOpen;
  const isMemoEditing = typeof options.isMemoEditing === 'function'
    ? options.isMemoEditing()
    : !!options.isMemoEditing;
  const isMemoListMode =
    typeof options.isMemoListMode === "function"
      ? options.isMemoListMode()
      : options.isMemoListMode !== undefined
        ? !!options.isMemoListMode
        : true;

  // 编辑/预览交给 MemoModal（脏检查或 returnToList）；列表模式才整窗关闭
  if (isMemoModalOpen && (isMemoEditing || !isMemoListMode)) {
    return false;
  }

  e.preventDefault();
  e.stopPropagation();

  // 如果应用中心弹窗已打开，关闭应用中心并隐藏窗口
  if (isPluginListModalOpen) {
    options.setIsPluginListModalOpen(false);
    setTimeout(() => {
      options.hideLauncherAndResetState();
    }, 100);
    return true;
  }

  // 如果备忘录弹窗已打开（列表模式），关闭备忘录并隐藏窗口
  if (isMemoModalOpen) {
    options.resetMemoState();
    setTimeout(() => {
      options.hideLauncherAndResetState();
    }, 100);
    return true;
  }

  // 如果正在显示 AI 回答，退出 AI 回答模式
  if (options.showAiAnswer) {
    options.setShowAiAnswer(false);
    options.setAiAnswer(null);
    return true;
  }

  // 默认：隐藏启动器并重置状态
  options.hideLauncherAndResetState({ resetMemo: true });
  return true;
}

/**
 * 关闭插件弹窗并隐藏窗口
 */
export function closePluginModalAndHide(
  setIsPluginListModalOpen: (value: boolean) => void,
  hideLauncherAndResetState: () => Promise<void>
): void {
  setIsPluginListModalOpen(false);
  setTimeout(() => {
    hideLauncherAndResetState();
  }, 100);
}

/**
 * 关闭备忘录弹窗并隐藏窗口
 */
export function closeMemoModalAndHide(
  resetMemoState: () => void,
  hideLauncherAndResetState: () => Promise<void>
): void {
  resetMemoState();
  setTimeout(() => {
    hideLauncherAndResetState();
  }, 100);
}

