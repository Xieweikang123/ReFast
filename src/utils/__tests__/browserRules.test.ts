import { describe, it, expect } from "vitest";
import { isBrowserRuleMatch, resolveBrowserForUrl } from "../browserRules";
import type { BrowserRule } from "../../types";

const rule = (pattern: string, browser = "edge", enabled = true): BrowserRule => ({
  pattern,
  browser,
  enabled,
});

describe("isBrowserRuleMatch", () => {
  it("按 URL 前缀匹配完整网址", () => {
    const r = rule("https://opencode.ai");
    expect(isBrowserRuleMatch(r, "https://opencode.ai/workspace/wrk_1/go")).toBe(true);
    expect(isBrowserRuleMatch(r, "https://opencode.ai")).toBe(true);
    expect(isBrowserRuleMatch(r, "https://linux.do")).toBe(false);
  });

  it("按域名后缀匹配", () => {
    const r = rule("opencode.ai");
    expect(isBrowserRuleMatch(r, "https://opencode.ai/workspace/go")).toBe(true);
    expect(isBrowserRuleMatch(r, "https://sub.opencode.ai/x")).toBe(true);
    expect(isBrowserRuleMatch(r, "https://opencode.ai.evil.com")).toBe(false);
  });

  it("支持单段域名匹配", () => {
    const r = rule("linux.do");
    expect(isBrowserRuleMatch(r, "https://linux.do/t/1")).toBe(true);
    expect(isBrowserRuleMatch(r, "https://sub.linux.do")).toBe(true);
  });

  it("大小写不敏感", () => {
    const r = rule("OpenCode.AI");
    expect(isBrowserRuleMatch(r, "https://opencode.ai/x")).toBe(true);
  });

  it("禁用规则不匹配", () => {
    expect(isBrowserRuleMatch(rule("opencode.ai", "edge", false), "https://opencode.ai")).toBe(false);
  });

  it("空模式不匹配", () => {
    expect(isBrowserRuleMatch(rule(""), "https://opencode.ai")).toBe(false);
  });
});

describe("resolveBrowserForUrl", () => {
  it("未命中返回 default", () => {
    expect(resolveBrowserForUrl("https://example.com", [rule("opencode.ai")])).toBe("default");
    expect(resolveBrowserForUrl("https://example.com", [])).toBe("default");
    expect(resolveBrowserForUrl("https://example.com", undefined)).toBe("default");
  });

  it("按列表顺序命中第一条启用规则", () => {
    const rules = [
      rule("linux.do", "chrome"),
      rule("opencode.ai", "edge"),
    ];
    expect(resolveBrowserForUrl("https://linux.do/t/1", rules)).toBe("chrome");
    expect(resolveBrowserForUrl("https://opencode.ai/workspace/go", rules)).toBe("edge");
  });

  it("跳过禁用规则", () => {
    const rules = [rule("opencode.ai", "edge", false), rule("opencode.ai", "chrome")];
    expect(resolveBrowserForUrl("https://opencode.ai/x", rules)).toBe("chrome");
  });
});
