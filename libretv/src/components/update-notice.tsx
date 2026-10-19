'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface UpdateStatus {
  enabled: boolean;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  notes: string;
  htmlUrl: string;
  publishedAt: string;
  lastCheckAt: string;
  error: string;
  applying: boolean;
  intervalHours: number;
}

const POLL_MS = 60_000;

/**
 * 顶部「发现新版本」提醒 + 一键 OTA。
 * 点击更新：下载更新包→校验→替换→自动重启，期间轮询状态直到版本变化。
 */
export function UpdateNotice() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/update', { cache: 'no-store' });
      if (!res.ok) return;
      setStatus((await res.json()) as UpdateStatus);
    } catch {
      /* 重启期间请求会失败，忽略 */
    }
  }, []);

  useEffect(() => {
    load().catch(() => undefined);
    timer.current = setInterval(() => load().catch(() => undefined), POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [load]);

  const waitForRestart = useCallback(async (target: string) => {
    setPhase('正在重启并检查新版本…');
    const deadline = Date.now() + 180_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await fetch('/api/update', { cache: 'no-store' });
        if (res.ok) {
          const next = (await res.json()) as UpdateStatus;
          setStatus(next);
          if (next.currentVersion === target) {
            setPhase('更新完成，即将刷新页面…');
            setTimeout(() => window.location.reload(), 1500);
            return;
          }
          if (!next.applying && Date.now() > deadline) break;
        }
      } catch {
        /* 重启中 */
      }
      if (Date.now() > deadline) break;
    }
    setPhase('');
    setApplying(false);
    setError('更新超时：请检查应用是否正常运行，必要时到应用中心重启');
  }, []);

  const apply = async () => {
    if (!status || applying) return;
    setApplying(true);
    setError('');
    setPhase('正在下载并校验更新包…');
    try {
      const res = await fetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'apply' }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; to?: string; restarting?: boolean };
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await waitForRestart(data.to || status.latestVersion);
    } catch (err) {
      setApplying(false);
      setPhase('');
      setError(err instanceof Error ? err.message : '更新失败');
    }
  };

  if (!status || !status.enabled || (!status.updateAvailable && !applying)) return null;

  return (
    <>
      <button
        className="relative px-2.5 py-1.5 rounded-md text-sm transition-colors text-warning hover:bg-hover"
        onClick={() => setOpen(true)}
        title={`发现新版本 v${status.latestVersion}`}
      >
        更新 v{status.latestVersion}
        <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-warning" />
      </button>

      {open && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={() => !applying && setOpen(false)}>
          <div
            className="w-full max-w-lg rounded-xl border border-line bg-surface p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-medium text-content">发现新版本 v{status.latestVersion}</h3>
                <p className="mt-1 text-xs text-faint">
                  当前 v{status.currentVersion} → 最新 v{status.latestVersion}
                  {status.publishedAt ? ` · 发布于 ${status.publishedAt.slice(0, 10)}` : ''}
                </p>
              </div>
              {!applying && (
                <button className="text-muted hover:text-content" onClick={() => setOpen(false)} aria-label="关闭">
                  ✕
                </button>
              )}
            </div>

            {status.notes && (
              <pre className="mt-3 max-h-52 overflow-y-auto scrollbar-thin whitespace-pre-wrap break-words rounded-md bg-chip p-2 text-[11px] leading-relaxed text-muted">
                {status.notes}
              </pre>
            )}

            {phase && <p className="mt-3 text-xs text-accent">{phase}</p>}
            {error && <p className="mt-3 text-xs text-danger">{error}</p>}

            <div className="mt-4 flex items-center justify-end gap-2">
              {!applying && (
                <button className="px-3 py-1.5 rounded-md text-sm text-muted hover:text-content" onClick={() => setOpen(false)}>
                  稍后
                </button>
              )}
              <button
                className="px-3 py-1.5 rounded-md text-sm bg-accent text-white disabled:opacity-60"
                disabled={applying}
                onClick={apply}
              >
                {applying ? '更新中…' : `立即更新到 v${status.latestVersion}`}
              </button>
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-faint">
              更新只会替换应用运行文件，配置、STRM 索引与媒体库数据都会保留；更新后应用会自动重启。
            </p>
          </div>
        </div>
      )}
    </>
  );
}
