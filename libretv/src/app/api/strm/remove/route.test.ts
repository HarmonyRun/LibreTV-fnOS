import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';
import type { StrmJob } from '@/lib/strm';

/**
 * 移除条目接口单测：入参校验（400）、未配置 STRM 根目录（409）、
 * 合法请求写入 remove 队列并 202 返回 jobId。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libretv-strm-remove-'));
const configFile = path.join(dataDir, 'config.json');
const queueDir = path.join(dataDir, 'queue');

function makeRequest(body: unknown, cookie = true): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) {
    const { token } = signSession();
    headers.cookie = `${SESSION_COOKIE}=${token}`;
  }
  return new Request('https://local.test/api/strm/remove', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function readJson(res: Response): Promise<{ ok?: boolean; jobId?: string; action?: string; error?: string }> {
  return (await res.json()) as { ok?: boolean; jobId?: string; action?: string; error?: string };
}

beforeAll(() => {
  process.env.PASSWORD = 'test-password';
  process.env.LIBRETV_DATA_DIR = dataDir;
});

beforeEach(() => {
  fs.rmSync(configFile, { force: true });
  fs.rmSync(queueDir, { recursive: true, force: true });
  fs.writeFileSync(configFile, JSON.stringify({ strmRoot: '/vol2/1000/strmdata' }), 'utf8');
});

afterAll(() => {
  delete process.env.LIBRETV_DATA_DIR;
  delete process.env.PASSWORD;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /api/strm/remove', () => {
  it('合法请求入队并 202 返回 jobId / action', async () => {
    const res = await POST(makeRequest({ key: 'https://a.com/api::1' }));
    expect(res.status).toBe(202);
    const data = await readJson(res);
    expect(data.ok).toBe(true);
    expect(data.action).toBe('remove');
    expect(data.jobId).toMatch(/^job-\d{10,}-[a-z0-9]{6}$/);

    const files = fs.readdirSync(queueDir).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(1);
    const job = JSON.parse(fs.readFileSync(path.join(queueDir, files[0]), 'utf8')) as StrmJob;
    expect(job.action).toBe('remove');
    expect(job.id).toBe(data.jobId);
    expect(job.payload).toMatchObject({ key: 'https://a.com/api::1' });
  });

  it('非法载荷返回 400（key / title 至少一个、season 范围）', async () => {
    for (const body of [{}, { key: 'k', season: 0 }, { key: 'k', type: 'anime' }, { key: 'k', dryRun: 'yes' }]) {
      const res = await POST(makeRequest(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await readJson(res)).error).toBeTruthy();
    }
    expect(fs.existsSync(queueDir) ? fs.readdirSync(queueDir) : []).toHaveLength(0);
  });

  it('未配置 STRM 根目录返回 409', async () => {
    fs.writeFileSync(configFile, JSON.stringify({ strmRoot: '' }), 'utf8');
    const res = await POST(makeRequest({ key: 'https://a.com/api::1' }));
    expect(res.status).toBe(409);
    expect((await readJson(res)).error).toContain('STRM 根目录');
  });

  it('未登录返回 401', async () => {
    const res = await POST(makeRequest({ key: 'https://a.com/api::1' }, false));
    expect(res.status).toBe(401);
  });
});
