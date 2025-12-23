/**
 * 粘贴处理工具函数
 * 负责处理剪贴板内容（图片、文件路径等）的粘贴逻辑
 */

import type React from "react";
import type { FileHistoryItem } from "../types";
import { tauriApi } from "../api/tauri";
import { searchFileHistoryFrontend } from "./searchUtils";

/**
 * 处理粘贴路径的选项接口
 */
export interface ProcessPastedPathOptions {
  trimmedPath: string;
  setQuery: (query: string) => void;
  setFilteredFiles: (files: FileHistoryItem[]) => void;
  allFileHistoryCacheRef: React.MutableRefObject<FileHistoryItem[]>;
  refreshFileHistoryCache: () => Promise<void>;
  tauriApi: typeof tauriApi;
}

/**
 * 处理粘贴的文件路径
 */
export async function processPastedPath(
  options: ProcessPastedPathOptions
): Promise<void> {
  const {
    trimmedPath,
    setQuery,
    setFilteredFiles,
    allFileHistoryCacheRef,
    refreshFileHistoryCache,
    tauriApi,
  } = options;

  console.log("Processing path:", trimmedPath);

  // Always set the query first so user sees something
  setQuery(trimmedPath);

  try {
    // Check if path exists (file or folder)
    console.log("Checking if path exists...");
    const pathItem = await tauriApi.checkPathExists(trimmedPath);
    console.log("Path check result:", pathItem);

    if (pathItem) {
      // Path exists, add to history first
      try {
        console.log("Adding to history...");
        await tauriApi.addFileToHistory(trimmedPath);
        // 更新前端缓存
        await refreshFileHistoryCache();
        // 使用前端缓存搜索
        const searchResults = await searchFileHistoryFrontend(
          trimmedPath,
          allFileHistoryCacheRef.current
        );
        console.log("Search results:", searchResults);
        if (searchResults.length > 0) {
          setFilteredFiles(searchResults);
        } else {
          // If not found in search, use the item we got from check
          console.log("Using pathItem from check");
          setFilteredFiles([pathItem]);
        }
      } catch (error) {
        // Ignore errors when adding to history, still show the result
        console.error("Failed to add file to history:", error);
        setFilteredFiles([pathItem]);
      }
    } else {
      // Path doesn't exist, search will still run via query change
      console.log("Path doesn't exist, but query is set for search");
    }
  } catch (error) {
    console.error("Failed to check path:", error);
    // Query is already set, search will still run
  }
}

/**
 * 处理粘贴事件的选项接口
 */
export interface HandlePasteOptions {
  e: React.ClipboardEvent;
  setQuery: (query: string) => void;
  setPastedImagePath: (path: string | null) => void;
  setPastedImageDataUrl: (dataUrl: string | null) => void;
  setErrorMessage: (message: string | null) => void;
  processPastedPath: (path: string) => Promise<void>;
  tauriApi: typeof tauriApi;
}

/**
 * 处理粘贴事件
 */
