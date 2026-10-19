import { describe, expect, it } from 'vitest';
import {
  isSlowSource,
  matchesAlive,
  matchesKeyword,
  normalizeForSearch,
  probeRank,
  sortChannels,
  type ProbeLike,
} from './live-channel-filter';

const channel = (over: Partial<{ name: string; tvgId?: string; group?: string; url: string }>) => ({
  url: 'https://s.example/1',
  name: '',
  ...over,
});

describe('normalizeForSearch', () => {
  it('小写化并去除分隔符', () => {
    expect(normalizeForSearch('CCTV-1 综合')).toBe('cctv1综合');
    expect(normalizeForSearch('CCTV_5+.HD')).toBe('cctv5hd');
  });
});

describe('matchesKeyword', () => {
  const c = channel({ name: 'CCTV-1 综合', tvgId: 'cctv1', group: '央视' });

  it('空关键字恒匹配', () => {
    expect(matchesKeyword(c, '')).toBe(true);
  });

  it('cctv1 命中 CCTV-1 综合（分隔符归一化）', () => {
    expect(matchesKeyword(c, normalizeForSearch('cctv1'))).toBe(true);
  });

  it('按 tvg-id 匹配', () => {
    expect(matchesKeyword(c, normalizeForSearch('CCTV1'))).toBe(true);
  });

  it('按分组名匹配', () => {
    expect(matchesKeyword(c, normalizeForSearch('央 视'))).toBe(true);
  });

  it('不相关关键字不匹配', () => {
    expect(matchesKeyword(c, normalizeForSearch('湖南卫视'))).toBe(false);
  });
});

describe('matchesAlive', () => {
  const green: ProbeLike = { ok: true, level: 'segment' };
  const fast: ProbeLike = { ok: true, level: 'segment', kbps: 3000 };
  const slow: ProbeLike = { ok: true, level: 'segment', kbps: 60 };
  const weak: ProbeLike = { ok: true, level: 'head' };
  const timeout: ProbeLike = { ok: false, timedOut: true };
  const dead: ProbeLike = { ok: false };

  it('off 恒真（含未测）', () => {
    expect(matchesAlive(undefined, 'off')).toBe(true);
    expect(matchesAlive(dead, 'off')).toBe(true);
  });

  it('ok 档：任何验证级别通过（含限速源）', () => {
    expect(matchesAlive(fast, 'ok')).toBe(true);
    expect(matchesAlive(slow, 'ok')).toBe(true);
    expect(matchesAlive(weak, 'ok')).toBe(true);
    expect(matchesAlive(timeout, 'ok')).toBe(false);
    expect(matchesAlive(dead, 'ok')).toBe(false);
    expect(matchesAlive(undefined, 'ok')).toBe(false);
  });

  it('green 档：仅分片级验证且吞吐达标', () => {
    expect(matchesAlive(fast, 'green')).toBe(true);
    expect(matchesAlive(green, 'green')).toBe(true); // 无吞吐数据不排除
    expect(matchesAlive(slow, 'green')).toBe(false);
    expect(matchesAlive(weak, 'green')).toBe(false);
  });
});

describe('isSlowSource', () => {
  it('分片级 + kbps 低于阈值判为限速', () => {
    expect(isSlowSource({ ok: true, level: 'segment', kbps: 58 })).toBe(true);
    expect(isSlowSource({ ok: true, level: 'segment', kbps: 5000 })).toBe(false);
    expect(isSlowSource({ ok: true, level: 'segment' })).toBe(false); // 未采样
    expect(isSlowSource({ ok: true, level: 'head', kbps: 58 })).toBe(false);
    expect(isSlowSource({ ok: false, level: 'segment', kbps: 58 })).toBe(false);
    expect(isSlowSource(undefined)).toBe(false);
  });
});

