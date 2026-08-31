import { describe, it, expect } from "vitest";
import { getUrlHistoryDisplay, getUrlResultDisplayName } from "../urlDisplayUtils";

describe("getUrlHistoryDisplay", () => {
  it("有自定义备注时应返回备注", () => {
    const result = getUrlHistoryDisplay({
      path: "https://rp.mockplus.cn/run/abc",
      name: "虚拟电厂 pr 原型",
    });

    expect(result.remark).toBe("虚拟电厂 pr 原型");
    expect(result.hostname).toBe("rp.mockplus.cn");
  });

  it("仅有自动域名时不应视为备注", () => {
    const result = getUrlHistoryDisplay({
      path: "https://rp.mockplus.cn/run/abc",
      name: "rp.mockplus.cn",
    });

    expect(result.remark).toBeNull();
    expect(result.hostname).toBe("rp.mockplus.cn");
  });
});

describe("getUrlResultDisplayName", () => {
  it("有备注时主标题应显示备注", () => {
    expect(
      getUrlResultDisplayName(
        "https://rp.mockplus.cn/run/abc",
        "虚拟电厂 pr 原型"
      )
    ).toBe("虚拟电厂 pr 原型");
  });

  it("无备注时主标题应显示域名", () => {
    expect(
      getUrlResultDisplayName("https://rp.mockplus.cn/run/abc", "rp.mockplus.cn")
    ).toBe("rp.mockplus.cn");
  });
});
