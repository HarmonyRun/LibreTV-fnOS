'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createEngine } = require('../engine-core');
const { startEngine } = require('../index');
const indexStore = require('../index-store');
const fnv = require('../fnv-client');

const API = 'https://cj.example.com/api.php/provide/vod';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lrtv-engine-'));
}

function silentLogger() {
  return { log() {}, info() {}, warn() {}, error() {} };
}

function jsonResponse(payload, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

function vod(vodName, vodYear, playUrl, playFrom = 'lzm3u8') {
  return {
    vod_id: '1197',
    vod_name: vodName,
    vod_year: vodYear,
    vod_play_from: playFrom,
    vod_play_url: playUrl,
  };
}

function writeConfig(dir, config) {
  const base = {
    port: 8090,
    strmRoot: path.join(dir, 'strm'),
    syncIntervalHours: 6,
    fnv: { enabled: false },
    sources: [],
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...base, ...config }, null, 2), 'utf8');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * 创建一个带 config.json 的引擎；fetchImpl 接受 (url) 并返回 Response 形态对象。
 */
function makeEngine(fetchImpl, configOverrides = {}, engineOptions = {}) {
  const dir = tmpDir();
  writeConfig(dir, configOverrides);
  const engine = createEngine({
    dataDir: dir,
    logger: silentLogger(),
    fetchImpl,
    syncDelayMs: 0,
    ...engineOptions,
  });
  return { dir, engine, root: path.join(dir, 'strm') };
}

