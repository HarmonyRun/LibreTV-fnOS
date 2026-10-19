'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { strmApi, STRM_CONFIG_QUERY_KEY } from '@/lib/client-api';
import {
  DEFAULT_FNV_BASE_URL,
  DEFAULT_SYNC_INTERVAL_HOURS,
  fnvStatus,
  formatSyncResult,
  STRM_LIMITS,
  SYNC_INTERVAL_MAX_HOURS,
  SYNC_INTERVAL_MIN_HOURS,
  type StrmConfigPublic,
  type StrmStatusResponse,
} from '@/lib/strm';
import { cn, formatRelativeTime } from '@/lib/utils';
import { useToast } from './toast';
import { Icon } from './icon';
import { SectionTitle, ToggleRow } from './settings-shared';
import { ErrorState, Spinner } from './states';
import { McpPanel } from './mcp-panel';

/**
 * 设置抽屉 →「媒体库 → STRM 媒体库」面板：
 * - 配置 STRM 根目录与同步间隔；
 * - 飞牛影视自动刷新（base_url / 账号 / secret_string / api_key / 媒体库名称），密码类字段只显示「已保存」；
 * - 保存 / 立即同步 / 立即清理 / 刷新状态，并展示索引条目数、队列、最近同步与 FnV 状态。
 * 文案与交互沿用现有 Drawer / 设置面板风格（暗色主题、btn-* / input 样式）。
 */

interface Draft {
  strmRoot: string;
  syncIntervalHours: string;
  fnvEnabled: boolean;
  baseUrl: string;
  username: string;
  libraryName: string;
  /** 密码类草稿：留空表示保持已保存的值不变 */
  password: string;
  secretString: string;
  apiKey: string;
}

function draftFromConfig(config: StrmConfigPublic): Draft {
  return {
    strmRoot: config.strmRoot,
    syncIntervalHours: String(config.syncIntervalHours),
    fnvEnabled: config.fnv.enabled,
    baseUrl: config.fnv.baseUrl || DEFAULT_FNV_BASE_URL,
    username: config.fnv.username,
    libraryName: config.fnv.libraryName,
    password: '',
    secretString: '',
    apiKey: '',
  };
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s]+$/.test(value);
}

function relativeFromIso(iso: string | undefined): string {
  if (!iso) return '—';
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? formatRelativeTime(timestamp) : iso;
}

function mediaTypeLabel(type: string): string {
  if (type === 'movie') return '电影';
  if (type === 'tv') return '剧集';
  return type;
}

const FNV_TONE_CLASS: Record<'ok' | 'warn' | 'error' | 'muted', string> = {
  ok: 'text-success',
  warn: 'text-warning',
  error: 'text-danger',
  muted: 'text-faint',
};

