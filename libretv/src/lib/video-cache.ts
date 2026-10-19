import { db } from './db';
import { documentBaseURI } from './m3u8';

/**
 * 视频片段本地缓存层。
 *
 * 职责边界：Cache Storage 读写 + IndexedDB（Dexie segmentMeta 表）元数据 + 两轮 LRU 淘汰。
 * 不做任何与播放器状态相关的判断，因此预取循环可以在视频暂停、页面切到后台时继续工作。
 *
 * 为什么不用 Service Worker：
 *   1. 播放器本来就在替换 hls.js 的 loader（广告过滤 + 缓存命中），叠加 cache-first 零注册成本；
 *   2. 跨域片段经 SW 拦截拿到的是 opaque response，cache.put 存不了内容；
 *   3. 无 SW 也无跨域 opaque 问题：预取侧与 loader 侧对同一分片生成字节一致的 key（见下）。
 *
 * key 一致性是缓存命中的前提：hls.js loader 请求分片时的 context.url 与预取器
 * 解析出的分片地址，都必须经 `new URL()` 归一化（抹平默认端口/百分号编码差异）。
 * 播放列表走代理改写形式（/api/proxy?url=…）时分片也是**本站根相对串**，
 * 不带基址的 `new URL()` 会原样放过——必须锚到文档基址才与绝对形式收敛为同一个 key。
 */

export const VIDEO_CACHE_NAME = 'libretv-video-v1';
const META_FLUSH_DEBOUNCE_MS = 30_000;

export interface CacheSettings {
  enabled: boolean;
  /** 前向预取窗口（秒）：从当前播放位置铺到多远；0 = 无限铺满到片尾 */
  horizonSeconds: number;
  /** 单集缓存上限（字节） */
  maxBytesPerEpisode: number;
  /** 全局缓存上限（字节） */
  maxTotalBytes: number;
}

export const DEFAULT_CACHE_SETTINGS: CacheSettings = {
  enabled: true,
  horizonSeconds: 300,
  maxBytesPerEpisode: 800 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

const SETTINGS_KEY = 'libretv-video-cache-settings';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function normalizeCacheSettings(input: unknown): CacheSettings {
  const raw = (input ?? {}) as Partial<CacheSettings>;
  return {
    enabled: raw.enabled !== false,
    // 0 = 无限（铺满到片尾）；否则 60s ~ 7200s
    horizonSeconds: raw.horizonSeconds === 0 ? 0 : clamp(raw.horizonSeconds ?? DEFAULT_CACHE_SETTINGS.horizonSeconds, 60, 7200),
    maxBytesPerEpisode: clamp(raw.maxBytesPerEpisode ?? DEFAULT_CACHE_SETTINGS.maxBytesPerEpisode, 50 * 1024 * 1024, 8 * 1024 * 1024 * 1024),
    maxTotalBytes: clamp(raw.maxTotalBytes ?? DEFAULT_CACHE_SETTINGS.maxTotalBytes, 100 * 1024 * 1024, 20 * 1024 * 1024 * 1024),
  };
}

export function loadCacheSettings(): CacheSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return normalizeCacheSettings(raw ? JSON.parse(raw) : undefined);
  } catch {
    return { ...DEFAULT_CACHE_SETTINGS };
  }
}

export function saveCacheSettings(next: Partial<CacheSettings>): CacheSettings {
  const merged = normalizeCacheSettings({ ...loadCacheSettings(), ...next });
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
  } catch { /* 隐私模式等场景忽略 */ }
  return merged;
}

/**
 * 分片缓存 key：归一化成绝对地址（两侧一致，缓存命中的前提）。
 * 以文档基址作基线，本站根相对的代理形式与绝对形式才会收敛到同一个串。
 */
export function buildSegmentCacheKey(segmentUrl: string): string {
  try {
    return new URL(segmentUrl, documentBaseURI()).href;
  } catch {
    return segmentUrl;
  }
}

function cacheStore(): CacheStorage | undefined {
  return typeof caches !== 'undefined' ? caches : undefined;
}

/** 请求持久化存储（避免浏览器在磁盘压力下清掉缓存；失败静默，不影响功能） */
export async function ensurePersistentStorage(): Promise<void> {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch { /* 忽略 */ }
}

export async function hasCachedSegment(key: string): Promise<boolean> {
  const store = cacheStore();
  if (!store) return false;
  try {
    const cache = await store.open(VIDEO_CACHE_NAME);
    const hit = await cache.match(key);
    return !!hit;
  } catch {
    return false;
  }
}

export interface CachedFragment {
  data: ArrayBuffer;
  /** 预取时记录的真实耗时（毫秒），供 loader 合成 hls.js stats */
  costMs: number;
}

export async function readCachedSegment(key: string): Promise<CachedFragment | null> {
  const store = cacheStore();
  if (!store) return null;
  try {
    const cache = await store.open(VIDEO_CACHE_NAME);
    const hit = await cache.match(key);
    if (!hit) return null;
    const data = await hit.arrayBuffer();
    const meta = await db.segmentMeta.get(key);
    return { data, costMs: meta?.costMs ?? 150 };
  } catch {
    return null;
  }
}