test('handleAdd：电影生成 <片名 (年份)>/<片名 (年份)>.strm 且索引结构符合契约', async () => {
  const url = 'https://cdn.example.com/movie/index.m3u8';
  const { dir, engine, root } = makeEngine(async () =>
    jsonResponse({ code: 1, list: [vod('沙丘', '2021', `HD中字$${url}`)] })
  );

  const result = await engine.handleAdd({
    sourceApiBase: API,
    sourceName: '示例源',
    vodId: '1197',
    vodName: '沙丘',
    vodYear: '2021',
    type: 'movie',
  });

  const expected = path.join(root, '沙丘 (2021)', '沙丘 (2021).strm');
  assert.deepEqual(result.strmPaths, [expected]);
  assert.equal(fs.readFileSync(expected, 'utf8'), url + '\n');

  const index = readJson(path.join(dir, 'strm-index.json'));
  assert.equal(index.version, 1);
  assert.match(index.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  const key = indexStore.entryKey(API, '1197');
  const entry = index.entries[key];
  assert.equal(entry.type, 'movie');
  assert.equal(entry.title, '沙丘');
  assert.equal(entry.year, '2021');
  assert.equal(entry.sourceName, '示例源');
  assert.equal(entry.sourceApiBase, API);
  assert.equal(entry.vodId, '1197');
  assert.deepEqual(entry.strmPaths, [expected]);
  assert.deepEqual(entry.lastKnownUrls, [url]);
  assert.match(entry.lastSyncedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(entry.consecutiveFailures, 0);
  assert.equal(entry.lastError, '');
});

test('handleAdd：剧集生成 Season NN/SxxExx 文件并支持中文集名', async () => {
  const { engine, root } = makeEngine(async () =>
    jsonResponse({
      code: 1,
      list: [
        vod(
          '庆余年',
          '2019',
          '第01集$https://cdn.example.com/1.m3u8#第02集$https://cdn.example.com/2.m3u8#第03集$https://cdn.example.com/3.m3u8'
        ),
      ],
    })
  );
  const result = await engine.handleAdd({
    sourceApiBase: API,
    sourceName: '示例源',
    vodId: '17701',
    vodName: '庆余年',
    vodYear: '2019',
    type: 'tv',
  });
  assert.equal(result.strmPaths.length, 3);
  assert.equal(fs.existsSync(path.join(root, '庆余年 (2019)', 'Season 01', '庆余年 - S01E01.strm')), true);
  assert.equal(fs.existsSync(path.join(root, '庆余年 (2019)', 'Season 01', '庆余年 - S01E03.strm')), true);
});

test('handleAdd：所选线路无 m3u8 时仍生成，同时在索引标记 warnings', async () => {
  const { dir, engine, root } = makeEngine(async () =>
    jsonResponse({
      code: 1,
      list: [vod('冷门片', '2020', 'HD中字$https://vip.example.com/share/abc', 'liangzi')],
    })
  );
  const result = await engine.handleAdd({
    sourceApiBase: API,
    vodId: '1',
    type: 'movie',
  });
  assert.deepEqual(result.warnings, ['no-m3u8']);
  assert.equal(fs.existsSync(path.join(root, '冷门片 (2020)', '冷门片 (2020).strm')), true);
  const entry = readJson(path.join(dir, 'strm-index.json')).entries[indexStore.entryKey(API, '1')];
  assert.deepEqual(entry.warnings, ['no-m3u8']);
});

test('handleSync：URL 变化时覆写 STRM 并更新 lastKnownUrls', async () => {
  const urlA = 'https://cdn.example.com/a/index.m3u8';
  const urlB = 'https://cdn.example.com/b/index.m3u8';
  let currentUrl = urlA;
  const { dir, engine, root } = makeEngine(async () =>
    jsonResponse({ code: 1, list: [vod('沙丘', '2021', `HD中字$${currentUrl}`)] })
  );

  await engine.handleAdd({
    sourceApiBase: API,
    vodId: '1197',
    vodName: '沙丘',
    vodYear: '2021',
    type: 'movie',
  });
  const file = path.join(root, '沙丘 (2021)', '沙丘 (2021).strm');
  assert.equal(fs.readFileSync(file, 'utf8'), urlA + '\n');

  currentUrl = urlB;
  const stats = await engine.handleSync();
  assert.equal(stats.checked, 1);
  assert.equal(stats.updated, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), urlB + '\n');
  const entry = readJson(path.join(dir, 'strm-index.json')).entries[indexStore.entryKey(API, '1197')];
  assert.deepEqual(entry.lastKnownUrls, [urlB]);
  assert.equal(entry.consecutiveFailures, 0);
});

test('handleSync：明确不存在连续 3 次才删除 STRM 并移除索引', async () => {
  let exists = true;
  const { dir, engine, root } = makeEngine(async () =>
    jsonResponse(exists ? { code: 1, list: [vod('沙丘', '2021', 'HD$https://cdn.example.com/a.m3u8')] } : { code: 1, list: [] })
  );

  await engine.handleAdd({
    sourceApiBase: API,
    vodId: '1197',
    vodName: '沙丘',
    vodYear: '2021',
    type: 'movie',
  });
  const file = path.join(root, '沙丘 (2021)', '沙丘 (2021).strm');
  assert.equal(fs.existsSync(file), true);
  exists = false;

  const first = await engine.handleSync();
  assert.equal(first.deleted, 0);
  let entry = readJson(path.join(dir, 'strm-index.json')).entries[indexStore.entryKey(API, '1197')];
  assert.equal(entry.consecutiveFailures, 1);
  assert.equal(fs.existsSync(file), true);

  const second = await engine.handleSync();
  assert.equal(second.deleted, 0);
  entry = readJson(path.join(dir, 'strm-index.json')).entries[indexStore.entryKey(API, '1197')];
  assert.equal(entry.consecutiveFailures, 2);
  assert.equal(fs.existsSync(file), true);

  const third = await engine.handleSync();
  assert.equal(third.deleted, 1);
  assert.equal(fs.existsSync(file), false);
  const index = readJson(path.join(dir, 'strm-index.json'));
  assert.equal(index.entries[indexStore.entryKey(API, '1197')], undefined);
  // 只清理因此变空的目录，strmRoot 本身必须保留
  assert.equal(fs.existsSync(root), true);
  assert.equal(fs.existsSync(path.join(root, '沙丘 (2021)')), false);
});

test('handleSync：网络错误只累计失败并保留文件', async () => {
  let failNetwork = false;
  const { dir, engine, root } = makeEngine(async () => {
    if (failNetwork) throw new Error('ECONNRESET');
    return jsonResponse({ code: 1, list: [vod('沙丘', '2021', 'HD$https://cdn.example.com/a.m3u8')] });
  });
  await engine.handleAdd({
    sourceApiBase: API,
    vodId: '1197',
    vodName: '沙丘',
    vodYear: '2021',
    type: 'movie',
  });
  const file = path.join(root, '沙丘 (2021)', '沙丘 (2021).strm');
  failNetwork = true;
  for (let i = 0; i < 3; i += 1) {
    const stats = await engine.handleSync();
    assert.equal(stats.errors, 1);
  }
  assert.equal(fs.existsSync(file), true);
  const entry = readJson(path.join(dir, 'strm-index.json')).entries[indexStore.entryKey(API, '1197')];
  assert.equal(entry.consecutiveFailures, 3);
  assert.match(entry.lastError, /网络错误|ECONNRESET/);
});

test('handleCleanup：删除孤儿 .strm、清理空目录，保留非 .strm 文件与 strmRoot', async () => {
  const { dir, engine, root } = makeEngine(async () => jsonResponse({ code: 1, list: [] }));
  const keepFile = path.join(root, '保留片 (2021)', '保留片 (2021).strm');
  const keepNote = path.join(root, '保留片 (2021)', 'readme.txt');
  const orphanFile = path.join(root, '孤儿片 (2020)', '孤儿片 (2020).strm');
  const orphanSeason = path.join(root, '孤儿剧 (2019)', 'Season 01', '孤儿剧 - S01E01.strm');
  for (const file of [keepFile, keepNote, orphanFile, orphanSeason]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'https://cdn.example.com/x.m3u8\n', 'utf8');
  }

  const index = indexStore.createEmptyIndex();
  indexStore.upsertEntry(index, {
    type: 'movie',
    title: '保留片',
    year: '2021',
    sourceName: '源',
    sourceApiBase: API,
    vodId: 'keep',
    strmPaths: [keepFile],
    lastKnownUrls: ['https://cdn.example.com/x.m3u8'],
    lastSyncedAt: new Date().toISOString(),
    consecutiveFailures: 0,
    lastError: '',
  });
  indexStore.saveIndex(dir, index);

  const stats = await engine.handleCleanup();
  assert.equal(stats.orphansDeleted, 2);
  assert.equal(fs.existsSync(keepFile), true);
  assert.equal(fs.existsSync(keepNote), true);
  assert.equal(fs.existsSync(orphanFile), false);
  assert.equal(fs.existsSync(orphanSeason), false);
  assert.equal(fs.existsSync(path.join(root, '孤儿片 (2020)')), false);
  assert.equal(fs.existsSync(path.join(root, '孤儿剧 (2019)')), false);
  assert.equal(fs.existsSync(root), true);
});

