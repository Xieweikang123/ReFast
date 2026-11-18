import { tauriApi } from "../api/tauri";
import { UNSAVED_IMAGE_PLACEHOLDER } from "./memoWysiwygUtils";

/** 从剪贴板/拖放的 File 保存为备忘录图片，返回相对路径 */
export async function saveMemoImageFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const name = file.name || "image.png";
  const ext =
    name.includes(".")
      ? name.split(".").pop()!.toLowerCase()
      : file.type.includes("jpeg")
        ? "jpg"
        : file.type.includes("webp")
          ? "webp"
          : file.type.includes("gif")
            ? "gif"
            : "png";
  return tauriApi.saveMemoImage(bytes, ext);
}

export function isMemoLocalImageSrc(src: string | undefined): boolean {
  if (!src) return false;
  if (src.startsWith("images/")) return true;
  // 绝对路径且落在 memos 目录时由后端校验；前端先按常见形态识别
  return /[/\\]ReFast[/\\]memos[/\\]images[/\\]/i.test(src);
}

/** MIME → 文件扩展名 */
export function extensionFromMime(mime: string): string {
  const m = mime.toLowerCase().split(";")[0].trim();
  if (m.includes("jpeg") || m === "image/jpg") return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("png")) return "png";
  return "png";
}

/** 解析 data:image/...;base64,... */
export function parseDataUrlImage(
  dataUrl: string
): { bytes: Uint8Array; mime: string } | null {
  const cleaned = dataUrl.replace(/\s/g, "");
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(cleaned);
  if (!m) return null;
  const mime = m[1];
  try {
    const binary = atob(m[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, mime };
  } catch {
    return null;
  }
}

/** 从 http(s)/data:/blob: 读取图片字节 */
export async function loadImageBytesFromSrc(
  src: string
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (src.startsWith("data:")) {
    return parseDataUrlImage(src);
  }
  if (src.startsWith("blob:") || /^https?:\/\//i.test(src)) {
    try {
      const res = await fetch(src);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      const headerMime = res.headers.get("content-type") || "";
      const mime = headerMime.startsWith("image/") ? headerMime : "image/png";
      return { bytes: new Uint8Array(buf), mime };
    } catch {
      return null;
    }
  }
  return null;
}

/** 将远程/内联图片落盘为 images/...，并生成预览 blob URL */
export async function persistMemoImageFromSrc(
  src: string
): Promise<{ rel: string; blobUrl: string } | null> {
  const loaded = await loadImageBytesFromSrc(src);
  if (!loaded || loaded.bytes.byteLength === 0) return null;
  const ext = extensionFromMime(loaded.mime);
  const rel = await tauriApi.saveMemoImage(loaded.bytes, ext);
  const copy = new Uint8Array(loaded.bytes.byteLength);
  copy.set(loaded.bytes);
  const blobUrl = URL.createObjectURL(
    new Blob([copy], { type: loaded.mime || "image/png" })
  );
  return { rel, blobUrl };
}

function isSavedMemoImg(img: HTMLImageElement): boolean {
  const memoSrc = img.getAttribute("data-memo-src") || "";
  return memoSrc.startsWith("images/") && !memoSrc.includes("..");
}

/** 编辑器中尚未落盘的 <img>（缺 data-memo-src 或路径非法） */
export function findUnsavedMemoImages(root: HTMLElement): HTMLImageElement[] {
  return Array.from(root.querySelectorAll("img")).filter((img) => !isSavedMemoImg(img));
}

function replaceImgWithPlaceholder(img: HTMLImageElement) {
  const prev = img.dataset.blobUrl;
  if (prev) URL.revokeObjectURL(prev);
  img.replaceWith(document.createTextNode(UNSAVED_IMAGE_PLACEHOLDER));
}

/**
 * 将编辑器内未保存图片尽量落盘；失败则替换为可见占位文本。
 * @returns 失败数量
 */
export async function persistUnsavedImagesInEditor(
  root: HTMLElement
): Promise<number> {
  const imgs = findUnsavedMemoImages(root);
  let failed = 0;
  for (const img of imgs) {
    const src = (img.getAttribute("src") || "").trim();
    if (!src) {
      replaceImgWithPlaceholder(img);
      failed++;
      continue;
    }
    try {
      const result = await persistMemoImageFromSrc(src);
      if (!result) {
        replaceImgWithPlaceholder(img);
        failed++;
        continue;
      }
      const prev = img.dataset.blobUrl;
      if (prev && prev !== result.blobUrl) URL.revokeObjectURL(prev);
      img.setAttribute("data-memo-src", result.rel);
      img.dataset.blobUrl = result.blobUrl;
      img.src = result.blobUrl;
      if (!img.getAttribute("alt")) img.setAttribute("alt", "图片");
      img.classList.add("memo-wysiwyg-img");
    } catch {
      replaceImgWithPlaceholder(img);
      failed++;
    }
  }
  return failed;
}

/**
 * 粘贴用 HTML：把其中的 img 落盘并改写为 data-memo-src；失败则占位文本。
 * 同时剥掉 script/style 等危险节点。
 */
export async function rewriteHtmlImagesForMemo(
  html: string
): Promise<{ html: string; failedCount: number }> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc
    .querySelectorAll("script,style,iframe,object,embed,link,meta")
    .forEach((el) => el.remove());

  let failedCount = 0;
  const imgs = Array.from(doc.querySelectorAll("img"));
  for (const img of imgs) {
    const src = (img.getAttribute("src") || "").trim();
    try {
      const result = src ? await persistMemoImageFromSrc(src) : null;
      if (!result) {
        img.replaceWith(doc.createTextNode(UNSAVED_IMAGE_PLACEHOLDER));
        failedCount++;
        continue;
      }
      const next = doc.createElement("img");
      next.setAttribute("data-memo-src", result.rel);
      next.setAttribute("data-blob-url", result.blobUrl);
      next.setAttribute("src", result.blobUrl);
      next.setAttribute("alt", img.getAttribute("alt") || "图片");
      next.className = "memo-wysiwyg-img";
      img.replaceWith(next);
    } catch {
      img.replaceWith(doc.createTextNode(UNSAVED_IMAGE_PLACEHOLDER));
      failedCount++;
    }
  }

  return { html: doc.body.innerHTML, failedCount };
}
