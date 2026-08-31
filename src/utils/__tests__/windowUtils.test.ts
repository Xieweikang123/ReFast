import { describe, it, expect } from "vitest";
import {
  computeContextMenuWindowHeight,
  computeOverlayWindowHeight,
  LAUNCHER_MAX_HEIGHT,
  CONTEXT_MENU_VIEWPORT_PADDING,
} from "../windowUtils";

describe("windowUtils", () => {
  describe("computeContextMenuWindowHeight", () => {
    it("菜单未超出视口时不应撑高", () => {
      expect(
        computeContextMenuWindowHeight(280, 320, LAUNCHER_MAX_HEIGHT, CONTEXT_MENU_VIEWPORT_PADDING)
      ).toBeNull();
    });

    it("菜单超出视口时应返回需要的高度", () => {
      expect(
        computeContextMenuWindowHeight(520, 280, LAUNCHER_MAX_HEIGHT, CONTEXT_MENU_VIEWPORT_PADDING)
      ).toBe(528);
    });

    it("不应超过启动器最大高度", () => {
      expect(
        computeContextMenuWindowHeight(700, 280, LAUNCHER_MAX_HEIGHT, CONTEXT_MENU_VIEWPORT_PADDING)
      ).toBe(LAUNCHER_MAX_HEIGHT);
    });

    it("已达最大高度且仍放不下时不应继续撑高", () => {
      expect(
        computeContextMenuWindowHeight(700, LAUNCHER_MAX_HEIGHT, LAUNCHER_MAX_HEIGHT, CONTEXT_MENU_VIEWPORT_PADDING)
      ).toBeNull();
    });
  });

  describe("computeOverlayWindowHeight", () => {
    it("弹层内容超出视口时应返回需要的高度", () => {
      expect(computeOverlayWindowHeight(320, 280)).toBe(352);
    });

    it("弹层内容可完整显示时不应撑高", () => {
      expect(computeOverlayWindowHeight(240, 320)).toBeNull();
    });
  });
});
