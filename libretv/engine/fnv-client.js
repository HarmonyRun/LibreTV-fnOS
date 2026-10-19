'use strict';

/**
 * FnvClient：飞牛影视（trim.media）刷新接口客户端（契约第 7 节）。
 *
 * 签名算法（与 quark-auto-save fnv.py 一致）：
 *   nonce      = 6 位随机数字
 *   timestamp  = 毫秒时间戳字符串
 *   GET        serialized = urlencode(sorted(params))       （Python quote_plus 语义）
 *   POST       serialized = 紧凑 JSON（键递归排序、无空格、中文不转义），无 body 时 ""
 *   bodyHash   = md5(serialized)
 *   sign       = md5([secretString, path, nonce, timestamp, bodyHash, apiKey].join('_'))
 *   header     authx: nonce=<nonce>&timestamp=<ts>&sign=<sign>
 *              登录后附加 Authorization: <token>、Content-Type: application/json
 *
 * 所有公开方法都返回 {ok,...}，不向外抛未捕获异常。
 */

const crypto = require('crypto');
const nodePath = require('path');

const LOGIN_PATH = '/v/api/v1/login';
// 真实端点（fnOS 1.2 / 影视 0.9.8+，NAS-RECON §4）
const MEDIADB_LIST_PATH = '/v/api/v1/mediadb/list';
const MEDIADB_SCAN_PREFIX = '/v/api/v1/mediadb/scan/';
// 旧端点（quark-auto-save 时代）：mediadb/* 返回 404/501/非 code 0 时回退
const LIBRARY_LIST_PATH = '/v/api/v1/mdb/list';
const SCAN_PATH_PREFIX = '/v/api/v1/mdb/scan/';
const TASK_STOP_PATH = '/v/api/v1/task/stop';

const DEFAULT_BASE_URL = 'http://127.0.0.1:5666';
const DEFAULT_APP_NAME = 'trimemedia-web';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RELOGIN_RETRIES = 3;
const MAX_STOP_RETRIES = 3;

function md5(text) {
  return crypto.createHash('md5').update(String(text), 'utf8').digest('hex');
}

/** Python urllib.parse.quote_plus 兼容的百分号编码 */
function pyQuote(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+');
}

/** GET 查询串：键升序 + urlencode */
function serializeGet(params) {
  if (!params || typeof params !== 'object') return '';
  const keys = Object.keys(params)
    .filter((key) => params[key] !== undefined)
    .sort();
  if (keys.length === 0) return '';
  return keys.map((key) => `${pyQuote(key)}=${pyQuote(params[key])}`).join('&');
}

/** 递归按键排序对象，保证 JSON 序列化与 Python sort_keys 一致 */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = sortDeep(value[key]);
    }
    return out;
  }
  return value;
}

/** 紧凑 JSON：键排序、无空格、中文不转义 */
function stableStringify(value) {
  if (value === undefined) return '';
  return JSON.stringify(sortDeep(value));
}

function serializeBody(data) {
  if (data === undefined || data === null) return '';
  return stableStringify(data);
}

function generateNonce() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * 纯函数：生成 authx 头与中间值，供单测固定向量使用。
 * @param {object} options {path, method?, params?, data?, secretString?, apiKey?, nonce?, timestamp?}
 */
function buildAuthx(options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const path = String(options.path || '');
  const nonce = options.nonce === undefined || options.nonce === null ? generateNonce() : String(options.nonce);
  const timestamp =
    options.timestamp === undefined || options.timestamp === null ? String(Date.now()) : String(options.timestamp);
  const secretString = options.secretString === undefined || options.secretString === null ? '' : String(options.secretString);
  const apiKey = options.apiKey === undefined || options.apiKey === null ? '' : String(options.apiKey);
  const serialized = method === 'GET' ? serializeGet(options.params) : serializeBody(options.data);
  const bodyHash = md5(serialized);
  const sign = md5([secretString, path, nonce, timestamp, bodyHash, apiKey].join('_'));
  return {
    method,
    path,
    nonce,
    timestamp,
    serialized,
    bodyHash,
    sign,
    authx: `nonce=${nonce}&timestamp=${timestamp}&sign=${sign}`,
  };
}

