import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 应用内更新代理（需登录）：
 *   GET  /api/update            → 更新状态（当前/最新版本、是否可更新）
 *   POST /api/update {action}   → action = "check" 重新检查 | "apply" 下载并安装
 *
 * 实际逻辑在应用内独立更新服务（127.0.0.1:8093），本路由只做鉴权与转发。
 */

function getDataDir(): string {
  return process.env.LIBRETV_DATA_DIR || process.env.TRIM_PKGVAR || path.join(process.cwd(), 'var');
}

function getPort(): number {
  const envPort = Number(process.env.LIBRETV_UPDATE_PORT);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(getDataDir(), 'config.json'), 'utf8')) as {
      update?: { port?: number };
    };
    const port = Number(cfg?.update?.port);
    if (Number.isFinite(port) && port > 0) return port;
  } catch {
    /* ignore */
  }
  return 8093;
}

async function callUpdater(pathname: string, init?: RequestInit): Promise<Response> {
  const url = `http://127.0.0.1:${getPort()}${pathname}`;
  try {
    const upstream = await fetch(url, { cache: 'no-store', ...init });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '更新服务不可用';
    return NextResponse.json({ enabled: false, error: `更新服务不可用: ${message}` }, { status: 502 });
  }
}

export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  return callUpdater('/status');
}

export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  let action = '';
  try {
    const body = (await req.json()) as { action?: unknown };
    action = typeof body?.action === 'string' ? body.action : '';
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }
  if (action === 'check') return callUpdater('/check', { method: 'POST' });
  if (action === 'apply') return callUpdater('/apply', { method: 'POST' });
  return NextResponse.json({ error: '未知 action' }, { status: 400 });
}
