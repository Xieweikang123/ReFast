import { useState, useEffect, useRef, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import Editor from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useEscapeKey } from "../hooks/useEscapeKey";

type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
type JsonObject = { [key: string]: JsonValue };
type JsonArray = JsonValue[];

const DEFAULT_INDENT = 2; // 固定缩进为 2 空格

export function JsonFormatterWindow() {
  const [input, setInput] = useState("");
  const [formatted, setFormatted] = useState("");
  const [parsedData, setParsedData] = useState<JsonValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"split" | "single">("single"); // 模式：分栏模式或单框模式
  const [singleModeInput, setSingleModeInput] = useState<string>(""); // 单框模式下的输入内容（使用 state）
  
  const shouldPreserveExpandedRef = useRef(false);
  const singleModeEditingRef = useRef<boolean>(false); // 单框模式下是否正在编辑
  const formatTimeoutRef = useRef<number | null>(null); // 格式化防抖定时器
  const monacoEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null); // Monaco Editor 实例


  // 处理 JSON 内容的函数
  const handleJsonContent = useCallback((jsonContent: string) => {
    if (!jsonContent) return;
    
    // 自动格式化
    try {
      const parsed = JSON.parse(jsonContent);
      const formattedJson = JSON.stringify(parsed, null, DEFAULT_INDENT);
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
  }, []);

  // 发送就绪信号的函数
  const sendReadySignal = useCallback(async () => {
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("json-formatter:ready");
    } catch (error) {
      console.error("Failed to emit ready signal:", error);
    }
  }, []);

  // 监听来自启动器的 JSON 内容设置事件
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let unlistenFocus: (() => void) | null = null;

    const setupListener = async () => {
      try {
        const window = getCurrentWindow();
        
        // 监听内容设置事件
        unlisten = await listen<string>("json-formatter:set-content", (event) => {
          handleJsonContent(event.payload);
        });
        
        // 监听窗口聚焦事件，当窗口显示时发送就绪信号
        unlistenFocus = await window.onFocusChanged(async ({ payload: focused }) => {
          if (focused) {
            // 窗口获得焦点时，发送就绪信号
            await sendReadySignal();
          }
        });
        
        // 组件挂载后，发送就绪信号，通知启动器窗口已准备好接收内容
        // 延迟一小段时间确保监听器已完全设置好
        setTimeout(() => {
          sendReadySignal();
        }, 100);
      } catch (error) {
        console.error("Failed to setup JSON formatter event listener:", error);
      }
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
      if (unlistenFocus) {
        unlistenFocus();
      }
    };
  }, [handleJsonContent, sendReadySignal]);

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
      const formattedJson = JSON.stringify(parsed, null, DEFAULT_INDENT);
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
  }, [input, mode]);

  // 格式化 JSON
  const handleFormat = () => {
    // 根据当前模式选择数据源
    const content = mode === "single" ? singleModeInput : input;
    
    if (!content.trim()) {
      setError("请输入 JSON 内容");
      setFormatted("");
      setParsedData(null);
      return;
    }

    try {
      const parsed = JSON.parse(content);
      const formattedJson = JSON.stringify(parsed, null, DEFAULT_INDENT);
      setFormatted(formattedJson);
      setParsedData(parsed);
      setError(null);
      
      // 如果是单框模式，更新编辑器内容
      if (mode === "single") {
        setSingleModeInput(formattedJson);
      }
      
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
    
    // 如果是单框模式且 Monaco Editor 已初始化，使用 Monaco Editor 的展开功能
    if (mode === "single" && monacoEditorRef.current) {
      const editor = monacoEditorRef.current;
      const unfoldAllAction = editor.getAction('editor.unfoldAll');
      if (unfoldAllAction) {
        unfoldAllAction.run();
      }
    } else if (parsedData) {
      // 分栏模式：使用树形视图的展开功能
      const allPaths = getAllPaths(parsedData, "");
      setExpandedPaths(new Set(allPaths));
    }
  };

  // 折叠所有（只展开根节点）
  const collapseAll = () => {
    shouldPreserveExpandedRef.current = true; // 标记用户已手动调整展开状态
    
    // 如果是单框模式且 Monaco Editor 已初始化，使用 Monaco Editor 的折叠功能
    if (mode === "single" && monacoEditorRef.current) {
      const editor = monacoEditorRef.current;
      const model = editor.getModel();
      
      if (model) {
        // 优化方法：使用 batch 操作减少闪烁
        // 先移动到第一行
        editor.setPosition({ lineNumber: 1, column: 1 });
        
        // 尝试使用 foldLevel2 action（折叠第二层及以下，保持根层级展开）
        const foldLevel2Action = editor.getAction('editor.foldLevel2');
        if (foldLevel2Action && foldLevel2Action.isSupported()) {
          // 如果支持 foldLevel2，直接使用，不会有闪烁
          foldLevel2Action.run();
        } else {
          // 备用方案：使用编辑器的事务机制，在同一个更新周期内完成
          // 先折叠所有，然后立即展开根层级，减少视觉闪烁
          const foldAllAction = editor.getAction('editor.foldAll');
          if (foldAllAction) {
            // 使用 Promise 链，但减少延迟
            foldAllAction.run().then(() => {
              // 使用微任务而不是 setTimeout，更快执行
              Promise.resolve().then(() => {
                editor.setPosition({ lineNumber: 1, column: 1 });
                const unfoldAction = editor.getAction('editor.unfold');
                if (unfoldAction) {
                  unfoldAction.run();
                }
              });
            });
          }
        }
      }
    } else {
      // 分栏模式：只保留根节点（空字符串路径）展开
      setExpandedPaths(new Set([""]));
    }
  };

  // 压缩 JSON
  const handleMinify = () => {
    // 根据当前模式选择数据源
    const content = mode === "single" ? singleModeInput : input;
    
    if (!content.trim()) {
      setError("请输入 JSON 内容");
      setFormatted("");
      setParsedData(null);
      return;
    }

    try {
      const parsed = JSON.parse(content);
      const minified = JSON.stringify(parsed);
      setFormatted(minified);
      // 压缩模式下不显示树形视图，只显示文本
      setParsedData(null);
      setError(null);
      setExpandedPaths(new Set());
      
      // 如果是单框模式，更新编辑器内容
      if (mode === "single") {
        setSingleModeInput(minified);
      }
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "JSON 格式错误";
      setError(errorMessage);
      setFormatted("");
      setParsedData(null);
    }
  };

  // 复制到剪贴板
  const handleCopy = async () => {
    // 根据当前模式选择数据源
    let textToCopy: string;
    
    if (mode === "single") {
      // 单框模式：优先使用编辑器内容，否则使用格式化后的内容
      textToCopy = singleModeInput || formatted || "";
    } else {
      // 分栏模式：如果有解析的数据，复制格式化后的文本；否则复制 formatted
      textToCopy = parsedData 
        ? JSON.stringify(parsedData, null, DEFAULT_INDENT)
        : formatted || "";
    }
    
    if (!textToCopy.trim()) return;

    try {
      await navigator.clipboard.writeText(textToCopy);
      alert("已复制到剪贴板");
    } catch (e) {
      console.error("复制失败:", e);
      alert("复制失败，请手动复制");
    }
  };

  // 转义/反转义 JSON 字符串
  const handleEscape = () => {
    // 根据当前模式选择数据源
    const content = mode === "single" ? singleModeInput : input;
    
    if (!content.trim()) {
      setError("请输入内容");
      return;
    }

    try {
      let result: string;
      
      // 检测内容是否已经是转义格式（包含转义字符）
      // 简单判断：如果包含 \" 或 \\ 等转义序列，可能是已转义的
      const hasEscapeSequences = /\\["\\/bfnrt]|\\u[0-9a-fA-F]{4}/.test(content);
      
      if (hasEscapeSequences) {
        // 反转义：将转义字符还原
        // 使用 JSON.parse 来解析转义的字符串
        try {
          // 如果内容是一个完整的 JSON 字符串（被双引号包裹），直接解析
          if (content.trim().startsWith('"') && content.trim().endsWith('"')) {
            result = JSON.parse(content);
          } else {
            // 否则，尝试将整个内容作为 JSON 字符串解析
            result = JSON.parse(`"${content}"`);
          }
        } catch (e) {
          // 如果解析失败，尝试手动反转义
          result = content
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\')
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\b/g, '\b')
            .replace(/\\f/g, '\f')
            .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        }
      } else {
        // 转义：将特殊字符转义
        // 使用 JSON.stringify 来转义字符串
        result = JSON.stringify(content);
        // 移除首尾的引号（因为 JSON.stringify 会给字符串加上引号）
        if (result.startsWith('"') && result.endsWith('"')) {
          result = result.slice(1, -1);
        }
      }
      
      // 更新内容
      if (mode === "single") {
        setSingleModeInput(result);
        // 清除错误和格式化状态
        setError(null);
        setFormatted("");
        setParsedData(null);
      } else {
        setInput(result);
        // 清除错误和格式化状态
        setError(null);
        setFormatted("");
        setParsedData(null);
      }
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "转义/反转义失败";
      setError(errorMessage);
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
                <div style={{ marginLeft: `${DEFAULT_INDENT * 8}px` }}>
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
                <div style={{ marginLeft: `${DEFAULT_INDENT * 8}px` }}>
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
  const handleClose = useCallback(async () => {
    const window = getCurrentWindow();
    await window.close();
  }, []);

  useEscapeKey(handleClose);

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
          disabled={!formatted && !parsedData && !singleModeInput.trim()}
          style={{
            padding: "8px 16px",
            backgroundColor: (formatted || parsedData || singleModeInput.trim()) ? "#6366f1" : "#9ca3af",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: (formatted || parsedData || singleModeInput.trim()) ? "pointer" : "not-allowed",
            fontSize: "14px",
            fontWeight: 500,
          }}
          onMouseOver={(e) => {
            if (formatted || parsedData || singleModeInput.trim()) {
              e.currentTarget.style.backgroundColor = "#4f46e5";
            }
          }}
          onMouseOut={(e) => {
            if (formatted || parsedData || singleModeInput.trim()) {
              e.currentTarget.style.backgroundColor = "#6366f1";
            }
          }}
        >
          复制结果
        </button>
        <button
          onClick={handleEscape}
          disabled={mode === "single" ? !singleModeInput.trim() : !input.trim()}
          style={{
            padding: "8px 16px",
            backgroundColor: (mode === "single" ? singleModeInput.trim() : input.trim()) ? "#8b5cf6" : "#9ca3af",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: (mode === "single" ? singleModeInput.trim() : input.trim()) ? "pointer" : "not-allowed",
            fontSize: "14px",
            fontWeight: 500,
          }}
          onMouseOver={(e) => {
            if (mode === "single" ? singleModeInput.trim() : input.trim()) {
              e.currentTarget.style.backgroundColor = "#7c3aed";
            }
          }}
          onMouseOut={(e) => {
            if (mode === "single" ? singleModeInput.trim() : input.trim()) {
              e.currentTarget.style.backgroundColor = "#8b5cf6";
            }
          }}
        >
          转义/反转义
        </button>
        <button
          onClick={expandAll}
          disabled={mode === "single" ? !singleModeInput.trim() : !parsedData}
          style={{
            padding: "8px 16px",
            backgroundColor: (mode === "single" ? singleModeInput.trim() : parsedData) ? "#f59e0b" : "#9ca3af",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: (mode === "single" ? singleModeInput.trim() : parsedData) ? "pointer" : "not-allowed",
            fontSize: "14px",
            fontWeight: 500,
          }}
          onMouseOver={(e) => {
            if (mode === "single" ? singleModeInput.trim() : parsedData) {
              e.currentTarget.style.backgroundColor = "#d97706";
            }
          }}
          onMouseOut={(e) => {
            if (mode === "single" ? singleModeInput.trim() : parsedData) {
              e.currentTarget.style.backgroundColor = "#f59e0b";
            }
          }}
        >
          展开全部
        </button>
        <button
          onClick={collapseAll}
          disabled={mode === "single" ? !singleModeInput.trim() : !parsedData}
          style={{
            padding: "8px 16px",
            backgroundColor: (mode === "single" ? singleModeInput.trim() : parsedData) ? "#f59e0b" : "#9ca3af",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: (mode === "single" ? singleModeInput.trim() : parsedData) ? "pointer" : "not-allowed",
            fontSize: "14px",
            fontWeight: 500,
          }}
          onMouseOver={(e) => {
            if (mode === "single" ? singleModeInput.trim() : parsedData) {
              e.currentTarget.style.backgroundColor = "#d97706";
            }
          }}
          onMouseOut={(e) => {
            if (mode === "single" ? singleModeInput.trim() : parsedData) {
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
                // 单框模式下只更新内容，不再自动格式化
                if (value !== undefined) {
                  setSingleModeInput(value);
                  singleModeEditingRef.current = true;

                  // 清理历史定时器，避免内存泄漏
                  if (formatTimeoutRef.current) {
                    window.clearTimeout(formatTimeoutRef.current);
                    formatTimeoutRef.current = null;
                  }
                }
              }}
              onMount={(editor) => {
                // 仅记录 editor 实例，不再在失焦时自动格式化
                monacoEditorRef.current = editor;
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
                tabSize: DEFAULT_INDENT,
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

