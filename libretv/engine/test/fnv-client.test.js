'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fnv = require('../fnv-client');

const LOGIN = fnv.LOGIN_PATH;
const LIST = fnv.LIBRARY_LIST_PATH; // 旧端点 /mdb/list
const SCAN = fnv.SCAN_PATH_PREFIX; // 旧端点 /mdb/scan/
const MEDIADB_LIST = fnv.MEDIADB_LIST_PATH;
const MEDIADB_SCAN = fnv.MEDIADB_SCAN_PREFIX;
const STOP = fnv.TASK_STOP_PATH;
const LIST_PATHS = [MEDIADB_LIST, LIST];
const SCAN_PREFIXES = [MEDIADB_SCAN, SCAN];
const isListPath = (p) => LIST_PATHS.includes(p);
const isScanPath = (p) => SCAN_PREFIXES.some((prefix) => p.startsWith(prefix));

function jsonResponse(payload, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

function baseOptions(overrides = {}) {
  return {
    baseUrl: 'http://127.0.0.1:5666',
    username: 'admin',
    password: 'secret',
    secretString: 's3cr3t',
    apiKey: 'key_123',
    libraryName: '',
    enabled: true,
    ...overrides,
  };
}

// 固定向量由独立的 Python 实现按契约算法计算（确保 JS 与 fnv.py 一致）
test('buildAuthx 固定向量 1：POST login（键排序、中文不转义）', () => {
  const result = fnv.buildAuthx({
    method: 'POST',
    path: LOGIN,
    secretString: 's3cr3t',
    apiKey: 'key_123',
    nonce: '123456',
    timestamp: '1710000000000',
    data: { username: 'admin', password: 'p@ss w0rd', app_name: 'trimemedia-web' },
  });
  assert.equal(
    result.serialized,
    '{"app_name":"trimemedia-web","password":"p@ss w0rd","username":"admin"}'
  );
  assert.equal(result.bodyHash, 'fa46bee72228b94738b5e703efa42cde');
  assert.equal(result.sign, 'ccea2dec425d8d67deb89cdcf807eff3');
  assert.equal(result.authx, 'nonce=123456&timestamp=1710000000000&sign=ccea2dec425d8d67deb89cdcf807eff3');
});

test('buildAuthx 固定向量 2：GET 参数排序 + urlencode（Python quote_plus 语义）', () => {
  const result = fnv.buildAuthx({
    method: 'GET',
    path: LIST,
    secretString: 'abc',
    apiKey: 'k_9',
    nonce: '000001',
    timestamp: '1700000000000',
    params: { page: '2', name: '电影 库', z: '1', a: '中文' },
  });
  assert.equal(result.serialized, 'a=%E4%B8%AD%E6%96%87&name=%E7%94%B5%E5%BD%B1+%E5%BA%93&page=2&z=1');
  assert.equal(result.bodyHash, '35832ffdc6a65624b09656b6df7042f8');
  assert.equal(result.sign, 'a876cdaab23db667e0fbcee093cb56c4');
});

test('buildAuthx 固定向量 3：POST 空对象与无 body', () => {
  const emptyObject = fnv.buildAuthx({
    method: 'POST',
    path: STOP,
    secretString: '',
    apiKey: '',
    nonce: '654321',
    timestamp: '1690000000123',
    data: {},
  });
  assert.equal(emptyObject.serialized, '{}');
  assert.equal(emptyObject.bodyHash, '99914b932bd37a50b983c5e7c90ae93b');
  assert.equal(emptyObject.sign, '6525d24bf4e82265c7b86e155f0377df');

  const noBody = fnv.buildAuthx({
    method: 'POST',
    path: STOP,
    secretString: '',
    apiKey: '',
    nonce: '654321',
    timestamp: '1690000000123',
  });
  assert.equal(noBody.serialized, '');
  assert.equal(noBody.bodyHash, 'd41d8cd98f00b204e9800998ecf8427e');
});

test('buildAuthx 固定向量 4：dir_list 中文路径', () => {
  const result = fnv.buildAuthx({
    method: 'POST',
    path: SCAN + '7f8e9d',
    secretString: 'my_secret',
    apiKey: 'api_key',
    nonce: '987654',
    timestamp: '1729000000000',
    data: { dir_list: ['/vol2/1000/liberTV/strmdata/沙丘 (2021)'] },
  });
  assert.equal(result.serialized, '{"dir_list":["/vol2/1000/liberTV/strmdata/沙丘 (2021)"]}');
  assert.equal(result.bodyHash, '24e34fd62e5335b3ec55605157bacd3e');
  assert.equal(result.sign, 'a7458f37524558a8d244514ea1e0f3a2');
});

test('FnvClient.configured：缺少凭据时不配置', () => {
  assert.equal(new fnv.FnvClient(baseOptions()).configured, true);
  assert.equal(new fnv.FnvClient(baseOptions({ username: '' })).configured, false);
  assert.equal(new fnv.FnvClient(baseOptions({ secretString: '' })).configured, false);
  assert.equal(new fnv.FnvClient(baseOptions({ apiKey: '' })).configured, false);
  assert.equal(new fnv.FnvClient(baseOptions({ enabled: false })).configured, false);
});

test('FnvClient：login + listLibraries + refreshLibrary 携带 authx/Authorization', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, headers: init.headers, body: init.body });
    if (parsed.pathname === LOGIN) return jsonResponse({ code: 0, data: { token: 'tok-1' } });
    if (isListPath(parsed.pathname)) {
      return jsonResponse({
        code: 0,
        data: {
          list: [
            { guid: 'g-movie', name: '电影库', dir_list: ['/vol2/1000/liberTV/strmdata'] },
            { guid: 'g-tv', name: '剧集库', dir_list: ['/vol2/1000/liberTV/strmdata'] },
          ],
        },
      });
    }
    if (isScanPath(parsed.pathname)) return jsonResponse({ code: 0, data: {} });
    throw new Error('unexpected path ' + parsed.pathname);
  };
  const client = new fnv.FnvClient(baseOptions({ fetchImpl }));

  const list = await client.listLibraries();
  assert.equal(list.ok, true);
  assert.equal(list.endpoint, 'mediadb');
  assert.equal(list.libraries.length, 2);
  assert.deepEqual(list.libraries[0].paths, ['/vol2/1000/liberTV/strmdata']);
  assert.equal(calls[0].path, LOGIN);
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[1].path, MEDIADB_LIST);
  assert.match(calls[1].headers.authx, /^nonce=\d{6}&timestamp=\d+&sign=[0-9a-f]{32}$/);
  assert.equal(calls[1].headers.Authorization, 'tok-1');

  const refresh = await client.refreshLibrary('g-movie', ['/vol2/1000/liberTV/strmdata/沙丘 (2021)']);
  assert.equal(refresh.ok, true);
  assert.equal(refresh.endpoint, 'mediadb');
  const scanCall = calls[calls.length - 1];
  assert.equal(scanCall.path, MEDIADB_SCAN + 'g-movie');
  assert.deepEqual(JSON.parse(scanCall.body), { dir_list: ['/vol2/1000/liberTV/strmdata/沙丘 (2021)'] });
  assert.equal(scanCall.headers.Authorization, 'tok-1');
  assert.equal(client.activeEndpoint, 'mediadb');
});

