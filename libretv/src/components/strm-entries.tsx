'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { strmApi } from '@/lib/client-api';
import { formatRemoveResult, type StrmEntry, type StrmLastResult } from '@/lib/strm';
import { formatRelativeTime } from '@/lib/utils';
import { useToast } from './toast';
import { Icon } from './icon';
import { SearchInput } from './settings-shared';
import { ErrorState, Spinner } from './states';
import { ConfirmDialog } from './confirm-dialog';

/**
 * 设置 → 媒体库 →「已入库条目」：
 * - 列表来自 /api/strm/entries（strm-index.json 投影），按片名排序，标题带数量；
 * - 每行展示片名（年份）、类型、STRM 文件数、最近同步时间与连续失败次数；
 * - 「移除」走二次确认 → POST /api/strm/remove 入队 → 轮询 /api/strm/status
 *   直到 state.engine.lastResult 出现本次 remove 任务结果，再刷新列表并提示；
 * - 条目较多时限高滚动 + 搜索框过滤。
 */

/** 轮询间隔与最长等待：2s × 10 ≈ 20s（与契约一致） */
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 10;
/** 超过该数量才显示搜索框，避免少量条目时多一行控件 */
const SEARCH_THRESHOLD = 6;

function mediaTypeLabel(type: StrmEntry['type']): string {
  return type === 'tv' ? '剧集' : '电影';
}

function entryTitle(entry: StrmEntry): string {
  return entry.title || entry.key;
}