test('processQueueOnce：按文件名处理 add 任务，成功删除队列文件并写 state', async () => {
  const { dir, engine, root } = makeEngine(async () =>
    jsonResponse({ code: 1, list: [vod('沙丘', '2021', 'HD$https://cdn.example.com/a.m3u8')] })
  );
  const queueDir = path.join(dir, 'queue');
  const job = {
    id: 'job-1710000000000-a1b2c3',
    createdAt: new Date().toISOString(),
    action: 'add',
    payload: {
      sourceApiBase: API,
      sourceName: '示例源',
      vodId: '1197',
      vodName: '沙丘',
      vodYear: '2021',
      type: 'movie',
    },
  };
  fs.writeFileSync(path.join(queueDir, 'job-1710000000000-a1b2c3.json'), JSON.stringify(job), 'utf8');

  const summary = await engine.processQueueOnce();
  assert.equal(summary.processed, 1);
  assert.equal(summary.succeeded, 1);
  assert.equal(fs.readdirSync(queueDir).filter((name) => name.endsWith('.json')).length, 0);
  assert.equal(fs.existsSync(path.join(root, '沙丘 (2021)', '沙丘 (2021).strm')), true);

  const state = readJson(path.join(dir, 'state.json'));
  assert.equal(state.engine.lastResult.ok, true);
  assert.equal(state.engine.lastResult.action, 'add');
  assert.match(state.engine.lastTickAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(state.engine.queuePending, 0);
  assert.equal(state.paths.indexCount, 1);
});

test('processQueueOnce：非法任务移到 queue/failed/ 并记录错误', async () => {
  const { dir, engine } = makeEngine(async () => jsonResponse({ code: 1, list: [] }));
  const queueDir = path.join(dir, 'queue');
  fs.writeFileSync(path.join(queueDir, 'job-1-badjson.json'), '{oops', 'utf8');
  fs.writeFileSync(
    path.join(queueDir, 'job-2-unknown.json'),
    JSON.stringify({ id: 'job-2', action: 'unknown-action', payload: {} }),
    'utf8'
  );

  const summary = await engine.processQueueOnce();
  assert.equal(summary.processed, 2);
  assert.equal(summary.failed, 2);
  const failed = fs.readdirSync(path.join(queueDir, 'failed')).filter((name) => name.endsWith('.json'));
  assert.deepEqual(failed.sort(), ['job-1-badjson.json', 'job-2-unknown.json']);
  const state = readJson(path.join(dir, 'state.json'));
  assert.equal(state.engine.lastResult.ok, false);
});


const FNV_CONFIG = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:5666',
  username: 'u',
  password: 'p',
  secretString: 's',
  apiKey: 'k',
  libraryName: '',
};

function isCmsHost(url) {
  return new URL(url).hostname === 'cj.example.com';
}

test('refreshDirs：自动匹配 strmRoot 下多个媒体库，一次传去重后的 dir_list', async () => {
  const scanCalls = [];
  let rootPath = '';
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    if (isCmsHost(url)) {
      return jsonResponse({ code: 1, list: [vod('沙丘', '2021', 'HD$https://cdn.example.com/a.m3u8')] });
    }
    if (parsed.pathname === fnv.LOGIN_PATH) return jsonResponse({ code: 0, data: { token: 'tok' } });
    if (parsed.pathname === fnv.MEDIADB_LIST_PATH) {
      return jsonResponse({
        code: 0,
        data: {
          list: [
            { guid: 'g-movie', name: '电影库', dir_list: [rootPath] },
            { guid: 'g-tv', name: '剧集库', dir_list: [rootPath] },
            { guid: 'g-other', name: '其他库', dir_list: ['/other/path'] },
          ],
        },
      });
    }
    if (parsed.pathname.startsWith(fnv.MEDIADB_SCAN_PREFIX)) {
      scanCalls.push({ path: parsed.pathname, body: JSON.parse(init.body) });
      return jsonResponse({ code: 0, data: {} });
    }
    throw new Error('unexpected ' + url);
  };
  const { dir, engine, root } = makeEngine(fetchImpl, { fnv: FNV_CONFIG });
  rootPath = root;
  await engine.handleAdd({
    sourceApiBase: API,
    vodId: '1197',
    vodName: '沙丘',
    vodYear: '2021',
    type: 'movie',
  });
  const refresh = await engine.flushRefresh();
  assert.equal(refresh.ok, true);
  assert.equal(refresh.mode, 'api');
  assert.equal(scanCalls.length, 2);
  assert.deepEqual(
    scanCalls.map((call) => call.path.split('/').pop()).sort(),
    ['g-movie', 'g-tv']
  );
  for (const call of scanCalls) {
    assert.deepEqual(call.body.dir_list, [path.join(root, '沙丘 (2021)')]);
  }
  engine.stop();
  const state = readJson(path.join(dir, 'state.json'));
  assert.equal(state.fnv.lastMode, 'api');
  assert.equal(state.fnv.endpoint, 'mediadb');
  assert.equal(state.fnv.secretSource, 'config');
  assert.match(state.fnv.lastOkAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(
    state.fnv.matchedLibraries.map((item) => item.guid).sort(),
    ['g-movie', 'g-tv']
  );
});

test('refreshDirs：带 dir_list 刷新失败时降级全库扫描一次', async () => {
  const scanBodies = [];
  let rootPath = '';
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    if (isCmsHost(url)) {
      return jsonResponse({ code: 1, list: [vod('沙丘', '2021', 'HD$https://cdn.example.com/a.m3u8')] });
    }
    if (parsed.pathname === fnv.LOGIN_PATH) return jsonResponse({ code: 0, data: { token: 'tok' } });
    if (parsed.pathname === fnv.MEDIADB_LIST_PATH) {
      return jsonResponse({ code: 0, data: { list: [{ guid: 'g1', name: '库', dir_list: [rootPath] }] } });
    }
    if (parsed.pathname.startsWith(fnv.MEDIADB_SCAN_PREFIX)) {
      const body = JSON.parse(init.body);
      scanBodies.push(body);
      if (body.dir_list && body.dir_list.length > 0) return jsonResponse({ code: -1, msg: 'invalid dir_list' });
      return jsonResponse({ code: 0, data: {} });
    }
    throw new Error('unexpected ' + url);
  };
  const { engine, root } = makeEngine(fetchImpl, { fnv: FNV_CONFIG });
  rootPath = root;
  await engine.handleAdd({
    sourceApiBase: API,
    vodId: '1197',
    vodName: '沙丘',
    vodYear: '2021',
    type: 'movie',
  });
  const refresh = await engine.flushRefresh();
  assert.equal(refresh.ok, true);
  assert.equal(scanBodies.length, 2);
  assert.deepEqual(scanBodies[0].dir_list, [path.join(root, '沙丘 (2021)')]);
  assert.deepEqual(scanBodies[1], {});
});

