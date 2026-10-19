import { describe, expect, it } from 'vitest';
import { formatRemarks, inferGroupRemarks } from './remarks';

describe('formatRemarks', () => {
  it('截图里那五种写法归一成两种结果', () => {
    // 360资源 / 暴风资源 / 电影天堂 / 非凡影视 / 光速资源 的实际取值
    expect(formatRemarks('全34集')).toBe('全34集');
    expect(formatRemarks('完结')).toBe('已完结');
    expect(formatRemarks('已完结')).toBe('已完结');
    expect(formatRemarks('第34集已完结')).toBe('全34集');
  });

  it('连载中保留进度', () => {
    expect(formatRemarks('更新至12集')).toBe('更新至12集');
    expect(formatRemarks('更新至第12集')).toBe('更新至12集');
    expect(formatRemarks('第12集')).toBe('更新至12集');
  });

  it('「全」「共」「集全」都是完结信号', () => {
    expect(formatRemarks('共24集')).toBe('全24集');
    expect(formatRemarks('24集全')).toBe('全24集');
    expect(formatRemarks('全集')).toBe('已完结');
    expect(formatRemarks('大结局')).toBe('已完结');
  });

  it('非集数备注原样保留，不能把信息改丢', () => {
    // 电影常用这类备注，跟集数无关
    expect(formatRemarks('HD国语')).toBe('HD国语');
    expect(formatRemarks('正片')).toBe('正片');
    expect(formatRemarks('BD高清中字')).toBe('BD高清中字');
    expect(formatRemarks('2026')).toBe('2026');
    // 「终」只认「剧终」：终极版不是完结
    expect(formatRemarks('终极版')).toBe('终极版');
  });

  it('空值与空白返回 undefined，交给调用方显示「暂无介绍」', () => {
    expect(formatRemarks(undefined)).toBeUndefined();
    expect(formatRemarks('')).toBeUndefined();
    expect(formatRemarks('   ')).toBeUndefined();
  });

  it('幂等：已归一化的文案再跑一次不变', () => {
    for (const raw of ['全34集', '更新至12集', '已完结', 'HD国语']) {
      const once = formatRemarks(raw);
      expect(formatRemarks(once)).toBe(once);
    }
  });

  it('首尾空白不影响判定', () => {
    expect(formatRemarks(' 全34集 ')).toBe('全34集');
  });
});

describe('inferGroupRemarks', () => {
  it('用组内已知的总集数补齐只标了「已完结」的源', () => {
    // 截图里 13 个源的真实组合：8 个「全34集」、4 个「已完结」、1 个「更新至34集」
    const group = [
      '全34集', '完结', '已完结', '已完结', '第34集已完结',
      '全34集', '全34集', '全34集', '全34集', '全34集',
      '已完结', '全34集', '更新至34集',
    ];
    expect(inferGroupRemarks(group)).toBe('全34集');
  });

  it('组内没有任何总集数时，退回「已完结」而不是编一个数字', () => {
    expect(inferGroupRemarks(['已完结', '完结', '已完结'])).toBe('已完结');
  });

  it('全是连载中的源：取最大进度', () => {
    expect(inferGroupRemarks(['更新至12集', '更新至5集'])).toBe('更新至12集');
  });

  it('总集数优先于进度：不能拿进度当总集数', () => {
    // 12 集的进度不代表这部只有 12 集；组内既然有源写「全24集」，总集数就是 24
    expect(inferGroupRemarks(['全24集', '更新至12集'])).toBe('全24集');
    // 反过来：只有进度时不能冒充总集数
    expect(inferGroupRemarks(['更新至12集', '更新至5集'])).toBe('更新至12集');
  });

  it('总集数优先于完结：有集数就别退回没集数的「已完结」', () => {
    expect(inferGroupRemarks(['已完结', '完结', '全24集'])).toBe('全24集');
  });

  it('非集数备注（电影）原样返回第一条', () => {
    expect(inferGroupRemarks(['HD国语', '正片'])).toBe('HD国语');
  });

  it('多个源给不同总集数时取最大的', () => {
    expect(inferGroupRemarks(['全24集', '全34集', '全12集'])).toBe('全34集');
  });

  it('什么都没给时返回 undefined', () => {
    expect(inferGroupRemarks([undefined, '', '  '])).toBeUndefined();
    expect(inferGroupRemarks([])).toBeUndefined();
  });
});
