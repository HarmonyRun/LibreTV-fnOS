import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FNV_BASE_URL,
  DEFAULT_SYNC_INTERVAL_HOURS,
  fnvStatus,
  formatSyncResult,
  makeJobId,
  mergeStrmConfig,
  normalizeStrmRoot,
  normalizeSyncInterval,
  publicStrmConfig,
  summarizeIndex,
  tailLogLines,
  validateAddPayload,
  validateRefreshPayload,
} from './strm';

describe('validateAddPayload', () => {
  it('接受合法 payload 并补齐可选字段', () => {
    const r = validateAddPayload({
      sourceApiBase: 'https://example.com/api.php/provide/vod',
      vodId: '12345',
      type: 'movie',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      sourceApiBase: 'https://example.com/api.php/provide/vod',
      sourceName: '',
      sourceDetailBase: '',
      vodId: '12345',
      vodName: '',
      vodYear: '',
      type: 'movie',
    });
  });

  it('保留完整字段并允许数字 vodId', () => {
    const r = validateAddPayload({
      sourceApiBase: ' http://example.com/api.php/provide/vod ',
      sourceName: '示例源',
      sourceDetailBase: 'https://example.com',
      vodId: 42,
      vodName: '沙丘',
      vodYear: '2021',
      type: 'tv',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sourceApiBase).toBe('http://example.com/api.php/provide/vod');
    expect(r.value.vodId).toBe('42');
    expect(r.value.type).toBe('tv');
  });

  it('拒绝非法源地址 / 空 vodId / 超长 vodId / 非法类型', () => {
    const base = { sourceApiBase: 'https://a.com/api', vodId: '1', type: 'movie' };
    expect(validateAddPayload({ ...base, sourceApiBase: 'ftp://a.com' }).ok).toBe(false);
    expect(validateAddPayload({ ...base, vodId: '' }).ok).toBe(false);
    expect(validateAddPayload({ ...base, vodId: 'x'.repeat(65) }).ok).toBe(false);
    expect(validateAddPayload({ ...base, type: 'anime' }).ok).toBe(false);
    expect(validateAddPayload(null).ok).toBe(false);
  });

  it('拒绝非 http(s) 的 sourceDetailBase', () => {
    const r = validateAddPayload({
      sourceApiBase: 'https://a.com/api',
      vodId: '1',
      type: 'movie',
      sourceDetailBase: 'javascript:alert(1)',
    });
    expect(r.ok).toBe(false);
  });
});

describe('validateRefreshPayload', () => {
  it('只接受 sourceApiBase + vodId', () => {
    expect(validateRefreshPayload({ sourceApiBase: 'https://a.com/api', vodId: '9' }).ok).toBe(true);
    expect(validateRefreshPayload({ sourceApiBase: 'https://a.com/api' }).ok).toBe(false);
    expect(validateRefreshPayload({ vodId: '9' }).ok).toBe(false);
  });
});

describe('makeJobId', () => {
  it('生成 job-<epochMs>-<6位随机> 格式', () => {
    expect(makeJobId(1710000000000, () => 'a1b2c3')).toBe('job-1710000000000-a1b2c3');
    expect(makeJobId(1710000000000, () => 'ZZZ')).toBe('job-1710000000000-zzz000');
    expect(makeJobId()).toMatch(/^job-\d{10,}-[a-z0-9]{6}$/);
  });
});

describe('publicStrmConfig', () => {
  it('脱敏所有密码类字段，只暴露 hasXxx', () => {
    const raw = {
      port: 8090,
      password: 'libretv',
      strmRoot: '/vol2/1000/liberTV/strmdata',
      syncIntervalHours: 6,
      movieLibraryName: '电影',
      tvLibraryName: '剧集',
      fnv: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:5666',
        username: 'admin',
        password: 'p',
        secretString: 's',
        apiKey: 'k',
        libraryName: 'LibreTV',
      },
      sources: [{ key: 'a', name: 'a', url: 'https://a.com' }],
    };
    const pub = publicStrmConfig(raw);
    expect(pub.strmRoot).toBe('/vol2/1000/liberTV/strmdata');
    expect(pub.hasPassword).toBe(true);
    expect(pub.fnv).toMatchObject({
      enabled: true,
      baseUrl: 'http://127.0.0.1:5666',
      username: 'admin',
      hasPassword: true,
      hasSecretString: true,
      hasApiKey: true,
    });
    const text = JSON.stringify(pub);
    expect(text).not.toContain('libretv');
    expect(text).not.toContain('"secretString"');
    expect(text).not.toContain('"apiKey"');
  });

  it('缺失字段回退默认值（未配置时 strmRoot 为空）', () => {
    const pub = publicStrmConfig(null);
    expect(pub.strmRoot).toBe('');
    expect(pub.syncIntervalHours).toBe(DEFAULT_SYNC_INTERVAL_HOURS);
    expect(pub.fnv.baseUrl).toBe(DEFAULT_FNV_BASE_URL);
    expect(pub.fnv.enabled).toBe(false);
    expect(pub.hasPassword).toBe(false);
  });

  it('容忍损坏的 fnv / 越界间隔', () => {
    expect(publicStrmConfig({ fnv: 'oops', syncIntervalHours: 999 }).syncIntervalHours).toBe(
      DEFAULT_SYNC_INTERVAL_HOURS
    );
  });
});

