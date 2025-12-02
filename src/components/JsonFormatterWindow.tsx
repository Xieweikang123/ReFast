import { useState, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
type JsonObject = { [key: string]: JsonValue };
type JsonArray = JsonValue[];

export function JsonFormatterWindow() {
  const [input, setInput] = useState("");
  const [formatted, setFormatted] = useState("");
  const [parsedData, setParsedData] = useState<JsonValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [indent, setIndent] = useState(2);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const shouldPreserveExpandedRef = useRef(false);

  // 监听来自启动器的 JSON 内容设置事件
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupListener = async () => {
      try {
        unlisten = await listen<string>("json-formatter:set-content", (event) => {
          const jsonContent = event.payload;
          if (jsonContent) {
            setInput(jsonContent);
            // 自动格式化
            try {
              const parsed = JSON.parse(jsonContent);
              const formattedJson = JSON.stringify(parsed, null, indent);
              setFormatted(formattedJson);
              setParsedData(parsed);
              setError(null);
              // 默认展开所有节点
              const allPaths = getAllPaths(parsed, "");
              setExpandedPaths(new Set(allPaths));
            } catch (e) {
              const errorMessage = e instanceof Error ? e.message : "JSON 格式错误";
              setError(errorMessage);
              setFormatted("");
              setParsedData(null);
            }
          }
        });
      } catch (error) {
        console.error("Failed to setup JSON formatter event listener:", error);
      }
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [indent]);

  // 实时格式化：监听 input 变化
  useEffect(() => {
    if (!input.trim()) {
      setFormatted("");
      setParsedData(null);
      setError(null);
      setExpandedPaths(new Set());
      shouldPreserveExpandedRef.current = false;
      return;
    }

    try {
      const parsed = JSON.parse(input);
      const formattedJson = JSON.stringify(parsed, null, indent);
      setFormatted(formattedJson);
      setParsedData(parsed);
      setError(null);
      
      // 实时格式化时，如果是第一次格式化，展开所有
      // 如果用户已经手动调整了展开状态，尽量保持
      if (!shouldPreserveExpandedRef.current) {
        const allPaths = getAllPaths(parsed, "");
        setExpandedPaths(new Set(allPaths));
      }
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "JSON 格式错误";
      setError(errorMessage);
      setFormatted("");
      setParsedData(null);
    }
  }, [input, indent]);

  // 格式化 JSON
  const handleFormat = () => {
    if (!input.trim()) {
      setError("请输入 JSON 内容");
      setFormatted("");
      setParsedData(null);
      return;
    }

    try {
      const parsed = JSON.parse(input);
      const formattedJson = JSON.stringify(parsed, null, indent);
      setFormatted(formattedJson);
      setParsedData(parsed);
      setError(null);
      // 格式化时展开所有节点
      shouldPreserveExpandedRef.current = true;
      const allPaths = getAllPaths(parsed, "");
      setExpandedPaths(new Set(allPaths));
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "JSON 格式错误";
      setError(errorMessage);
      setFormatted("");
      setParsedData(null);
    }
  };

  // 获取所有路径（用于展开所有）
  const getAllPaths = (value: JsonValue, prefix: string): string[] => {
    const paths: string[] = [];
    // 只有当值是对象或数组时才添加路径（因为它们可以展开）
    // 包括根节点（空字符串）
    if (Array.isArray(value) || (value !== null && typeof value === "object")) {
      paths.push(prefix);
    }
    
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        // 对于根数组，路径是 [0], [1] 等
        // 对于嵌套数组，路径是 parent[0], parent[1] 等
        const path = prefix ? `${prefix}[${index}]` : `[${index}]`;
        paths.push(...getAllPaths(item, path));
      });
    } else if (value !== null && typeof value === "object") {
      Object.keys(value).forEach((key) => {
        // 对于根对象，路径是 key
        // 对于嵌套对象，路径是 parent.key
        const path = prefix ? `${prefix}.${key}` : key;
        paths.push(...getAllPaths((value as JsonObject)[key], path));
      });
    }
    return paths;
  };

  // 切换展开/折叠
  const toggleExpand = (path: string) => {
    shouldPreserveExpandedRef.current = true; // 标记用户已手动调整展开状态
    setExpandedPaths((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(path)) {
        newSet.delete(path);
      } else {
        newSet.add(path);
      }
      return newSet;
    });
  };

  // 展开所有
  const expandAll = () => {
    shouldPreserveExpandedRef.current = true; // 标记用户已手动调整展开状态
    if (parsedData) {
      const allPaths = getAllPaths(parsedData, "");
      setExpandedPaths(new Set(allPaths));
    }
  };

  // 折叠所有
  const collapseAll = () => {
    shouldPreserveExpandedRef.current = true; // 标记用户已手动调整展开状态
    setExpandedPaths(new Set());
  };

  // 压缩 JSON
  const handleMinify = () => {
    if (!input.trim()) {
      setError("请输入 JSON 内容");
      setFormatted("");
      setParsedData(null);
      return;
    }

    try {
      const parsed = JSON.parse(input);
      const minified = JSON.stringify(parsed);
      setFormatted(minified);
      // 压缩模式下不显示树形视图，只显示文本
      setParsedData(null);
      setError(null);
      setExpandedPaths(new Set());
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "JSON 格式错误";
      setError(errorMessage);
      setFormatted("");
      setParsedData(null);
    }
  };

  // 验证 JSON
  const handleValidate = () => {
    if (!input.trim()) {
      setError("请输入 JSON 内容");
      return;
    }

    try {
      JSON.parse(input);
      setError(null);
      alert("JSON 格式正确！");
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "JSON 格式错误";
      setError(errorMessage);
    }
  };

  // 复制到剪贴板
  const handleCopy = async () => {
    // 如果有解析的数据，复制格式化后的文本；否则复制 formatted
    const textToCopy = parsedData 
      ? JSON.stringify(parsedData, null, indent)
      : formatted;
    
    if (!textToCopy) return;

    try {
      await navigator.clipboard.writeText(textToCopy);
      alert("已复制到剪贴板");
    } catch (e) {
      console.error("复制失败:", e);
      alert("复制失败，请手动复制");
    }
  };

  // 清空
  const handleClear = () => {
    setInput("");
    setFormatted("");
    setParsedData(null);
    setError(null);
    setExpandedPaths(new Set());
    shouldPreserveExpandedRef.current = false;
  };

  // 渲染 JSON 值
  const renderJsonValue = (value: JsonValue, path: string, _key: string = "", showComma: boolean = false): JSX.Element => {
    const isExpanded = expandedPaths.has(path);
    
    if (value === null) {
      return <span style={{ color: "#6b7280" }}>null{showComma && <span style={{ color: "#6b7280" }}>,</span>}</span>;
    }
    
    if (typeof value === "boolean") {
      return <span style={{ color: "#8b5cf6" }}>{value.toString()}{showComma && <span style={{ color: "#6b7280" }}>,</span>}</span>;
    }
    
    if (typeof value === "number") {
      return <span style={{ color: "#059669" }}>{value}{showComma && <span style={{ color: "#6b7280" }}>,</span>}</span>;
    }
    
    if (typeof value === "string") {
      return <span style={{ color: "#dc2626" }}>"{value}"{showComma && <span style={{ color: "#6b7280" }}>,</span>}</span>;
    }
    
    if (Array.isArray(value)) {
      const isEmpty = value.length === 0;
      return (
        <div>
          <span
            onClick={() => toggleExpand(path)}
            style={{
              cursor: "pointer",
              userSelect: "none",
              color: "#3b82f6",
              fontWeight: 500,
            }}
          >
            {isExpanded ? "▼" : "▶"} {"["}
          </span>
          {isEmpty && <span style={{ color: "#6b7280" }}> {"]"}</span>}
          {!isEmpty && (
            <>
              {isExpanded && (
                <div style={{ marginLeft: "20px" }}>
                  {value.map((item, index) => {
                    const itemPath = `${path}[${index}]`;
                    const isLast = index === value.length - 1;
                    return (
                      <div key={index} style={{ marginTop: "4px" }}>
                        <span style={{ color: "#6b7280" }}>{index}: </span>
                        {renderJsonValue(item, itemPath, "", !isLast)}
                      </div>
                    );
                  })}
                </div>
              )}
              {!isExpanded && (
                <span style={{ color: "#6b7280", marginLeft: "4px" }}>
                  {value.length} items
                </span>
              )}
              {isExpanded && (
                <span
                  onClick={() => toggleExpand(path)}
                  style={{
                    cursor: "pointer",
                    userSelect: "none",
                    color: "#3b82f6",
                  }}
                >
                  ]{showComma && <span style={{ color: "#6b7280" }}>,</span>}
                </span>
              )}
            </>
          )}
        </div>
      );
    }
    
    if (typeof value === "object") {
      const obj = value as JsonObject;
      const keys = Object.keys(obj);
      const isEmpty = keys.length === 0;
      
      return (
        <div style={{ display: "inline-block", verticalAlign: "top" }}>
          <span
            onClick={() => toggleExpand(path)}
            style={{
              cursor: "pointer",
              userSelect: "none",
              color: "#3b82f6",
              fontWeight: 500,
            }}
          >
            {isExpanded ? "▼" : "▶"} {"{"}
          </span>
          {isEmpty && <span style={{ color: "#6b7280" }}> {"}"}</span>}
          {!isEmpty && (
            <>
              {isExpanded && (
                <div style={{ marginLeft: "20px" }}>
                  {keys.map((k, index) => {
                    const itemPath = path ? `${path}.${k}` : k;
                    const isLast = index === keys.length - 1;
                    return (
                      <div key={k} style={{ marginTop: "4px", display: "flex", alignItems: "flex-start" }}>
                        <span style={{ color: "#059669", marginRight: "4px" }}>"{k}":</span>
                        <div style={{ flex: 1 }}>
                          {renderJsonValue(obj[k], itemPath, k, !isLast)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {!isExpanded && (
                <span style={{ color: "#6b7280", marginLeft: "4px" }}>
                  {keys.length} keys
                </span>
              )}
              {isExpanded && (
                <span
                  onClick={() => toggleExpand(path)}
                  style={{
                    cursor: "pointer",
                    userSelect: "none",
                    color: "#3b82f6",
                  }}
                >
                  {"}"}
                </span>
              )}
            </>
          )}
        </div>
      );
    }
    
    return <span>{String(value)}</span>;
  };

  // ESC 键关闭窗口
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const window = getCurrentWindow();
        await window.close();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        backgroundColor: "#f9fafb",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      {/* 标题栏 */}
      <div
        style={{
          padding: "16px 20px",
          backgroundColor: "#ffffff",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: "18px",
            fontWeight: 600,
            color: "#111827",
          }}
        >
          JSON 格式化查看器
        </h1>
        <button
          onClick={async () => {
            const window = getCurrentWindow();
            await window.close();
          }}
          style={{
            padding: "6px 12px",
            backgroundColor: "#ef4444",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "14px",
            fontWeight: 500,
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.backgroundColor = "#dc2626";
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.backgroundColor = "#ef4444";
          }}
        >
          关闭
        </button>
      </div>

      {/* 工具栏 */}
      <div
        style={{
          padding: "12px 20px",
          backgroundColor: "#ffffff",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          gap: "8px",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <button
          onClick={handleFormat}
          style={{
            padding: "8px 16px",
            backgroundColor: "#3b82f6",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "14px",
            fontWeight: 500,
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.backgroundColor = "#2563eb";
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.backgroundColor = "#3b82f6";
          }}
        >
          格式化
        </button>
        <button
          onClick={handleMinify}
          style={{
            padding: "8px 16px",
            backgroundColor: "#10b981",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "14px",
            fontWeight: 500,
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.backgroundColor = "#059669";
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.backgroundColor = "#10b981";
          }}
        >
          压缩
        </button>
        <button
          onClick={handleValidate}
          style={{
            padding: "8px 16px",
            backgroundColor: "#8b5cf6",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "14px",
            fontWeight: 500,
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.backgroundColor = "#7c3aed";
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.backgroundColor = "#8b5cf6";
          }}
        >
          验证
        </button>
        <button
          onClick={handleCopy}
          disabled={!formatted && !parsedData}
          style={{
            padding: "8px 16px",
            backgroundColor: (formatted || parsedData) ? "#6366f1" : "#9ca3af",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: (formatted || parsedData) ? "pointer" : "not-allowed",
            fontSize: "14px",
            fontWeight: 500,
          }}
          onMouseOver={(e) => {
            if (formatted || parsedData) {
              e.currentTarget.style.backgroundColor = "#4f46e5";
            }
          }}
          onMouseOut={(e) => {
            if (formatted || parsedData) {
              e.currentTarget.style.backgroundColor = "#6366f1";
            }
          }}
        >
          复制结果
        </button>
        <button
          onClick={expandAll}
          disabled={!parsedData}
          style={{
            padding: "8px 16px",
            backgroundColor: parsedData ? "#f59e0b" : "#9ca3af",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: parsedData ? "pointer" : "not-allowed",
            fontSize: "14px",
            fontWeight: 500,
          }}
          onMouseOver={(e) => {
            if (parsedData) {
              e.currentTarget.style.backgroundColor = "#d97706";
            }
          }}
          onMouseOut={(e) => {
            if (parsedData) {
              e.currentTarget.style.backgroundColor = "#f59e0b";
            }
          }}
        >
          展开全部
        </button>
        <button
          onClick={collapseAll}
          disabled={!parsedData}
          style={{
            padding: "8px 16px",
            backgroundColor: parsedData ? "#f59e0b" : "#9ca3af",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: parsedData ? "pointer" : "not-allowed",
            fontSize: "14px",
            fontWeight: 500,
          }}
          onMouseOver={(e) => {
            if (parsedData) {
              e.currentTarget.style.backgroundColor = "#d97706";
            }
          }}
          onMouseOut={(e) => {
            if (parsedData) {
              e.currentTarget.style.backgroundColor = "#f59e0b";
            }
          }}
        >
          折叠全部
        </button>
        <button
          onClick={handleClear}
          style={{
            padding: "8px 16px",
            backgroundColor: "#6b7280",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "14px",
            fontWeight: 500,
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.backgroundColor = "#4b5563";
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.backgroundColor = "#6b7280";
          }}
        >
          清空
        </button>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" }}>
          <label style={{ fontSize: "14px", color: "#374151" }}>缩进:</label>
          <select
            value={indent}
            onChange={(e) => setIndent(Number(e.target.value))}
            style={{
              padding: "6px 10px",
              border: "1px solid #d1d5db",
              borderRadius: "6px",
              fontSize: "14px",
              backgroundColor: "white",
              cursor: "pointer",
            }}
          >
            <option value={2}>2 空格</option>
            <option value={4}>4 空格</option>
            <option value={0}>无缩进</option>
          </select>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div
          style={{
            padding: "12px 20px",
            backgroundColor: "#fef2f2",
            borderBottom: "1px solid #fecaca",
            color: "#dc2626",
            fontSize: "14px",
          }}
        >
          <strong>错误:</strong> {error}
        </div>
      )}

      {/* 主内容区 */}
      <div
        style={{
          flex: 1,
          display: "flex",
          gap: "1px",
          overflow: "hidden",
        }}
      >
        {/* 输入区域 */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            backgroundColor: "#ffffff",
          }}
        >
          <div
            style={{
              padding: "8px 12px",
              backgroundColor: "#f3f4f6",
              borderBottom: "1px solid #e5e7eb",
              fontSize: "13px",
              fontWeight: 500,
              color: "#374151",
            }}
          >
            输入 JSON
          </div>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="在此粘贴或输入 JSON 内容..."
            style={{
              flex: 1,
              padding: "12px",
              border: "none",
              outline: "none",
              resize: "none",
              fontFamily: "'Courier New', monospace",
              fontSize: "14px",
              lineHeight: "1.6",
              backgroundColor: "#ffffff",
              color: "#111827",
            }}
            spellCheck={false}
          />
        </div>

        {/* 输出区域 */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            backgroundColor: "#ffffff",
            borderLeft: "1px solid #e5e7eb",
          }}
        >
          <div
            style={{
              padding: "8px 12px",
              backgroundColor: "#f3f4f6",
              borderBottom: "1px solid #e5e7eb",
              fontSize: "13px",
              fontWeight: 500,
              color: "#374151",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>格式化结果</span>
            {parsedData && (
              <div style={{ display: "flex", gap: "8px", fontSize: "12px" }}>
                <button
                  onClick={() => {
                    const textarea = document.createElement("textarea");
                    textarea.value = formatted;
                    document.body.appendChild(textarea);
                    textarea.select();
                    document.execCommand("copy");
                    document.body.removeChild(textarea);
                    alert("已复制到剪贴板");
                  }}
                  style={{
                    padding: "4px 8px",
                    backgroundColor: "#6366f1",
                    color: "white",
                    border: "none",
                    borderRadius: "4px",
                    cursor: "pointer",
                    fontSize: "12px",
                  }}
                >
                  复制文本
                </button>
              </div>
            )}
          </div>
          <div
            style={{
              flex: 1,
              padding: "12px",
              overflow: "auto",
              fontFamily: "'Courier New', monospace",
              fontSize: "14px",
              lineHeight: "1.8",
              backgroundColor: "#ffffff",
              color: "#111827",
            }}
          >
            {parsedData ? (
              renderJsonValue(parsedData, "")
            ) : formatted ? (
              <pre
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {formatted}
              </pre>
            ) : (
              <div style={{ color: "#9ca3af" }}>格式化后的 JSON 将显示在这里...</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

