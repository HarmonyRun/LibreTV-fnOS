'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const indexStore = require('../index-store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lrtv-index-'));
}

function sampleEntry(overrides = {}) {
  return {
    type: 'movie',
    title: '沙丘',
    year: '2021',
    sourceName: '示例源',
    sourceApiBase: 'https://cj.example.com/api.php/provide/vod',
    vodId: '1197',
    strmPaths: ['/vol2/1000/liberTV/strmdata/沙丘 (2021)/沙丘 (2021).strm'],
    lastKnownUrls: ['https://cdn.example.com/index.m3u8'],
    lastSyncedAt: '2026-10-19T03:00:00.000Z',
    consecutiveFailures: 0,
    lastError: '',
    ...overrides,
  };
}

test('entryKey：去掉 sourceApiBase 尾部斜杠', () => {
  assert.equal(
    indexStore.entryKey('https://a.example.com/api.php/provide/vod///', ' 123 '),
    'https://a.example.com/api.php/provide/vod::123'
  );
  assert.equal(indexStore.entryKey(' ', ''), '::');
});

test('loadIndex：文件不存在返回空索引且不写盘', () => {
  const dir = tmpDir();
  const index = indexStore.loadIndex(dir);
  assert.equal(index.version, 1);
  assert.deepEqual(index.entries, {});
  assert.equal(fs.existsSync(path.join(dir, 'strm-index.json')), false);
});

test('saveIndex / loadIndex：原子写并可回读（version/updatedAt/字段）', () => {
  const dir = tmpDir();
  const index = indexStore.createEmptyIndex();
  indexStore.upsertEntry(index, sampleEntry());
  indexStore.saveIndex(dir, index);

  const files = fs.readdirSync(dir);
  assert.ok(files.includes('strm-index.json'));
  assert.deepEqual(files.filter((name) => name.endsWith('.tmp')), [], '不应残留 .tmp 临时文件');

  const loaded = indexStore.loadIndex(dir);
  assert.equal(loaded.version, 1);
  assert.match(loaded.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  const key = indexStore.entryKey(sampleEntry().sourceApiBase, sampleEntry().vodId);
  assert.deepEqual(loaded.entries[key], sampleEntry());
});

test('损坏索引：备份为 .corrupt-*.bak 并重建空索引', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'strm-index.json');
  fs.writeFileSync(file, '{ this is not json', 'utf8');

  const loaded = indexStore.loadIndex(dir);
  assert.deepEqual(loaded.entries, {});

  const backups = fs.readdirSync(dir).filter((name) => /\.corrupt-.*\.bak$/.test(name));
  assert.equal(backups.length, 1);
  assert.match(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), /this is not json/);

  // 重建后的索引可被再次正常读取
  const reloaded = indexStore.loadIndex(dir);
  assert.deepEqual(reloaded.entries, {});
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
});

test('结构损坏（entries 不是对象）同样备份重建', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'strm-index.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8');
  const loaded = indexStore.loadIndex(dir);
  assert.deepEqual(loaded.entries, {});
  assert.equal(fs.readdirSync(dir).filter((name) => /\.corrupt-.*\.bak$/.test(name)).length, 1);
});

test('upsert / remove / find / collectStrmPaths', () => {
  const index = indexStore.createEmptyIndex();
  const key = indexStore.upsertEntry(index, sampleEntry());
  assert.equal(Object.keys(index.entries).length, 1);
  assert.equal(indexStore.findEntry(index, sampleEntry().sourceApiBase, sampleEntry().vodId).key, key);

  indexStore.upsertEntry(index, sampleEntry({ title: '沙丘2', strmPaths: ['/a/沙丘2.strm'] }));
  assert.equal(index.entries[key].title, '沙丘2');
  assert.equal(Object.keys(index.entries).length, 1);

  assert.deepEqual([...indexStore.collectStrmPaths(index)], [path.resolve('/a/沙丘2.strm')]);
  assert.equal(indexStore.removeEntry(index, key), true);
  assert.equal(indexStore.removeEntry(index, key), false);
  assert.deepEqual(index.entries, {});
});

test('warnings 扩展字段可持久化，空数组不写入', () => {
  const dir = tmpDir();
  const index = indexStore.createEmptyIndex();
  indexStore.upsertEntry(index, sampleEntry({ warnings: ['no-m3u8'] }));
  indexStore.saveIndex(dir, index);
  const loaded = indexStore.loadIndex(dir);
  const [entry] = Object.values(loaded.entries);
  assert.deepEqual(entry.warnings, ['no-m3u8']);

  const index2 = indexStore.createEmptyIndex();
  indexStore.upsertEntry(index2, sampleEntry({ warnings: [] }));
  indexStore.saveIndex(dir, index2);
  const loaded2 = indexStore.loadIndex(dir);
  const [entry2] = Object.values(loaded2.entries);
  assert.equal('warnings' in entry2, false);
});
