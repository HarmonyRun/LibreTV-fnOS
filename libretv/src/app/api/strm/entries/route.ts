import path from 'node:path';
import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { isPlainRecord, type StrmEntriesResponse, type StrmEntry } from '@/lib/strm';
import { getDataPaths, readConfigPublic, readJsonFile } from '@/lib/strm-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 已入库条目列表（设置 → 媒体库 → 已入库条目）：
 * 把 strm-index.json 的 entries 投影成前端友好的数组，按片名排序。
 * 索引缺失 / 损坏 / 结构异常时统一返回空列表（不报 500），
 * 与 /api/strm/status 的容错读取保持一致。
 */

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function asCount(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

/** strmPaths[0] 相对 STRM 根目录的第一层目录名；越界或无法计算时返回空 */
function resourceRootOf(strmRoot: string, firstStrmPath: string): string {
  if (!strmRoot || !firstStrmPath) return '';
  const rel = path.relative(path.resolve(strmRoot), path.resolve(firstStrmPath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  const first = rel.split(path.sep)[0];
  return first && first !== '..' ? first : '';
}

export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  try {
    const [rawIndex, config] = await Promise.all([
      readJsonFile(getDataPaths().index),
      readConfigPublic(),
    ]);

    const rawEntries = isPlainRecord(rawIndex) ? rawIndex.entries : null;
    const entries: StrmEntry[] = [];
    if (isPlainRecord(rawEntries)) {
      for (const [key, value] of Object.entries(rawEntries)) {
        if (!isPlainRecord(value)) continue;
        const strmPaths = Array.isArray(value.strmPaths)
          ? value.strmPaths.filter((item): item is string => typeof item === 'string')
          : [];
        entries.push({
          key,
          title: asString(value.title),
          year: asString(value.year),
          type: value.type === 'tv' ? 'tv' : 'movie',
          sourceName: asString(value.sourceName),
          strmCount: strmPaths.length,
          resourceRoot: resourceRootOf(config.strmRoot, strmPaths[0] ?? ''),
          lastSyncedAt: asString(value.lastSyncedAt),
          lastError: asString(value.lastError),
          consecutiveFailures: asCount(value.consecutiveFailures),
        });
      }
    }

    entries.sort(
      (a, b) => a.title.localeCompare(b.title, 'zh-CN') || a.key.localeCompare(b.key, 'zh-CN')
    );

    const body: StrmEntriesResponse = { ok: true, total: entries.length, entries };
    return NextResponse.json(body);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : '读取已入库条目失败', 500);
  }
}
