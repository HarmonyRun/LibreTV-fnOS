import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { readStrmStatus } from '@/lib/strm-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * STRM 媒体库运行状态：state.json + strm-index.json 概要 + engine.log 末 50 行 + 脱敏配置。
 * 所有读取均容错（文件缺失 / 损坏返回空值），引擎未启动时也能正常响应。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  try {
    return NextResponse.json(await readStrmStatus());
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : '读取 STRM 状态失败', 500);
  }
}
