import { getClientId } from "../utils/clientId";
import { tauriApi } from "./tauri";

const importMetaEnv = typeof import.meta !== "undefined" ? (import.meta as any).env : undefined;

const EVENTS_BASE =
  (importMetaEnv?.VITE_EVENTS_BASE as string | undefined) ||
  "http://8.152.198.86:5000/api/events";

const API_KEY = importMetaEnv?.VITE_EVENTS_API_KEY as string | undefined;

// 固定项目键
const PROJECT_KEY = "refast";

// 缓存应用版本号
let cachedAppVersion: string | null = null;
let versionFetchPromise: Promise<string> | null = null;

/**
 * 获取应用版本号（带缓存）
 */
async function getAppVersion(): Promise<string | null> {
  // 如果已经缓存，直接返回
  if (cachedAppVersion !== null) {
    return cachedAppVersion;
  }

  // 如果正在获取，等待获取完成
  if (versionFetchPromise) {
    try {
      cachedAppVersion = await versionFetchPromise;
      return cachedAppVersion;
    } catch {
      return null;
    }
  }

  // 开始获取版本号
  versionFetchPromise = (async () => {
    try {
      const version = await tauriApi.getAppVersion();
      cachedAppVersion = version;
      return version;
    } catch (error) {
      console.warn("[events] Failed to get app version:", error);
      cachedAppVersion = ""; // 缓存空字符串，避免重复请求
      return "";
    } finally {
      versionFetchPromise = null;
    }
  })();

  try {
    return await versionFetchPromise;
  } catch {
    return null;
  }
}

// 在模块加载时预获取版本号（不阻塞）
void getAppVersion();

export interface EventWriteRequest {
  name: string;
  occurredAt?: string;
  userId?: string;
  properties?: Record<string, unknown>;
}

const defaultHeaders: HeadersInit = {
  "Content-Type": "application/json",
};

if (API_KEY) {
  defaultHeaders["x-api-key"] = API_KEY;
}

async function sendRequest(path: string, body: unknown) {
  const res = await fetch(`${EVENTS_BASE}${path}`, {
    method: "POST",
    headers: defaultHeaders,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Events API failed: ${res.status} ${res.statusText}`);
  }
}

export async function sendEvent(event: EventWriteRequest): Promise<void> {
  if (!event.name?.trim()) return;
  try {
    // 获取应用版本号并添加到 properties 中
    const appVersion = await getAppVersion();
    const properties = {
      ...event.properties,
      ...(appVersion ? { version: appVersion } : {}),
    };

    await sendRequest("", {
      ...event,
      properties,
      userId: event.userId || getClientId(),
      project_key: PROJECT_KEY,
    });
  } catch (error) {
    console.warn("[events] sendEvent failed", error);
  }
}

export async function sendEventsBatch(events: EventWriteRequest[]): Promise<void> {
  if (!events.length) return;
  try {
    // 获取应用版本号并添加到所有事件的 properties 中
    const appVersion = await getAppVersion();
    const payload = {
      events: events.map((evt) => ({
        ...evt,
        properties: {
          ...evt.properties,
          ...(appVersion ? { version: appVersion } : {}),
        },
        userId: evt.userId || getClientId(),
        project_key: PROJECT_KEY,
      })),
    };
    await sendRequest("/batch", payload);
  } catch (error) {
    console.warn("[events] sendEventsBatch failed", error);
  }
}

export async function fetchDaily(from?: string, to?: string): Promise<
  Array<{
    date: string;
    count: number;
  }>
> {
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);

  try {
    const res = await fetch(
      `${EVENTS_BASE}/daily${qs.toString() ? `?${qs.toString()}` : ""}`,
      { headers: defaultHeaders }
    );
    if (!res.ok) {
      throw new Error(`Events daily failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  } catch (error) {
    console.warn("[events] fetchDaily failed", error);
    return [];
  }
}

export async function fetchUsersCount(from?: string, to?: string): Promise<number> {
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);

  try {
    const res = await fetch(
      `${EVENTS_BASE}/users/count${qs.toString() ? `?${qs.toString()}` : ""}`,
      { headers: defaultHeaders }
    );
    if (!res.ok) {
      throw new Error(`Events users count failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { count?: number };
    return typeof data.count === "number" ? data.count : 0;
  } catch (error) {
    console.warn("[events] fetchUsersCount failed", error);
    return 0;
  }
}

/**
 * Fire-and-forget tracking helper.
 */
export function trackEvent(name: string, properties?: Record<string, unknown>): void {
  void sendEvent({
    name,
    properties,
  });
}