export async function handlePaste(options: HandlePasteOptions): Promise<void> {
  const {
    e,
    setQuery,
    setPastedImagePath,
    setPastedImageDataUrl,
    setErrorMessage,
    processPastedPath,
    tauriApi,
  } = options;

  const clipboardTypes = Array.from(e.clipboardData.types);

  // 首先检查剪贴板是否包含图片
  const imageTypes = clipboardTypes.filter((type) =>
    type.startsWith("image/")
  );
  if (imageTypes.length > 0) {
    e.preventDefault();
    e.stopPropagation();

    try {
      // 获取图片数据
      const imageType = imageTypes[0];
      const imageItem = Array.from(e.clipboardData.items).find((item) =>
        item.type.startsWith("image/")
      );

      if (imageItem) {
        const imageFile = imageItem.getAsFile();

        if (imageFile) {
          // 读取图片数据
          const arrayBuffer = await imageFile.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);

          // 创建 base64 data URL 用于预览（使用 FileReader 避免大文件问题）
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              if (reader.result) {
                resolve(reader.result as string);
              } else {
                reject(new Error("Failed to read image data"));
              }
            };
            reader.onerror = () => reject(new Error("Failed to read image"));
            reader.readAsDataURL(imageFile);
          });
          setPastedImageDataUrl(dataUrl);

          // 确定文件扩展名
          let extension = "png";
          if (imageType.includes("jpeg") || imageType.includes("jpg")) {
            extension = "jpg";
          } else if (imageType.includes("gif")) {
            extension = "gif";
          } else if (imageType.includes("webp")) {
            extension = "webp";
          } else if (imageType.includes("bmp")) {
            extension = "bmp";
          }

          // 保存图片到临时文件
          const tempPath = await tauriApi.saveClipboardImage(
            uint8Array,
            extension
          );

          // 保存粘贴的图片路径到状态
          setPastedImagePath(tempPath);

          // 处理粘贴的图片路径
          await processPastedPath(tempPath);
          return;
        }
      }
    } catch (error) {
      console.error("Failed to process clipboard image:", error);
      setErrorMessage("粘贴图片失败: " + (error as Error).message);
    }
  }

  // 清除粘贴图片状态（如果粘贴的是其他内容）
  if (!clipboardTypes.some((type) => type.startsWith("image/"))) {
    setPastedImagePath(null);
    setPastedImageDataUrl(null);
  }

  // Check if clipboard contains files (when copying folders/files in Windows)
  if (clipboardTypes.includes("Files")) {
    e.preventDefault();
    e.stopPropagation();

    const files = e.clipboardData.files;
    console.log("Files in clipboard:", files.length);

    if (files.length > 0) {
      // 检查第一个文件是否是图片文件
      const firstFile = files[0];
      const fileName = firstFile.name.toLowerCase();
      const isImageFile =
        fileName.endsWith(".png") ||
        fileName.endsWith(".jpg") ||
        fileName.endsWith(".jpeg") ||
        fileName.endsWith(".gif") ||
        fileName.endsWith(".webp") ||
        fileName.endsWith(".bmp");

      // 如果是图片文件且剪贴板中没有 image/ 类型，尝试作为图片处理
      if (isImageFile && imageTypes.length === 0) {
        try {
          const arrayBuffer = await firstFile.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);

          // 创建 base64 data URL 用于预览（使用 FileReader 避免大文件问题）
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              if (reader.result) {
                resolve(reader.result as string);
              } else {
                reject(new Error("Failed to read image data"));
              }
            };
            reader.onerror = () => reject(new Error("Failed to read image"));
            reader.readAsDataURL(firstFile);
          });
          setPastedImageDataUrl(dataUrl);

          // 确定文件扩展名
          let extension = "png";
          if (fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) {
            extension = "jpg";
          } else if (fileName.endsWith(".gif")) {
            extension = "gif";
          } else if (fileName.endsWith(".webp")) {
            extension = "webp";
          } else if (fileName.endsWith(".bmp")) {
            extension = "bmp";
          }

          // 保存图片到临时文件
          const tempPath = await tauriApi.saveClipboardImage(
            uint8Array,
            extension
          );
          console.log("Saved clipboard image file to:", tempPath);

          // 保存粘贴的图片路径到状态
          setPastedImagePath(tempPath);

          // 处理粘贴的图片路径
          await processPastedPath(tempPath);
          return;
        } catch (error) {
          console.error("Failed to process clipboard image file:", error);
          // 如果图片处理失败，继续尝试作为普通文件处理
        }
      }

      // Get the first file/folder path
      // Note: In browser, we can't directly get the full path from File object
      // We need to use Tauri's clipboard API or handle it differently
      // For now, let's try to get the path from the file name and use a backend command

      // Try to get text representation if available
      let pathText = "";
      try {
        // Some browsers/clipboard implementations might have text representation
        pathText =
          e.clipboardData.getData("text/uri-list") ||
          e.clipboardData.getData("text") ||
          e.clipboardData.getData("text/plain");
      } catch (err) {
        console.log("Could not get text from clipboard:", err);
      }

      // If we have a file, we need to get its path from backend
      // Since browser File API doesn't expose full path, we'll need to use Tauri
      // Try to get path from Tauri clipboard API (Windows only)
      if (!pathText) {
        console.log("Getting path from Tauri clipboard API");
        try {
          const clipboardPath = await tauriApi.getClipboardFilePath();
          if (clipboardPath) {
            console.log("Got path from clipboard API:", clipboardPath);
            await processPastedPath(clipboardPath);
            return;
          } else {
            console.log("Tauri clipboard API returned null");
          }
        } catch (error) {
          console.error("Failed to get clipboard file path:", error);
        }
      }

      if (pathText) {
        console.log("Processing path from clipboard files:", pathText);
        await processPastedPath(pathText);
      } else {
        console.log(
          "Could not get file path from clipboard - file may need to be selected from file system"
        );
        // 如果无法获取路径，至少显示文件名
        setQuery(firstFile.name);
      }
    }
    return;
  }

  // Try to get text from clipboard - Windows may use different formats
  let pastedText = e.clipboardData.getData("text");

  // If no text, try text/plain format
  if (!pastedText) {
    pastedText = e.clipboardData.getData("text/plain");
  }

  // Handle Windows file paths that might have quotes or be on multiple lines
  if (pastedText) {
    // Remove quotes if present
    pastedText = pastedText.replace(/^["']|["']$/g, "");
    // Take first line if multiple lines
    pastedText = pastedText.split("\n")[0].split("\r")[0];
  }

  console.log("Pasted text:", pastedText);

  // Check if pasted text looks like a file path
  const isPath =
    pastedText &&
    pastedText.trim().length > 0 &&
    (pastedText.includes("\\") ||
      pastedText.includes("/") ||
      pastedText.match(/^[A-Za-z]:/));

  if (isPath) {
    e.preventDefault();
    e.stopPropagation();
    await processPastedPath(pastedText.trim());
  } else {
    console.log(
      "Pasted text doesn't look like a path, allowing default paste behavior"
    );
  }
}

/**
 * 保存图片到下载目录的选项接口
 */
export interface SaveImageToDownloadsOptions {
  imagePath: string;
  setSuccessMessage: (message: string | null) => void;
  setErrorMessage: (message: string | null) => void;
  setPastedImagePath: (path: string | null) => void;
  setPastedImageDataUrl: (dataUrl: string | null) => void;
  refreshFileHistoryCache: () => Promise<void>;
  tauriApi: typeof tauriApi;
}

/**
 * 保存图片到下载目录
 */
export async function saveImageToDownloads(
  options: SaveImageToDownloadsOptions
): Promise<void> {
  const {
    imagePath,
    setSuccessMessage,
    setErrorMessage,
    setPastedImagePath,
    setPastedImageDataUrl,
    refreshFileHistoryCache,
    tauriApi,
  } = options;

  try {
    const savedPath = await tauriApi.copyFileToDownloads(imagePath);
    setSuccessMessage(`图片已保存到下载目录: ${savedPath}`);
    setPastedImagePath(null); // 清除状态
    setPastedImageDataUrl(null); // 清除预览
    // 只添加到历史记录，不更新搜索结果，避免自动打开
    try {
      await tauriApi.addFileToHistory(savedPath);
      // 更新前端缓存
      await refreshFileHistoryCache();
    } catch (error) {
      // 静默处理历史记录添加错误
      console.log("Failed to add to history:", error);
    }
    // 3秒后自动清除成功消息
    setTimeout(() => {
      setSuccessMessage(null);
    }, 3000);
  } catch (error) {
    setErrorMessage("保存图片失败: " + (error as Error).message);
  }
}

