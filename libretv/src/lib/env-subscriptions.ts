/**
 * 部署者通过 DEFAULT_SUBSCRIPTIONS 环境变量预置的 SourceList 订阅链接。
 * 格式为 JSON 数组，元素为 URL 字符串或 {url, name} 对象：
 *   ["https://.../sources.json", {"url":"https://.../list.json","name":"名称"}]
 * 与 DEFAULT_SOURCES / DEFAULT_LIVE_SOURCES 的容错策略一致：解析失败整体忽略。
 */
export interface EnvSubscription {
  url: string;
  name?: string;
}

export function getEnvSubscriptions(): EnvSubscription[] {
  const raw = process.env.DEFAULT_SUBSCRIPTIONS;
  if (!raw || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('必须是 JSON 数组');
    const list: EnvSubscription[] = parsed.map((item, i) => {
      const url = typeof item === 'string' ? item.trim() : typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).url === 'string' ? String((item as Record<string, unknown>).url).trim() : '';
      if (!url || !/^https?:\/\//.test(url)) {
        throw new Error(`第 ${i + 1} 项不是合法的 http(s) 订阅地址`);
      }
      const name =
        typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).name === 'string'
          ? String((item as Record<string, unknown>).name).trim() || undefined
          : undefined;
      return { url: url.replace(/\/+$/, ''), name };
    });
    return list;
  } catch (err) {
    console.warn('[LibreTV] DEFAULT_SUBSCRIPTIONS 解析失败，已忽略：', err instanceof Error ? err.message : err);
    return [];
  }
}
