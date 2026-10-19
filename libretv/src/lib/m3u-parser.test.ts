import { describe, expect, it } from 'vitest';
import { normalizeStreamUrl, parseM3u } from './m3u-parser';

describe('normalizeStreamUrl', () => {
  it('相对地址按 base 解析', () => {
    expect(normalizeStreamUrl('/live/cctv1.m3u8', 'https://sub.example.com/playlist')).toBe(
      'https://sub.example.com/live/cctv1.m3u8'
    );
  });

  it('拒绝非 http(s) 协议', () => {
    expect(normalizeStreamUrl('rtp://239.1.1.1:5000')).toBeUndefined();
    expect(normalizeStreamUrl('udp://@239.1.1.1:5000')).toBeUndefined();
    expect(normalizeStreamUrl('rtsp://cam.local/stream')).toBeUndefined();
  });

  it('空串与非法地址返回 undefined', () => {
    expect(normalizeStreamUrl('')).toBeUndefined();
    expect(normalizeStreamUrl('  ')).toBeUndefined();
    expect(normalizeStreamUrl('not a url')).toBeUndefined();
  });
});

describe('parseM3u', () => {
  it('解析标准 M3U 属性', () => {
    const m3u = `#EXTM3U
#EXTINF:-1 tvg-id="cctv1" tvg-name="CCTV1" tvg-logo="https://img/logo1.png" group-title="央视",CCTV-1 综合
https://stream.example.com/cctv1.m3u8
#EXTINF:-1 tvg-id="cctv5" group-title="体育",CCTV-5 体育
https://stream.example.com/cctv5.m3u8`;
    const channels = parseM3u(m3u);
    expect(channels).toHaveLength(2);
    expect(channels[0]).toMatchObject({
      id: 'cctv1',
      name: 'CCTV-1 综合',
      url: 'https://stream.example.com/cctv1.m3u8',
      logo: 'https://img/logo1.png',
      group: '央视',
      tvgId: 'cctv1',
      rawName: 'CCTV1',
    });
    expect(channels[1].group).toBe('体育');
  });

  it('兼容属性写在标题后的非标准写法', () => {
    const m3u = `#EXTM3U
#EXTINF:-1,广东卫视 tvg-id="gdtv" group-title="卫视"
https://stream.example.com/gd.flv`;
    const channels = parseM3u(m3u);
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      id: 'gdtv',
      name: '广东卫视',
      group: '卫视',
      url: 'https://stream.example.com/gd.flv',
    });
  });

  it('EXTGRP 补充分组', () => {
    const m3u = `#EXTM3U
#EXTINF:-1,新闻频道
#EXTGRP:资讯
https://stream.example.com/news.m3u8`;
    expect(parseM3u(m3u)[0].group).toBe('资讯');
  });

  it('相对流地址按订阅 URL 解析', () => {
    const channels = parseM3u(
      '#EXTINF:-1,测试\nlive/a.m3u8',
      'https://cdn.example.com/list/index.m3u'
    );
    expect(channels[0].url).toBe('https://cdn.example.com/list/live/a.m3u8');
  });

  it('相对 logo 同样解析为绝对地址', () => {
    const channels = parseM3u(
      '#EXTINF:-1 tvg-logo="/logos/a.png",A\nhttps://x.example.com/a.m3u8',
      'https://cdn.example.com/'
    );
    expect(channels[0].logo).toBe('https://cdn.example.com/logos/a.png');
  });

  it('按 URL 去重，保留首个', () => {
    const m3u = `#EXTM3U
#EXTINF:-1,频道A
https://s.example.com/same.m3u8
#EXTINF:-1,频道A 高清
https://s.example.com/same.m3u8`;
    const channels = parseM3u(m3u);
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('频道A');
  });

  it('丢弃非 http(s) 流与无地址行', () => {
    const m3u = `#EXTM3U
#EXTINF:-1,组播源
rtp://239.3.1.1:5000
#EXTINF:-1,正常源
https://s.example.com/ok.m3u8`;
    const channels = parseM3u(m3u);
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('正常源');
  });

  it('无 EXTINF 的裸地址也能解析并生成兜底名称', () => {
    const channels = parseM3u('https://s.example.com/feeds/news.m3u8');
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('news');
    expect(channels[0].id).not.toBe('');
  });

  it('无 tvg-id 时由 URL 生成稳定 id', () => {
    const a = parseM3u('#EXTINF:-1,X\nhttps://s.example.com/x.m3u8');
    const b = parseM3u('#EXTINF:-1,X\nhttps://s.example.com/x.m3u8');
    expect(a[0].id).toBe(b[0].id);
  });

  it('空输入与异常输入不抛错', () => {
    expect(parseM3u('')).toEqual([]);
    expect(parseM3u('随便一段文本\n没有地址')).toEqual([]);
    expect(parseM3u('#EXTINF:-1,孤儿频道')).toEqual([]);
  });
});
