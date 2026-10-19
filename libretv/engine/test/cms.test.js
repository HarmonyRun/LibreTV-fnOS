'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cms = require('../cms');

const API = 'https://cj.example.com/api.php/provide/vod';

function jsonResponse(payload, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

function vodJson(overrides = {}) {
  const vod = {
    vod_id: '1197',
    vod_name: '沙丘',
    vod_year: '2021',
    vod_play_from: 'liangzi$$$lzm3u8',
    vod_play_url:
      'HD中字$https://vip.example.com/share/abc$$$HD中字$https://vip.example.com/20220325/489/index.m3u8',
    ...overrides,
  };
  return { code: 1, msg: '数据列表', list: [vod] };
}

test('searchUrl / detailUrl 构造（含编码与已有 query）', () => {
  const search = cms.searchUrl(API, '沙丘 2');
  assert.match(search, /^https:\/\/cj\.example\.com\/api\.php\/provide\/vod\?/);
  assert.match(search, /ac=videolist/);
  assert.match(search, /wd=%E6%B2%99%E4%B8%98(%20|\+)2/);

  const detail = new URL(cms.detailUrl(API, '1197'));
  assert.equal(detail.searchParams.get('ac'), 'videolist');
  assert.equal(detail.searchParams.get('ids'), '1197');

  const withQuery = new URL(cms.detailUrl(API + '?foo=bar', '42'));
  assert.equal(withQuery.searchParams.get('foo'), 'bar');
  assert.equal(withQuery.searchParams.get('ids'), '42');
});

test('parsePlayUrl：$$$ 分线路、# 分集、$ 分名称与 URL', () => {
  const lines = cms.parsePlayUrl(
    '第01集$https://cdn.example.com/a.m3u8#第02集$https://cdn.example.com/b.m3u8$$$第01集$https://share.example.com/x',
    { sourceApiBase: API, playFrom: 'lzm3u8$$$liangzi' }
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[0].name, 'lzm3u8');
  assert.equal(lines[0].episodes.length, 2);
  assert.deepEqual(
    lines[0].episodes.map((ep) => ({ season: ep.season, episode: ep.episode })),
    [
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
    ]
  );
  assert.equal(lines[0].episodes[0].title, '第01集');
  assert.equal(lines[1].name, 'liangzi');
});

test('choosePlayLine：多线路时优先选 m3u8 在第二条的线路（Lead 实测场景）', () => {
  const lines = cms.parsePlayUrl(
    'HD中字$https://vip.example.com/share/854d9fca$$$HD中字$https://vip.example.com/20220325/489/index.m3u8',
    { sourceApiBase: API, playFrom: 'liangzi$$$lzm3u8' }
  );
  const chosen = cms.choosePlayLine(lines);
  assert.equal(chosen.index, 1);
  assert.equal(chosen.name, 'lzm3u8');
  assert.equal(chosen.reason, 'all-m3u8');
  assert.equal(chosen.noM3u8, false);
  assert.deepEqual(chosen.episodes.map((ep) => ep.url), [
    'https://vip.example.com/20220325/489/index.m3u8',
  ]);
});

test('choosePlayLine：全部 m3u8 的线路优先于部分 m3u8 的线路', () => {
  const lines = cms.parsePlayUrl(
    '第1集$https://cdn.example.com/1.m3u8#第2集$https://share.example.com/2$$$第1集$https://cdn2.example.com/1.m3u8#第2集$https://cdn2.example.com/2.m3u8',
    { sourceApiBase: API, playFrom: 'line0$$$line1' }
  );
  const chosen = cms.choosePlayLine(lines);
  assert.equal(chosen.index, 1);
  assert.equal(chosen.reason, 'all-m3u8');
  assert.equal(chosen.m3u8Ratio, 1);
});

test('choosePlayLine：都没有 m3u8 时退回第一条 http(s) 线路并标记 no-m3u8', () => {
  const lines = cms.parsePlayUrl('HD$https://vip.example.com/share/abc', {
    sourceApiBase: API,
    playFrom: 'liangzi',
  });
  const chosen = cms.choosePlayLine(lines);
  assert.equal(chosen.index, 0);
  assert.equal(chosen.reason, 'no-m3u8');
  assert.equal(chosen.noM3u8, true);
});

test('parsePlayUrl：相对 URL 用 sourceApiBase 的 origin 补全', () => {
  const lines = cms.parsePlayUrl('/v/1.m3u8#//cdn.example.com/2.m3u8', {
    sourceApiBase: 'https://cj.example.com/api.php/provide/vod',
    playFrom: 'line',
  });
  assert.deepEqual(lines[0].episodes.map((ep) => ep.url), [
    'https://cj.example.com/v/1.m3u8',
    'https://cdn.example.com/2.m3u8',
  ]);
});

test('parsePlayUrl：非 http(s) 协议被丢弃，集号缺失按数组序回退', () => {
  const lines = cms.parsePlayUrl('花絮$magnet:?xt=xxx#01$https://cdn.example.com/a.m3u8#下一集$https://cdn.example.com/b.m3u8', {
    sourceApiBase: API,
    playFrom: 'line',
  });
  assert.equal(lines[0].episodes.length, 2);
  assert.deepEqual(
    lines[0].episodes.map((ep) => ({ season: ep.season, episode: ep.episode })),
    [
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
    ]
  );
});

test('fetchDetail：成功解析多线路，选中 m3u8 线路', async () => {
  const detail = await cms.fetchDetail({
    sourceApiBase: API,
    vodId: '1197',
    fetchImpl: async () => jsonResponse(vodJson()),
  });
  assert.equal(detail.ok, true);
  assert.equal(detail.vod.title, '沙丘');
  assert.equal(detail.vod.year, '2021');
  assert.equal(detail.lines.length, 2);
  assert.equal(detail.chosenLine.index, 1);
  assert.deepEqual(detail.chosenUrls, ['https://vip.example.com/20220325/489/index.m3u8']);
  assert.deepEqual(detail.warnings, []);
});

test('fetchDetail：中文被 \\u 转义时仍能正常解析，第01集 → S01E01', async () => {
  const escaped = String.raw`{"code":1,"list":[{"vod_id":"1","vod_name":"\u5e86\u4f59\u5e74","vod_year":"2019","vod_play_from":"lzm3u8","vod_play_url":"\u7b2c01\u96c6$https://cdn.example.com/1.m3u8#\u7b2c02\u96c6$https://cdn.example.com/2.m3u8"}]}`;
  const detail = await cms.fetchDetail({
    sourceApiBase: API,
    vodId: '1',
    fetchImpl: async () => jsonResponse(escaped),
  });
  assert.equal(detail.ok, true);
  assert.equal(detail.vod.title, '庆余年');
  assert.deepEqual(
    detail.chosenLine.episodes.map((ep) => ({ season: ep.season, episode: ep.episode })),
    [
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
    ]
  );
});

test('fetchDetail：list 为空 / list=null → 条目不存在', async () => {
  const empty = await cms.fetchDetail({
    sourceApiBase: API,
    vodId: '404',
    fetchImpl: async () => jsonResponse({ code: 1, msg: '数据列表', list: [] }),
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.notFound, true);

  const nullList = await cms.fetchDetail({
    sourceApiBase: API,
    vodId: '404',
    fetchImpl: async () => jsonResponse({ code: 1, list: null }),
  });
  assert.equal(nullList.ok, false);
  assert.equal(nullList.notFound, true);
});

test('fetchDetail：网络错误 / 5xx / 非法 JSON → 临时错误', async () => {
  const network = await cms.fetchDetail({
    sourceApiBase: API,
    vodId: '1',
    fetchImpl: async () => {
      throw new Error('ECONNRESET');
    },
  });
  assert.equal(network.ok, false);
  assert.equal(network.notFound, false);
  assert.equal(network.transient, true);

  let calls = 0;
  const retried = await cms.fetchDetail({
    sourceApiBase: API,
    vodId: '1',
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? jsonResponse('boom', 500) : jsonResponse(vodJson());
    },
  });
  assert.equal(retried.ok, true);
  assert.equal(calls, 2);

  const badJson = await cms.fetchDetail({
    sourceApiBase: API,
    vodId: '1',
    fetchImpl: async () => jsonResponse('<html>not json</html>'),
  });
  assert.equal(badJson.ok, false);
  assert.equal(badJson.transient, true);
});

test('fetchDetail：HTTP 404 → 条目不存在（不重试）', async () => {
  let calls = 0;
  const result = await cms.fetchDetail({
    sourceApiBase: API,
    vodId: '1',
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse('not found', 404);
    },
  });
  assert.equal(result.notFound, true);
  assert.equal(calls, 1);
});

test('fetchDetail：code=0 且无 list 字段 → 临时错误而非不存在', async () => {
  const result = await cms.fetchDetail({
    sourceApiBase: API,
    vodId: '1',
    fetchImpl: async () => jsonResponse({ code: 0, msg: '参数错误' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.notFound, false);
  assert.equal(result.transient, true);
});

test('parseDetailPayload 纯函数：data.vod 单对象也兼容', () => {
  const result = cms.parseDetailPayload(
    { code: 1, vod: { vod_id: 9, vod_name: '测试', vod_play_url: 'HD$https://cdn.example.com/a.m3u8' } },
    { sourceApiBase: API }
  );
  assert.equal(result.ok, true);
  assert.equal(result.vod.vodId, '9');
  assert.deepEqual(result.chosenUrls, ['https://cdn.example.com/a.m3u8']);
});
