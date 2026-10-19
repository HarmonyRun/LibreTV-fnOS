import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { validateAddPayload } from '@/lib/strm';
import { enqueueStrmJob, readConfigPublic } from '@/lib/strm-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 加入媒体库：校验入参后写入队列立即返回 202 {jobId}，实际 STRM 生成由引擎异步完成。
 * 与其余 STRM 接口一致要求登录（按钮仅在登录后的详情弹窗中出现）；
 * 未登录的匿名入队会被拒绝，避免局域网内其他人刷队列。
 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonError('请求格式错误', 400);
    }

    const validated = validateAddPayload(body);
    if (!validated.ok) return jsonError(validated.error, 400);

    const config = await readConfigPublic();
    if (!config.strmRoot) {
      return jsonError('尚未配置 STRM 根目录，请先在「设置 → 媒体库」中填写', 409);
    }

    const job = await enqueueStrmJob('add', { ...validated.value });
    return NextResponse.json({ ok: true, jobId: job.id }, { status: 202 });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : '加入媒体库失败', 500);
  }
}