test('refreshDirs：媒体库列表不可解析时降级 fallback（utimes + state）', async () => {
  const fixedNow = Date.now() + 120000;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (isCmsHost(url)) {
      return jsonResponse({ code: 1, list: [vod('沙丘', '2021', 'HD$https://cdn.example.com/a.m3u8')] });
    }
    if (parsed.pathname === fnv.LOGIN_PATH) return jsonResponse({ code: 0, data: { token: 'tok' } });
    if (
      parsed.pathname === fnv.MEDIADB_LIST_PATH ||
      parsed.pathname === fnv.LIBRARY_LIST_PATH
    ) {
      return jsonResponse({ code: 0, data: { items: 'oops' } });
    }
    throw new Error('unexpected ' + url);
  };
  const { dir, engine, root } = makeEngine(fetchImpl, { fnv: FNV_CONFIG }, { now: () => fixedNow });
  await engine.handleAdd({
    sourceApiBase: API,
    vodId: '1197',
    vodName: '沙丘',
    vodYear: '2021',
    type: 'movie',
  });
  const folder = path.join(root, '沙丘 (2021)');
  const before = fs.statSync(folder).mtimeMs;
  const refresh = await engine.flushRefresh();
  assert.equal(refresh.ok, false);
  assert.equal(refresh.mode, 'fallback');
  const after = fs.statSync(folder).mtimeMs;
  assert.ok(Math.abs(after - fixedNow) < 2000, `目录 mtime 应被 utimes 更新: ${after} vs ${fixedNow}`);
  engine.stop();
  const state = readJson(path.join(dir, 'state.json'));
  assert.equal(state.fnv.lastMode, 'fallback');
  assert.equal(state.fnv.lastError.length > 0, true);
  assert.equal(state.fnv.endpoint, 'mdb');
  assert.equal(state.fnv.secretSource, 'config');
  assert.ok(after >= before);
});


test('engine：config 留空时从 mock bundle 提取密钥，并经 mediadb 端点刷新', async () => {
  const os = require('os');
  const bundleDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lrtv-bundle-')), 'assets');
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(
    path.join(bundleDir, 'main.js'),
    'const secret_string="MockSecret0123456789AbCdEfGhIjKl";api_key:"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";',
    'utf8'
  );

  let rootPath = '';
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (isCmsHost(url)) {
      return jsonResponse({ code: 1, list: [vod('沙丘', '2021', 'HD$https://cdn.example.com/a.m3u8')] });
    }
    if (parsed.pathname === fnv.LOGIN_PATH) return jsonResponse({ code: 0, data: { token: 'tok' } });
    if (parsed.pathname === fnv.MEDIADB_LIST_PATH) {
      return jsonResponse({ code: 0, data: { list: [{ guid: 'g1', name: '电影库', dir_list: [rootPath] }] } });
    }
    if (parsed.pathname.startsWith(fnv.MEDIADB_SCAN_PREFIX)) return jsonResponse({ code: 0, data: {} });
    throw new Error('unexpected ' + url);
  };
  const { dir, engine, root } = makeEngine(
    fetchImpl,
    {
      fnv: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:5666',
        username: 'u',
        password: 'p',
        secretString: '',
        apiKey: '',
        libraryName: '',
      },
    },
    { fnvBundleDir: bundleDir }
  );
  rootPath = root;
  await engine.handleAdd({
    sourceApiBase: API,
    vodId: '1197',
    vodName: '沙丘',
    vodYear: '2021',
    type: 'movie',
  });
  const refresh = await engine.flushRefresh();
  assert.equal(refresh.ok, true);
  assert.equal(refresh.endpoint, 'mediadb');
  engine.stop();
  const state = readJson(path.join(dir, 'state.json'));
  assert.equal(state.fnv.secretSource, 'bundle');
  assert.equal(state.fnv.endpoint, 'mediadb');
  assert.equal(state.fnv.lastMode, 'api');
});

