import { describe, it, expect } from "vitest";
import { getThemeConfig, getLayoutConfig } from "../themeConfig";

describe("themeConfig", () => {
  describe("getThemeConfig", () => {
    it("应该返回 compact 主题配置", () => {
      const config = getThemeConfig("compact");
      
      expect(config).toBeDefined();
      expect(typeof config.card).toBe("function");
      expect(typeof config.indicator).toBe("function");
      expect(typeof config.indexBadge).toBe("function");
    });

    it("应该返回 soft 主题配置", () => {
      const config = getThemeConfig("soft");
      
      expect(config).toBeDefined();
      const cardClass = config.card(true);
      expect(cardClass).toContain("blue");
    });

    it("应该返回 skeuomorphic 主题配置", () => {
      const config = getThemeConfig("skeuomorphic");
      
      expect(config).toBeDefined();
      const cardClass = config.card(true);
      expect(cardClass).toContain("gradient");
    });

    it("应该根据选中状态返回不同的样式", () => {
      const config = getThemeConfig("compact");
      
      const selectedCard = config.card(true);
      const unselectedCard = config.card(false);
      
      expect(selectedCard).not.toBe(unselectedCard);
      expect(selectedCard).toContain("indigo");
      expect(unselectedCard).toContain("white");
    });

    it("应该为不同标签类型返回不同样式", () => {
      const config = getThemeConfig("soft");
      
      const urlTag = config.tag("url", false);
      const jsonTag = config.tag("json_formatter", false);
      
      expect(urlTag).toContain("blue");
      expect(jsonTag).toContain("indigo");
    });
  });

  describe("getLayoutConfig", () => {
    it("应该返回 compact 布局配置", () => {
      const config = getLayoutConfig("compact");
      
      expect(config).toBeDefined();
      expect(config.container).toContain("bg-white");
      expect(typeof config.pluginIcon).toBe("function");
    });

    it("应该返回 soft 布局配置", () => {
      const config = getLayoutConfig("soft");
      
      expect(config).toBeDefined();
      expect(config.container).toContain("bg-white");
    });

    it("应该返回 skeuomorphic 布局配置", () => {
      const config = getLayoutConfig("skeuomorphic");
      
      expect(config).toBeDefined();
      expect(config.wrapperBg).toContain("gradient");
      expect(config.container).toContain("gradient");
    });

    it("应该根据悬停状态返回不同的插件图标样式", () => {
      const config = getLayoutConfig("compact");
      
      const hoveringIcon = config.pluginIcon(true);
      const notHoveringIcon = config.pluginIcon(false);
      
      expect(hoveringIcon).not.toBe(notHoveringIcon);
      expect(hoveringIcon).toContain("indigo");
    });
  });
});