describe('paths & interval validation', () => {
  it('normalizeStrmRoot 规范化绝对路径', () => {
    expect(normalizeStrmRoot('/vol2/1000//liberTV/./strmdata/')).toBe('/vol2/1000/liberTV/strmdata');
    expect(normalizeStrmRoot('/vol2/1000/a/../strmdata')).toBe('/vol2/1000/strmdata');
    expect(normalizeStrmRoot('relative/path')).toBeNull();
    expect(normalizeStrmRoot('/../etc')).toBeNull();
    expect(normalizeStrmRoot('/vol2/1000/\u0000bad')).toBeNull();
  });

  it('normalizeSyncInterval 只接受 1–168 整数', () => {
    expect(normalizeSyncInterval(6)).toBe(6);
    expect(normalizeSyncInterval('12')).toBe(12);
    for (const v of [0, 169, 1.5, 'abc', null, undefined, -1]) {
      expect(normalizeSyncInterval(v)).toBeNull();
    }
  });
});

describe('mergeStrmConfig', () => {
  const current = {
    port: 8090,
    password: 'old-password',
    strmRoot: '/vol2/1000/liberTV/strmdata',
    syncIntervalHours: 6,
    movieLibraryName: 'LibreTV 电影',
    tvLibraryName: 'LibreTV 剧集',
    sources: [{ key: 'a', name: 'a', url: 'https://a.com' }],
    fnv: { enabled: false, baseUrl: '', password: 'old-fnv-password', secretString: 'old-secret', apiKey: 'old-key' },
  };

  it('部分更新保留未提交字段（含引擎侧 port / sources）', () => {
    const r = mergeStrmConfig(current, { syncIntervalHours: 12 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.syncIntervalHours).toBe(12);
    expect(r.value.port).toBe(8090);
    expect(r.value.sources).toEqual(current.sources);
    expect(r.value.password).toBe('old-password');
  });

  it('strmRoot 必须是绝对路径且不得位于应用内部 / 系统目录', () => {
    for (const bad of ['relative/path', '/vol1/@appdata/libretv', '/vol1/@appstore/x', '/var/apps/libretv', '/usr/local/x', '/etc/libretv', '/proc/x', '/sys/x', '/']) {
      const r = mergeStrmConfig(current, { strmRoot: bad });
      expect(r.ok, bad).toBe(false);
    }
    const ok = mergeStrmConfig(current, { strmRoot: '/vol2/1000/liberTV/strmdata/' });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.strmRoot).toBe('/vol2/1000/liberTV/strmdata');
  });

  it('同步间隔越界 / 非整数时拒绝', () => {
    for (const bad of [0, 169, 1.5, 'abc']) {
      expect(mergeStrmConfig(current, { syncIntervalHours: bad }).ok).toBe(false);
    }
  });

  it('密码类字段传空字符串表示保持原值', () => {
    const r = mergeStrmConfig(current, {
      password: '',
      fnv: { password: '', secretString: '', apiKey: '', username: 'admin' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.password).toBe('old-password');
    expect(r.value.fnv).toMatchObject({
      password: 'old-fnv-password',
      secretString: 'old-secret',
      apiKey: 'old-key',
      username: 'admin',
    });
  });

  it('密码类字段非空时覆盖', () => {
    const r = mergeStrmConfig(current, {
      password: 'new-password',
      fnv: { password: 'new-fnv', secretString: 'new-secret', apiKey: 'new-key' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.password).toBe('new-password');
    expect(r.value.fnv).toMatchObject({
      password: 'new-fnv',
      secretString: 'new-secret',
      apiKey: 'new-key',
    });
  });

  it('fnv.baseUrl 允许 http(s) 或留空', () => {
    for (const bad of ['127.0.0.1:5666', 'ftp://x', 'javascript:alert(1)']) {
      expect(mergeStrmConfig(current, { fnv: { baseUrl: bad } }).ok, bad).toBe(false);
    }
    for (const okUrl of ['', 'http://127.0.0.1:5666', 'https://fnv.local']) {
      expect(mergeStrmConfig(current, { fnv: { baseUrl: okUrl } }).ok, okUrl).toBe(true);
    }
  });

  it('字符串长度超限时拒绝', () => {
    expect(mergeStrmConfig(current, { fnv: { password: 'x'.repeat(257) } }).ok).toBe(false);
    expect(mergeStrmConfig(current, { movieLibraryName: 'x'.repeat(129) }).ok).toBe(false);
    expect(mergeStrmConfig(current, { strmRoot: `/${'a'.repeat(600)}` }).ok).toBe(false);
  });

  it('非对象 patch 直接拒绝', () => {
    expect(mergeStrmConfig(current, null).ok).toBe(false);
    expect(mergeStrmConfig(current, '[]').ok).toBe(false);
  });
});

describe('summarizeIndex / tailLogLines / 状态文案', () => {
  it('汇总索引条目数与类型，损坏结构返回 0', () => {
    const summary = summarizeIndex({
      entries: {
        'https://a.com::1': { type: 'movie' },
        'https://a.com::2': { type: 'movie' },
        'https://a.com::3': { type: 'tv' },
      },
    });
    expect(summary).toEqual({ count: 3, types: { movie: 2, tv: 1 } });
    expect(summarizeIndex(null)).toEqual({ count: 0, types: {} });
    expect(summarizeIndex({ entries: 'oops' })).toEqual({ count: 0, types: {} });
  });

  it('日志取末尾 N 行并忽略空行', () => {
    const log = ['a', '', 'b', 'c', 'd'].join('\n');
    expect(tailLogLines(log, 2)).toEqual(['c', 'd']);
    expect(tailLogLines('', 50)).toEqual([]);
  });

  it('FnV 状态文案覆盖未配置 / 降级 / 错误 / 已配置', () => {
    expect(fnvStatus(null).label).toBe('未配置');
    expect(fnvStatus({ fnv: { configured: false } }).label).toBe('未配置');
    expect(fnvStatus({ fnv: { configured: true, lastMode: 'fallback', lastError: 'x' } })).toMatchObject({
      label: '降级',
      tone: 'warn',
    });
    expect(fnvStatus({ fnv: { configured: true, lastError: 'boom' } }).label).toBe('错误');
    expect(fnvStatus({ fnv: { configured: true, lastMode: 'api' } })).toMatchObject({
      label: '已配置',
      tone: 'ok',
    });
  });

  it('同步结果摘要', () => {
    expect(formatSyncResult({ checked: 3, updated: 1, deleted: 0, orphansDeleted: 2, errors: 0 })).toBe(
      '检查 3 · 更新 1 · 删除 0 · 孤儿 2 · 错误 0'
    );
    expect(formatSyncResult(null)).toBe('');
  });
});
