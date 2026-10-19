/**
 * 批量画质探测接口单测：同 URL + detail + 影片的并发请求要合并成一次上游探测，
 * 但结果仍按各自条目的 sourceKey 返回（直接按 cacheKey 去重会把另一个源的徽章吞掉）。
 * 上游与鉴权一律 mock，不产生网络请求。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';
import type { QualityProbeResult } from '@/lib/types';

const state = vi.hoisted(() => ({
  /** 模拟 probeQuality 调用次数：用来断言「合并成一次」 */
  calls: 0,
  /** 模拟 probeQuality 抛异常（客户端断开） */
  abort: false,
  /** 内存缓存，模拟 fetch-utils 内的 getCache/setCache */
  cache: new Map<string, { value: unknown; expiresAt: number }>(),
}));

vi.mock('@/lib/api-guard', () => ({
  // 接口鉴权在本测试范围内不关心，假装放行
  guardRequest: vi.fn(() => null),
}));

vi.mock('@/lib/fetch-utils', () => ({
  getCache: <T,>(key: string): T | undefined => {
    const hit = state.cache.get(key);
    return hit && hit.expiresAt > Date.now() ? (hit.value as T) : undefined;
  },
  setCache: (key: string, value: unknown, ttlMs: number) => {
    state.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  },
}));

vi.mock('@/lib/quality-probe', () => ({
  probeQuality: vi.fn(async () => {
    state.calls++;
    if (state.abort) throw new DOMException('aborted', 'AbortError');
    return { sourceKey: 'mock', vodId: 'mock', height: 1080 };
  }),
}));

const item = (key: string, url: string, id = '1') => ({
  source: { key, name: key, url },
  id,
});

function post(items: unknown[]): Request {
  return new Request('https://local.test/api/quality', {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
}

beforeEach(() => {
  state.calls = 0;
  state.abort = false;
  state.cache.clear();
});

describe('POST /api/quality', () => {
  it('同 URL + detail + 影片的多条请求合并成一次上游探测，但结果按各自 sourceKey 返回', async () => {
    // 同一份资源挂了两个源（订阅 + 自定义常见），url 与 id 相同、sourceKey 不同
    const res = await POST(post([item('a', 'https://s.test/api'), item('b', 'https://s.test/api')]));
    const data = (await res.json()) as { results: QualityProbeResult[] };
    expect(res.status).toBe(200);
    expect(state.calls).toBe(1);
    expect(data.results).toHaveLength(2);
    expect(data.results.map((r) => r.sourceKey).sort()).toEqual(['a', 'b']);
    expect(data.results.every((r) => r.height === 1080)).toBe(true);
  });

  it('探测完成后才写缓存；并发请求缓存未命中时也只会打一次源站', async () => {
    // 一次性发 6 条且同 key —— 没有合并逻辑的话，cache 还没写入就会 6 次都 miss
    const res = await POST(
      post(['1', '2', '3', '4', '5', '6'].map((k) => item(k, 'https://s.test/api')))
    );
    const data = (await res.json()) as { results: QualityProbeResult[] };
    expect(state.calls).toBe(1);
    expect(data.results).toHaveLength(6);
  });

  it('第二次同 key 请求命中缓存：不再调 probeQuality', async () => {
    await POST(post([item('a', 'https://s.test/api')]));
    expect(state.calls).toBe(1);
    await POST(post([item('a', 'https://s.test/api')]));
    expect(state.calls).toBe(1);
  });

  it('客户端断开等中断：error 为「探测已取消」且不写缓存（下次仍会重试）', async () => {
    state.abort = true;
    const res = await POST(post([item('a', 'https://s.test/api')]));
    const data = (await res.json()) as { results: QualityProbeResult[] };
    expect(data.results[0]).toMatchObject({ sourceKey: 'a', error: '探测已取消' });
    expect(state.cache.size).toBe(0);

    state.abort = false;
    await POST(post([item('a', 'https://s.test/api')]));
    expect(state.calls).toBe(2);
  });
});
