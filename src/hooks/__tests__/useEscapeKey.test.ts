import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useEscapeKey } from "../useEscapeKey";

describe("useEscapeKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("应该在按下 Escape 键时调用回调", () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeKey(onEscape));

    const escapeEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      keyCode: 27,
      bubbles: true,
    });
    document.dispatchEvent(escapeEvent);

    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("应该使用 keyCode 27 触发 Escape", () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeKey(onEscape));

    const escapeEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      keyCode: 27,
      bubbles: true,
    });
    document.dispatchEvent(escapeEvent);

    expect(onEscape).toHaveBeenCalled();
  });

  it("不应该在按下其他键时调用回调", () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeKey(onEscape));

    const otherEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      keyCode: 13,
      bubbles: true,
    });
    document.dispatchEvent(otherEvent);

    expect(onEscape).not.toHaveBeenCalled();
  });

  it("应该在禁用时不调用回调", () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeKey(onEscape, false));

    const escapeEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      keyCode: 27,
      bubbles: true,
    });
    document.dispatchEvent(escapeEvent);

    expect(onEscape).not.toHaveBeenCalled();
  });

  it("应该在卸载时移除事件监听器", () => {
    const onEscape = vi.fn();
    const { unmount } = renderHook(() => useEscapeKey(onEscape));

    unmount();

    const escapeEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      keyCode: 27,
      bubbles: true,
    });
    document.dispatchEvent(escapeEvent);

    expect(onEscape).not.toHaveBeenCalled();
  });

  it("应该阻止默认行为和事件传播", () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeKey(onEscape));

    const escapeEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      keyCode: 27,
      bubbles: true,
      cancelable: true,
    });
    
    const preventDefaultSpy = vi.spyOn(escapeEvent, "preventDefault");
    const stopPropagationSpy = vi.spyOn(escapeEvent, "stopPropagation");
    
    document.dispatchEvent(escapeEvent);

    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(stopPropagationSpy).toHaveBeenCalled();
  });
});
