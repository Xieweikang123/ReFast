import { useCallback, useEffect, useState } from "react";
import { tauriApi } from "../api/tauri";
import { isLnkPath } from "../utils/launcherUtils";

const lnkTargetCache = new Map<string, string>();
const pendingResolves = new Map<string, Promise<string | null>>();

async function fetchLnkTarget(lnkPath: string): Promise<string | null> {
  if (lnkTargetCache.has(lnkPath)) {
    return lnkTargetCache.get(lnkPath)!;
  }

  const pending = pendingResolves.get(lnkPath);
  if (pending) {
    return pending;
  }

  const promise = tauriApi
    .resolveLnkTarget(lnkPath)
    .then((target) => {
      const trimmed = target.trim();
      if (!trimmed || isLnkPath(trimmed)) {
        return null;
      }
      lnkTargetCache.set(lnkPath, trimmed);
      return trimmed;
    })
    .catch((error) => {
      console.warn("[resolveLnkTarget] 解析失败:", lnkPath, error);
      return null;
    })
    .finally(() => {
      pendingResolves.delete(lnkPath);
    });

  pendingResolves.set(lnkPath, promise);
  return promise;
}

/** 解析 .lnk 目标路径（带缓存），失败返回 null */
export async function resolveLnkTargetPath(lnkPath: string): Promise<string | null> {
  if (!isLnkPath(lnkPath)) return null;
  return fetchLnkTarget(lnkPath);
}

/** 用于「打开所在文件夹」等操作：.lnk 解析为目标路径，否则原样返回 */
export async function getRevealPath(path: string): Promise<string> {
  if (!isLnkPath(path)) return path;
  const target = await fetchLnkTarget(path);
  return target ?? path;
}

/**
 * .lnk 快捷方式目标路径解析（挂载时预取）
 */
export function useLnkTargetTooltip(path: string, options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const isLnk = isLnkPath(path);
  const [resolvedTarget, setResolvedTarget] = useState<string | undefined>(() =>
    isLnk ? lnkTargetCache.get(path) : undefined
  );
  const [isLoading, setIsLoading] = useState(false);
  const [resolveFailed, setResolveFailed] = useState(false);

  const prefetch = useCallback(() => {
    if (!isLnk) return;

    const cached = lnkTargetCache.get(path);
    if (cached) {
      setResolvedTarget(cached);
      setResolveFailed(false);
      return;
    }

    if (pendingResolves.has(path)) {
      setIsLoading(true);
      void pendingResolves.get(path)!.then((target) => {
        if (target) {
          setResolvedTarget(target);
          setResolveFailed(false);
        } else {
          setResolveFailed(true);
        }
        setIsLoading(false);
      });
      return;
    }

    setIsLoading(true);
    setResolveFailed(false);
    void fetchLnkTarget(path).then((target) => {
      if (target) {
        setResolvedTarget(target);
        setResolveFailed(false);
      } else {
        setResolveFailed(true);
      }
      setIsLoading(false);
    });
  }, [isLnk, path]);

  useEffect(() => {
    if (isLnk && enabled) {
      prefetch();
    }
  }, [isLnk, enabled, path, prefetch]);

  return { isLnk, resolvedTarget, isLoading, resolveFailed, prefetch };
}

export function getAppResultTooltip(
  path: string,
  type: string,
  resolvedLnkTarget?: string
): string | undefined {
  if (isLnkPath(path)) {
    return resolvedLnkTarget ?? path;
  }
  if (type === "app") {
    return path;
  }
  return undefined;
}