describe('probeRank', () => {
  it('绿点 < 限速分片 < 弱验证 < 超时 < 失败 < 未测', () => {
    expect(probeRank({ ok: true, level: 'segment', kbps: 3000 })).toBeLessThan(
      probeRank({ ok: true, level: 'segment', kbps: 60 })
    );
    expect(probeRank({ ok: true, level: 'segment', kbps: 60 })).toBeLessThan(probeRank({ ok: true, level: 'head' }));
    expect(probeRank({ ok: true, level: 'head' })).toBeLessThan(probeRank({ ok: false, timedOut: true }));
    expect(probeRank({ ok: false, timedOut: true })).toBeLessThan(probeRank({ ok: false }));
    expect(probeRank({ ok: false })).toBeLessThan(probeRank(undefined));
  });
});

describe('sortChannels', () => {
  // 用 ASCII 台名/分组断言排序，避免依赖运行环境的中文 collation 细节
  const list = [
    channel({ name: 'TV5', group: 'B-Sat', url: 'u1' }),
    channel({ name: 'CCTV-1', group: 'A-Nat', url: 'u2' }),
    channel({ name: 'CCTV-5', group: 'A-Nat', url: 'u3' }),
  ];

  it('default 保持原序', () => {
    expect(sortChannels(list, 'default').map((c) => c.url)).toEqual(['u1', 'u2', 'u3']);
  });

  it('name 按名称排序', () => {
    expect(sortChannels(list, 'name').map((c) => c.url)).toEqual(['u2', 'u3', 'u1']);
  });

  it('group 先按分组再按名称', () => {
    expect(sortChannels(list, 'group').map((c) => c.url)).toEqual(['u2', 'u3', 'u1']);
  });

  it('group 同分组内保持稳定序（sort 稳定性）', () => {
    const order = sortChannels(list, 'group').filter((c) => c.group === 'A-Nat');
    expect(order.map((c) => c.url)).toEqual(['u2', 'u3']);
  });

  it('probe 可用优先、同级按带宽降序', () => {
    const probeOf = (url: string): ProbeLike | undefined =>
      url === 'u3' ? { ok: true, level: 'head' } : url === 'u1' ? { ok: true, level: 'segment', ms: 200, kbps: 3000 } : { ok: false };
    // u1 绿点（带宽达标）→ u3 弱验证 → u2 失败
    expect(sortChannels(list, 'probe', { probeOf }).map((c) => c.url)).toEqual(['u1', 'u3', 'u2']);
  });

  it('probe 同级绿点按带宽降序', () => {
    const probeOf = (url: string): ProbeLike | undefined =>
      url === 'u1' ? { ok: true, level: 'segment', kbps: 2000 } : url === 'u2' ? { ok: true, level: 'segment', kbps: 6000 } : { ok: true, level: 'segment', kbps: 4000 };
    expect(sortChannels(list, 'probe', { probeOf }).map((c) => c.url)).toEqual(['u2', 'u3', 'u1']);
  });

  it('probe 限速源排在正常绿点之后', () => {
    const probeOf = (url: string): ProbeLike | undefined =>
      url === 'u1' ? { ok: true, level: 'segment', kbps: 60, ms: 10 } : url === 'u2' ? { ok: true, level: 'segment', kbps: 3000, ms: 500 } : { ok: false };
    // u1 延迟更低但限速 → 排在 u2 之后
    expect(sortChannels(list, 'probe', { probeOf }).map((c) => c.url)).toEqual(['u2', 'u1', 'u3']);
  });

  it('probe 未测频道排在已测之后', () => {
    const probeOf = (url: string): ProbeLike | undefined => (url === 'u1' ? { ok: false } : undefined);
    expect(sortChannels(list, 'probe', { probeOf }).map((c) => c.url)).toEqual(['u1', 'u2', 'u3']);
  });

  it('recent 按最近观看序排列，未观看的靠后', () => {
    const recentOrder = new Map([
      ['u3', 0],
      ['u1', 1],
    ]);
    expect(sortChannels(list, 'recent', { recentOrder }).map((c) => c.url)).toEqual(['u3', 'u1', 'u2']);
  });
});
