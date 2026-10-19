'use client';

import { useEffect, useRef, type RefObject } from 'react';

/** 弹窗内可聚焦元素选择器 */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 弹窗焦点管理：打开时记忆来源并把焦点移入，Tab 在容器内循环（不逃逸到背景页面），
 * 关闭后归还焦点。Drawer 内联实现了同一套逻辑，此处抽出来供其它弹窗（详情 / 换源）复用。
 *
 * @param active 是否处于打开状态（常驻挂载的弹窗传 true 即可）
 * @param containerRef 弹窗面板的 ref（需可聚焦：加 tabIndex={-1}）
 */
export function useFocusTrap(active: boolean, containerRef: RefObject<HTMLElement | null>) {
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = containerRef.current;
    if (panel) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    }
    return () => {
      restoreRef.current?.focus?.();
      restoreRef.current = null;
    };
  }, [active, containerRef]);

  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const panel = containerRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0 || el === document.activeElement
      );
      if (nodes.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const current = document.activeElement;
      if (e.shiftKey) {
        if (current === first || !panel.contains(current)) {
          e.preventDefault();
          last.focus();
        }
      } else if (current === last || !panel.contains(current)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [active, containerRef]);
}