test('FnvClient：-2 触发重新登录后重试（最多 3 次）', async () => {
  let loginCalls = 0;
  let listCalls = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === LOGIN) {
      loginCalls += 1;
      return jsonResponse({ code: 0, data: { token: 'tok-' + loginCalls } });
    }
    if (isListPath(parsed.pathname)) {
      listCalls += 1;
      if (listCalls === 1) return jsonResponse({ code: -2, msg: 'token expired' });
      return jsonResponse({ code: 0, data: { list: [{ guid: 'g1', name: '库' }] } });
    }
    throw new Error('unexpected');
  };
  const client = new fnv.FnvClient(baseOptions({ fetchImpl }));
  const result = await client.getLibraryId('库');
  assert.equal(result.ok, true);
  assert.equal(result.guid, 'g1');
  assert.equal(loginCalls, 2);
  assert.equal(client.token, 'tok-2');
});

test('FnvClient：-14 先 POST task/stop 再重试', async () => {
  const paths = [];
  let scanCalls = 0;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    paths.push({ path: parsed.pathname, body: init.body });
    if (parsed.pathname === LOGIN) return jsonResponse({ code: 0, data: { token: 'tok' } });
    if (isScanPath(parsed.pathname)) {
      scanCalls += 1;
      if (scanCalls === 1) return jsonResponse({ code: -14, msg: 'task running' });
      return jsonResponse({ code: 0, data: {} });
    }
    if (parsed.pathname === STOP) return jsonResponse({ code: 0, data: {} });
    throw new Error('unexpected ' + parsed.pathname);
  };
  const client = new fnv.FnvClient(baseOptions({ fetchImpl }));
  const result = await client.refreshLibrary('g1', []);
  assert.equal(result.ok, true);
  const stopCall = paths.find((item) => item.path === STOP);
  assert.ok(stopCall, '应调用 task/stop');
  assert.deepEqual(JSON.parse(stopCall.body), { guid: 'g1', type: 'TaskItemScrap' });
  assert.equal(scanCalls, 2);
});