test('start：未配置 strmRoot 时仅轮询队列，state.setupNeeded=true 且不崩溃', async () => {
  const dir = tmpDir();
  const engine = createEngine({
    dataDir: dir,
    logger: silentLogger(),
    fetchImpl: async () => jsonResponse({ code: 1, list: [] }),
    syncDelayMs: 0,
  });
  engine.start();
  engine.stop();

  const state = readJson(path.join(dir, 'state.json'));
  assert.equal(state.setupNeeded, true);
  assert.equal(state.paths.setupNeeded, true);
  assert.equal(state.paths.strmRoot, '');
  assert.equal(fs.existsSync(path.join(dir, 'setup-needed')), true);
  assert.match(state.engine.lastTickAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('startEngine：重复启动返回同一 handle，stop 后可再次启动', () => {
  const dir = tmpDir();
  writeConfig(dir, { fnv: { enabled: false } });
  const first = startEngine({ dataDir: dir, logger: silentLogger() });
  const second = startEngine({ dataDir: dir, logger: silentLogger() });
  assert.equal(first, second);
  assert.ok(first.getEngine());
  first.stop();
  const third = startEngine({ dataDir: dir, logger: silentLogger() });
  assert.notEqual(third, first);
  third.stop();
});

test('handleSync：源站新增剧集时自动追更（9 集 → 新增集数自动写 STRM）', async () => {
  let episodeCount = 2;
  const { dir, engine, root } = makeEngine(async () => {
    const eps = Array.from({ length: episodeCount }, (_, i) => `第${i + 1}集$https://cdn.example.com/e${i + 1}.m3u8`).join('#');
    return jsonResponse({ code: 1, list: [vod('追更剧', '2026', `HD$${eps}`)] });
  });

  await engine.handleAdd({
    sourceApiBase: API,
    vodId: '9001',
    vodName: '追更剧',
    vodYear: '2026',
    type: 'tv',
  });
  const seasonDir = path.join(root, '追更剧 (2026)', 'Season 01');
  assert.equal(fs.readdirSync(seasonDir).filter((n) => n.endsWith('.strm')).length, 2);

  episodeCount = 4;
  const stats = await engine.handleSync();
  assert.equal(stats.checked, 1);
  assert.equal(stats.episodesAdded, 2);
  assert.equal(stats.updated, 1);
  const files = fs.readdirSync(seasonDir).filter((n) => n.endsWith('.strm')).sort();
  assert.equal(files.length, 4);
  assert.ok(files.some((n) => n.includes('S01E04')));
  const urls = fs.readFileSync(path.join(seasonDir, files.find((n) => n.includes('S01E04'))), 'utf8');
  assert.match(urls, /e4\.m3u8/);

  const entry = readJson(path.join(dir, 'strm-index.json')).entries[indexStore.entryKey(API, '9001')];
  assert.equal(entry.lastKnownUrls.length, 4);
});

test('handleSync：URL 未变但本地 STRM 被删时自动补齐', async () => {
  const { dir, engine, root } = makeEngine(async () =>
    jsonResponse({ code: 1, list: [vod('补齐剧', '2026', '第1集$https://cdn.example.com/1.m3u8#第2集$https://cdn.example.com/2.m3u8')] })
  );
  await engine.handleAdd({
    sourceApiBase: API,
    vodId: '9002',
    vodName: '补齐剧',
    vodYear: '2026',
    type: 'tv',
  });
  const seasonDir = path.join(root, '补齐剧 (2026)', 'Season 01');
  const removed = fs.readdirSync(seasonDir).find((n) => n.includes('S01E02'));
  fs.unlinkSync(path.join(seasonDir, removed));

  const stats = await engine.handleSync();
  assert.equal(stats.filesRestored, 1);
  assert.equal(fs.readdirSync(seasonDir).filter((n) => n.endsWith('.strm')).length, 2);
});

test('handleCleanup：资源目录 0 个 STRM（留 nfo/海报）时整目录回收并清索引', async () => {
  const { dir, engine, root } = makeEngine(async () => jsonResponse({ code: 1, list: [] }));
  const resourceDir = path.join(root, '空资源 (2026)');
  const seasonDir = path.join(resourceDir, 'Season 01');
  fs.mkdirSync(seasonDir, { recursive: true });
  fs.writeFileSync(path.join(seasonDir, 'tvshow.nfo'), 'metadata\n', 'utf8');
  fs.writeFileSync(path.join(resourceDir, 'poster.jpg'), Buffer.alloc(8));
  // 模拟“用户在媒体库删除后只剩空目录”，把 mtime 调老以越过宽限期
  const old = new Date(Date.now() - 30 * 60 * 1000);
  fs.utimesSync(seasonDir, old, old);
  fs.utimesSync(resourceDir, old, old);

  const index = indexStore.createEmptyIndex();
  indexStore.upsertEntry(index, {
    type: 'tv',
    title: '空资源',
    year: '2026',
    sourceName: '源',
    sourceApiBase: API,
    vodId: 'empty',
    strmPaths: [path.join(seasonDir, '空资源 - S01E01.strm')],
    lastKnownUrls: ['https://cdn.example.com/x.m3u8'],
    lastSyncedAt: new Date().toISOString(),
    consecutiveFailures: 0,
    lastError: '',
  });
  indexStore.saveIndex(dir, index);

  const stats = await engine.handleCleanup();
  assert.equal(stats.emptyDirsRemoved, 1);
  assert.equal(stats.entriesRemoved, 1);
  assert.equal(fs.existsSync(resourceDir), false);
  assert.equal(fs.existsSync(root), true);
  assert.equal(readJson(path.join(dir, 'strm-index.json')).entries[indexStore.entryKey(API, 'empty')], undefined);
});

test('reclaimEmptyResourceDirs：宽限期内新建空目录不删', async () => {
  const { engine, root } = makeEngine(async () => jsonResponse({ code: 1, list: [] }));
  const fresh = path.join(root, '刚建空目录 (2026)');
  fs.mkdirSync(fresh, { recursive: true });
  const stats = await engine.reclaimEmptyResourceDirs();
  assert.equal(stats.emptyDirsRemoved, 0);
  assert.equal(fs.existsSync(fresh), true);
});

// —— 加固 b：尊重手动删除（资源目录整体消失时不再补写） ——

test('handleSync：资源目录被整体删除时按手动移除处理，不再补写也不重建目录', async () => {
  const { dir, engine, root } = makeEngine(async () =>
    jsonResponse({ code: 1, list: [vod('手动删剧', '2026', 'HD$https://cdn.example.com/a.m3u8')] })
  );
  await engine.handleAdd({ sourceApiBase: API, vodId: '7001', vodName: '手动删剧', vodYear: '2026', type: 'movie' });
  const resourceDir = path.join(root, '手动删剧 (2026)');
  assert.equal(fs.existsSync(path.join(resourceDir, '手动删剧 (2026).strm')), true);

  // 模拟用户在飞牛影视里删除整部影片（连目录一起删掉）
  fs.rmSync(resourceDir, { recursive: true, force: true });

  const stats = await engine.handleSync();
  assert.equal(stats.manualRemoved, 1);
  assert.equal(stats.filesRestored, 0);
  assert.equal(fs.existsSync(resourceDir), false);
  const index = readJson(path.join(dir, 'strm-index.json'));
  assert.equal(index.entries[indexStore.entryKey(API, '7001')], undefined);
});

test('handleSync：respectManualRemoval=false 时仍按误删补齐', async () => {
  const { dir, engine, root } = makeEngine(
    async () => jsonResponse({ code: 1, list: [vod('手动删剧', '2026', 'HD$https://cdn.example.com/a.m3u8')] }),
    { respectManualRemoval: false }
  );
  await engine.handleAdd({ sourceApiBase: API, vodId: '7002', vodName: '手动删剧', vodYear: '2026', type: 'movie' });
  const resourceDir = path.join(root, '手动删剧 (2026)');
  fs.rmSync(resourceDir, { recursive: true, force: true });

  const stats = await engine.handleSync();
  assert.equal(stats.manualRemoved, 0);
  assert.equal(stats.filesRestored, 1);
  assert.equal(fs.existsSync(path.join(resourceDir, '手动删剧 (2026).strm')), true);
  assert.notEqual(readJson(path.join(dir, 'strm-index.json')).entries[indexStore.entryKey(API, '7002')], undefined);
});

// —— 加固 b：remove 队列任务（设置页「移除」按钮与 MCP 共用） ——

test('handleRemove：删除整个资源目录并移除索引条目', async () => {
  const { dir, engine, root } = makeEngine(async () =>
    jsonResponse({ code: 1, list: [vod('要删的片', '2026', 'HD$https://cdn.example.com/a.m3u8')] })
  );
  await engine.handleAdd({ sourceApiBase: API, vodId: '7101', vodName: '要删的片', vodYear: '2026', type: 'movie' });
  const key = indexStore.entryKey(API, '7101');
  const resourceDir = path.join(root, '要删的片 (2026)');
  assert.equal(fs.existsSync(resourceDir), true);

  const result = await engine.handleRemove({ key });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'resource');
  assert.deepEqual(result.deletedDirs, [resourceDir]);
  assert.equal(result.deletedFiles, 1);
  assert.equal(result.removedEntries.length, 1);
  assert.equal(result.removedEntries[0].key, key);
  assert.equal(fs.existsSync(resourceDir), false);
  assert.equal(readJson(path.join(dir, 'strm-index.json')).entries[key], undefined);
  assert.equal(fs.existsSync(root), true);
});

test('handleRemove：dryRun 只返回计划，不改文件与索引', async () => {
  const { dir, engine, root } = makeEngine(async () =>
    jsonResponse({ code: 1, list: [vod('要删的片', '2026', 'HD$https://cdn.example.com/a.m3u8')] })
  );
  await engine.handleAdd({ sourceApiBase: API, vodId: '7102', vodName: '要删的片', vodYear: '2026', type: 'movie' });
  const key = indexStore.entryKey(API, '7102');
  const resourceDir = path.join(root, '要删的片 (2026)');

  const result = await engine.handleRemove({ key, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.dirs.length, 1);
  assert.equal(result.totalFiles, 1);
  assert.equal(fs.existsSync(resourceDir), true);
  assert.notEqual(readJson(path.join(dir, 'strm-index.json')).entries[key], undefined);
});

test('handleRemove：season 模式只删该季目录，其余季保留并裁剪索引', async () => {
  const { dir, engine, root } = makeEngine(async () => jsonResponse({ code: 1, list: [] }));
  const resourceDir = path.join(root, '两季剧 (2025)');
  const s1 = path.join(resourceDir, 'Season 01', '两季剧 - S01E01.strm');
  const s2 = path.join(resourceDir, 'Season 02', '两季剧 - S02E01.strm');
  for (const file of [s1, s2]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'https://cdn.example.com/ep.m3u8\n', 'utf8');
  }
  const key = indexStore.entryKey(API, '7201');
  const index = indexStore.createEmptyIndex();
  indexStore.upsertEntry(index, {
    type: 'tv',
    title: '两季剧',
    year: '2025',
    sourceName: '源',
    sourceApiBase: API,
    vodId: '7201',
    strmPaths: [s1, s2],
    lastKnownUrls: ['https://cdn.example.com/e1.m3u8', 'https://cdn.example.com/e2.m3u8'],
    lastSyncedAt: new Date().toISOString(),
    consecutiveFailures: 0,
    lastError: '',
  });
  indexStore.saveIndex(dir, index);

  const result = await engine.handleRemove({ key, season: 2 });
  assert.equal(result.mode, 'season');
  assert.deepEqual(result.deletedDirs, [path.join(resourceDir, 'Season 02')]);
  assert.equal(fs.existsSync(s1), true);
  assert.equal(fs.existsSync(s2), false);
  assert.equal(result.prunedEntries.length, 1);
  const entry = readJson(path.join(dir, 'strm-index.json')).entries[key];
  assert.deepEqual(entry.strmPaths, [s1]);
  assert.deepEqual(entry.lastKnownUrls, ['https://cdn.example.com/e1.m3u8']);
});

test('processQueueOnce：remove 任务被消费并通过 lastResult 暴露计数', async () => {
  const { dir, engine, root } = makeEngine(async () =>
    jsonResponse({ code: 1, list: [vod('队列删片', '2026', 'HD$https://cdn.example.com/a.m3u8')] })
  );
  await engine.handleAdd({ sourceApiBase: API, vodId: '7301', vodName: '队列删片', vodYear: '2026', type: 'movie' });
  const key = indexStore.entryKey(API, '7301');
  const resourceDir = path.join(root, '队列删片 (2026)');
  const jobId = 'job-test-remove-1';
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'queue', `${jobId}.json`),
    JSON.stringify({ id: jobId, createdAt: new Date().toISOString(), action: 'remove', payload: { key } }),
    'utf8'
  );

  const summary = await engine.processQueueOnce();
  assert.equal(summary.succeeded, 1);
  assert.equal(fs.existsSync(resourceDir), false);
  assert.equal(readJson(path.join(dir, 'strm-index.json')).entries[key], undefined);
  const state = readJson(path.join(dir, 'state.json'));
  assert.equal(state.engine.lastResult.action, 'remove');
  assert.equal(state.engine.lastResult.jobId, jobId);
  assert.equal(state.engine.lastResult.ok, true);
  assert.equal(state.engine.lastResult.result.mode, 'resource');
  assert.equal(state.engine.lastResult.result.dirsRemoved, 1);
  assert.equal(state.engine.lastResult.result.deletedFiles, 1);
  assert.equal(state.engine.lastResult.result.entriesRemoved, 1);
});

