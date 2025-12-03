import { useState, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import Editor from "@monaco-editor/react";
import type { editor } from "monaco-editor";

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
  const [mode, setMode] = useState<"split" | "single">("single"); // 模式：分栏模式或单框模式
  const [singleModeInput, setSingleModeInput] = useState<string>(""); // 单框模式下的输入内容（使用 state）
  
  const shouldPreserveExpandedRef = useRef(false);
  const singleModeEditingRef = useRef<boolean>(false); // 单框模式下是否正在编辑
  const formatTimeoutRef = useRef<number | null>(null); // 格式化防抖定时器
  const monacoEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null); // Monaco Editor 实例


  // 监听来自启动器的 JSON 内容设置事件
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupListener = async () => {
      try {
        unlisten = await listen<string>("json-formatter:set-content", (event) => {
          const jsonContent = event.payload;
          if (jsonContent) {
            // 自动格式化
            try {
              const parsed = JSON.parse(jsonContent);
              const formattedJson = JSON.stringify(parsed, null, indent);
              setFormatted(formattedJson);
              setParsedData(parsed);
              setError(null);
              
              // 同时更新两个状态，确保无论当前模式如何都能正确显示
              setInput(jsonContent); // 分栏模式使用
              setSingleModeInput(formattedJson); // 单框模式使用格式化后的内容
              
              // 默认展开所有节点
              const allPaths = getAllPaths(parsed, "");
              setExpandedPaths(new Set(allPaths));
            } catch (e) {
              const errorMessage = e instanceof Error ? e.message : "JSON 格式错误";
              setError(errorMessage);
              setFormatted("");
              setParsedData(null);
              // 即使解析失败，也显示原始内容
              setInput(jsonContent);
              setSingleModeInput(jsonContent);
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

  // 格式化输入的 JSON 内容
  const formatJsonContent = (content: string, preserveCursor: boolean = false) => {
    if (!content.trim()) {
      setFormatted("");
      setParsedData(null);
      setError(null);
      setExpandedPaths(new Set());
      shouldPreserveExpandedRef.current = false;
      return;
    }

    try {
      const parsed = JSON.parse(content);
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

      // 如果需要在格式化后恢复光标位置（单框模式）
      if (preserveCursor && mode === "single" && !singleModeEditingRef.current) {
        // 更新 singleModeInput state
        // Monaco Editor 会自动处理光标位置
        setSingleModeInput(formattedJson);
      }
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "JSON 格式错误";
      setError(errorMessage);
      setFormatted("");
      setParsedData(null);
    }
  };

  // 实时格式化：监听 input 变化（分栏模式）
  useEffect(() => {
    if (mode === "split") {
      formatJsonContent(input);
    }
  }, [input, indent, mode]);

  // 当缩进改变时，如果单框模式有内容且不在编辑状态，重新格式化
  useEffect(() => {
    if (mode === "single" && singleModeInput && !singleModeEditingRef.current && formatted) {
      formatJsonContent(singleModeInput, true);
    }
  }, [indent]);

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

  // 折叠所有（只展开根节点）
  const collapseAll = () => {
    shouldPreserveExpandedRef.current = true; // 标记用户已手动调整展开状态
    // 只保留根节点（空字符串路径）展开
    setExpandedPaths(new Set([""]));
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
    setSingleModeInput("");
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
      // 改进：引号和内容颜色区分
      return (
        <span>
          <span style={{ color: "#dc2626", opacity: 0.7 }}>"</span>
          <span style={{ color: "#dc2626" }}>{value}</span>
          <span style={{ color: "#dc2626", opacity: 0.7 }}>"</span>
          {showComma && <span style={{ color: "#6b7280" }}>,</span>}
        </span>
      );
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
              marginRight: "4px",
            }}
          >
            {isExpanded ? "▼" : "▶"}
          </span>
          <span style={{ color: "#6b7280" }}>[</span>
          {isEmpty && <span style={{ color: "#6b7280" }}>]</span>}
          {!isEmpty && (
            <>
              {isExpanded && (
                <div style={{ marginLeft: `${indent * 8}px` }}>
                  {value.map((item, index) => {
                    const itemPath = `${path}[${index}]`;
                    const isLast = index === value.length - 1;
                    return (
                      <div key={index} style={{ marginTop: "2px", marginBottom: "2px" }}>
                        <span style={{ color: "#9ca3af", fontWeight: 500, marginRight: "6px" }}>{index}:</span>
                        {renderJsonValue(item, itemPath, "", !isLast)}
                      </div>
                    );
                  })}
                </div>
              )}
              {!isExpanded && (
                <>
                  <span style={{ color: "#6b7280", marginLeft: "4px" }}>
                    {value.length} items
                  </span>
                  <span style={{ color: "#6b7280" }}>]</span>
                  {showComma && <span style={{ color: "#6b7280" }}>,</span>}
                </>
              )}
              {isExpanded && (
                <div>
                  <span
                    onClick={() => toggleExpand(path)}
                    style={{
                      cursor: "pointer",
                      userSelect: "none",
                      color: "#3b82f6",
                    }}
                  >
                    <span style={{ color: "#6b7280" }}>]</span>
                    {showComma && <span style={{ color: "#6b7280" }}>,</span>}
                  </span>
                </div>
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
              marginRight: "4px",
            }}
          >
            {isExpanded ? "▼" : "▶"}
          </span>
          <span style={{ color: "#6b7280" }}>{"{"}</span>
          {isEmpty && <span style={{ color: "#6b7280" }}>{"}"}</span>}
          {!isEmpty && (
            <>
              {isExpanded && (
                <div style={{ marginLeft: `${indent * 8}px` }}>
                  {keys.map((k, index) => {
                    const itemPath = path ? `${path}.${k}` : k;
                    const isLast = index === keys.length - 1;
                    return (
                      <div key={k} style={{ marginTop: "2px", marginBottom: "2px", display: "flex", alignItems: "flex-start" }}>
                        <span style={{ color: "#7c3aed", marginRight: "8px", fontWeight: 500 }}>"{k}"</span>
                        <span style={{ color: "#6b7280", marginRight: "6px" }}>:</span>
                        <div style={{ flex: 1 }}>
                          {renderJsonValue(obj[k], itemPath, k, !isLast)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {!isExpanded && (
                <>
                  <span style={{ color: "#6b7280", marginLeft: "4px" }}>
                    {keys.length} keys
                  </span>
                  <span style={{ color: "#6b7280" }}>{"}"}</span>
                  {showComma && <span style={{ color: "#6b7280" }}>,</span>}
                </>
              )}
              {isExpanded && (
                <div>
                  <span
                    onClick={() => toggleExpand(path)}
                    style={{
                      cursor: "pointer",
                      userSelect: "none",
                      color: "#3b82f6",
                    }}
                  >
                    <span style={{ color: "#6b7280" }}>{"}"}</span>
                    {showComma && <span style={{ color: "#6b7280" }}>,</span>}
                  </span>
                </div>
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
        height: "100%",
        width: "100%",
        backgroundColor: "#1e1e1e", // 深色背景
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        color: "#cccccc", // 默认文本颜色
      }}
    >
      {/* 标题栏 */}
      <div
        style={{
          padding: "16px 20px",
          backgroundColor: "#252526", // 深色标题栏
          borderBottom: "1px solid #3e3e42", // 深色边框
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
            color: "#cccccc", // 浅色文字
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
          backgroundColor: "#252526", // 深色工具栏
          borderBottom: "1px solid #3e3e42", // 深色边框
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
          <button
            onClick={() => {
              const newMode = mode === "split" ? "single" : "split";
              setMode(newMode);
              if (newMode === "single" && input) {
                // 切换到单框模式时，将当前输入内容同步到单框模式
                setSingleModeInput(input);
                formatJsonContent(input);
              } else if (newMode === "split" && singleModeInput) {
                // 切换回分栏模式时，将单框模式的内容同步到输入框
                setInput(singleModeInput);
              }
            }}
            style={{
              padding: "6px 12px",
              backgroundColor: mode === "single" ? "#6366f1" : "#3c3c3c", // 深色模式按钮
              color: mode === "single" ? "white" : "#cccccc", // 浅色文字
              border: "none",
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "13px",
              fontWeight: 500,
            }}
            onMouseOver={(e) => {
              if (mode === "split") {
                e.currentTarget.style.backgroundColor = "#4a4a4a"; // 深色 hover
              }
            }}
            onMouseOut={(e) => {
              if (mode === "split") {
                e.currentTarget.style.backgroundColor = "#3c3c3c"; // 深色背景
              }
            }}
          >
            {mode === "split" ? "单框模式" : "分栏模式"}
          </button>
          <label style={{ fontSize: "14px", color: "#cccccc" }}>缩进:</label>
          <select
            value={indent}
            onChange={(e) => setIndent(Number(e.target.value))}
            style={{
              padding: "6px 10px",
              border: "1px solid #3e3e42", // 深色边框
              borderRadius: "6px",
              fontSize: "14px",
              backgroundColor: "#3c3c3c", // 深色下拉框背景
              color: "#cccccc", // 浅色文字
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
            backgroundColor: "#3c1f1f", // 深色错误背景
            borderBottom: "1px solid #5a2a2a", // 深色错误边框
            color: "#f48771", // 浅色错误文字
            fontSize: "14px",
          }}
        >
          <strong>错误:</strong> {error}
        </div>
      )}

      {/* 主内容区 */}
      {mode === "split" ? (
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
              backgroundColor: "#1e1e1e", // 深色背景
            }}
          >
            <div
              style={{
                padding: "8px 12px",
                backgroundColor: "#2d2d30", // 深色区域标题
                borderBottom: "1px solid #3e3e42", // 深色边框
                fontSize: "13px",
                fontWeight: 500,
                color: "#cccccc", // 浅色文字
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
                backgroundColor: "#1e1e1e", // 深色背景
                color: "#cccccc", // 浅色文字
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
              backgroundColor: "#1e1e1e", // 深色背景
              borderLeft: "1px solid #3e3e42", // 深色边框
            }}
          >
            <div
              style={{
                padding: "8px 12px",
                backgroundColor: "#2d2d30", // 深色区域标题
                borderBottom: "1px solid #3e3e42", // 深色边框
                fontSize: "13px",
                fontWeight: 500,
                color: "#cccccc", // 浅色文字
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
                lineHeight: "1.6",
                backgroundColor: "#1e1e1e", // 深色背景
                color: "#cccccc", // 浅色文字
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
                    color: "#cccccc", // 浅色文字
                  }}
                >
                  {formatted}
                </pre>
              ) : (
                <div style={{ color: "#858585" }}>格式化后的 JSON 将显示在这里...</div>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* 单框模式：可编辑的格式化结果 */
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            backgroundColor: "#1e1e1e", // 深色背景
            overflow: "auto",
            height: "100%",
          }}
        >
          <div
            style={{
              padding: "8px 12px",
              backgroundColor: "#2d2d30", // 深色区域标题
              borderBottom: "1px solid #3e3e42", // 深色边框
              fontSize: "13px",
              fontWeight: 500,
              color: "#cccccc", // 浅色文字
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>JSON 编辑器（所见即所得）</span>
            <div style={{ display: "flex", gap: "8px", fontSize: "12px", alignItems: "center" }}>
              {formatted && (
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(formatted || singleModeInput);
                      alert("已复制到剪贴板");
                    } catch (e) {
                      console.error("复制失败:", e);
                      alert("复制失败，请手动复制");
                    }
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
              )}
            </div>
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            {/* 文本编辑区 - 使用 Monaco Editor */}
            <Editor
              height="100%"
              language="json"
              value={singleModeInput}
              onChange={(value) => {
                if (value !== undefined) {
                  setSingleModeInput(value);
                  singleModeEditingRef.current = true;
                  
                  // 清除之前的定时器
                  if (formatTimeoutRef.current) {
                    window.clearTimeout(formatTimeoutRef.current);
                  }
                  
                  // 防抖：停止输入 500ms 后自动格式化
                  formatTimeoutRef.current = window.setTimeout(() => {
                    singleModeEditingRef.current = false;
                    formatJsonContent(value, true);
                  }, 500);
                }
              }}
              onMount={(editor) => {
                monacoEditorRef.current = editor;
                // 监听失去焦点事件
                editor.onDidBlurEditorText(() => {
                  // 失去焦点时立即格式化
                  if (formatTimeoutRef.current) {
                    window.clearTimeout(formatTimeoutRef.current);
                  }
                  singleModeEditingRef.current = false;
                  formatJsonContent(singleModeInput, true);
                });
              }}
              options={{
                fontSize: 14,
                fontFamily: "'Courier New', monospace",
                lineNumbers: "on",
                folding: true,
                foldingStrategy: "indentation",
                showFoldingControls: "always",
                wordWrap: "on",
                minimap: { 
                  enabled: true, // 启用右侧导航缩略图
                  renderCharacters: true, // 渲染字符（对应右键菜单的 "Render Characters"）
                  maxColumn: 120, // 最大列数
                  showSlider: "always", // 显示滑块：always（总是）、mouseover（鼠标悬停时）
                  side: "right", // 位置：右侧
                  size: "fill", // 垂直大小：proportional（比例）、fill（填充）、fit（适应）
                },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: indent,
                insertSpaces: true,
                formatOnPaste: false,
                formatOnType: false,
                padding: { top: 12, bottom: 12 },
                lineDecorationsWidth: 10,
                lineNumbersMinChars: 3,
                renderLineHighlight: "all",
                matchBrackets: "always",
                bracketPairColorization: { enabled: true },
              }}
              theme="vs-dark" // 使用黑色主题
            />
          </div>
        </div>
      )}
    </div>
  );
}