test('FnvClient：网络异常/非 JSON 都返回 {ok:false} 不抛出', async () => {
  const throwing = new fnv.FnvClient(
    baseOptions({
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    })
  );
  const login = await throwing.login();
  assert.equal(login.ok, false);
  assert.match(login.error, /网络错误|ECONNREFUSED/);

  const badJson = new fnv.FnvClient(
    baseOptions({
      fetchImpl: async () => jsonResponse('not-json'),
    })
  );
  const refresh = await badJson.refreshLibrary('g1', []);
  assert.equal(refresh.ok, false);
});

test('FnvClient：未配置时所有请求直接返回 ok:false', async () => {
  const client = new fnv.FnvClient(baseOptions({ apiKey: '' }));
  const result = await client.refreshLibrary('g1', []);
  assert.equal(result.ok, false);
  assert.match(result.error, /未配置/);
});

test('matchLibraries：strmRoot 前缀双向匹配，多个库全部返回', () => {
  const libraries = [
    { guid: 'g-movie', name: '电影', paths: ['/vol2/1000/liberTV/strmdata'] },
    { guid: 'g-tv', name: '剧集', paths: ['/vol2/1000/liberTV/strmdata/'] },
    { guid: 'g-other', name: '其他', paths: ['/vol3/media'] },
  ];
  const result = fnv.matchLibraries(libraries, { strmRoot: '/vol2/1000/liberTV/strmdata' });
  assert.equal(result.reason, 'path');
  assert.deepEqual(result.matched.map((item) => item.guid), ['g-movie', 'g-tv']);
});

test('matchLibraries：显式 libraryName 优先，仅刷新命中的一个库', () => {
  const libraries = [
    { guid: 'g-movie', name: '电影', paths: ['/strm'] },
    { guid: 'g-tv', name: '剧集', paths: ['/strm'] },
  ];
  const result = fnv.matchLibraries(libraries, { libraryName: '剧集', strmRoot: '/strm' });
  assert.equal(result.reason, 'name');
  assert.deepEqual(result.matched.map((item) => item.guid), ['g-tv']);
});

test('matchLibraries：显式名称找不到时回退按路径匹配', () => {
  const libraries = [{ guid: 'g1', name: '电影', paths: ['/vol/strm'] }];
  const result = fnv.matchLibraries(libraries, { libraryName: '不存在', strmRoot: '/vol/strm' });
  assert.equal(result.reason, 'path');
  assert.equal(result.matched[0].guid, 'g1');
});

