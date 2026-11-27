import { describe, expect, it } from "vitest";
import {
  detectClipboardSuggestion,
  detectMultilineCalcPad,
  looksLikeFilesystemPath,
  looksLikeHexPayload,
  looksLikeUrl,
  normalizeClipboardFirstLine,
  truncatePreview,
  tryParseJsonSuggestion,
} from "../clipboardSuggestionUtils";

describe("clipboardSuggestionUtils", () => {
  describe("normalizeClipboardFirstLine", () => {
    it("去引号并取首行", () => {
      expect(normalizeClipboardFirstLine('"D:\\a\\b"\nother')).toBe("D:\\a\\b");
      expect(normalizeClipboardFirstLine("'C:/x'\r\ny")).toBe("C:/x");
    });
  });

  describe("looksLikeFilesystemPath", () => {
    it("识别盘符与斜杠", () => {
      expect(looksLikeFilesystemPath("D:\\project\\re-fast")).toBe(true);
      expect(looksLikeFilesystemPath("C:/Users/a")).toBe(true);
      expect(looksLikeFilesystemPath("\\\\server\\share")).toBe(true);
    });

    it("排除 URL 与普通句子", () => {
      expect(looksLikeFilesystemPath("https://example.com/a")).toBe(false);
      expect(looksLikeFilesystemPath("hello world")).toBe(false);
    });
  });

  describe("URL / JSON / hex", () => {
    it("looksLikeUrl", () => {
      expect(looksLikeUrl("https://example.com/x")).toBe(true);
      expect(looksLikeUrl("http://a")).toBe(true);
      expect(looksLikeUrl("ftp://a")).toBe(false);
    });

    it("合法 JSON 才通过", () => {
      expect(tryParseJsonSuggestion('{"a":1}')).toBe('{"a":1}');
      expect(tryParseJsonSuggestion("[1,2]")).toBe("[1,2]");
      expect(tryParseJsonSuggestion("{nope")).toBeNull();
      expect(tryParseJsonSuggestion("hello")).toBeNull();
    });

    it("hex 收紧：0x 或含字母的偶数长度串", () => {
      expect(looksLikeHexPayload("0xFF")).toBe(true);
      expect(looksLikeHexPayload("0xdead")).toBe(true);
      expect(looksLikeHexPayload("deadbeef")).toBe(true);
      expect(looksLikeHexPayload("12345678")).toBe(false);
      expect(looksLikeHexPayload("abc")).toBe(false);
      expect(looksLikeHexPayload("hello!!!")).toBe(false);
    });
  });

  describe("detectMultilineCalcPad", () => {
    it("至少两行可算", () => {
      expect(detectMultilineCalcPad("1+2\n3*4")).toContain("1+2");
      expect(detectMultilineCalcPad("1+2\nhello")).toBeNull();
      expect(detectMultilineCalcPad("1+2")).toBeNull();
    });
  });

  describe("detectClipboardSuggestion 优先级", () => {
    it("存在路径优先于公式/URL", () => {
      const hit = detectClipboardSuggestion({
        text: "1+2*3",
        existingPath: "D:\\project\\foo",
      });
      expect(hit?.kind).toBe("path");
      expect(hit?.actionLabel).toBe("搜索");
    });

    it("URL 优先于公式", () => {
      const hit = detectClipboardSuggestion({
        text: "https://example.com/a",
      });
      expect(hit?.kind).toBe("url");
      expect(hit?.actionLabel).toBe("打开");
    });

    it("合法 JSON", () => {
      const hit = detectClipboardSuggestion({
        text: '{\n  "x": 1\n}',
      });
      expect(hit?.kind).toBe("json");
      expect(hit?.actionLabel).toBe("格式化");
    });

    it("非法 JSON 不提示", () => {
      expect(
        detectClipboardSuggestion({ text: "{not json" })
      ).toBeNull();
    });

    it("单行公式", () => {
      const hit = detectClipboardSuggestion({ text: "1+2*3" });
      expect(hit?.kind).toBe("calc");
      expect(hit?.message).toContain("→ 7");
      expect(hit?.actionLabel).toBe("填入");
    });

    it("单位换算", () => {
      const hit = detectClipboardSuggestion({ text: "100 km to mi" });
      expect(hit?.kind).toBe("unit");
      expect(hit?.actionLabel).toBe("填入");
    });

    it("hex", () => {
      const hit = detectClipboardSuggestion({ text: "0xFF00" });
      expect(hit?.kind).toBe("hex");
      expect(hit?.actionLabel).toBe("转换");
    });

    it("多行算式走稿纸，不走单行 calc", () => {
      const hit = detectClipboardSuggestion({ text: "1+2\n3*4" });
      expect(hit?.kind).toBe("calc_pad");
      expect(hit?.actionLabel).toBe("稿纸");
    });

    it("普通句子无建议", () => {
      expect(detectClipboardSuggestion({ text: "hello world" })).toBeNull();
    });

    it("路径形态但未确认存在时不提示 path，可落到其它类型", () => {
      const hit = detectClipboardSuggestion({
        text: "D:\\not\\really\\here",
        existingPath: null,
      });
      // 不像 URL/JSON/公式
      expect(hit).toBeNull();
    });
  });

  describe("truncatePreview", () => {
    it("过长截断", () => {
      const long = "a".repeat(60);
      expect(truncatePreview(long, 10).endsWith("…")).toBe(true);
      expect(truncatePreview(long, 10).length).toBe(10);
    });
  });
});
