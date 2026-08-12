import { useState, useEffect, useRef, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { tauriApi } from "../api/tauri";
// 导入 mathjs 并配置高精度
import { create, all } from "mathjs";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useWindowClose } from "../hooks/useWindowClose";

interface CalculationLine {
  id: string;
  expression: string;
  result: string | null;
  error: string | null;
}

// 创建配置了高精度的 mathjs 实例
const math = create(all, {
  number: "BigNumber", // 使用 BigNumber 模式以获得更高精度
  precision: 64, // 设置精度为 64 位
});

// 格式化 mathjs 的计算结果
function formatMathResult(result: any): string {
  // 如果是 BigNumber，转换为字符串
  if (result && typeof result === "object" && result.toString) {
    let str = result.toString();
    
    // 移除末尾的零和小数点（如果小数点后全是零）
    if (str.includes('.')) {
      str = str.replace(/\.?0+$/, '');
    }
    
    // 如果结果包含科学计数法，对于普通范围内的数字尝试转换为普通形式
    if (str.includes('e') || str.includes('E')) {
      const num = parseFloat(str);
      const absNum = Math.abs(num);
      // 对于普通范围内的数字，使用 toFixed 转换为普通形式
      if (absNum >= 1e-6 && absNum < 1e15) {
        str = num.toFixed(15).replace(/\.?0+$/, '');
      }
    }
    
    return str;
  }
  
  // 如果是普通数字，转换为字符串
  if (typeof result === "number") {
    let str = result.toString();
    if (str.includes('.')) {
      str = str.replace(/\.?0+$/, '');
    }
    return str;
  }
  
  return String(result);
}

// 使用 mathjs 进行精确计算
function calculateExpression(expr: string): { result: any; error: string | null } {
  try {
    // 移除所有空格
    expr = expr.trim().replace(/\s+/g, "");
    
    if (!expr) {
      return { result: null, error: null };
    }

    // 安全检查：只允许数字、运算符和括号
    if (!/^[0-9+\-*/%^().\sEe]+$/.test(expr)) {
      return { result: null, error: "包含非法字符" };
    }

    try {
      // 使用 mathjs 的 evaluate 函数进行精确计算
      const result = math.evaluate(expr);
      
      // 检查结果是否有效
      if (result === null || result === undefined || (typeof result === "number" && !isFinite(result))) {
        return { result: null, error: "计算结果无效" };
      }
      
      return { result, error: null };
    } catch (e) {
      return { result: null, error: "表达式错误" };
    }
  } catch (e) {
    return { result: null, error: "计算失败" };
  }
}

