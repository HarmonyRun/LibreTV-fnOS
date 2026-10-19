import { describe, expect, it } from 'vitest';
import { groupCalendarByWeekday, normalizeWeekday, subjectToItem } from './bangumi';

describe('normalizeWeekday', () => {
  it('1-7 原样保留，非法值丢弃', () => {
    expect(normalizeWeekday(1)).toBe(1);
    expect(normalizeWeekday(7)).toBe(7);
    expect(normalizeWeekday(0)).toBeUndefined();
    expect(normalizeWeekday(8)).toBeUndefined();
  });
});

describe('subjectToItem', () => {
  it('优先中文名、评分保留一位小数', () => {
    const item = subjectToItem({
      id: 123,
      name: 'Original Name',
      name_cn: '中文名',
      images: { large: 'https://lain.bgm.tv/pic/cover/l/1.jpg', common: 'https://lain.bgm.tv/pic/cover/c/1.jpg' },
      rating: { score: 8.76 },
    });
    expect(item).toEqual({
      id: '123',
      title: '中文名',
      cover: 'https://lain.bgm.tv/pic/cover/l/1.jpg',
      rating: '8.8',
      isTv: true,
    });
  });

  it('无中文名时回退原名，0 分不输出 rating', () => {
    const item = subjectToItem({
      id: 456,
      name: 'Fallback',
      images: { medium: 'https://lain.bgm.tv/pic/cover/m/2.jpg' },
      rating: { score: 0 },
    });
    expect(item).toMatchObject({ title: 'Fallback', cover: 'https://lain.bgm.tv/pic/cover/m/2.jpg' });
    expect(item?.rating).toBeUndefined();
  });

  it('缺 id、标题或封面的脏数据返回 undefined', () => {
    expect(subjectToItem({ id: 1, name: 'x', images: {} })).toBeUndefined();
    expect(subjectToItem({ name: 'x', images: { large: 'c' } })).toBeUndefined();
    expect(subjectToItem({ id: 1, images: { large: 'c' } })).toBeUndefined();
  });
});

describe('groupCalendarByWeekday', () => {
  it('按星期分组，跳过非法星期与脏条目', () => {
    const days = groupCalendarByWeekday([
      {
        weekday: { id: 1, cn: '星期一' },
        items: [
          { id: 10, name: 'a', name_cn: '甲', images: { large: 'c1' }, rating: { score: 7 } },
          { name: 'dirty', images: { large: 'c2' } },
        ],
      },
      { weekday: { id: 9 }, items: [{ id: 99, name: 'x', images: { large: 'c3' } }] },
      { weekday: { id: 7 }, items: [] },
    ]);
    expect(Object.keys(days).sort()).toEqual(['1', '7']);
    expect(days[1]).toEqual([{ id: '10', title: '甲', cover: 'c1', rating: '7.0', isTv: true }]);
    expect(days[7]).toEqual([]);
  });
});
