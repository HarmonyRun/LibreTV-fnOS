import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { validateRemovePayload } from '@/lib/strm';
import { enqueueStrmJob, readConfigPublic } from '@/lib/strm-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 从媒体库移除条目：校验入参后写入 remove 队列立即返回 202 {jobId}，
 * 实际删除资源目录、清理索引与刷新飞牛影视由引擎异步完成。
 * 与其余 STRM 接口一致要求登录；未配置 STRM 根目录时 409。
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

    const validated = validateRemovePayload(body);
    if (!validated.ok) return jsonError(validated.error, 400);

    const config = await readConfigPublic();
    if (!config.strmRoot) {
      return jsonError('尚未配置 STRM 根目录，请先在「设置 → 媒体库」中填写', 409);
    }

    const job = await enqueueStrmJob('remove', { ...validated.value });
    return NextResponse.json({ ok: true, jobId: job.id, action: 'remove' }, { status: 202 });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : '移除条目失败', 500);
  }
}