export function CalculatorPadWindow() {
  const [lines, setLines] = useState<CalculationLine[]>([
    { id: "1", expression: "", result: null, error: null },
  ]);
  const [_focusedLineId, setFocusedLineId] = useState<string>("1");
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  const applyExpression = useCallback((expression: string) => {
    const trimmed = expression.trim();
    if (!trimmed) return;

    setLines((prevLines) => {
      const newLines = [...prevLines];
      if (newLines.length > 0) {
        newLines[0] = {
          ...newLines[0],
          expression: trimmed,
        };
      } else {
        newLines.push({
          id: "1",
          expression: trimmed,
          result: null,
          error: null,
        });
      }
      return newLines;
    });

    setTimeout(() => {
      const firstInput = inputRefs.current.get("1");
      if (firstInput) {
        firstInput.focus();
        firstInput.setSelectionRange(firstInput.value.length, firstInput.value.length);
      }
    }, 100);
  }, []);

  const pullPendingExpression = useCallback(async () => {
    try {
      const expression = await tauriApi.takeCalculatorPadExpression();
      if (expression?.trim()) {
        applyExpression(expression);
      }
    } catch (error) {
      console.error("Failed to take calculator pad expression:", error);
    }
  }, [applyExpression]);

  // 组件首次挂载时自动聚焦到第一行输入框
  useEffect(() => {
    const timer = setTimeout(() => {
      const firstInput = inputRefs.current.get("1");
      if (firstInput) {
        firstInput.focus();
      }
    }, 100);

    return () => {
      clearTimeout(timer);
    };
  }, []);

  // 从后端拉取待填入的表达式（mount 与窗口聚焦时）
  useEffect(() => {
    let unlistenFocus: (() => void) | null = null;

    const setup = async () => {
      await pullPendingExpression();

      try {
        const window = getCurrentWindow();
        unlistenFocus = await window.onFocusChanged(async ({ payload: focused }) => {
          if (focused) {
            await pullPendingExpression();
          }
        });
      } catch (error) {
        console.error("Failed to setup calculator pad focus listener:", error);
      }
    };

    setup();

    return () => {
      if (unlistenFocus) {
        unlistenFocus();
      }
    };
  }, [pullPendingExpression]);

  // 计算所有行的结果
  // 使用 useMemo 来跟踪表达式变化，避免无限循环
  const expressions = lines.map((l) => l.expression).join("|");
  useEffect(() => {
    setLines((prevLines) =>
      prevLines.map((line) => {
        if (!line.expression.trim()) {
          return { ...line, result: null, error: null };
        }
        const { result, error } = calculateExpression(line.expression);
        return {
          ...line,
          result: result !== null ? formatMathResult(result) : null,
          error,
        };
      })
    );
  }, [expressions]);

  // 添加新行
  const addLine = (afterId?: string) => {
    const newId = Date.now().toString();
    const newLine: CalculationLine = {
      id: newId,
      expression: "",
      result: null,
      error: null,
    };

    if (afterId) {
      const index = lines.findIndex((l) => l.id === afterId);
      if (index >= 0) {
        const newLines = [...lines];
        newLines.splice(index + 1, 0, newLine);
        setLines(newLines);
        setFocusedLineId(newId);
        // 延迟聚焦，确保 DOM 已更新
        setTimeout(() => {
          const input = inputRefs.current.get(newId);
          if (input) {
            input.focus();
          }
        }, 10);
        return;
      }
    }

    setLines([...lines, newLine]);
    setFocusedLineId(newId);
    setTimeout(() => {
      const input = inputRefs.current.get(newId);
      if (input) {
        input.focus();
      }
    }, 10);
  };

  // 删除行
  const deleteLine = (id: string) => {
    if (lines.length === 1) {
      // 如果只剩一行，清空内容而不是删除
      setLines([{ id: lines[0].id, expression: "", result: null, error: null }]);
      setFocusedLineId(lines[0].id);
      setTimeout(() => {
        const input = inputRefs.current.get(lines[0].id);
        if (input) {
          input.focus();
        }
      }, 10);
      return;
    }

    const index = lines.findIndex((l) => l.id === id);
    if (index >= 0) {
      const newLines = lines.filter((l) => l.id !== id);
      setLines(newLines);
      // 聚焦到上一行或下一行
      if (index > 0) {
        setFocusedLineId(newLines[index - 1].id);
      } else if (newLines.length > 0) {
        setFocusedLineId(newLines[0].id);
      }
    }
  };

  // 更新表达式
  const updateExpression = (id: string, expression: string) => {
    setLines((prevLines) =>
      prevLines.map((line) =>
        line.id === id ? { ...line, expression } : line
      )
    );
  };

  // 处理键盘事件
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, lineId: string) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // 在当前行后添加新行
      addLine(lineId);
    } else if (e.key === "Backspace" && e.currentTarget.value === "") {
      // 如果输入框为空，按退格键删除当前行
      e.preventDefault();
      deleteLine(lineId);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const index = lines.findIndex((l) => l.id === lineId);
      if (index < lines.length - 1) {
        setFocusedLineId(lines[index + 1].id);
        setTimeout(() => {
          const input = inputRefs.current.get(lines[index + 1].id);
          if (input) {
            input.focus();
          }
        }, 10);
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const index = lines.findIndex((l) => l.id === lineId);
      if (index > 0) {
        setFocusedLineId(lines[index - 1].id);
        setTimeout(() => {
          const input = inputRefs.current.get(lines[index - 1].id);
          if (input) {
            input.focus();
          }
        }, 10);
      }
    }
  };

  // ESC 键关闭窗口
  const handleClose = useWindowClose();

  useEscapeKey(handleClose);

  // 复制单行结果（只复制结果，不包含表达式）
  const copyLineResult = async (line: CalculationLine) => {
    let textToCopy = "";
    if (line.error) {
      // 如果有错误，不复制
      return;
    } else if (line.result !== null) {
      // 只复制结果
      textToCopy = line.result;
    } else {
      // 没有结果，不复制
      return;
    }

    try {
      await navigator.clipboard.writeText(textToCopy);
      // 可以添加一个提示，但为了不打断用户体验，这里不显示
    } catch (error) {
      console.error("复制失败:", error);
      alert("复制失败，请手动复制");
    }
  };

  // 复制所有结果
  const copyAllResults = async () => {
    const results = lines
      .map((line) => {
        if (line.error) {
          return `${line.expression} = 错误: ${line.error}`;
        } else if (line.result !== null) {
          return `${line.expression} = ${line.result}`;
        } else if (line.expression.trim()) {
          return `${line.expression} = (未计算)`;
        }
        return null;
      })
      .filter((r) => r !== null)
      .join("\n");

    if (results) {
      try {
        await navigator.clipboard.writeText(results);
        alert("已复制所有结果到剪贴板");
      } catch (error) {
        console.error("复制失败:", error);
        alert("复制失败，请手动复制");
      }
    }
  };

  // 清空所有
  const clearAll = () => {
    setLines([{ id: Date.now().toString(), expression: "", result: null, error: null }]);
    setFocusedLineId(lines[0].id);
  };

  return (
    <div className="h-screen w-screen flex flex-col" style={{ backgroundColor: "#fef9e7" }}>
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: "#e5d4a1", backgroundColor: "#fff8dc" }}>
        <h2 className="text-lg font-semibold" style={{ color: "#8b6914" }}>计算稿纸</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={copyAllResults}
            className="px-3 py-1.5 text-sm text-white rounded hover:opacity-90 transition-colors"
            style={{ backgroundColor: "#d4a574" }}
          >
            复制所有结果
          </button>
          <button
            onClick={clearAll}
            className="px-3 py-1.5 text-sm rounded transition-colors"
            style={{ color: "#8b6914", backgroundColor: "#f5e6d3" }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "#e5d4a1"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "#f5e6d3"}
          >
            清空
          </button>
          <button
            onClick={async () => {
              const window = getCurrentWindow();
              await window.close();
            }}
            className="px-3 py-1.5 text-sm rounded transition-colors"
            style={{ color: "#8b6914", backgroundColor: "#f5e6d3" }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "#e5d4a1"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "#f5e6d3"}
          >
            关闭
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4" style={{ backgroundColor: "#fef9e7" }}>
        <div className="max-w-4xl mx-auto space-y-3">
          {lines.map((line, index) => (
            <div
              key={line.id}
              className="flex items-center gap-2 p-3 rounded-lg border transition-colors"
              style={{ 
                backgroundColor: "#fff8dc",
                borderColor: "#e5d4a1"
              }}
              onMouseEnter={(e) => e.currentTarget.style.borderColor = "#d4a574"}
              onMouseLeave={(e) => e.currentTarget.style.borderColor = "#e5d4a1"}
            >
              <div className="flex-1 flex items-center gap-2">
                <span className="text-sm w-8 flex-shrink-0" style={{ color: "#8b6914" }}>
                  {index + 1}.
                </span>
                <input
                  ref={(el) => {
                    if (el) {
                      inputRefs.current.set(line.id, el);
                    } else {
                      inputRefs.current.delete(line.id);
                    }
                  }}
                  type="text"
                  value={line.expression}
                  onChange={(e) => updateExpression(line.id, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(e, line.id)}
                  onFocus={(e) => {
                    setFocusedLineId(line.id);
                    e.currentTarget.style.borderColor = "#d4a574";
                    e.currentTarget.style.boxShadow = "0 0 0 2px rgba(212, 165, 116, 0.2)";
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = "#e5d4a1";
                    e.currentTarget.style.boxShadow = "none";
                  }}
                  placeholder="输入算式，例如: 1 + 2 * 3"
                  className="flex-1 px-3 py-2 border rounded-md focus:outline-none focus:ring-2 font-mono text-sm"
                  style={{
                    backgroundColor: "#fffef5",
                    borderColor: "#e5d4a1",
                    color: "#5a4a2a"
                  }}
                />
                <span className="mx-2" style={{ color: "#8b6914" }}>=</span>
                <div className="flex-1 min-w-[120px]">
                  {line.error ? (
                    <span className="text-sm" style={{ color: "#c44e4e" }}>错误: {line.error}</span>
                  ) : line.result !== null ? (
                    <span className="font-semibold text-sm" style={{ color: "#5a7c3a" }}>
                      {line.result}
                    </span>
                  ) : line.expression.trim() ? (
                    <span className="text-sm" style={{ color: "#a68b5b" }}>(计算中...)</span>
                  ) : (
                    <span className="text-sm" style={{ color: "#c9b99a" }}>(等待输入)</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => copyLineResult(line)}
                  className="px-2 py-1 text-xs rounded transition-colors"
                  style={{ color: "#5a7c3a", backgroundColor: "#f5e6d3" }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "#e5d4a1"}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "#f5e6d3"}
                  title="复制此行结果"
                >
                  复制
                </button>
                <button
                  onClick={() => deleteLine(line.id)}
                  className="px-2 py-1 text-xs rounded transition-colors"
                  style={{ color: "#c44e4e", backgroundColor: "#f5e6d3" }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "#e5d4a1"}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "#f5e6d3"}
                  title="删除此行"
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* 提示信息 */}
        <div className="max-w-4xl mx-auto mt-6 p-4 rounded-lg border" style={{ backgroundColor: "#fff8dc", borderColor: "#e5d4a1" }}>
          <div className="text-sm" style={{ color: "#8b6914" }}>
            <div className="font-semibold mb-2">使用提示：</div>
            <ul className="list-disc list-inside space-y-1" style={{ color: "#6b5a2a" }}>
              <li>按 <kbd className="px-1.5 py-0.5 rounded" style={{ backgroundColor: "#f5e6d3" }}>Enter</kbd> 键添加新行</li>
              <li>在空行按 <kbd className="px-1.5 py-0.5 rounded" style={{ backgroundColor: "#f5e6d3" }}>Backspace</kbd> 键删除该行</li>
              <li>使用 <kbd className="px-1.5 py-0.5 rounded" style={{ backgroundColor: "#f5e6d3" }}>↑</kbd> / <kbd className="px-1.5 py-0.5 rounded" style={{ backgroundColor: "#f5e6d3" }}>↓</kbd> 键在行间导航</li>
              <li>支持基本运算：+、-、*、/、()</li>
              <li>按 <kbd className="px-1.5 py-0.5 rounded" style={{ backgroundColor: "#f5e6d3" }}>ESC</kbd> 键关闭窗口</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

