import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefersTouchPointer } from './touch-pointer';

afterEach(() => {
  vi.unstubAllGlobals();
});

const mq = (matches: boolean) => () => ({ matches });

describe('prefersTouchPointer', () => {
  it('hover:none + pointer:coarse（手机/平板手指）→ 触屏', () => {
    expect(prefersTouchPointer(mq(true))).toBe(true);
  });

  it('hover 可用（桌面鼠标/触控板）→ 非触屏', () => {
    expect(prefersTouchPointer(mq(false))).toBe(false);
  });

  it('查询串固定为 (hover: none) and (pointer: coarse)', () => {
    const queries: string[] = [];
    prefersTouchPointer((q) => {
      queries.push(q);
      return { matches: true };
    });
    expect(queries).toEqual(['(hover: none) and (pointer: coarse)']);
  });

  it('SSR / 无 window → 按桌面处理（node 环境天然覆盖）', () => {
    expect(prefersTouchPointer()).toBe(false);
  });

  it('window 有 matchMedia 时走真实媒体查询结果', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    expect(prefersTouchPointer()).toBe(true);
  });

  it('window 存在但无 matchMedia（老浏览器）→ 桌面处理', () => {
    vi.stubGlobal('window', {});
    expect(prefersTouchPointer()).toBe(false);
  });

  it('matchMedia 抛错（隐私模式等异常环境）→ 桌面处理，不炸调用方', () => {
    vi.stubGlobal('window', {
      matchMedia: () => {
        throw new Error('boom');
      },
    });
    expect(prefersTouchPointer()).toBe(false);
  });
});
