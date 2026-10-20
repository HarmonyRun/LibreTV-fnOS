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
