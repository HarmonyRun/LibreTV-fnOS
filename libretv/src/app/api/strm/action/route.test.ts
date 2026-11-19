import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';
import type { StrmJob } from '@/lib/strm';

/**
 * 手动动作接口单测：换源迁移（migrate）入队与 dryRun 透传 / 校验，
 * 以及 action 白名单、未配置 STRM 根目录与登录态。
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libretv-strm-action-'));
const configFile = path.join(dataDir, 'config.json');
const queueDir = path.join(dataDir, 'queue');

function makeRequest(body: unknown, cookie = true): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) {
    const { token } = signSession();
    headers.cookie = `${SESSION_COOKIE}=${token}`;
  }
  return new Request('https://local.test/api/strm/action', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function readJson(res: Response): Promise<{ ok?: boolean; jobId?: string; action?: string; error?: string }> {
  return (await res.json()) as { ok?: boolean; jobId?: string; action?: string; error?: string };
}

function readQueuedJobs(): StrmJob[] {
  if (!fs.existsSync(queueDir)) return [];
  return fs
    .readdirSync(queueDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(queueDir, name), 'utf8')) as StrmJob);
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

describe('POST /api/strm/action migrate', () => {
  it('migrate 入队并 202 返回 jobId / action', async () => {
    const res = await POST(makeRequest({ action: 'migrate' }));
    expect(res.status).toBe(202);
    const data = await readJson(res);
    expect(data.ok).toBe(true);
    expect(data.action).toBe('migrate');
    expect(data.jobId).toMatch(/^job-\d{10,}-[a-z0-9]{6}$/);

    const jobs = readQueuedJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: data.jobId, action: 'migrate', payload: {} });
  });

  it('dryRun 为布尔值时透传到任务载荷', async () => {
    const res = await POST(makeRequest({ action: 'migrate', dryRun: true }));
    expect(res.status).toBe(202);
    expect(readQueuedJobs()[0]?.payload).toEqual({ dryRun: true });
  });

  it('dryRun 非布尔值返回 400 且不入队', async () => {
    const res = await POST(makeRequest({ action: 'migrate', dryRun: 'yes' }));
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe('dryRun 必须是布尔值');
    expect(readQueuedJobs()).toHaveLength(0);
  });

  it('action 白名单包含 migrate，未知动作返回 400', async () => {
    const res = await POST(makeRequest({ action: 'explode' }));
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe('action 只能是 sync、cleanup、refresh 或 migrate');
  });

  it('未配置 STRM 根目录返回 409', async () => {
    fs.writeFileSync(configFile, JSON.stringify({ strmRoot: '' }), 'utf8');
    const res = await POST(makeRequest({ action: 'migrate' }));
    expect(res.status).toBe(409);
    expect((await readJson(res)).error).toContain('STRM 根目录');
  });

  it('未登录返回 401', async () => {
    const res = await POST(makeRequest({ action: 'migrate' }, false));
    expect(res.status).toBe(401);
  });
});
