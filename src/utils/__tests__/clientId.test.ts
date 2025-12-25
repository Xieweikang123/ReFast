import { describe, it, expect, beforeEach, vi } from "vitest";
import { getClientId } from "../clientId";

describe("clientId", () => {
  beforeEach(() => {
    // 清除 localStorage
    localStorage.clear();
    // 清除模块缓存
    vi.resetModules();
  });

  it("应该生成新的客户端 ID", () => {
    const id = getClientId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("应该从 localStorage 读取已存在的 ID", async () => {
    const existingId = "test-client-id-123";
    localStorage.setItem("refast_client_id", existingId);
    
    // 重新导入模块以清除缓存
    vi.resetModules();
    const { getClientId: getClientIdFresh } = await import("../clientId");
    
    const id = getClientIdFresh();
    expect(id).toBe(existingId);
  });

  it("应该将新生成的 ID 保存到 localStorage", async () => {
    localStorage.clear();
    
    // 重新导入模块以清除缓存
    vi.resetModules();
    const { getClientId: getClientIdFresh } = await import("../clientId");
    
    const id = getClientIdFresh();
    const storedId = localStorage.getItem("refast_client_id");
    
    expect(storedId).toBe(id);
    expect(storedId).toBeTruthy();
  });

  it("应该返回相同的 ID 在多次调用时（缓存）", () => {
    const id1 = getClientId();
    const id2 = getClientId();
    expect(id1).toBe(id2);
  });

  it("应该在 localStorage 不可用时使用内存 ID", async () => {
    // 模拟 localStorage 不可用
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    
    Storage.prototype.getItem = vi.fn(() => {
      throw new Error("localStorage not available");
    });
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error("localStorage not available");
    });
    
    try {
      vi.resetModules();
      const { getClientId: getClientIdFresh } = await import("../clientId");
      
      const id = getClientIdFresh();
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    } finally {
      // 恢复原始方法
      Storage.prototype.getItem = originalGetItem;
      Storage.prototype.setItem = originalSetItem;
    }
  });
});

