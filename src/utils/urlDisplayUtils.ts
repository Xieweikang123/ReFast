export function extractUrlHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    const match = url.match(/^https?:\/\/([^/?#]+)/i);
    return match?.[1] ?? url;
  }
}

export interface UrlHistoryDisplay {
  hostname: string;
  remark: string | null;
}

/** URL 历史：区分用户备注与自动提取的域名 */
export function getUrlHistoryDisplay(item: {
  path: string;
  name: string;
}): UrlHistoryDisplay {
  const hostname = extractUrlHostname(item.path);
  const trimmedName = item.name.trim();
  const hasCustomRemark =
    trimmedName.length > 0 &&
    trimmedName !== hostname &&
    trimmedName !== item.path;

  return {
    hostname,
    remark: hasCustomRemark ? trimmedName : null,
  };
}

/** 启动器 URL 结果的主标题：优先备注，其次域名 */
export function getUrlResultDisplayName(
  url: string,
  storedName?: string | null
): string {
  if (storedName) {
    const { remark, hostname } = getUrlHistoryDisplay({
      path: url,
      name: storedName,
    });
    if (remark) return remark;
    if (hostname) return hostname;
  }

  return extractUrlHostname(url);
}

/** 判断 URL 是否有用户自定义备注 */
export function hasUrlCustomRemark(
  url: string,
  storedName?: string | null
): boolean {
  if (!storedName) return false;
  return getUrlHistoryDisplay({ path: url, name: storedName }).remark !== null;
}
