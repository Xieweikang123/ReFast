import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, confirm, message } from "@tauri-apps/plugin-dialog";
import { tauriApi } from "../api/tauri";

interface ReplaceResult {
  filePath: string;
  matches: number;
  success: boolean;
  error?: string;
}

export function FileToolboxWindow() {
  const [folderPath, setFolderPath] = useState("");
  const [searchText, setSearchText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [fileExtensions, setFileExtensions] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [results, setResults] = useState<ReplaceResult[]>([]);
  const [totalMatches, setTotalMatches] = useState(0);
  const [totalFiles, setTotalFiles] = useState(0);
  const [useRegex, setUseRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [previewMode, setPreviewMode] = useState(true);
  const [backupFolder, setBackupFolder] = useState(true);
  const [replaceFileName, setReplaceFileName] = useState(true);

  // 选择文件夹
  const handleSelectFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择要处理的文件夹",
      });
      if (selected && typeof selected === "string") {
        setFolderPath(selected);
        setResults([]);
        setTotalMatches(0);
        setTotalFiles(0);
      }
    } catch (error) {
      console.error("选择文件夹失败:", error);
      await message(`选择文件夹失败: ${error}`, { title: "错误", kind: "error" });
    }
  };

  // 预览替换（不实际替换）
  const handlePreview = async () => {
    if (!folderPath || !searchText) {
      await message("请先选择文件夹并输入要查找的字符串", { title: "提示", kind: "info" });
      return;
    }

    setIsProcessing(true);
    setResults([]);
    setTotalMatches(0);
    setTotalFiles(0);

    try {
      const result = await tauriApi.previewFileReplace({
        folderPath,
        searchText,
        replaceText: replaceText || "",
        fileExtensions: fileExtensions.split(",").map((ext) => ext.trim()).filter(Boolean),
        useRegex,
        caseSensitive,
        backupFolder,
        replaceFileName,
      });

      setResults(result.results);
      setTotalMatches(result.totalMatches);
      setTotalFiles(result.totalFiles);
    } catch (error) {
      console.error("预览失败:", error);
      await message(`预览失败: ${error}`, { title: "错误", kind: "error" });
    } finally {
      setIsProcessing(false);
    }
  };

  // 执行替换
  const handleReplace = async () => {
    if (!folderPath || !searchText) {
      await message("请先选择文件夹并输入要查找的字符串", { title: "提示", kind: "info" });
      return;
    }

    if (previewMode && results.length === 0) {
      const confirmed = await confirm("您还没有预览结果。是否先预览？", {
        title: "提示",
        kind: "info",
      });
      if (confirmed) {
        await handlePreview();
        return;
      }
    }

    const backupHint = backupFolder 
      ? "\n\n已启用备份功能，将在替换前自动备份文件夹。" 
      : "\n\n⚠️ 警告：未启用备份功能，此操作不可撤销！";
    const confirmed = await confirm(
      `确定要替换 ${totalFiles} 个文件中的 ${totalMatches} 处匹配吗？${backupHint}`,
      {
        title: "确认替换",
        kind: "warning",
      }
    );
    if (!confirmed) {
      return;
    }

    setIsProcessing(true);

    try {
      const result = await tauriApi.executeFileReplace({
        folderPath,
        searchText,
        replaceText: replaceText || "",
        fileExtensions: fileExtensions.split(",").map((ext) => ext.trim()).filter(Boolean),
        useRegex,
        caseSensitive,
        backupFolder,
        replaceFileName,
      });

      setResults(result.results);
      setTotalMatches(result.totalMatches);
      setTotalFiles(result.totalFiles);

      const backupMessage = backupFolder 
        ? "\n\n文件夹已自动备份到父目录。"
        : "";
      await message(
        `替换完成！\n处理了 ${result.totalFiles} 个文件，共替换 ${result.totalMatches} 处。${backupMessage}`,
        { title: "替换完成", kind: "info" }
      );
    } catch (error) {
      console.error("替换失败:", error);
      await message(`替换失败: ${error}`, { title: "错误", kind: "error" });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        backgroundColor: "#1e1e1e",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        color: "#cccccc",
      }}
    >
      {/* 标题栏 */}
      <div
        style={{
          padding: "16px 20px",
          backgroundColor: "#252526",
          borderBottom: "1px solid #3e3e42",
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
            color: "#cccccc",
          }}
        >
          文件工具箱
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

      {/* 主内容区 */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          padding: "20px",
          overflow: "auto",
          gap: "16px",
        }}
      >
        {/* 配置区域 */}
        <div
          style={{
            backgroundColor: "#252526",
            borderRadius: "8px",
            padding: "20px",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
          }}
        >
          {/* 文件夹选择 */}
          <div>
            <label
              style={{
                display: "block",
                marginBottom: "8px",
                fontSize: "14px",
                fontWeight: 500,
                color: "#cccccc",
              }}
            >
              目标文件夹
            </label>
            <div style={{ display: "flex", gap: "8px" }}>
              <input
                type="text"
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
                placeholder="选择或输入文件夹路径"
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  backgroundColor: "#1e1e1e",
                  border: "1px solid #3e3e42",
                  borderRadius: "6px",
                  color: "#cccccc",
                  fontSize: "14px",
                }}
              />
              <button
                onClick={handleSelectFolder}
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
                选择文件夹
              </button>
            </div>
          </div>

          {/* 查找字符串 */}
          <div>
            <label
              style={{
                display: "block",
                marginBottom: "8px",
                fontSize: "14px",
                fontWeight: 500,
                color: "#cccccc",
              }}
            >
              查找字符串
            </label>
            <textarea
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="输入要查找的字符串"
              rows={3}
              style={{
                width: "100%",
                padding: "8px 12px",
                backgroundColor: "#1e1e1e",
                border: "1px solid #3e3e42",
                borderRadius: "6px",
                color: "#cccccc",
                fontSize: "14px",
                fontFamily: "'Courier New', monospace",
                resize: "vertical",
              }}
            />
          </div>

          {/* 替换字符串 */}
          <div>
            <label
              style={{
                display: "block",
                marginBottom: "8px",
                fontSize: "14px",
                fontWeight: 500,
                color: "#cccccc",
              }}
            >
              替换为
            </label>
            <textarea
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
              placeholder="输入要替换成的字符串（留空则删除匹配内容）"
              rows={3}
              style={{
                width: "100%",
                padding: "8px 12px",
                backgroundColor: "#1e1e1e",
                border: "1px solid #3e3e42",
                borderRadius: "6px",
                color: "#cccccc",
                fontSize: "14px",
                fontFamily: "'Courier New', monospace",
                resize: "vertical",
              }}
            />
          </div>

          {/* 文件扩展名 */}
          <div>
            <label
              style={{
                display: "block",
                marginBottom: "8px",
                fontSize: "14px",
                fontWeight: 500,
                color: "#cccccc",
              }}
            >
              文件扩展名（逗号分隔，留空则处理所有文件）
            </label>
            <input
              type="text"
              value={fileExtensions}
              onChange={(e) => setFileExtensions(e.target.value)}
              placeholder=""
              style={{
                width: "100%",
                padding: "8px 12px",
                backgroundColor: "#1e1e1e",
                border: "1px solid #3e3e42",
                borderRadius: "6px",
                color: "#cccccc",
                fontSize: "14px",
              }}
            />
          </div>

          {/* 选项 */}
          <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                cursor: "pointer",
                fontSize: "14px",
              }}
            >
              <input
                type="checkbox"
                checked={useRegex}
                onChange={(e) => setUseRegex(e.target.checked)}
                style={{ cursor: "pointer" }}
              />
              <span>使用正则表达式</span>
            </label>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                cursor: "pointer",
                fontSize: "14px",
              }}
            >
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(e) => setCaseSensitive(e.target.checked)}
                style={{ cursor: "pointer" }}
              />
              <span>区分大小写</span>
            </label>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                cursor: "pointer",
                fontSize: "14px",
              }}
            >
              <input
                type="checkbox"
                checked={previewMode}
                onChange={(e) => setPreviewMode(e.target.checked)}
                style={{ cursor: "pointer" }}
              />
              <span>预览模式（先预览再替换）</span>
            </label>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                cursor: "pointer",
                fontSize: "14px",
              }}
            >
              <input
                type="checkbox"
                checked={backupFolder}
                onChange={(e) => setBackupFolder(e.target.checked)}
                style={{ cursor: "pointer" }}
              />
              <span>备份原有文件夹（替换前备份）</span>
            </label>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                cursor: "pointer",
                fontSize: "14px",
              }}
            >
              <input
                type="checkbox"
                checked={replaceFileName}
                onChange={(e) => setReplaceFileName(e.target.checked)}
                style={{ cursor: "pointer" }}
              />
              <span>替换文件名</span>
            </label>
          </div>

          {/* 操作按钮 */}
          <div style={{ display: "flex", gap: "12px" }}>
            <button
              onClick={handlePreview}
              disabled={isProcessing || !folderPath || !searchText}
              style={{
                padding: "10px 20px",
                backgroundColor: isProcessing || !folderPath || !searchText ? "#9ca3af" : "#3b82f6",
                color: "white",
                border: "none",
                borderRadius: "6px",
                cursor: isProcessing || !folderPath || !searchText ? "not-allowed" : "pointer",
                fontSize: "14px",
                fontWeight: 500,
              }}
              onMouseOver={(e) => {
                if (!isProcessing && folderPath && searchText) {
                  e.currentTarget.style.backgroundColor = "#2563eb";
                }
              }}
              onMouseOut={(e) => {
                if (!isProcessing && folderPath && searchText) {
                  e.currentTarget.style.backgroundColor = "#3b82f6";
                }
              }}
            >
              {isProcessing ? "处理中..." : "预览"}
            </button>
            <button
              onClick={handleReplace}
              disabled={isProcessing || !folderPath || !searchText}
              style={{
                padding: "10px 20px",
                backgroundColor: isProcessing || !folderPath || !searchText ? "#9ca3af" : "#10b981",
                color: "white",
                border: "none",
                borderRadius: "6px",
                cursor: isProcessing || !folderPath || !searchText ? "not-allowed" : "pointer",
                fontSize: "14px",
                fontWeight: 500,
              }}
              onMouseOver={(e) => {
                if (!isProcessing && folderPath && searchText) {
                  e.currentTarget.style.backgroundColor = "#059669";
                }
              }}
              onMouseOut={(e) => {
                if (!isProcessing && folderPath && searchText) {
                  e.currentTarget.style.backgroundColor = "#10b981";
                }
              }}
            >
              {isProcessing ? "处理中..." : "执行替换"}
            </button>
          </div>
        </div>

        {/* 结果统计 */}
        {(totalFiles > 0 || totalMatches > 0) && (
          <div
            style={{
              backgroundColor: "#252526",
              borderRadius: "8px",
              padding: "16px 20px",
              display: "flex",
              gap: "24px",
              fontSize: "14px",
            }}
          >
            <div>
              <span style={{ color: "#9ca3af" }}>处理文件数：</span>
              <span style={{ color: "#3b82f6", fontWeight: 600 }}>{totalFiles}</span>
            </div>
            <div>
              <span style={{ color: "#9ca3af" }}>匹配总数：</span>
              <span style={{ color: "#10b981", fontWeight: 600 }}>{totalMatches}</span>
            </div>
          </div>
        )}

        {/* 结果列表 */}
        {results.length > 0 && (
          <div
            style={{
              backgroundColor: "#252526",
              borderRadius: "8px",
              padding: "20px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: "16px",
                fontWeight: 600,
                color: "#cccccc",
              }}
            >
              处理结果
            </h2>
            <div
              style={{
                maxHeight: "400px",
                overflow: "auto",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              {results.map((result, index) => (
                <div
                  key={index}
                  style={{
                    padding: "12px",
                    backgroundColor: result.success ? "#1e3a1e" : "#3a1e1e",
                    border: `1px solid ${result.success ? "#3e7e3e" : "#7e3e3e"}`,
                    borderRadius: "6px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "13px",
                        color: result.success ? "#4ade80" : "#f87171",
                        marginBottom: "4px",
                        wordBreak: "break-all",
                      }}
                    >
                      {result.filePath}
                    </div>
                    <div style={{ fontSize: "12px", color: "#9ca3af" }}>
                      {result.success
                        ? `成功替换 ${result.matches} 处`
                        : `错误: ${result.error || "未知错误"}`}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

