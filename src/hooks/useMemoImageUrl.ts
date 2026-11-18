import { useEffect, useState } from "react";
import { tauriApi } from "../api/tauri";
import { isMemoLocalImageSrc } from "../utils/memoImageUtils";

/** 进程内 blob URL 缓存：列表滚动/重进时复用，避免重复读盘 */
const urlCache = new Map<string, string>();
/** 同一路径并发加载合并为一次请求 */
const inflight = new Map<string, Promise<string>>();

async function loadMemoImageObjectUrl(src: string): Promise<string> {
  const cached = urlCache.get(src);
  if (cached) return cached;

  const pending = inflight.get(src);
  if (pending) return pending;

  const promise = (async () => {
    const data = await tauriApi.getMemoImageData(src);
    const bytes =
      data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    // 拷贝到独立 ArrayBuffer，避免 SharedArrayBuffer 类型不兼容 BlobPart
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const blob = new Blob([copy], { type: "image/png" });
    const objectUrl = URL.createObjectURL(blob);
    urlCache.set(src, objectUrl);
    return objectUrl;
  })().finally(() => {
    inflight.delete(src);
  });

  inflight.set(src, promise);
  return promise;
}

/** 将备忘录本地图片路径加载为 blob URL（带进程内缓存） */
export function useMemoImageUrl(src: string | null | undefined): {
  url: string | null;
  loading: boolean;
} {
  const cached = src && isMemoLocalImageSrc(src) ? urlCache.get(src) ?? null : null;
  const [url, setUrl] = useState<string | null>(cached);
  const [loading, setLoading] = useState(Boolean(src && isMemoLocalImageSrc(src) && !cached));

  useEffect(() => {
    let cancelled = false;

    if (!src || !isMemoLocalImageSrc(src)) {
      setUrl(null);
      setLoading(false);
      return;
    }

    const hit = urlCache.get(src);
    if (hit) {
      setUrl(hit);
      setLoading(false);
      return;
    }

    setLoading(true);
    void loadMemoImageObjectUrl(src)
      .then((objectUrl) => {
        if (!cancelled) {
          setUrl(objectUrl);
          setLoading(false);
        }
      })
      .catch((e) => {
        console.error("加载备忘录图片失败:", e);
        if (!cancelled) {
          setUrl(null);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      // 缓存跨组件复用，卸载时不 revoke
    };
  }, [src]);

  return { url, loading };
}