export function StrmMediaPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingAction, setPendingAction] = useState<'sync' | 'cleanup' | null>(null);
  const [status, setStatus] = useState<StrmStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  // 密码类字段是否已保存：只用于占位文案，原文不会下发到前端
  const [hasPassword, setHasPassword] = useState(false);
  const [hasSecretString, setHasSecretString] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      setStatus(await strmApi.status());
    } catch (err) {
      toast(err instanceof Error ? err.message : '读取 STRM 状态失败', 'error');
    } finally {
      setStatusLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = await strmApi.config();
        if (cancelled) return;
        setDraft(draftFromConfig(config));
        setHasPassword(config.fnv.hasPassword);
        setHasSecretString(config.fnv.hasSecretString);
        setHasApiKey(config.fnv.hasApiKey);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : '读取 STRM 配置失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, [loadStatus]);

  const setField = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const save = async () => {
    if (!draft || saving) return;
    const strmRoot = draft.strmRoot.trim();
    if (!strmRoot) {
      toast('请填写 STRM 根目录', 'warning');
      return;
    }
    const hours = Number(draft.syncIntervalHours);
    if (!Number.isInteger(hours) || hours < SYNC_INTERVAL_MIN_HOURS || hours > SYNC_INTERVAL_MAX_HOURS) {
      toast(`同步间隔需为 ${SYNC_INTERVAL_MIN_HOURS}–${SYNC_INTERVAL_MAX_HOURS} 之间的整数小时`, 'warning');
      return;
    }
    const baseUrl = draft.baseUrl.trim();
    if (baseUrl && !isHttpUrl(baseUrl)) {
      toast('飞牛影视 base_url 需以 http:// 或 https:// 开头', 'warning');
      return;
    }

    setSaving(true);
    try {
      const next = await strmApi.saveConfig({
        strmRoot,
        syncIntervalHours: hours,
        fnv: {
          enabled: draft.fnvEnabled,
          baseUrl,
          username: draft.username.trim(),
          libraryName: draft.libraryName.trim(),
          // 空字符串 = 保持原密码，服务端按此约定合并
          password: draft.password,
          secretString: draft.secretString,
          apiKey: draft.apiKey,
        },
      });
      setDraft(draftFromConfig(next));
      setHasPassword(next.fnv.hasPassword);
      setHasSecretString(next.fnv.hasSecretString);
      setHasApiKey(next.fnv.hasApiKey);
      // 配置变化后引擎下次轮询自动生效；引导条共用同一份配置查询，需要刷新
      queryClient.setQueryData(STRM_CONFIG_QUERY_KEY, next);
      void queryClient.invalidateQueries({ queryKey: STRM_CONFIG_QUERY_KEY });
      toast('STRM 配置已保存', 'success');
      await loadStatus();
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (action: 'sync' | 'cleanup') => {
    if (pendingAction) return;
    setPendingAction(action);
    try {
      const result = await strmApi.action(action);
      if (action === 'sync') {
        toast(
          result.existing ? '已有同步任务在队列中，无需重复提交' : '已加入同步队列，稍后自动执行',
          'success'
        );
      } else {
        toast('已加入清理队列，稍后自动执行', 'success');
      }
      await loadStatus();
    } catch (err) {
      toast(err instanceof Error ? err.message : '触发失败', 'error');
    } finally {
      setPendingAction(null);
    }
  };

  const engine = status?.state?.engine;
  const fnv = fnvStatus(status?.state);
  const types = status?.indexSummary.types ?? {};
  const typeText = Object.entries(types)
    .map(([type, count]) => `${mediaTypeLabel(type)} ${count}`)
    .join(' · ');
  const syncResultText = formatSyncResult(engine?.lastSyncResult);
  const configuredRoot = status?.config.strmRoot || draft?.strmRoot.trim() || '';

  return (
    <section>
      <SectionTitle
        title="STRM 媒体库"
        hint="把点播源中的影片生成为 .strm 文件，供飞牛影视扫描播放"
      />

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Spinner />
        </div>
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={() => window.location.reload()} />
      ) : !draft ? (
        <ErrorState message="未获取到 STRM 配置" onRetry={() => window.location.reload()} />
      ) : (
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs text-muted">STRM 根目录</span>
            <input
              className="input w-full mt-1"
              value={draft.strmRoot}
              onChange={(e) => setField('strmRoot', e.target.value)}
              placeholder="/vol2/1000/liberTV/strmdata"
              aria-label="STRM 根目录"
              maxLength={STRM_LIMITS.strmRoot}
              spellCheck={false}
              autoComplete="off"
            />
            <span className="mt-1 block text-[11px] text-faint leading-relaxed">
              请在「文件管理」中创建普通文件夹，复制其绝对路径；不要使用应用内部目录（如 /vol1/@appdata）。
            </span>
          </label>

          <label className="block">
            <span className="text-xs text-muted">同步间隔（小时）</span>
            <input
              type="number"
              className="input w-full mt-1"
              value={draft.syncIntervalHours}
              onChange={(e) => setField('syncIntervalHours', e.target.value)}
              min={SYNC_INTERVAL_MIN_HOURS}
              max={SYNC_INTERVAL_MAX_HOURS}
              step={1}
              aria-label="同步间隔（小时）"
            />
            <span className="mt-1 block text-[11px] text-faint leading-relaxed">
              每隔多少小时做一次增量同步，范围 {SYNC_INTERVAL_MIN_HOURS}–{SYNC_INTERVAL_MAX_HOURS} 小时，默认{' '}
              {DEFAULT_SYNC_INTERVAL_HOURS} 小时。
            </span>
          </label>

          <div className="pt-3 mt-3 border-t border-line space-y-3">
            <ToggleRow
              label="飞牛影视自动刷新"
              description="生成/更新 STRM 后调用飞牛影视接口触发扫描；凭据不完整时自动跳过，不影响 STRM 生成"
              checked={draft.fnvEnabled}
              onChange={(v) => setField('fnvEnabled', v)}
            />

            {draft.fnvEnabled && (
              <div className="space-y-2.5">
                <label className="block">
                  <span className="text-xs text-muted">base_url</span>
                  <input
                    className="input w-full mt-1"
                    value={draft.baseUrl}
                    onChange={(e) => setField('baseUrl', e.target.value)}
                    placeholder={DEFAULT_FNV_BASE_URL}
                    aria-label="飞牛影视 base_url"
                    maxLength={STRM_LIMITS.baseUrl}
                    spellCheck={false}
                    autoComplete="off"
                  />
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <label className="block">
                    <span className="text-xs text-muted">用户名</span>
                    <input
                      className="input w-full mt-1"
                      value={draft.username}
                      onChange={(e) => setField('username', e.target.value)}
                      placeholder="飞牛影视用户名"
                      aria-label="飞牛影视用户名"
                      maxLength={STRM_LIMITS.username}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted">密码</span>
                    <input
                      type="password"
                      className="input w-full mt-1"
                      value={draft.password}
                      onChange={(e) => setField('password', e.target.value)}
                      placeholder={hasPassword ? '已保存（留空不修改）' : '未保存'}
                      aria-label="飞牛影视密码"
                      maxLength={STRM_LIMITS.password}
                      autoComplete="new-password"
                    />
                  </label>
                </div>

                <label className="block">
                  <span className="text-xs text-muted">secret_string</span>
                  <input
                    type="password"
                    className="input w-full mt-1"
                    value={draft.secretString}
                    onChange={(e) => setField('secretString', e.target.value)}
                    placeholder={hasSecretString ? '已保存（留空不修改）' : '未保存'}
                    aria-label="飞牛影视 secret_string"
                    maxLength={STRM_LIMITS.secretString}
                    spellCheck={false}
                    autoComplete="new-password"
                  />
                </label>

                <label className="block">
                  <span className="text-xs text-muted">api_key</span>
                  <input
                    type="password"
                    className="input w-full mt-1"
                    value={draft.apiKey}
                    onChange={(e) => setField('apiKey', e.target.value)}
                    placeholder={hasApiKey ? '已保存（留空不修改）' : '未保存'}
                    aria-label="飞牛影视 api_key"
                    maxLength={STRM_LIMITS.apiKey}
                    spellCheck={false}
                    autoComplete="new-password"
                  />
                </label>

                <label className="block">
                  <span className="text-xs text-muted">媒体库名称</span>
                  <input
                    className="input w-full mt-1"
                    value={draft.libraryName}
                    onChange={(e) => setField('libraryName', e.target.value)}
                    placeholder="留空 = 使用索引中的媒体库 / 全量刷新"
                    aria-label="飞牛影视媒体库名称"
                    maxLength={STRM_LIMITS.libraryName}
                    spellCheck={false}
                    autoComplete="off"
                  />
                </label>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button className="btn-primary btn-sm" onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button
              className="btn-ghost btn-sm"
              onClick={() => void runAction('sync')}
              disabled={pendingAction !== null || !configuredRoot}
            >
              {pendingAction === 'sync' ? '同步中…' : '立即同步'}
            </button>
            <button
              className="btn-ghost btn-sm"
              onClick={() => void runAction('cleanup')}
              disabled={pendingAction !== null || !configuredRoot}
            >
              {pendingAction === 'cleanup' ? '清理中…' : '立即清理'}
            </button>
          </div>

          {/* 运行状态：数据来自 /api/strm/status（引擎未启动时也安全返回空值） */}
          <div className="mt-4 rounded-lg border border-line bg-card p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h4 className="text-xs font-medium text-content">运行状态</h4>
              <button className="btn-ghost btn-sm" onClick={() => void loadStatus()} disabled={statusLoading}>
                {statusLoading ? <Spinner size="sm" /> : <Icon name="refresh" className="w-3.5 h-3.5" />}
                刷新状态
              </button>
            </div>

            <dl className="grid grid-cols-1 gap-1.5 text-xs">
              <StatusRow
                label="索引条目"
                value={
                  status
                    ? `${status.indexSummary.count} 条${typeText ? `（${typeText}）` : ''}`
                    : '—'
                }
              />
              <StatusRow
                label="队列"
                value={
                  status
                    ? `${status.queuePending} 个待处理${engine?.processingJob ? ' · 正在处理 1 个' : ''}`
                    : '—'
                }
              />
              <StatusRow
                label="最近同步"
                detail={syncResultText || undefined}
                value={status ? relativeFromIso(engine?.lastSyncAt) : '—'}
              />
              <StatusRow
                label="飞牛影视"
                detail={fnv.detail}
                value={<span className={FNV_TONE_CLASS[fnv.tone]}>{fnv.label}</span>}
              />
              <StatusRow
                label="STRM 目录"
                value={
                  !configuredRoot
                    ? '未配置'
                    : status
                      ? status.strmRootWritable
                        ? '可写'
                        : '不可写（请检查目录是否存在与权限）'
                      : '—'
                }
                valueClassName={
                  configuredRoot && status && !status.strmRootWritable ? 'text-warning' : undefined
                }
              />
            </dl>

            {lastFnvOkAt(status) && (
              <p className="mt-2 text-[11px] text-faint">上次飞牛刷新成功：{relativeFromIso(lastFnvOkAt(status))}</p>
            )}

            {status && status.log.length > 0 && (
              <details className="mt-3">
                <summary className="text-[11px] text-muted cursor-pointer select-none">
                  引擎日志（最近 {status.log.length} 行）
                </summary>
                <pre className="mt-1.5 max-h-48 overflow-y-auto scrollbar-thin rounded-md bg-chip p-2 text-[10px] leading-relaxed text-faint whitespace-pre-wrap break-all">
                  {status.log.join('\n')}
                </pre>
              </details>
            )}
          </div>
        </div>
      )}
      <McpPanel />
    </section>
  );
}

function lastFnvOkAt(status: StrmStatusResponse | null): string | undefined {
  return status?.state?.fnv?.lastOkAt;
}

function StatusRow({
  label,
  value,
  detail,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-faint">{label}</dt>
      <dd className="min-w-0 text-right">
        <span className={cn('text-content', valueClassName)}>{value}</span>
        {detail && <span className="block text-[11px] text-faint break-all">{detail}</span>}
      </dd>
    </div>
  );
}
