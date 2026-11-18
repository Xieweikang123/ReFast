import { useEffect, useRef, useState } from "react";
import { tauriApi } from "../api/tauri";
import { isMemoLocalImageSrc } from "../utils/memoImageUtils";

/** 将备忘录本地图片路径加载为 blob URL，卸载时释放 */
export function useMemoImageUrl(src: string | null | undefined): {
  url: string | null;
  loading: boolean;
} {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!src || !isMemoLocalImageSrc(src)) {
        setUrl(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const data = await tauriApi.getMemoImageData(src);
        const bytes =
          data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
        // 拷贝到独立 ArrayBuffer，避免 SharedArrayBuffer 类型不兼容 BlobPart
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const blob = new Blob([copy], { type: "image/png" });
        const objectUrl = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = objectUrl;
        setUrl(objectUrl);
      } catch (e) {
        console.error("加载备忘录图片失败:", e);
        if (!cancelled) setUrl(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [src]);

  return { url, loading };
}
