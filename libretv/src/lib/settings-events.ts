'use client';

/**
 * 打开设置抽屉的全局事件：
 * 详情弹窗（加入媒体库失败时引导去配置）与首启引导条不在设置抽屉的组件树内，
 * 通过 custom event 交给 Header 统一打开，并可直接定位到「媒体库 → STRM」分组。
 */

export const OPEN_SETTINGS_EVENT = 'libretv:open-settings';

export interface OpenSettingsDetail {
  /** 目标二级面板；目前只有 STRM 媒体库需要深链 */
  section?: 'strm';
}

export function requestOpenSettings(detail?: OpenSettingsDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<OpenSettingsDetail>(OPEN_SETTINGS_EVENT, { detail }));
}
