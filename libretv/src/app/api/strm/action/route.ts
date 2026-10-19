import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { validateRefreshPayload, type StrmActionName } from '@/lib/strm';
import { enqueueStrmJob, findPendingJob, readConfigPublic } from '@/lib/strm-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS: StrmActionName[] = ['sync', 'cleanup', 'refresh'];

/**
 * 手动触发引擎动作：sync 全量增量同步 / cleanup 快扫清理 / refresh 重新同步单个条目。
 * 统一入队后立即返回 202；sync 已有未处理任务时直接返回已有 jobId（避免重复全量同步）。
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

    const action = (body as { action?: unknown } | null)?.action;
    if (typeof action !== 'string' || !ACTIONS.includes(action as StrmActionName)) {
      return jsonError('action 只能是 sync、cleanup 或 refresh', 400);
    }
    const actionName = action as StrmActionName;

    // refresh 需要精确定位索引条目，先把载荷校验完再决定是否入队
    let payload: Record<string, unknown> = {};
    if (actionName === 'refresh') {
      const validated = validateRefreshPayload(body);
      if (!validated.ok) return jsonError(validated.error, 400);
      payload = { ...validated.value };
    }

    const config = await readConfigPublic();
    if (!config.strmRoot) {
      return jsonError('尚未配置 STRM 根目录，请先在「设置 → 媒体库」中填写', 409);
    }

    if (actionName === 'sync') {
      const existing = await findPendingJob('sync');
      if (existing) {
        return NextResponse.json(
          { ok: true, jobId: existing.id, action: actionName, existing: true },
          { status: 202 }
        );
      }
    }

    const job = await enqueueStrmJob(actionName, payload);
    return NextResponse.json({ ok: true, jobId: job.id, action: actionName }, { status: 202 });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : '触发 STRM 动作失败', 500);
  }
}
