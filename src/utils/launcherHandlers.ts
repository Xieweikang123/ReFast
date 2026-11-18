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

  // 编辑中的备忘录交给 MemoModal 处理，此处不拦截
  if (isMemoModalOpen && isMemoEditing) {
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

  // 如果备忘录弹窗已打开，关闭备忘录并隐藏窗口
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

