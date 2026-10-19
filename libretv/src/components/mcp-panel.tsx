'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useToast } from './toast';
import { Spinner } from './states';

interface McpInfo {
  enabled: boolean;
  port: number;
  token: string;
  endpoints: { direct: string; viaWeb: string };
  docs: { stdioBridge: string; authHeader: string };
}

/**
 * 设置抽屉 →「MCP 服务」面板：
 * 展示 MCP 连接地址与 token，支持复制、重新生成 token、启用/禁用。
 * 仅登录后可访问（API 有会话守卫）。
 */
export function McpPanel() {
  const { toast } = useToast();
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/strm/mcp', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setInfo((await res.json()) as McpInfo);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取 MCP 配置失败');
    }
  }, []);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch('/api/strm/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as McpInfo & { error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setInfo(data);
      return data;
    } catch (err) {
      toast(err instanceof Error ? err.message : '操作失败', 'error');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label}已复制`, 'success');
    } catch {
      toast('复制失败，请手动选择文本', 'error');
    }
  };

  const host = typeof window !== 'undefined' ? window.location.hostname : '<NAS-IP>';
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://<NAS-IP>:8090';
  const direct = info ? `http://${host}:${info.port}/mcp` : '';
  const viaWeb = `${origin}/api/mcp`;

  return (
    <div className="mt-4 rounded-lg border border-line bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-content">MCP 服务（大模型接入）</p>
          <p className="mt-0.5 text-[11px] text-faint">
            让 DeepSeek Harness / WorkBuddy 等 MCP 客户端搜索资源、加入媒体库、删除 STRM、同步与清理
          </p>
        </div>
        {info && (
          <button
            className={cn('btn-ghost btn-sm shrink-0', !info.enabled && 'text-faint')}
            disabled={busy}
            onClick={() => post({ action: 'setEnabled', enabled: !info.enabled }).then((d) => d && toast(d.enabled ? 'MCP 已启用' : 'MCP 已禁用', 'success'))}
          >
            {info.enabled ? '已启用' : '已禁用'}
          </button>
        )}
      </div>

      {error && <p className="mt-2 text-[11px] text-danger">读取失败：{error}</p>}
      {!info && !error && (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      )}

      {info && (
        <div className="mt-3 space-y-2.5">
          <dl className="space-y-1.5 text-[11px]">
            <div className="flex items-start justify-between gap-3">
              <dt className="shrink-0 text-faint">HTTP MCP（直连）</dt>
              <dd className="min-w-0 text-right text-content break-all">{direct}</dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="shrink-0 text-faint">HTTP MCP（8090 同源）</dt>
              <dd className="min-w-0 text-right text-content break-all">{viaWeb}</dd>
            </div>
          </dl>

          <div className="rounded-md bg-chip p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-faint">访问令牌（Authorization: Bearer）</span>
              <span className="flex items-center gap-2">
                <button className="text-[11px] text-accent hover:underline" onClick={() => copy(info.token, 'Token')}>
                  复制
                </button>
                <button
                  className="text-[11px] text-muted hover:text-content"
                  disabled={busy}
                  onClick={() => post({ action: 'regenerate' }).then((d) => d && toast('Token 已重新生成，旧 Token 立即失效', 'success'))}
                >
                  重新生成
                </button>
              </span>
            </div>
            <code className="mt-1 block max-h-16 overflow-y-auto scrollbar-thin break-all text-[10px] leading-relaxed text-content">
              {info.token || '（未生成）'}
            </code>
          </div>

          <div className="text-[10px] leading-relaxed text-faint">
            <p>
              <span className="text-muted">HTTP/Streamable HTTP 客户端配置：</span>URL 填上面任一地址，Header 加{' '}
              <code className="text-content">{info.docs.authHeader.replace('<TOKEN>', info.token.slice(0, 6) + '…')}</code>
            </p>
            <p className="mt-1 break-all">
              <span className="text-muted">仅支持 stdio 的客户端：</span>
              <code className="text-content">{info.docs.stdioBridge.replace('<NAS-IP>', host).replace('<TOKEN>', info.token.slice(0, 6) + '…')}</code>
            </p>
            <p className="mt-1">可用工具：search_videos / add_to_library / list_library / remove_from_library / sync_library / cleanup_orphans 等。</p>
          </div>
        </div>
      )}
    </div>
  );
}