export type CachePutResult = 'ok' | 'quota' | 'failed';

/** 写入分片：QuotaExceeded 时先触发两轮 LRU 淘汰再重试一次 */
export async function putCachedSegmentResilient(
  key: string,
  buffer: ArrayBuffer,
  opts: { episodeKey: string; index: number; costMs: number; settings: CacheSettings }
): Promise<CachePutResult> {
  const store = cacheStore();
  if (!store) return 'failed';
  const bytes = buffer.byteLength;
  const put = async (): Promise<CachePutResult> => {
    try {
      const cache = await store.open(VIDEO_CACHE_NAME);
      const headers = new Headers({ 'Content-Type': 'video/mp2t', 'Content-Length': String(bytes) });
      await cache.put(key, new Response(buffer.slice(0), { headers }));
      await db.segmentMeta.put({
        key,
        episodeKey: opts.episodeKey,
        index: opts.index,
        bytes,
        costMs: Math.max(1, Math.round(opts.costMs)),
        lastAccess: Date.now(),
      });
      return 'ok';
    } catch (err) {
      return err instanceof DOMException && err.name === 'QuotaExceededError' ? 'quota' : 'failed';
    }
  };

  const first = await put();
  if (first !== 'quota') return first;
  await enforceQuota(opts.settings);
  return put();
}

/**
 * 两轮 LRU 淘汰：
 * ① 按剧集分组，组内按 lastAccess 升序淘汰到单集上限以内；
 * ② 全局按 lastAccess 升序淘汰到总量上限以内。
 * 返回删除的分片数。Cache 条目与元数据并行删除，孤儿元数据顺带清理。
 */
export async function enforceQuota(settings?: CacheSettings): Promise<number> {
  const conf = settings ?? loadCacheSettings();
  const store = cacheStore();
  if (!store) return 0;
  try {
    const cache = await store.open(VIDEO_CACHE_NAME);
    const metas = await db.segmentMeta.toArray();
    let removed = 0;

    const remove = async (key: string) => {
      await cache.delete(key);
      await db.segmentMeta.delete(key);
      removed += 1;
    };

    // ① 单集上限
    const byEpisode = new Map<string, typeof metas>();
    for (const m of metas) {
      const list = byEpisode.get(m.episodeKey) ?? [];
      list.push(m);
      byEpisode.set(m.episodeKey, list);
    }
    for (const list of byEpisode.values()) {
      let bytes = list.reduce((sum, m) => sum + m.bytes, 0);
      if (bytes <= conf.maxBytesPerEpisode) continue;
      const sorted = [...list].sort((a, b) => a.lastAccess - b.lastAccess);
      for (const m of sorted) {
        if (bytes <= conf.maxBytesPerEpisode) break;
        bytes -= m.bytes;
        await remove(m.key);
      }
    }

    // ② 全局上限
    let total = (await db.segmentMeta.toArray()).reduce((sum, m) => sum + m.bytes, 0);
    if (total > conf.maxTotalBytes) {
      const sorted = (await db.segmentMeta.toArray()).sort((a, b) => a.lastAccess - b.lastAccess);
      for (const m of sorted) {
        if (total <= conf.maxTotalBytes) break;
        total -= m.bytes;
        await remove(m.key);
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

/** 命中/读取时刷新 lastAccess；30s 内同 key 只写一次，避免高频写放大 */
const touchTimers = new Map<string, number>();
export async function touchMeta(key: string): Promise<void> {
  const now = Date.now();
  const last = touchTimers.get(key) ?? 0;
  if (now - last < META_FLUSH_DEBOUNCE_MS) return;
  touchTimers.set(key, now);
  try {
    const meta = await db.segmentMeta.get(key);
    if (meta) await db.segmentMeta.update(key, { lastAccess: now });
  } catch { /* 忽略 */ }
}

export interface CacheSummary {
  segments: number;
  bytes: number;
  episodes: number;
}

export async function getCacheSummary(): Promise<CacheSummary> {
  try {
    const metas = await db.segmentMeta.toArray();
    return {
      segments: metas.length,
      bytes: metas.reduce((sum, m) => sum + m.bytes, 0),
      episodes: new Set(metas.map((m) => m.episodeKey)).size,
    };
  } catch {
    return { segments: 0, bytes: 0, episodes: 0 };
  }
}

export async function clearVideoCache(): Promise<void> {
  const store = cacheStore();
  try {
    if (store) await store.delete(VIDEO_CACHE_NAME);
    await db.segmentMeta.clear();
  } catch { /* 忽略 */ }
}

export async function deleteEpisodeCache(episodeKey: string): Promise<void> {
  const store = cacheStore();
  try {
    const metas = await db.segmentMeta.where('episodeKey').equals(episodeKey).toArray();
    if (store) {
      const cache = await store.open(VIDEO_CACHE_NAME);
      await Promise.all(metas.map((m) => cache.delete(m.key)));
    }
    await db.segmentMeta.bulkDelete(metas.map((m) => m.key));
  } catch { /* 忽略 */ }
}