test('handleSync：URL 变化但资源目录已被手动删除时仍按移除处理（不因 URL 轮换复活）', async () => {
  const urlA = 'https://cdn.example.com/a/index.m3u8';
  const urlB = 'https://cdn.example.com/b/index.m3u8';
  let currentUrl = urlA;
  const { dir, engine, root } = makeEngine(async () =>
    jsonResponse({ code: 1, list: [vod('轮换剧', '2026', `HD$https://cdn.example.com/x.m3u8`, 'liangzi')] })
  );
  await engine.handleAdd({
    sourceApiBase: API,
    vodId: '7401',
    vodName: '轮换剧',
    vodYear: '2026',
    type: 'movie',
  });
  const resourceDir = path.join(root, '轮换剧 (2026)');
  assert.equal(fs.existsSync(resourceDir), true);

  // 模拟用户在飞牛影视里删掉整部影片，且源站 URL 恰好轮换（旧实现会判定为「更新」并重新写回）
  fs.rmSync(resourceDir, { recursive: true, force: true });
  currentUrl = urlB;
  const stats = await engine.handleSync();
  assert.equal(stats.manualRemoved, 1);
  assert.equal(stats.updated, 0);
  assert.equal(fs.existsSync(resourceDir), false);
  assert.equal(readJson(path.join(dir, 'strm-index.json')).entries[indexStore.entryKey(API, '7401')], undefined);
});

