import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publishSourceList } from './source-list-publish';

/**
 * 发布器单测：多后端依次降级，以及「部分写入」这类必须当失败的边界。
 * fetch 全部 mock，不产生任何真实上传。
 */

const state = vi.hoisted(() => ({
  pasteRs: { status: 201, body: 'https://paste.rs/abc123' },
  zeroX0: { status: 200, body: 'https://0x0.st/xyz.json' },
  calls: [] as string[],
}));

vi.stubGlobal(
  'fetch',
  vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    state.calls.push(url);
    if (url.startsWith('https://paste.rs')) {
      return new Response(state.pasteRs.body, { status: state.pasteRs.status });
    }
    if (url.startsWith('https://0x0.st')) {
      return new Response(state.zeroX0.body, { status: state.zeroX0.status });
    }
    return new Response('unexpected target', { status: 500 });
  })
);

beforeEach(() => {
  state.pasteRs = { status: 201, body: 'https://paste.rs/abc123' };
  state.zeroX0 = { status: 200, body: 'https://0x0.st/xyz.json' };
  state.calls = [];
});

describe('publishSourceList', () => {
  it('首选粘贴板成功即返回链接与来源', async () => {
    const result = await publishSourceList('{"a":1}');
    expect(result).toEqual({ url: 'https://paste.rs/abc123', provider: 'paste.rs' });
    // 成功后不应继续尝试后续后端
    expect(state.calls).toHaveLength(1);
  });

  it('206 表示内容被截断，必须当失败并降级到下一个后端', async () => {
    // paste.rs 超出体积上限时返回 206，只写入了一部分；若当成成功会发布出半个 JSON
    state.pasteRs = { status: 206, body: 'https://paste.rs/partial' };
    const result = await publishSourceList('{"a":1}');
    expect(result.provider).toBe('0x0.st');
    expect(result.url).toBe('https://0x0.st/xyz.json');
    expect(state.calls).toEqual(['https://paste.rs/', 'https://0x0.st']);
  });

  it('返回内容不是链接时同样降级', async () => {
    state.pasteRs = { status: 201, body: 'rate limited, try later' };
    const result = await publishSourceList('{"a":1}');
    expect(result.provider).toBe('0x0.st');
  });

  it('全部后端失败时抛出带各自原因的汇总错误', async () => {
    state.pasteRs = { status: 503, body: '' };
    state.zeroX0 = { status: 500, body: '' };
    await expect(publishSourceList('{"a":1}')).rejects.toThrow(/paste\.rs（HTTP 503）/);
    await expect(publishSourceList('{"a":1}')).rejects.toThrow(/0x0\.st（HTTP 500）/);
  });

  it('只向写死的第三方域名发请求', async () => {
    await publishSourceList('{"a":1}');
    for (const url of state.calls) {
      expect(url).toMatch(/^https:\/\/(paste\.rs|0x0\.st)/);
    }
  });
});
