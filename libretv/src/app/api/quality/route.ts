import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { getCache, setCache } from '@/lib/fetch-utils';
import { withHostLimit } from '@/lib/host-gate';
import { probeQuality } from '@/lib/quality-probe';
import type { QualityProbeItem, QualityProbeResult } from '@/lib/types';

export const runtime = 'nodejs';

interface QualityBody {
  items?: unknown;
}

/** 单次请求最多探测的条目数：一张卡片展开最多十几个源，留足余量且防止被刷 */
const MAX_ITEMS = 50;

/** 并发上限：一次打满十几个源容易触发源站限流，也会把服务端出站连接占满 */
const CONCURRENCY = 6;

/** 探测成功缓存 30 分钟：源站短期内不会给同一部剧换片源 */
const OK_CACHE_TTL = 30 * 60 * 1000;

/** 失败结果短缓存：避免每个用户每次展开都去白打一遍已经挂掉的源 */
const FAIL_CACHE_TTL = 2 * 60 * 1000;

interface CachedProbe {
  height?: number;
  error?: string;
}

function isProbeItem(v: unknown): v is QualityProbeItem {
  if (!v || typeof v !== 'object') return false;
  const item = v as { source?: unknown; id?: unknown };
  if (!item.source || typeof item.source !== 'object') return false;
  const source = item.source as Record<string, unknown>;
  if (typeof source.key !== 'string' || typeof source.url !== 'string') return false;
  return typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 64;
}

function cacheKey(item: QualityProbeItem): string {
  return `quality:${item.source.url.replace(/\/+$/, '')}|${item.source.detail ?? ''}|${item.id}`;
}

/** 定长并发池：逐个取任务，worker 内部自行兜住异常 */
async function runWithConcurrency(
  items: QualityProbeItem[],
  limit: number,
  worker: (item: QualityProbeItem) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(lanes);
}

/**
 * 批量画质探测：
 * - 默认返回完整 JSON；
 * - `?stream=1` 以 NDJSON 逐条推送——展开来源面板时先到的先亮，不必等最慢的源。
 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: QualityBody;
  try {
    body = (await req.json()) as QualityBody;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: '请提供待探测的条目' }, { status: 400 });
  }
  const items = body.items.filter(isProbeItem).slice(0, MAX_ITEMS);
  if (items.length === 0) {
    return NextResponse.json({ error: '条目格式无效' }, { status: 400 });
  }

  const isStream = new URL(req.url).searchParams.get('stream') === '1';

  // 同一「源地址 + detail + 影片」的探测按进程内合并：缓存只在探测完成后才写入，
  // 并发的重复条目会同时 miss、各打一遍源站，缓存本身挡不住。
  // 结果仍按条目各自的 sourceKey 返回——直接按 cacheKey 去重会吞掉另一个源的结论，
  // 那个源在前端就永远拿不到结果、徽章不亮
  const inflight = new Map<string, Promise<CachedProbe>>();

  const resolveItem = async (item: QualityProbeItem): Promise<QualityProbeResult> => {
    const key = cacheKey(item);
    const cached = getCache<CachedProbe>(key);
    if (cached) {
      return { sourceKey: item.source.key, vodId: item.id, height: cached.height, error: cached.error };
    }
    let pending = inflight.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          // per-host 闸门放在最外层：同一采集站的多个影片共用一个 host，
          // 只限单请求内的 CONCURRENCY 挡不住「多用户 × 单请求并发」的叠加冲击。
          // 排队等待不占用 probeQuality 内部的 8s 死线（超时在拿到名额后才起算）
          const result = await withHostLimit(item.source.url, () => probeQuality(item, req.signal));
          const value: CachedProbe = { height: result.height, error: result.error };
          // 「测不出」（height 缺失且无 error）同样是有效结论，也要缓存，
          // 否则单码率源每次展开都会被重复探测一遍
          setCache(key, value, result.error ? FAIL_CACHE_TTL : OK_CACHE_TTL);
          return value;
        } catch {
          // 客户端断开等中断：不缓存、也不作为失败结果下发
          return { error: '探测已取消' };
        }
      })();
      inflight.set(key, pending);
    }
    const value = await pending;
    return { sourceKey: item.source.key, vodId: item.id, height: value.height, error: value.error };
  };

  if (!isStream) {
    const results: QualityProbeResult[] = [];
    await runWithConcurrency(items, CONCURRENCY, async (item) => {
      results.push(await resolveItem(item));
    });
    return NextResponse.json({ results });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (result: QualityProbeResult) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(result) + '\n'));
        } catch {
          closed = true; // 客户端已断开
        }
      };
      await runWithConcurrency(items, CONCURRENCY, async (item) => {
        if (closed) return;
        send(await resolveItem(item));
      });
      closed = true;
      try {
        controller.close();
      } catch {
        /* 已断开 */
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
