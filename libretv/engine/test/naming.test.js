'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const naming = require('../naming');

test('safeName: 非法字符替换为全角安全字符，且不含路径分隔符', () => {
  const dirty = 'a/b\\c:d*e?f"g<h>i|j';
  const safe = naming.safeName(dirty);
  assert.equal(safe, 'a／b＼c：d＊e？f＂g＜h＞i｜j');
  assert.equal(/[\\/:*?"<>|]/.test(safe), false);
});

test('safeName: 控制字符、首尾空格与点、空标题', () => {
  assert.equal(naming.safeName('  hello\u0001world  '), 'hello world');
  assert.equal(naming.safeName('...片名...'), '片名');
  assert.equal(naming.safeName('   '), 'Untitled');
  assert.equal(naming.safeName(null), 'Untitled');
  assert.equal(naming.safeName('...'), 'Untitled');
});

test('normalizeYear: 年份提取与缺失处理', () => {
  assert.equal(naming.normalizeYear('2021'), '2021');
  assert.equal(naming.normalizeYear(2021), '2021');
  assert.equal(naming.normalizeYear('2021-05-01'), '2021');
  assert.equal(naming.normalizeYear('未知'), '');
  assert.equal(naming.normalizeYear(''), '');
  assert.equal(naming.normalizeYear(null), '');
});

test('电影路径：片名 (年份)/片名 (年份).strm', () => {
  const expected = path.join('沙丘 (2021)', '沙丘 (2021).strm');
  assert.equal(naming.movieRelativePath('沙丘', '2021'), expected);
  assert.equal(naming.movieRelativePath('沙丘 (2021)', ''), path.join('沙丘 (2021)', '沙丘 (2021).strm'));
  assert.equal(naming.movieRelativePath('沙丘', '未知'), path.join('沙丘', '沙丘.strm'));
});

test('剧集路径：Season NN 与 SxxExx 两位补零', () => {
  const expected = path.join('庆余年 (2019)', 'Season 01', '庆余年 - S01E05.strm');
  assert.equal(naming.episodeRelativePath('庆余年', '2019', 1, 5), expected);
  assert.equal(
    naming.episodeRelativePath('庆余年', '2019', 12, 123),
    path.join('庆余年 (2019)', 'Season 12', '庆余年 - S12E123.strm')
  );
  assert.equal(naming.episodeRelativePath('无年份剧', '', 1, 1), path.join('无年份剧', 'Season 01', '无年份剧 - S01E01.strm'));
});

test('季集解析：SxxExx / 第x季 / Season x / 第x集 / EPx / 纯数字', () => {
  assert.deepEqual(
    (({ season, episode }) => ({ season, episode }))(naming.parseSeasonEpisode('S02E07')),
    { season: 2, episode: 7 }
  );
  assert.deepEqual(
    (({ season, episode }) => ({ season, episode }))(naming.parseSeasonEpisode('第3季 第12集')),
    { season: 3, episode: 12 }
  );
  assert.deepEqual(
    (({ season, episode }) => ({ season, episode }))(naming.parseSeasonEpisode('Season 4', 8)),
    { season: 4, episode: 8 }
  );
  assert.deepEqual(
    (({ season, episode }) => ({ season, episode }))(naming.parseSeasonEpisode('EP09', 3)),
    { season: 1, episode: 9 }
  );
  assert.deepEqual(
    (({ season, episode }) => ({ season, episode }))(naming.parseSeasonEpisode('08', 3)),
    { season: 1, episode: 8 }
  );
  assert.deepEqual(
    (({ season, episode }) => ({ season, episode }))(naming.parseSeasonEpisode('第十二集', 3)),
    { season: 1, episode: 12 }
  );
  assert.deepEqual(
    (({ season, episode }) => ({ season, episode }))(naming.parseSeasonEpisode('第2季', 6)),
    { season: 2, episode: 6 }
  );
});

test('季集解析：无法解析时按数组序回退', () => {
  assert.deepEqual(
    (({ season, episode }) => ({ season, episode }))(naming.parseSeasonEpisode('未知标题', 3)),
    { season: 1, episode: 3 }
  );
  assert.deepEqual(
    (({ season, episode }) => ({ season, episode }))(naming.parseSeasonEpisode('', 1)),
    { season: 1, episode: 1 }
  );
  const parsed = naming.parseSeasonEpisode('花絮', 5);
  assert.equal(parsed.episodeParsed, false);
  assert.equal(parsed.episode, 5);
});

test('cnToNumber: 中文数字', () => {
  assert.equal(naming.cnToNumber('一'), 1);
  assert.equal(naming.cnToNumber('十'), 10);
  assert.equal(naming.cnToNumber('十二'), 12);
  assert.equal(naming.cnToNumber('二十三'), 23);
  assert.equal(naming.cnToNumber('一百零五'), 105);
  assert.equal(Number.isNaN(naming.cnToNumber('abc')), true);
});

test('formatEpisodeCode', () => {
  assert.equal(naming.formatEpisodeCode(1, 2), 'S01E02');
  assert.equal(naming.formatEpisodeCode(10, 100), 'S10E100');
});
