import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { mergeStrmConfig, publicStrmConfig } from '@/lib/strm';
import { readConfigRaw, writeConfigRaw } from '@/lib/strm-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 读取 STRM 配置（脱敏：密码类字段只返回 hasXxx 布尔） */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  try {
    return NextResponse.json(publicStrmConfig(await readConfigRaw()));
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : '读取 STRM 配置失败', 500);
  }
}

/**
 * 部分更新 STRM 配置（合并写入 + 原子写 + 字段校验）。
 * 密码类字段传空字符串表示保持原值；写后引擎下次轮询自动生效，无需重启。
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

    const current = await readConfigRaw();
    const merged = mergeStrmConfig(current, body);
    if (!merged.ok) return jsonError(merged.error, 400);

    await writeConfigRaw(merged.value);
    return NextResponse.json(publicStrmConfig(merged.value));
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : '保存 STRM 配置失败', 500);
  }
}