// —— 换源迁移：源被替换后原地重建 STRM（文件名不变、索引换源、可追更） ——

const MIG_OLD = 'https://old-source.example.com/api.php/provide/vod';
const MIG_NEW = 'https://new-source.example.com/api.php/provide/vod';
const MIG_PLAY_URLS = [
  '第01集$https://cdn.new.example.com/1.m3u8',
  '第02集$https://cdn.new.example.com/2.m3u8',
  '第03集$https://cdn.new.example.com/3.m3u8',
];

function migrationFetch({ oldFails = true, newVodName = '迁移测试剧', withDetail = true } = {}) {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'old-source.example.com') {
      if (oldFails) throw new Error('ECONNRESET');
    }
    if (parsed.hostname === 'new-source.example.com') {
      const ac = parsed.searchParams.get('ac');
      if (ac === 'videolist' && parsed.searchParams.get('wd')) {
        return jsonResponse({
          code: 1,
          list: [{ vod_id: 9001, vod_name: newVodName, vod_year: '2026' }],
        });
      }
      if (ac === 'videolist' && parsed.searchParams.get('ids')) {
        if (!withDetail) return jsonResponse({ code: 1, list: [] });
        return jsonResponse({
          code: 1,
          list: [
            {
              vod_id: 9001,
              vod_name: '迁移测试剧',
              vod_year: '2026',
              vod_play_from: 'lzm3u8',
              vod_play_url: MIG_PLAY_URLS.join('#'),
            },
          ],
        });
      }
    }
    throw new Error('unexpected url ' + url);
  };
}

function seedOldEntry(dir, root, { vodId = '111', title = '迁移测试剧', year = '2026', episodes = 2 } = {}) {
  const seasonDir = path.join(root, `${title} (${year})`, 'Season 01');
  fs.mkdirSync(seasonDir, { recursive: true });
  const strmPaths = [];
  const lastKnownUrls = [];
  for (let i = 1; i <= episodes; i += 1) {
    const file = path.join(seasonDir, `${title} - S01E0${i}.strm`);
    const oldUrl = `https://cdn.old.example.com/${i}.m3u8`;
    fs.writeFileSync(file, oldUrl + '\n', 'utf8');
    strmPaths.push(file);
    lastKnownUrls.push(oldUrl);
  }
  const key = indexStore.entryKey(MIG_OLD, vodId);
  const index = indexStore.createEmptyIndex();
  indexStore.upsertEntry(index, {
    type: 'tv',
    title,
    year,
    sourceName: '旧源',
    sourceApiBase: MIG_OLD,
    vodId,
    strmPaths,
    lastKnownUrls,
    lastSyncedAt: new Date().toISOString(),
    consecutiveFailures: 0,
    lastError: '',
  });
  indexStore.saveIndex(dir, index);
  return { key, strmPaths, episodeCount: episodes };
}