test('matchLibraries：路径字段未知且只有一个库时回退唯一库', () => {
  const result = fnv.matchLibraries([{ guid: 'g1', name: '唯一库', paths: [] }], { strmRoot: '/strm' });
  assert.equal(result.reason, 'single-library');
  assert.equal(result.matched[0].guid, 'g1');
});

test('matchLibraries：多个库但路径字段未知时返回空，便于上层打印完整 JSON', () => {
  const result = fnv.matchLibraries(
    [
      { guid: 'g1', name: 'A', paths: [] },
      { guid: 'g2', name: 'B', paths: [] },
    ],
    { strmRoot: '/strm' }
  );
  assert.equal(result.matched.length, 0);
  assert.equal(result.reason, 'unknown-path-fields');
});

test('buildAuthx 真实常量固定向量：login / mediadb list / mediadb scan', () => {
  const { BUILTIN_SECRET_STRING, BUILTIN_API_KEY } = require('../fnv-secrets');
  const common = { secretString: BUILTIN_SECRET_STRING, apiKey: BUILTIN_API_KEY };

  const login = fnv.buildAuthx({
    ...common,
    method: 'POST',
    path: '/v/api/v1/login',
    nonce: '135792',
    timestamp: '1729300000000',
    data: { username: 'admin', password: 's3cr3t', app_name: 'trimemedia-web' },
  });
  assert.equal(login.bodyHash, '93421b3c6b9d8079b519b2452d04c94c');
  assert.equal(login.sign, '39078aa56a64dd470d22637f2890f12d');

  const list = fnv.buildAuthx({
    ...common,
    method: 'GET',
    path: '/v/api/v1/mediadb/list',
    nonce: '246813',
    timestamp: '1729300000001',
    params: {},
  });
  assert.equal(list.serialized, '');
  assert.equal(list.bodyHash, 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(list.sign, '6c276b6e2f41e57cefd1976ae186c58c');

  const scan = fnv.buildAuthx({
    ...common,
    method: 'POST',
    path: '/v/api/v1/mediadb/scan/c94038bf70b14aa4abdc74ad957ca367',
    nonce: '112233',
    timestamp: '1729300000002',
    data: { dir_list: ['/vol2/1000/liberTV/strmdata/沙丘 (2021)'] },
  });
  assert.equal(scan.bodyHash, '24e34fd62e5335b3ec55605157bacd3e');
  assert.equal(scan.sign, 'bb0b4b352f4709cf668e1b484e93425d');
});

test('双端点：mediadb/list 成功（默认优先），不会请求旧 mdb/list', async () => {
  const paths = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    paths.push(parsed.pathname);
    if (parsed.pathname === LOGIN) return jsonResponse({ code: 0, data: { token: 'tok' } });
    if (parsed.pathname === MEDIADB_LIST) {
      return jsonResponse({ code: 0, data: { list: [{ guid: 'g1', name: '库', dir_list: ['/strm'] }] } });
    }
    if (parsed.pathname === MEDIADB_SCAN + 'g1') return jsonResponse({ code: 0, data: {} });
    throw new Error('unexpected ' + parsed.pathname);
  };
  const client = new fnv.FnvClient(baseOptions({ fetchImpl }));
  const list = await client.listLibraries();
  assert.equal(list.ok, true);
  assert.equal(list.endpoint, 'mediadb');
  assert.equal(paths.includes(LIST), false);

  const refresh = await client.refreshLibrary('g1', []);
  assert.equal(refresh.ok, true);
  assert.equal(refresh.endpoint, 'mediadb');
  assert.deepEqual(paths.filter((p) => p !== LOGIN), [MEDIADB_LIST, MEDIADB_SCAN + 'g1']);
});

