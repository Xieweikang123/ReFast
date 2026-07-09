import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CalculatorPadWindow } from "../CalculatorPadWindow";

// Mock Tauri APIs
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    close: vi.fn(),
    onFocusChanged: vi.fn(() => Promise.resolve(() => {})),
  })),
}));

vi.mock("../../api/tauri", () => ({
  tauriApi: {
    takeCalculatorPadExpression: vi.fn(() => Promise.resolve(null)),
  },
}));

vi.mock("../../hooks/useEscapeKey", () => ({
  useEscapeKey: vi.fn(),
}));

vi.mock("../../hooks/useWindowClose", () => ({
  useWindowClose: vi.fn(() => vi.fn()),
}));

describe("CalculatorPadWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("应该渲染计算稿纸窗口", () => {
    render(<CalculatorPadWindow />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("应该能够输入表达式", async () => {
    const user = userEvent.setup();
    render(<CalculatorPadWindow />);

    const input = screen.getByRole("textbox");
    await user.type(input, "2 + 2");

    expect(input).toHaveValue("2 + 2");
  });

  it("应该计算表达式并显示结果", async () => {
    const user = userEvent.setup();
    render(<CalculatorPadWindow />);

    const input = screen.getByRole("textbox");
    await user.type(input, "2 + 2");

    await waitFor(() => {
      const result = screen.getByText("4");
      expect(result).toBeInTheDocument();
    });
  });

  it("应该处理错误的表达式", async () => {
    const user = userEvent.setup();
    render(<CalculatorPadWindow />);

    const input = screen.getByRole("textbox");
    await user.type(input, "1 / 0");

    await waitFor(() => {
      // 检查是否有错误显示（可能是 "计算失败" 或其他错误信息）
      const errorElements = screen.queryAllByText(/计算失败|错误|Error|NaN|Infinity/i);
      // 或者检查输入框附近是否有错误提示
      expect(errorElements.length).toBeGreaterThan(0);
    }, { timeout: 3000 });
  });

  it("应该支持多行计算", async () => {
    const user = userEvent.setup();
    render(<CalculatorPadWindow />);

    const input = screen.getByRole("textbox");
    await user.type(input, "2 + 2");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      const inputs = screen.getAllByRole("textbox");
      expect(inputs.length).toBeGreaterThan(1);
    });
  });

  it("应该支持删除行", async () => {
    const user = userEvent.setup();
    render(<CalculatorPadWindow />);

    const input = screen.getByRole("textbox");
    await user.type(input, "2 + 2");
    await user.keyboard("{Enter}");
    await user.type(input, "3 + 3");

    await waitFor(() => {
      const inputs = screen.getAllByRole("textbox");
      expect(inputs.length).toBeGreaterThan(1);
    });

    const secondInput = screen.getAllByRole("textbox")[1];
    secondInput.focus();
    await user.clear(secondInput);
    await user.keyboard("{Backspace}");

    await waitFor(() => {
      const inputs = screen.getAllByRole("textbox");
      expect(inputs.length).toBe(1);
    });
  });

  it("应该支持方向键导航", async () => {
    const user = userEvent.setup();
    render(<CalculatorPadWindow />);

    const input = screen.getByRole("textbox");
    await user.type(input, "2 + 2");
    await user.keyboard("{Enter}");
    await user.type(input, "3 + 3");

    await waitFor(() => {
      const inputs = screen.getAllByRole("textbox");
      expect(inputs.length).toBeGreaterThan(1);
    });

    const firstInput = screen.getAllByRole("textbox")[0];
    firstInput.focus();
    await user.keyboard("{ArrowDown}");

    await waitFor(() => {
      const inputs = screen.getAllByRole("textbox");
      expect(document.activeElement).toBe(inputs[1]);
    });
  });
});