function toCode(code) {
  const n = Number(code);
  return Number.isFinite(n) ? n : NaN;
}

function errorMessage(payload) {
  if (!payload || typeof payload !== 'object') return '响应格式无效';
  return (
    (typeof payload.msg === 'string' && payload.msg) ||
    (typeof payload.message === 'string' && payload.message) ||
    (typeof payload.error === 'string' && payload.error) ||
    `API 错误 code=${payload.code}`
  );
}

function extractToken(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload.trim();
  if (typeof payload !== 'object') return '';
  const data = payload.data;
  const candidates = [
    typeof data === 'string' ? data.trim() : '',
    payload.token,
    payload.access_token,
    payload.accessToken,
    payload.user_token,
    data && typeof data === 'object' ? data.token : '',
    data && typeof data === 'object' ? data.access_token : '',
    data && typeof data === 'object' ? data.accessToken : '',
    data && typeof data === 'object' ? data.user_token : '',
    data && typeof data === 'object' && data.data ? data.data.token : '',
    payload.result && typeof payload.result === 'object' ? payload.result.token : '',
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function extractLibraryList(payload) {
  const arrays = [];
  const push = (value) => {
    if (Array.isArray(value)) arrays.push(value);
  };
  const data = payload && typeof payload === 'object' ? payload.data : undefined;
  push(payload && payload.list);
  push(payload && payload.items);
  if (Array.isArray(data)) push(data);
  if (data && typeof data === 'object') {
    push(data.list);
    push(data.items);
    push(data.mdb_list);
    push(data.mediadb_list);
    push(data.mediadbList);
    push(data.mdbs);
    push(data.libraries);
    push(data.data);
  }
  for (const arr of arrays) {
    const objects = arr.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
    if (objects.length > 0) return objects;
  }
  return null;
}

function extractGuid(item) {
  if (!item || typeof item !== 'object') return '';
  const keys = [
    'guid',
    'item_guid',
    'itemGuid',
    'mdb_guid',
    'mdbGuid',
    'library_guid',
    'guid_str',
    'id',
    'mdb_id',
    'value',
  ];
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function extractLibraryName(item) {
  if (!item || typeof item !== 'object') return '';
  const keys = [
    'name',
    'title',
    'label',
    'item_name',
    'itemName',
    'mdb_name',
    'mdbName',
    'mdb_title',
    'mdbTitle',
    'library_name',
    'libraryName',
  ];
  for (const key of keys) {
    if (typeof item[key] === 'string' && item[key].trim()) return item[key].trim();
  }
  return '';
}

const LIBRARY_PATH_KEYS = [
  'dir_list',
  'dirList',
  'dirs',
  'paths',
  'path',
  'mdb_path',
  'mdbPath',
  'library_path',
  'libraryPath',
  'scan_path',
  'scanPath',
  'root',
  'root_path',
  'folders',
  'directories',
  'dir',
];

function collectPathValues(value, out) {
  if (typeof value === 'string') {
    if (value.trim()) out.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathValues(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of ['path', 'dir', 'name', 'value', 'dir_path', 'dirPath']) {
      if (typeof value[key] === 'string' && value[key].trim()) out.push(value[key].trim());
    }
  }
}

/** 从媒体库条目中提取目录路径（字段名未知时返回空数组） */
function extractLibraryPaths(item) {
  if (!item || typeof item !== 'object') return [];
  const out = [];
  for (const key of LIBRARY_PATH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(item, key)) collectPathValues(item[key], out);
  }
  // 部分实现把路径放在 item.data / item.extra 里
  for (const nestedKey of ['data', 'extra', 'config']) {
    const nested = item[nestedKey];
    if (nested && typeof nested === 'object') {
      for (const key of LIBRARY_PATH_KEYS) {
        if (Object.prototype.hasOwnProperty.call(nested, key)) collectPathValues(nested[key], out);
      }
    }
  }
  return [...new Set(out)];
}

function normalizePath(p) {
  if (typeof p !== 'string' || !p.trim()) return '';
  let resolved = p.trim();
  try {
    resolved = nodePath.resolve(resolved);
  } catch {
    /* ignore */
  }
  return resolved.replace(/[\\/]+$/, '');
}

function pathRelated(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const aSep = a.endsWith('/') ? a : a + '/';
  const bSep = b.endsWith('/') ? b : b + '/';
  return b.startsWith(aSep) || a.startsWith(bSep);
}

/**
 * 选择需要刷新的媒体库：
 *   1) libraryName 显式配置且名称精确匹配 → 只返回该库
 *   2) 否则按 strmRoot 与库路径前缀/包含关系匹配，返回全部命中（同一目录可同时是电影/剧集库）
 *   3) 无法提取任何路径时：若仅一个媒体库则回退用它，否则返回 needsPathInfo
 * @returns {{matched:Array, reason:string, unmatched:Array}}
 */
function matchLibraries(libraries, options = {}) {
  const list = Array.isArray(libraries) ? libraries.filter((item) => item && item.guid) : [];
  const libraryName = typeof options.libraryName === 'string' ? options.libraryName.trim() : '';
  const strmRoot = normalizePath(options.strmRoot);

  if (libraryName) {
    const exact = list.find((item) => item.name === libraryName);
    const loose = exact || list.find((item) => (item.name || '').toLowerCase() === libraryName.toLowerCase());
    if (loose) return { matched: [loose], reason: 'name', unmatched: list.filter((item) => item.guid !== loose.guid) };
  }

  const withPaths = list.filter((item) => Array.isArray(item.paths) && item.paths.length > 0);
  if (withPaths.length > 0 && strmRoot) {
    const matched = withPaths.filter((item) =>
      item.paths.some((p) => pathRelated(normalizePath(p), strmRoot))
    );
    if (matched.length > 0) {
      return {
        matched,
        reason: 'path',
        unmatched: list.filter((item) => !matched.some((m) => m.guid === item.guid)),
      };
    }
    // 有路径但都不匹配：不做错误猜测，交给上层决定是否降级
    return { matched: [], reason: 'no-path-match', unmatched: list };
  }

  if (list.length === 1) return { matched: [list[0]], reason: 'single-library', unmatched: [] };
  return { matched: [], reason: withPaths.length === 0 && list.length > 1 ? 'unknown-path-fields' : 'no-match', unmatched: list };
}

class FnvClient {
  constructor(options = {}) {
    this.baseUrl = (typeof options.baseUrl === 'string' && options.baseUrl.trim()
      ? options.baseUrl.trim()
      : DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
    this.appName =
      (typeof options.appName === 'string' && options.appName.trim()
        ? options.appName.trim()
        : DEFAULT_APP_NAME
      ) || DEFAULT_APP_NAME;
    this.username = typeof options.username === 'string' ? options.username.trim() : '';
    this.password = typeof options.password === 'string' ? options.password : '';
    this.secretString = typeof options.secretString === 'string' ? options.secretString : '';
    this.apiKey = typeof options.apiKey === 'string' ? options.apiKey : '';
    this.libraryName = typeof options.libraryName === 'string' ? options.libraryName.trim() : '';
    this.enabled = options.enabled !== false;
    this.timeoutMs =
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
    this.logger = options.logger && typeof options.logger === 'object' ? options.logger : null;
    this.token = null;
    this.lastLoginAt = 0;
    /** 最近一次成功使用的端点名：'mediadb' | 'mdb' */
    this.activeEndpoint = '';
    this.lastEndpoint = '';
    this.endpointAttempts = [];
  }

  get configured() {
    return Boolean(
      this.enabled &&
        this.baseUrl &&
        this.username &&
        this.password &&
        this.secretString &&
        this.apiKey &&
        typeof this.fetchImpl === 'function'
    );
  }

  _log(level, message, extra) {
    if (!this.logger) return;
    try {
      const fn = this.logger[level] || this.logger.log;
      if (typeof fn === 'function') fn(message, extra);
    } catch {
      /* ignore */
    }
  }

  /**
   * 发送单个 HTTP 请求（网络错误/5xx 重试 1 次），返回 {ok,json,status} 或 {ok:false,error}。
   * 不处理业务 code。
   */
  async _send(method, path, options = {}) {
    const attempts = 2;
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const authx = buildAuthx({
        method,
        path,
        params: options.params,
        data: options.data,
        secretString: this.secretString,
        apiKey: this.apiKey,
      });
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        authx: authx.authx,
      };
      if (options.auth !== false && this.token) headers.Authorization = this.token;
      let url = this.baseUrl + path;
      if (method === 'GET' && authx.serialized) url += '?' + authx.serialized;
      const init = { method, headers, redirect: 'follow' };
      if (method !== 'GET' && options.data !== undefined) init.body = stableStringify(options.data);
      try {
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
          init.signal = AbortSignal.timeout(this.timeoutMs);
        }
        const res = await this.fetchImpl(url, init);
        const status = Number(res && res.status) || 0;
        let text = '';
        try {
          text = typeof res.text === 'function' ? await res.text() : '';
        } catch (err) {
          lastError = new Error(`读取响应失败: ${(err && err.message) || err}`);
          if (attempt < attempts - 1) continue;
          return { ok: false, error: lastError.message };
        }
        if (status >= 500) {
          lastError = new Error(`HTTP ${status}`);
          // 501 通常表示端点未实现：立即返回，让上层快速回退旧端点，不做重试
          if (status !== 501 && attempt < attempts - 1) continue;
          return { ok: false, error: lastError.message, status };
        }
        if (status >= 400) {
          return { ok: false, error: `HTTP ${status}: ${text.slice(0, 200)}`, status };
        }
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          return { ok: false, error: '响应不是合法 JSON', status };
        }
        return { ok: true, json, status };
      } catch (err) {
        lastError = new Error(`网络错误: ${(err && err.message) || err}`);
        if (attempt < attempts - 1) continue;
        return { ok: false, error: lastError.message };
      }
    }
    return { ok: false, error: lastError ? lastError.message : '请求失败' };
  }

  /** 登录并缓存 token */
  async login() {
    if (!this.configured) return { ok: false, error: '飞牛影视未配置' };
    const body = { username: this.username, password: this.password, app_name: this.appName };
    const res = await this._send('POST', LOGIN_PATH, { data: body, auth: false });
    if (!res.ok) return { ok: false, error: res.error };
    const code = toCode(res.json && res.json.code);
    if (code !== 0) {
      return { ok: false, code, error: errorMessage(res.json) };
    }
    const token = extractToken(res.json);
    if (!token) return { ok: false, error: '登录响应缺少 token' };
    this.token = token;
    this.lastLoginAt = Date.now();
    this._log('info', '飞牛影视登录成功');
    return { ok: true, token };
  }

  async _ensureToken() {
    if (this.token) return true;
    const result = await this.login();
    return result.ok;
  }

  /**
   * 带业务码处理的请求：-2 重新登录（最多 3 次），-14 停止扫描任务后重试。
   * 返回 {ok:true,data,raw} 或 {ok:false,code?,error}
   */
  async _request(method, path, options = {}) {
    if (!this.configured) return { ok: false, error: '飞牛影视未配置' };
    let reloginRetries = 0;
    let stopRetries = 0;
    for (let guard = 0; guard < 12; guard += 1) {
      const tokenOk = await this._ensureToken();
      if (!tokenOk) return { ok: false, error: '飞牛影视登录失败' };
      const res = await this._send(method, path, { params: options.params, data: options.data });
      if (!res.ok) return { ok: false, error: res.error, status: res.status };
      const payload = res.json;
      const code = toCode(payload && payload.code);
      if (code === 0) return { ok: true, data: payload ? payload.data : undefined, raw: payload };

      if (code === -2 && reloginRetries < MAX_RELOGIN_RETRIES) {
        reloginRetries += 1;
        this.token = null;
        this._log('warn', `飞牛影视 token 失效（code -2），重新登录第 ${reloginRetries} 次`);
        continue;
      }
      if (code === -14 && stopRetries < MAX_STOP_RETRIES) {
        stopRetries += 1;
        if (options.stopGuid) await this.stopTask(options.stopGuid);
        this._log('warn', `飞牛影视扫描任务冲突（code -14），已尝试停止任务后重试`);
        continue;
      }
      return { ok: false, code, error: errorMessage(payload) };
    }
    return { ok: false, error: '飞牛影视请求重试次数已用尽' };
  }

  /** 停止指定媒体库的扫描任务（-14 分支使用） */
  async stopTask(guid) {
    if (!guid) return { ok: false, error: '缺少 guid' };
    const res = await this._send('POST', TASK_STOP_PATH, { data: { guid, type: 'TaskItemScrap' } });
    if (!res.ok) return { ok: false, error: res.error };
    const code = toCode(res.json && res.json.code);
    if (code !== 0) return { ok: false, code, error: errorMessage(res.json) };
    return { ok: true };
  }

  /** 端点顺序：优先上次成功的端点，其次 mediadb/*，最后旧 mdb/* */
  _orderedEndpoints(kind) {
    const candidates =
      kind === 'scan'
        ? [
            ['mediadb', MEDIADB_SCAN_PREFIX],
            ['mdb', SCAN_PATH_PREFIX],
          ]
        : [
            ['mediadb', MEDIADB_LIST_PATH],
            ['mdb', LIBRARY_LIST_PATH],
          ];
    if (!this.activeEndpoint) return candidates;
    return [
      ...candidates.filter(([name]) => name === this.activeEndpoint),
      ...candidates.filter(([name]) => name !== this.activeEndpoint),
    ];
  }

  /** 依次尝试 mediadb/* → mdb/*，任意失败（404/501/非 code 0/网络错误）都回退 */
  async _requestAcrossEndpoints(kind, makeRequest) {
    const attempts = [];
    let lastResult = null;
    for (const [name, base] of this._orderedEndpoints(kind)) {
      const request = makeRequest(base);
      const result = await this._request(request.method, request.path, request.options || {});
      attempts.push({
        endpoint: name,
        ok: Boolean(result.ok),
        status: result.status,
        code: result.code,
        error: result.error || '',
      });
      lastResult = { ...result, endpoint: name, attempts };
      if (result.ok) {
        this.activeEndpoint = name;
        this.lastEndpoint = name;
        this.endpointAttempts = attempts;
        return lastResult;
      }
    }
    this.endpointAttempts = attempts;
    this.lastEndpoint = attempts.length > 0 ? attempts[attempts.length - 1].endpoint : this.lastEndpoint;
    if (!lastResult) return { ok: false, error: '没有可用的媒体库端点', attempts };
    return { ...lastResult, attempts };
  }

  /** 媒体库列表（含解析出的目录路径），供自动匹配使用；mediadb/list 失败时回退 mdb/list */
  async listLibraries() {
    const attempts = [];
    for (const [name, base] of this._orderedEndpoints('list')) {
      const res = await this._request('GET', base, {});
      attempts.push({
        endpoint: name,
        ok: Boolean(res.ok),
        status: res.status,
        code: res.code,
        error: res.error || '',
      });
      if (res.ok) {
        const rawList = extractLibraryList(res.raw);
        if (rawList === null) {
          attempts[attempts.length - 1].error = '无法解析媒体库列表（字段名未知）';
          continue;
        }
        this.activeEndpoint = name;
        this.lastEndpoint = name;
        this.endpointAttempts = attempts;
        const libraries = rawList.map((item) => ({
          guid: extractGuid(item),
          name: extractLibraryName(item),
          paths: extractLibraryPaths(item),
          raw: item,
        }));
        return { ok: true, libraries, raw: res.raw, endpoint: name, attempts };
      }
    }
    this.endpointAttempts = attempts;
    const last = attempts.length > 0 ? attempts[attempts.length - 1] : {};
    this.lastEndpoint = last.endpoint || '';
    return {
      ok: false,
      error: last.error || '媒体库列表请求失败',
      endpoint: last.endpoint || '',
      attempts,
    };
  }

  /** 按名称查询单个媒体库 guid（契约接口；空名称时仅在唯一库时返回） */
  async getLibraryId(name) {
    const result = await this.listLibraries();
    if (!result.ok) return result;
    const wanted = typeof name === 'string' ? name.trim() : '';
    if (wanted) {
      const match =
        result.libraries.find((item) => item.name === wanted) ||
        result.libraries.find((item) => (item.name || '').toLowerCase() === wanted.toLowerCase());
      if (!match || !match.guid) return { ok: false, error: `未找到媒体库: ${wanted}` };
      return {
        ok: true,
        guid: match.guid,
        name: match.name,
        endpoint: result.endpoint,
        libraries: result.libraries,
      };
    }
    if (result.libraries.length === 1) {
      const only = result.libraries[0];
      if (!only.guid) return { ok: false, error: '媒体库缺少 guid 字段' };
      return {
        ok: true,
        guid: only.guid,
        name: only.name,
        endpoint: result.endpoint,
        libraries: result.libraries,
      };
    }
    return {
      ok: false,
      error:
        result.libraries.length === 0
          ? '飞牛影视中没有任何媒体库'
          : '存在多个媒体库，请在设置中填写媒体库名称',
      libraries: result.libraries,
    };
  }

  /**
   * 触发媒体库扫描。
   * @param {string} id 媒体库 guid
   * @param {string[]} [dirList] 变更目录绝对路径；空数组/缺省表示全库扫描
   */
  async refreshLibrary(id, dirList) {
    const guid = typeof id === 'string' ? id.trim() : String(id || '').trim();
    if (!guid) return { ok: false, error: '缺少媒体库 guid' };
    const data = Array.isArray(dirList) && dirList.length > 0 ? { dir_list: dirList.map((p) => String(p)) } : {};
    const res = await this._requestAcrossEndpoints('scan', (base) => ({
      method: 'POST',
      path: base + encodeURIComponent(guid),
      options: { data, stopGuid: guid },
    }));
    if (!res.ok) return res;
    return { ok: true, endpoint: res.endpoint, attempts: res.attempts, raw: res.raw };
  }
}

module.exports = {
  FnvClient,
  buildAuthx,
  md5,
  pyQuote,
  serializeGet,
  stableStringify,
  generateNonce,
  extractToken,
  extractLibraryList,
  extractGuid,
  extractLibraryName,
  extractLibraryPaths,
  matchLibraries,
  normalizePath,
  pathRelated,
  LOGIN_PATH,
  MEDIADB_LIST_PATH,
  MEDIADB_SCAN_PREFIX,
  LIBRARY_LIST_PATH,
  TASK_STOP_PATH,
  SCAN_PATH_PREFIX,
  DEFAULT_BASE_URL,
  DEFAULT_APP_NAME,
  MAX_RELOGIN_RETRIES,
  MAX_STOP_RETRIES,
};
