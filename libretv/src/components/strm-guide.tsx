'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { strmApi, STRM_CONFIG_QUERY_KEY } from '@/lib/client-api';
import { useAuth } from './auth';
import { Icon } from './icon';

/**
 * 首启引导条：登录后若 config.strmRoot 仍为空，在页面顶部提示如何创建目录。
 * 可关闭（localStorage 记忆），「去设置」直接打开设置抽屉的 STRM 媒体库分组。
 */

const DISMISS_STORAGE_KEY = 'libretv-strm-guide-dismissed';

export function StrmGuideBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { verified } = useAuth();
  // 首帧默认隐藏，挂载后再读本地记录，避免 SSR / hydration 不一致与闪现
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_STORAGE_KEY) === '1');
    } catch {
      setDismissed(false);
    }
  }, []);

  const { data } = useQuery({
    queryKey: STRM_CONFIG_QUERY_KEY,
    queryFn: () => strmApi.config(),
    enabled: verified && !dismissed,
    staleTime: 30_000,
  });

  if (!verified || dismissed || !data || data.strmRoot) return null;

  const close = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_STORAGE_KEY, '1');
    } catch {
      /* 隐私模式等无法写入时仅本次隐藏 */
    }
  };

  return (
    <div className="border-b border-accent/20 bg-accent/10">
      <div className="max-w-6xl mx-auto px-4 py-2 flex items-center gap-3">
        <Icon name="library" className="w-4 h-4 text-accent shrink-0" />
        <p className="flex-1 min-w-0 text-xs text-muted leading-relaxed">
          还没有配置 <span className="text-content">STRM 媒体库</span>
          ：请在「文件管理」中新建普通文件夹并复制其绝对路径，填入「设置 → 媒体库」，之后即可把影片加入飞牛影视。
        </p>
        <button className="btn-primary btn-sm shrink-0" onClick={onOpenSettings}>
          去设置
        </button>
        <button
          className="p-1.5 rounded-md text-muted hover:text-content hover:bg-hover shrink-0"
          onClick={close}
          aria-label="关闭引导"
          title="不再提示"
        >
          <Icon name="close" className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
