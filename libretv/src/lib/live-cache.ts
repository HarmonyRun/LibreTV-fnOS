/**
 * 直播模块专用的大对象 TTL 缓存（EPG 节目单等）。
 *
 * 刻意不复用 fetch-utils.ts 的通用缓存：其条目数超限时会整体 clear()，
 * 一个几十 MB 的 EPG 条目即可连带清掉豆瓣推荐等热点数据。
 * 这里独立实例 + 按字节数与条目数双重上限，超限逐出最旧条目。
 */

interface Entry {
  value: unknown;
  expiresAt: number;
  /** 估算字节数（sizeHint 或保守估计） */
  bytes: number;
}

const MAX_ENTRIES = 10;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024; // 256MB

const store = new Map<string, Entry>();

export function getLiveCache<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function setLiveCache(key: string, value: unknown, ttlMs: number, sizeHint?: number): void {
  const now = Date.now();
  const bytes = Math.max(sizeHint ?? 0, 64 * 1024);

  // 先清理已过期条目
  for (const [k, v] of store) {
    if (now > v.expiresAt) store.delete(k);
  }

  // 容量上限：逐出最旧写入的条目（Map 迭代序即插入序）
  while (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  let total = 0;
  for (const v of store.values()) total += v.bytes;
  while (total + bytes > MAX_TOTAL_BYTES && store.size > 0) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    total -= store.get(oldest)!.bytes;
    store.delete(oldest);
  }

  store.set(key, { value, expiresAt: now + ttlMs, bytes });
}