test('双端点：mediadb/list 404 → 回退 mdb/list，后续 scan 也走 mdb', async () => {
  const paths = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    paths.push(parsed.pathname);
    if (parsed.pathname === LOGIN) return jsonResponse({ code: 0, data: { token: 'tok' } });
    if (parsed.pathname === MEDIADB_LIST) return jsonResponse('not found', 404);
    if (parsed.pathname === LIST) {
      return jsonResponse({ code: 0, data: { list: [{ guid: 'g1', name: '库', dir_list: ['/strm'] }] } });
    }
    if (parsed.pathname === SCAN + 'g1') return jsonResponse({ code: 0, data: {} });
    throw new Error('unexpected ' + parsed.pathname);
  };
  const client = new fnv.FnvClient(baseOptions({ fetchImpl }));
  const list = await client.listLibraries();
  assert.equal(list.ok, true);
  assert.equal(list.endpoint, 'mdb');
  assert.deepEqual(list.attempts.map((item) => item.endpoint), ['mediadb', 'mdb']);

  const refresh = await client.refreshLibrary('g1', []);
  assert.equal(refresh.ok, true);
  assert.equal(refresh.endpoint, 'mdb');
  assert.equal(paths.includes(MEDIADB_SCAN + 'g1'), false);
  assert.equal(paths.includes(SCAN + 'g1'), true);
});

test('双端点：mediadb/list 业务 code 非 0 → 回退 mdb/list', async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === LOGIN) return jsonResponse({ code: 0, data: { token: 'tok' } });
    if (parsed.pathname === MEDIADB_LIST) return jsonResponse({ code: 5000, msg: 'invalid sign' });
    if (parsed.pathname === LIST) {
      return jsonResponse({ code: 0, data: { list: [{ guid: 'g1', name: '库' }] } });
    }
    throw new Error('unexpected ' + parsed.pathname);
  };
  const client = new fnv.FnvClient(baseOptions({ fetchImpl }));
  const list = await client.listLibraries();
  assert.equal(list.ok, true);
  assert.equal(list.endpoint, 'mdb');
  assert.equal(list.attempts[0].code, 5000);
});

test('双端点：mediadb/scan 501 → 回退 mdb/scan', async () => {
  const scanPaths = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === LOGIN) return jsonResponse({ code: 0, data: { token: 'tok' } });
    if (parsed.pathname === MEDIADB_LIST) {
      return jsonResponse({ code: 0, data: { list: [{ guid: 'g1', name: '库', dir_list: ['/strm'] }] } });
    }
    if (isScanPath(parsed.pathname)) {
      scanPaths.push(parsed.pathname);
      if (parsed.pathname === MEDIADB_SCAN + 'g1') return jsonResponse('not implemented', 501);
      if (parsed.pathname === SCAN + 'g1') return jsonResponse({ code: 0, data: {} });
    }
    throw new Error('unexpected ' + parsed.pathname);
  };
  const client = new fnv.FnvClient(baseOptions({ fetchImpl }));
  const refresh = await client.refreshLibrary('g1', []);
  assert.equal(refresh.ok, true);
  assert.equal(refresh.endpoint, 'mdb');
  assert.deepEqual(scanPaths, [MEDIADB_SCAN + 'g1', SCAN + 'g1']);
  assert.deepEqual(refresh.attempts.map((item) => item.endpoint), ['mediadb', 'mdb']);
});

test('extractToken / extractLibraryList：兼容真实响应常见形态', () => {
  assert.equal(fnv.extractToken({ code: 0, data: 'tok-from-data-string' }), 'tok-from-data-string');
  assert.equal(fnv.extractToken({ code: 0, data: { token: 'tok-nested' } }), 'tok-nested');
  assert.equal(fnv.extractToken({ code: 0, data: { access_token: 'tok-access' } }), 'tok-access');

  const list = fnv.extractLibraryList({ code: 0, data: { mediadb_list: [{ item_guid: 'g1', title: '电影', path: '/strm' }] } });
  assert.equal(list.length, 1);
  assert.equal(fnv.extractGuid(list[0]), 'g1');
  assert.equal(fnv.extractLibraryName(list[0]), '电影');
  assert.deepEqual(fnv.extractLibraryPaths(list[0]), ['/strm']);
});