test('handleSync：源被替换后自动换源迁移，文件名不变、索引换到新源，并补齐新集', async () => {
  const { dir, engine, root } = makeEngine(migrationFetch(), {
    sources: [{ key: 'env_0', name: '新源', url: MIG_NEW }],
  });
  const seeded = seedOldEntry(dir, root);
  const oldKey = seeded.key;
  const newKey = indexStore.entryKey(MIG_NEW, '9001');

  const stats = await engine.handleSync();
  assert.equal(stats.migrated, 1);

  const index = readJson(path.join(dir, 'strm-index.json'));
  assert.equal(index.entries[oldKey], undefined, '旧 key 应被移除');
  const entry = index.entries[newKey];
  assert.ok(entry, '应写入新 key');
  assert.equal(entry.title, '迁移测试剧');
  assert.equal(entry.year, '2026');
  assert.equal(entry.sourceApiBase, MIG_NEW);
  // 原有文件名/路径完全不变（E01/E02），内容换成新源地址
  assert.deepEqual(entry.strmPaths.slice(0, 2), seeded.strmPaths);
  assert.equal(fs.readFileSync(seeded.strmPaths[0], 'utf8'), 'https://cdn.new.example.com/1.m3u8\n');
  assert.equal(fs.readFileSync(seeded.strmPaths[1], 'utf8'), 'https://cdn.new.example.com/2.m3u8\n');
  // 新源多出的第 3 集按原命名补齐（追更）
  const extra = path.join(root, '迁移测试剧 (2026)', 'Season 01', '迁移测试剧 - S01E03.strm');
  assert.equal(entry.strmPaths.length, 3);
  assert.equal(entry.strmPaths[2], extra);
  assert.equal(fs.readFileSync(extra, 'utf8'), 'https://cdn.new.example.com/3.m3u8\n');
  assert.deepEqual(entry.lastKnownUrls, [
    'https://cdn.new.example.com/1.m3u8',
    'https://cdn.new.example.com/2.m3u8',
    'https://cdn.new.example.com/3.m3u8',
  ]);
});

test('handleSync：新源找不到同名条目时跳过迁移，不动原文件', async () => {
  const { dir, engine, root } = makeEngine(migrationFetch({ newVodName: '完全不同的剧' }), {
    sources: [{ key: 'env_0', name: '新源', url: MIG_NEW }],
  });
  const seeded = seedOldEntry(dir, root);
  const stats = await engine.handleSync();
  assert.equal(stats.migrated, 0);
  assert.equal(stats.errors, 1);
  const index = readJson(path.join(dir, 'strm-index.json'));
  assert.ok(index.entries[seeded.key], '无匹配时保留旧条目');
  assert.equal(
    fs.readFileSync(seeded.strmPaths[0], 'utf8'),
    'https://cdn.old.example.com/1.m3u8\n',
    '原文件内容不应被改写'
  );
});

test('handleSync：新源条目已存在（key 冲突）时跳过迁移', async () => {
  const { dir, engine, root } = makeEngine(migrationFetch(), {
    sources: [{ key: 'env_0', name: '新源', url: MIG_NEW }],
  });
  const seeded = seedOldEntry(dir, root);
  const newKey = indexStore.entryKey(MIG_NEW, '9001');
  const index = readJson(path.join(dir, 'strm-index.json'));
  indexStore.upsertEntry(index, {
    type: 'tv',
    title: '迁移测试剧',
    year: '2026',
    sourceName: '新源',
    sourceApiBase: MIG_NEW,
    vodId: '9001',
    strmPaths: [path.join(root, '迁移测试剧 (2026)', 'Season 01', '迁移测试剧 - S01E01.strm')],
    lastKnownUrls: ['https://cdn.new.example.com/1.m3u8'],
    lastSyncedAt: new Date().toISOString(),
    consecutiveFailures: 0,
    lastError: '',
  });
  indexStore.saveIndex(dir, index);

  const stats = await engine.handleSync();
  assert.equal(stats.migrated, 0);
  const after = readJson(path.join(dir, 'strm-index.json'));
  assert.ok(after.entries[seeded.key], '冲突时保留旧条目');
  assert.ok(after.entries[newKey], '新条目保持不变');
});

test('handleMigrate：dryRun 只统计不落盘；正式执行后原地重建', async () => {
  const { dir, engine, root } = makeEngine(migrationFetch(), {
    sources: [{ key: 'env_0', name: '新源', url: MIG_NEW }],
  });
  const seeded = seedOldEntry(dir, root);
  const newKey = indexStore.entryKey(MIG_NEW, '9001');

  const dry = await engine.handleMigrate({ dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.migrated, 1);
  assert.equal(fs.readFileSync(seeded.strmPaths[0], 'utf8'), 'https://cdn.old.example.com/1.m3u8\n');
  assert.ok(readJson(path.join(dir, 'strm-index.json')).entries[seeded.key]);

  const real = await engine.handleMigrate({});
  assert.equal(real.migrated, 1);
  const index = readJson(path.join(dir, 'strm-index.json'));
  assert.equal(index.entries[seeded.key], undefined);
  assert.ok(index.entries[newKey]);
  assert.equal(fs.readFileSync(seeded.strmPaths[0], 'utf8'), 'https://cdn.new.example.com/1.m3u8\n');
});

test('handleSync：migrateOnSourceChange=false 时不做换源迁移', async () => {
  const { dir, engine, root } = makeEngine(migrationFetch(), {
    sources: [{ key: 'env_0', name: '新源', url: MIG_NEW }],
    migrateOnSourceChange: false,
  });
  const seeded = seedOldEntry(dir, root);
  const stats = await engine.handleSync();
  assert.equal(stats.migrated, 0);
  const index = readJson(path.join(dir, 'strm-index.json'));
  assert.ok(index.entries[seeded.key]);
  assert.equal(fs.readFileSync(seeded.strmPaths[0], 'utf8'), 'https://cdn.old.example.com/1.m3u8\n');
});
