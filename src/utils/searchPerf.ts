/**
 * 搜索链路临时打点工具（仅用于定位「不丝滑」问题，定位完成后可整体删除）
 *
 * dev 模式默认开启，每个搜索会话汇总一行写入 .cursor/debug.log（[search-perf] 前缀）。
 * 生产构建自动关闭；也可用 localStorage 设 "refast-search-perf"="0" 强制关闭。
 */

const ENABLE_KEY = "refast-search-perf";

// 项目未引入 vite/client 类型，参照 events.ts 的方式安全读取 env
const importMetaEnv =
  typeof import.meta !== "undefined" ? (import.meta as any).env : undefined;
const IS_DEV = !!importMetaEnv?.DEV;

export function isSearchPerfEnabled(): boolean {
  try {
    const forced = localStorage.getItem(ENABLE_KEY);
    if (forced === "0") return false;
    if (forced === "1") return true;
    // dev 构建默认开启（Vite 注入），生产默认关闭
    return IS_DEV;
  } catch {
    return IS_DEV;
  }
}

export interface SearchPhase {
  phase: string;
  start: number;
  end: number | null;
  meta?: Record<string, unknown>;
}

interface SessionRecord {
  id: number;
  query: string;
  startTime: number;
  /** 用户按下一个字符的时间点（用于测量输入到结果呈现的全链路） */
  phases: Map<string, SearchPhase>;
  everythingCount: number;
  resizeCount: number;
  longestFrame: number;
  reported: boolean;
}

let sessionCounter = 0;
let currentSession: SessionRecord | null = null;
let lastQuery = "";

function now(): number {
  return performance.now();
}

/**
 * 开始一个新的测量会话（每次 query 变化调用一次）。
 * 连续打字时会覆盖上一个未完成的会话。
 */
export function perfBeginSession(query: string): void {
  if (!isSearchPerfEnabled()) return;
  if (query === lastQuery) return;
  lastQuery = query;

  sessionCounter += 1;
  currentSession = {
    id: sessionCounter,
    query,
    startTime: now(),
    phases: new Map(),
    everythingCount: 0,
    resizeCount: 0,
    longestFrame: 0,
    reported: false,
  };
  // 输入 → 本地首帧呈现 的起点
  currentSession.phases.set("本地首帧呈现", {
    phase: "本地首帧呈现",
    start: now(),
    end: null,
  });
  // 暴露到 window 便于手动检查
  const w = window as unknown as { __searchPerf?: { current: SessionRecord | null; history: SessionRecord[] } };
  if (!w.__searchPerf) {
    w.__searchPerf = { current: null, history: [] };
  }
  w.__searchPerf.current = currentSession;
  w.__searchPerf.history.push(currentSession);
  if (w.__searchPerf.history.length > 50) {
    w.__searchPerf.history.shift();
  }
}

/** 标记一个阶段的开始 */
export function perfMarkStart(phase: string, meta?: Record<string, unknown>): void {
  if (!isSearchPerfEnabled() || !currentSession) return;
  currentSession.phases.set(phase, { phase, start: now(), end: null, meta });
}

/** 标记一个阶段结束（相对 perfMarkStart） */
export function perfMarkEnd(phase: string, meta?: Record<string, unknown>): void {
  if (!isSearchPerfEnabled() || !currentSession) return;
  const p = currentSession.phases.get(phase);
  if (!p || p.end !== null) return;
  p.end = now();
  if (meta) {
    p.meta = { ...(p.meta ?? {}), ...meta };
  }
}

/** 独立计时：记录某事件持续时长（不依赖 start/end 配对，覆盖式累计） */
export function perfRecordDuration(phase: string, durationMs: number, meta?: Record<string, unknown>): void {
  if (!isSearchPerfEnabled() || !currentSession) return;
  currentSession.phases.set(phase, {
    phase,
    start: 0,
    end: durationMs,
    meta,
  });
}

/** 累加计数（如 Everything 结果到达次数、窗口 resize 次数） */
export function perfIncrement(phase: string, by = 1): void {
  if (!isSearchPerfEnabled() || !currentSession) return;
  const existing = currentSession.phases.get(phase);
  if (existing && existing.end !== null) {
    existing.end = (existing.end as number) + by;
    existing.start = 0;
  } else {
    currentSession.phases.set(phase, { phase, start: 0, end: by, meta: undefined });
  }
}

/** 记录一次长帧（主线程卡顿检测，>=16.7ms 算一帧未跟上） */
export function perfNoteLongFrame(durationMs: number): void {
  if (!isSearchPerfEnabled() || !currentSession) return;
  if (durationMs > currentSession.longestFrame) {
    currentSession.longestFrame = durationMs;
  }
}

/** 输出当前会话汇总（防重复），同时写入 debug.log 供外部读取 */
export function perfReport(): void {
  if (!isSearchPerfEnabled() || !currentSession || currentSession.reported) return;
  const s = currentSession;
  s.reported = true;

  const parts: string[] = [];
  for (const p of s.phases.values()) {
    if (p.end === null) continue;
    const dur = Math.round((p.end as number) - p.start);
    const metaStr = p.meta ? ` ${JSON.stringify(p.meta)}` : "";
    parts.push(`${p.phase}=${dur}ms${metaStr}`);
  }

  const total = Math.round(now() - s.startTime);
  const pending = [...s.phases.values()].filter((p) => p.end === null).map((p) => p.phase);
  const line =
    `#${s.id} q="${s.query}" 会话总耗时${total}ms` +
    (parts.length ? ` | ${parts.join(" | ")}` : "") +
    (pending.length ? ` | [未完成:${pending.join(",")}]` : "") +
    (s.longestFrame > 16.7 ? ` | ⚠️最长帧${Math.round(s.longestFrame)}ms(主线程卡顿)` : "");

  // eslint-disable-next-line no-console
  console.info(`[search-perf] ${line}`);

  // 异步写入 debug.log（失败静默，不影响搜索）
  import("../api/tauri")
    .then(({ tauriApi }) =>
      tauriApi.writeDebugLog(`[search-perf] ${line}`)
    )
    .catch(() => {});
}

/** 测量一个 Promise 的耗时并打点 */
export async function perfMeasureAsync<T>(
  phase: string,
  fn: () => Promise<T>,
  meta?: Record<string, unknown>
): Promise<T> {
  perfMarkStart(phase, meta);
  try {
    return await fn();
  } finally {
    perfMarkEnd(phase);
  }
}