function relativeFromIso(iso: string): string {
  if (!iso) return '—';
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? formatRelativeTime(timestamp) : iso;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function StrmEntriesSection({ onChanged }: { onChanged?: () => void }) {
  const { toast } = useToast();
  const [entries, setEntries] = useState<StrmEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [confirmTarget, setConfirmTarget] = useState<StrmEntry | null>(null);
  // 正在等待移除结果的条目 key：期间禁用全部移除按钮，避免并发轮询互相干扰
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  // 组件卸载后不再 setState（轮询/请求都可能晚于卸载返回）
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const loadEntries = useCallback(async (mode: 'initial' | 'refresh' | 'silent' = 'silent') => {
    if (mode === 'initial') setLoading(true);
    if (mode === 'refresh') setRefreshing(true);
    try {
      const data = await strmApi.entries();
      if (!aliveRef.current) return;
      setEntries(data.entries);
      setLoadError('');
    } catch (err) {
      if (!aliveRef.current) return;
      const message = err instanceof Error ? err.message : '读取已入库条目失败';
      if (mode === 'initial') setLoadError(message);
      else toast(message, 'error');
    } finally {
      if (aliveRef.current) {
        if (mode === 'initial') setLoading(false);
        if (mode === 'refresh') setRefreshing(false);
      }
    }
  }, [toast]);

  useEffect(() => {
    void loadEntries('initial');
  }, [loadEntries]);

  /**
   * 等待本次 remove 任务完成：优先按 jobId 精确匹配，
   * jobId 缺失时用「action=remove 且 at 不早于提交时间」兜底，避免读到旧的移除结果。
   */
  const waitForRemoveResult = useCallback(async (jobId: string, submittedAt: number) => {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
      await sleep(POLL_INTERVAL_MS);
      if (!aliveRef.current) return null;
      let last: StrmLastResult | null = null;
      try {
        const status = await strmApi.status();
        if (!aliveRef.current) return null;
        last = status.state?.engine?.lastResult ?? null;
      } catch {
        // 轮询期间的瞬时失败忽略，继续等下一次
        continue;
      }
      if (!last || last.action !== 'remove') continue;
      if (last.jobId) {
        if (last.jobId === jobId) return last;
        continue;
      }
      const at = Date.parse(last.at ?? '');
      if (Number.isFinite(at) && at >= submittedAt - 2000) return last;
    }
    return null;
  }, []);

  const confirmRemove = async () => {
    const target = confirmTarget;
    if (!target || removingKey) return;
    setConfirmTarget(null);
    setRemovingKey(target.key);
    const submittedAt = Date.now();
    const label = entryTitle(target);
    try {
      const result = await strmApi.remove({ key: target.key });
      if (!aliveRef.current) return;
      toast('已提交移除任务', 'success');

      const last = await waitForRemoveResult(result.jobId, submittedAt);
      if (!aliveRef.current) return;

      // 无论成功/超时都刷新列表：引擎可能已经在后台完成删除
      await loadEntries('silent');
      if (!aliveRef.current) return;
      onChanged?.();

      if (!last) {
        toast(`「${label}」移除任务已提交，等待结果超时，请稍后刷新列表确认`, 'warning');
      } else if (last.ok === false) {
        toast(`移除「${label}」失败：${last.error || '未知错误'}`, 'error');
      } else {
        const detail = formatRemoveResult(last.result);
        toast(detail ? `「${label}」${detail}` : `「${label}」已移除`, 'success');
      }
    } catch (err) {
      if (aliveRef.current) toast(err instanceof Error ? err.message : '移除失败', 'error');
    } finally {
      if (aliveRef.current) setRemovingKey(null);
    }
  };

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return entries;
    return entries.filter((entry) =>
      [entry.title, entry.year, entry.resourceRoot, entry.sourceName, entry.key]
        .join(' ')
        .toLowerCase()
        .includes(keyword)
    );
  }, [entries, query]);

  return (
    <div className="mt-4 rounded-lg border border-line bg-card p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h4 className="text-xs font-medium text-content">已入库条目（{entries.length}）</h4>
        <button
          className="btn-ghost btn-sm"
          onClick={() => void loadEntries('refresh')}
          disabled={refreshing}
          aria-label="刷新已入库条目"
        >
          {refreshing ? <Spinner size="sm" /> : <Icon name="refresh" className="w-3.5 h-3.5" />}
          刷新列表
        </button>
      </div>

      {entries.length > SEARCH_THRESHOLD && (
        <div className="mb-2">
          <SearchInput value={query} onChange={setQuery} placeholder="搜索片名 / 资源目录 / 来源" />
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-6">
          <Spinner />
        </div>
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={() => void loadEntries('initial')} />
      ) : entries.length === 0 ? (
        <p className="py-3 text-center text-[11px] text-faint leading-relaxed">
          还没有入库条目。在搜索结果详情中点击「加入媒体库」，生成的 STRM 条目会显示在这里。
        </p>
      ) : filtered.length === 0 ? (
        <p className="py-3 text-center text-[11px] text-faint">没有匹配的条目</p>
      ) : (
        <ul className="max-h-72 overflow-y-auto scrollbar-thin divide-y divide-line">
          {filtered.map((entry) => (
            <EntryRow
              key={entry.key}
              entry={entry}
              removing={removingKey === entry.key}
              disabled={removingKey !== null}
              onRemove={() => setConfirmTarget(entry)}
            />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirmTarget !== null}
        title="移除媒体库条目"
        danger
        confirmLabel="移除"
        message={
          confirmTarget ? (
            <>
              将删除「{entryTitle(confirmTarget)}」
              {confirmTarget.resourceRoot ? `（${confirmTarget.resourceRoot}）` : ''}
              在 STRM 根目录下的整个资源目录，并从索引移除；飞牛影视里的条目随后会自动消失。
              此操作不可撤销，但可重新在 LibreTV 搜索后加入媒体库。
            </>
          ) : (
            ''
          )
        }
        onConfirm={() => void confirmRemove()}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}

function EntryRow({
  entry,
  removing,
  disabled,
  onRemove,
}: {
  entry: StrmEntry;
  removing: boolean;
  disabled: boolean;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-start justify-between gap-2 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate text-xs text-content" title={entry.title || entry.key}>
            {entryTitle(entry)}
            {entry.year ? `（${entry.year}）` : ''}
          </span>
          <span className="tag shrink-0 bg-chip text-faint">{mediaTypeLabel(entry.type)}</span>
          {entry.consecutiveFailures > 0 && (
            <span className="shrink-0 text-[11px] text-warning">
              连续失败 {entry.consecutiveFailures} 次
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-faint">
          <span className="shrink-0">{entry.strmCount} 个 STRM</span>
          <span className="shrink-0">· 最近同步 {relativeFromIso(entry.lastSyncedAt)}</span>
          {entry.resourceRoot && (
            <span className="min-w-0 truncate" title={entry.resourceRoot}>
              · {entry.resourceRoot}
            </span>
          )}
          {entry.sourceName && (
            <span className="min-w-0 truncate" title={entry.sourceName}>
              · {entry.sourceName}
            </span>
          )}
        </div>
        {entry.lastError && (
          <p className="mt-0.5 truncate text-[11px] text-warning" title={entry.lastError}>
            {entry.lastError}
          </p>
        )}
      </div>
      <button
        className="btn-ghost btn-sm shrink-0"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`移除 ${entryTitle(entry)}`}
      >
        <Icon name="trash" className="w-3.5 h-3.5" />
        {removing ? '移除中…' : '移除'}
      </button>
    </li>
  );
}
