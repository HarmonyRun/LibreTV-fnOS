import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';

/**
 * 已入库条目接口单测：从 strm-index.json 投影列表、按片名排序、
 * resourceRoot 取第一层目录名，以及索引缺失/损坏时的空列表兜底。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libretv-strm-entries-'));
const indexFile = path.join(dataDir, 'strm-index.json');
const configFile = path.join(dataDir, 'config.json');

interface EntriesBody {
  ok?: boolean;
  total?: number;
  entries?: {
    key: string;
    title: string;
    year: string;
    type: string;
    sourceName: string;
    strmCount: number;
    resourceRoot: string;
    lastSyncedAt: string;
    lastError: string;
    consecutiveFailures: number;
  }[];
}

function makeRequest(cookie = true): Request {
  const headers: Record<string, string> = {};
  if (cookie) {
    const { token } = signSession();
    headers.cookie = `${SESSION_COOKIE}=${token}`;
  }
  return new Request('https://local.test/api/strm/entries', { headers });
}

async function readJson(res: Response): Promise<EntriesBody> {
  return (await res.json()) as EntriesBody;
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
}

beforeAll(() => {
  process.env.PASSWORD = 'test-password';
  process.env.LIBRETV_DATA_DIR = dataDir;
});

beforeEach(() => {
  fs.rmSync(indexFile, { force: true });
  fs.rmSync(configFile, { force: true });
});

afterAll(() => {
  delete process.env.LIBRETV_DATA_DIR;
  delete process.env.PASSWORD;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /api/strm/entries', () => {
  it('索引缺失 / 损坏时返回空列表而不是报错', async () => {
    let res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ ok: true, total: 0, entries: [] });

    fs.writeFileSync(indexFile, '{ not json', 'utf8');
    res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ ok: true, total: 0, entries: [] });
  });

  it('投影索引条目：类型 / STRM 数 / resourceRoot / 失败次数，并按片名排序', async () => {
    writeJson(configFile, { strmRoot: '/vol2/1000/strmdata' });
    writeJson(indexFile, {
      version: 1,
      entries: {
        'https://a.com/api::2': {
          type: 'tv',
          title: 'Bravo 剧集',
          year: 2019,
          sourceName: '示例源',
          strmPaths: [
            '/vol2/1000/strmdata/Bravo 剧集 (2019)/Season 01/S01E01.strm',
            '/vol2/1000/strmdata/Bravo 剧集 (2019)/Season 01/S01E02.strm',
          ],
          lastSyncedAt: '2026-01-02T03:04:05.000Z',
          consecutiveFailures: 2,
          lastError: '同步失败',
        },
        'https://a.com/api::1': {
          type: 'movie',
          title: 'Alpha 电影',
          year: '2009',
          sourceName: '示例源',
          strmPaths: ['/vol2/1000/strmdata/Alpha 电影 (2009)/Alpha 电影.strm'],
          lastSyncedAt: '',
          consecutiveFailures: -3,
        },
        'https://a.com/api::3': {
          type: 'movie',
          title: 'Gamma 越界',
          // 不在 STRM 根目录内：resourceRoot 留空
          strmPaths: ['/mnt/other/Gamma/Gamma.strm'],
        },
        'https://a.com/api::4': null,
      },
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const data = await readJson(res);
    expect(data.ok).toBe(true);
    expect(data.total).toBe(3);
    // 排序：Alpha → Bravo → Gamma（zh-CN 排序对 ASCII 结果仍是字典序）
    expect(data.entries?.map((entry) => entry.title)).toEqual(['Alpha 电影', 'Bravo 剧集', 'Gamma 越界']);

    const tv = data.entries?.find((entry) => entry.title === 'Bravo 剧集');
    expect(tv).toMatchObject({
      key: 'https://a.com/api::2',
      year: '2019',
      type: 'tv',
      sourceName: '示例源',
      strmCount: 2,
      resourceRoot: 'Bravo 剧集 (2019)',
      lastSyncedAt: '2026-01-02T03:04:05.000Z',
      lastError: '同步失败',
      consecutiveFailures: 2,
    });

    const movie = data.entries?.find((entry) => entry.title === 'Alpha 电影');
    expect(movie).toMatchObject({ year: '2009', type: 'movie', consecutiveFailures: 0 });
    expect(movie?.resourceRoot).toBe('Alpha 电影 (2009)');

    expect(data.entries?.find((entry) => entry.title === 'Gamma 越界')?.resourceRoot).toBe('');
  });

  it('未登录返回 401', async () => {
    const res = await GET(makeRequest(false));
    expect(res.status).toBe(401);
  });
});
