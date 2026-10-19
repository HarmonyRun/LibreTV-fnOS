'use strict';

/**
 * LibreTV-fnOS MCP 服务（Model Context Protocol）
 *
 * 传输：MCP Streamable HTTP（POST /mcp，JSON-RPC 2.0；GET 返回 405，客户端使用 POST）
 * 鉴权：Authorization: Bearer <config.mcp.token>（或 X-MCP-Token）
 * 工具：搜索资源 / 详情 / 加入影视库 / 列出库 / 删除 STRM / 同步 / 清理 / 状态 / 刷新影视库
 *
 * 设计：随 start.js 启动的独立 HTTP 服务（默认 8092），与 Next/STRM 引擎同进程；
 * 所有写操作复用现有队列/索引契约，不绕过工程引擎。失败不影响主 Web。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cms = require('../engine/cms');
const indexStore = require('../engine/index-store');
const { FnvClient } = require('../engine/fnv-client');

const DEFAULT_PORT = 8092;
const VERSION = (() => {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8'));
    return String(v.version || '1.0.4');
  } catch {
    return '1.0.4';
  }
})();
const MAX_BODY = 2 * 1024 * 1024;
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_SOURCES = [
  { key: 'env_0', name: '电影天堂资源', url: 'https://caiji.dyttzyapi.com/api.php/provide/vod' },
  { key: 'env_1', name: '量子资源', url: 'https://cj.lziapi.com/api.php/provide/vod' },
  { key: 'env_2', name: '如意资源', url: 'https://cj.rycjapi.com/api.php/provide/vod' },
  { key: 'env_3', name: '优质资源', url: 'https://api.yzzy-api.com/inc/apijson.php' },
];

function normalizeTitle(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/第[一二三四五六七八九十百零\d]+季/g, '')
    .replace(/season\s*\d+/g, '')
    .replace(/[：:·・,，.。!！?？'"“”‘’()（）\[\]【】\-_—–/\\|]/g, '');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function isInside(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

function createMcpServer({ dataDir, logger, port = DEFAULT_PORT, version = VERSION } = {}) {
  const log = {
    info: (m, e) => (logger && logger.info ? logger.info(`[mcp] ${m}`, e) : console.log(`[mcp] ${m}`)),
    warn: (m, e) => (logger && logger.warn ? logger.warn(`[mcp] ${m}`, e) : console.warn(`[mcp] ${m}`)),
    error: (m, e) => (logger && logger.error ? logger.error(`[mcp] ${m}`, e) : console.error(`[mcp] ${m}`)),
  };

  const paths = {
    config: path.join(dataDir, 'config.json'),
    index: path.join(dataDir, 'strm-index.json'),
    state: path.join(dataDir, 'state.json'),
    queue: path.join(dataDir, 'queue'),
  };

  function readConfig() {
    return readJson(paths.config) || {};
  }

  /** 确保存在 MCP token；缺失则生成并持久化（保留其它配置） */
  function ensureMcpConfig() {
    const cfg = readConfig();
    let changed = false;
    if (!cfg.mcp || typeof cfg.mcp !== 'object' || Array.isArray(cfg.mcp)) {
      cfg.mcp = {};
      changed = true;
    }
    if (!str(cfg.mcp.token)) {
      cfg.mcp.token = randomToken();
      changed = true;
    }
    if (cfg.mcp.enabled === undefined) {
      cfg.mcp.enabled = true;
      changed = true;
    }
    if (!Number.isFinite(Number(cfg.mcp.port)) || Number(cfg.mcp.port) <= 0) {
      cfg.mcp.port = port;
      changed = true;
    }
    if (changed) {
      try {
        writeJsonAtomic(paths.config, cfg);
        log.info('已生成/补全 config.mcp 配置');
      } catch (err) {
        log.warn(`写入 config.mcp 失败: ${err && err.message}`);
      }
    }
    return cfg.mcp;
  }

  function getMcpConfig() {
    const cfg = readConfig();
    const mcp = cfg.mcp && typeof cfg.mcp === 'object' ? cfg.mcp : {};
    return {
      enabled: mcp.enabled !== false,
      token: str(mcp.token) || str(ensureMcpConfig().token),
      port: Number(mcp.port) > 0 ? Number(mcp.port) : port,
    };
  }

  function getSources() {
    const cfg = readConfig();
    const list = Array.isArray(cfg.sources) ? cfg.sources : [];
    const sources = list
      .filter((s) => s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url))
      .map((s, i) => ({
        key: str(s.key) || `env_${i}`,
        name: str(s.name) || `源 ${i + 1}`,
        url: str(s.url).replace(/\/+$/, ''),
        detail: str(s.detail) || undefined,
      }));
    return sources.length ? sources : DEFAULT_SOURCES;
  }

  function getStrmRoot() {
    const root = str(readConfig().strmRoot);
    return root ? path.resolve(root) : '';
  }

  function readState() {
    return readJson(paths.state) || {};
  }

  function readIndex() {
    try {
      return indexStore.loadIndex(dataDir);
    } catch {
      return indexStore.createEmptyIndex();
    }
  }
  function saveIndex(index) {
    indexStore.saveIndex(dataDir, index);
  }

  function enqueueJob(action, payload) {
    const id = `job-${Date.now()}-${crypto.randomBytes(3).toString('hex').slice(0, 6)}`;
    const job = { id, createdAt: new Date().toISOString(), action, payload: payload || {} };
    writeJsonAtomic(path.join(paths.queue, `${id}.json`), job);
    return job;
  }

  function findPendingJob(action) {
    try {
      const names = fs.readdirSync(paths.queue).filter((n) => n.endsWith('.json')).sort();
      for (const n of names) {
        const j = readJson(path.join(paths.queue, n));
        if (j && j.action === action) return j;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitFor(fn, timeoutMs, intervalMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await fn();
      if (result) return result;
      if (Date.now() >= deadline) return null;
      await sleep(intervalMs);
    }
  }

  const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

  /** 从目录名解析季度：Season 01 / S01 / 第1季 / 第一季 */
  function parseSeasonNumber(name) {
    const s = String(name || '').trim();
    let m = /^season\s*0*(\d+)$/i.exec(s) || /^s0*(\d+)$/i.exec(s);
    if (m) return Number(m[1]);
    m = /^第([一二三四五六七八九十百零\d]+)季$/.exec(s);
    if (!m) return null;
    const raw = m[1];
    if (/^\d+$/.test(raw)) return Number(raw);
    if (raw === '十') return 10;
    if (raw.length === 1 && CN_NUM[raw]) return CN_NUM[raw];
    const ten = /^十([一二三四五六七八九])$/.exec(raw);
    if (ten) return 10 + CN_NUM[ten[1]];
    const tens = /^([一二三四五六七八九])十([一二三四五六七八九]?)$/.exec(raw);
    if (tens) return CN_NUM[tens[1]] * 10 + (tens[2] ? CN_NUM[tens[2]] : 0);
    return null;
  }

  /** 资源根目录 = strmRoot 下的第一层目录（如 庆余年 (2019)） */
  function resourceRootOfPath(absPath) {
    const root = getStrmRoot();
    if (!root) return null;
    const abs = path.resolve(String(absPath));
    if (!isInside(root, abs) || abs === root) return null;
    const first = path.relative(root, abs).split(path.sep)[0];
    if (!first || first === '..') return null;
    return path.join(root, first);
  }

  function entryResourceRoots(entry) {
    const roots = new Set();
    for (const p of entry.strmPaths || []) {
      const r = resourceRootOfPath(p);
      if (r) roots.add(r);
    }
    return [...roots];
  }

  function listSeasonDirs(resourceRoot) {
    const out = [];
    try {
      for (const name of fs.readdirSync(resourceRoot)) {
        const abs = path.join(resourceRoot, name);
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;
        const season = parseSeasonNumber(name);
        if (season !== null) out.push({ season, name, dir: abs });
      }
    } catch {
      /* ignore */
    }
    return out.sort((a, b) => a.season - b.season || a.name.localeCompare(b.name));
  }

  function countFilesRecursive(dir) {
    let count = 0;
    const stack = [dir];
    while (stack.length) {
      const current = stack.pop();
      let list;
      try {
        list = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const item of list) {
        const abs = path.join(current, item.name);
        if (item.isDirectory()) stack.push(abs);
        else count += 1;
      }
    }
    return count;
  }

  function entrySummary(entry) {
    const roots = entryResourceRoots(entry);
    const root = roots.length === 1 ? roots[0] : null;
    const relRoot = root && getStrmRoot() ? path.relative(getStrmRoot(), root) : '';
    let seasons = [];
    if (root) {
      const counts = new Map();
      for (const p of entry.strmPaths || []) {
        const rel = path.relative(root, path.resolve(p)).split(path.sep)[0];
        const n = parseSeasonNumber(rel);
        if (n !== null) counts.set(n, (counts.get(n) || 0) + 1);
      }
      seasons = listSeasonDirs(root).map((s) => ({ season: s.season, name: s.name, strmCount: counts.get(s.season) || 0 }));
    }
    return {
      key: entry.key,
      title: entry.title,
      year: entry.year,
      type: entry.type,
      sourceName: entry.sourceName || '',
      sourceApiBase: entry.sourceApiBase || '',
      vodId: entry.vodId || '',
      resourceRoot: relRoot,
      resourceRootAbs: root || '',
      seasons,
      strmCount: Array.isArray(entry.strmPaths) ? entry.strmPaths.length : 0,
      urlCount: Array.isArray(entry.lastKnownUrls) ? entry.lastKnownUrls.length : 0,
      strmPaths: Array.isArray(entry.strmPaths) ? entry.strmPaths : [],
      lastSyncedAt: entry.lastSyncedAt || '',
      consecutiveFailures: Number(entry.consecutiveFailures) || 0,
      warnings: Array.isArray(entry.warnings) ? entry.warnings : [],
    };
  }

  function allEntries() {
    const index = readIndex();
    const entries = index && index.entries && typeof index.entries === 'object' ? index.entries : {};
    return Object.entries(entries).map(([key, e]) => ({ key, ...e }));
  }

  /** 按标题/年份/类型查找索引条目 */
  function matchEntries({ key, sourceApiBase, vodId, title, year, type }) {
    const entries = allEntries();
    if (key) return entries.filter((e) => e.key === key);
    if (sourceApiBase && vodId) {
      const k = indexStore.entryKey(sourceApiBase, vodId);
      return entries.filter((e) => e.key === k);
    }
    const nq = normalizeTitle(title);
    return entries.filter((e) => {
      if (type && e.type && e.type !== type) return false;
      if (year && e.year && String(e.year) !== String(year)) return false;
      if (!nq) return false;
      const nt = normalizeTitle(e.title);
      return nt === nq || nt.includes(nq) || nq.includes(nt);
    });
  }

  function removeEmptyParents(filePath, root) {
    const dirs = [];
    let dir = path.dirname(filePath);
    const rootResolved = path.resolve(root);
    while (isInside(rootResolved, dir) && path.resolve(dir) !== rootResolved) {
      try {
        if (fs.readdirSync(dir).length > 0) break;
        fs.rmdirSync(dir);
        dirs.push(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
    return dirs;
  }

  /** 校验待删除目录：必须在 strmRoot 内且不是 strmRoot 本身 */
  function assertDeletableDir(dir) {
    const root = getStrmRoot();
    if (!root) throw new Error('STRM 根目录未配置');
    const abs = path.resolve(dir);
    if (!isInside(root, abs) || abs === path.resolve(root)) {
      throw new Error(`拒绝删除目录（不在 STRM 根目录内或为根目录）: ${abs}`);
    }
    return abs;
  }

  function removeIndexEntriesByDirs(index, dirs) {
    const removedKeys = [];
    const prunedKeys = [];
    if (!index || !index.entries) return { removedKeys, prunedKeys };
    for (const [key, entry] of Object.entries(index.entries)) {
      const paths = Array.isArray(entry.strmPaths) ? entry.strmPaths : [];
      const urls = Array.isArray(entry.lastKnownUrls) ? entry.lastKnownUrls : [];
      const keep = [];
      paths.forEach((p, i) => {
        const abs = path.resolve(String(p));
        const hit = dirs.some((dir) => isInside(dir, abs));
        if (!hit) keep.push(i);
      });
      if (keep.length === 0) {
        delete index.entries[key];
        removedKeys.push(key);
      } else if (keep.length !== paths.length) {
        entry.strmPaths = keep.map((i) => paths[i]);
        entry.lastKnownUrls = keep.filter((i) => i < urls.length).map((i) => urls[i]);
        prunedKeys.push(key);
      }
    }
    return { removedKeys, prunedKeys };
  }

  async function refreshMedia(dirList) {
    const cfg = readConfig();
    const fnv = cfg.fnv && typeof cfg.fnv === 'object' ? cfg.fnv : {};
    if (fnv.enabled === false) return { ok: false, skipped: true, reason: '飞牛影视自动刷新未启用' };
    if (!fnv.username || !fnv.password || !fnv.secretString || !fnv.apiKey) {
      return { ok: false, skipped: true, reason: '缺少飞牛影视账号/密钥配置' };
    }
    const client = new FnvClient({ ...fnv, logger: log });
    if (!client.configured) return { ok: false, skipped: true, reason: '飞牛影视配置不完整' };
    const list = await client.listLibraries();
    if (!list.ok) return { ok: false, error: list.error || '获取媒体库列表失败' };
    const root = getStrmRoot();
    const related = (lib) => {
      const ps = Array.isArray(lib.paths) ? lib.paths : [];
      return ps.some((p) => root && (isInside(p, root) || isInside(root, p) || path.resolve(p) === path.resolve(root)));
    };
    let targets = list.libraries.filter(related);
    const wanted = str(fnv.libraryName);
    if (wanted) {
      const byName = list.libraries.filter((l) => l.name === wanted);
      if (byName.length) targets = byName;
    }
    if (!targets.length) return { ok: false, error: '未找到包含 STRM 根目录的飞牛影视媒体库' };
    const results = [];
    for (const lib of targets) {
      const r = await client.refreshLibrary(lib.guid, dirList);
      results.push({ name: lib.name, guid: lib.guid, ok: Boolean(r.ok), error: r.error || '' });
    }
    return { ok: results.every((r) => r.ok), libraries: results, mode: 'api' };
  }

  async function searchSource(source, query) {
    const url = cms.searchUrl(source.url, query);
    const res = await cms.fetchJson(url, { timeoutMs: 10000, retries: 1 });
    let data;
    try {
      data = JSON.parse(res.text);
    } catch {
      return { ok: false, source, error: '源站返回非 JSON' };
    }
    const list = cms.extractVodList(data);
    if (list === null) return { ok: false, source, error: '源站响应缺少 list' };
    return {
      ok: true,
      source,
      list: list.slice(0, 8).map((v) => ({
        vodId: String(v.vod_id || v.vodId || ''),
        name: str(v.vod_name || v.vodName || ''),
        year: str(v.vod_year || v.vodYear || ''),
        typeName: str(v.type_name || v.typeName || ''),
        remarks: str(v.vod_remarks || v.vodRemarks || ''),
        pic: str(v.vod_pic || v.vodPic || ''),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // 工具实现
  // ---------------------------------------------------------------------------

  const tools = [
    {
      name: 'search_videos',
      description: '在 LibreTV 配置的采集站（Apple CMS）中搜索影视资源。返回可用的源、vodId、片名、年份等信息，供后续加入媒体库。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，如片名' },
          limit: { type: 'integer', minimum: 1, maximum: 30, description: '返回结果数量上限，默认 10' },
          sources: { type: 'array', items: { type: 'string' }, description: '可选：限定源名称/URL 关键字' },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_video_detail',
      description: '获取某条影视资源的详情与剧集/线路信息（只读）。',
      inputSchema: {
        type: 'object',
        properties: {
          sourceApiBase: { type: 'string', description: '采集站 API 地址（search_videos 返回的 sourceApiBase）' },
          vodId: { type: 'string', description: '资源 ID（search_videos 返回的 vodId）' },
        },
        required: ['sourceApiBase', 'vodId'],
      },
    },
    {
      name: 'add_to_library',
      description: '把影视资源加入飞牛影视库：后台生成 STRM 文件并刷新媒体库。type 可选 movie/tv/auto（默认 auto）。',
      inputSchema: {
        type: 'object',
        properties: {
          sourceApiBase: { type: 'string' },
          vodId: { type: 'string' },
          name: { type: 'string', description: '可选：片名（缺省从源站详情获取）' },
          year: { type: 'string', description: '可选：年份' },
          type: { type: 'string', enum: ['movie', 'tv', 'auto'], description: '默认 auto' },
          wait: { type: 'boolean', description: '是否等待生成完成，默认 true' },
          timeoutSeconds: { type: 'integer', minimum: 5, maximum: 300, description: '等待超时，默认 90' },
        },
        required: ['sourceApiBase', 'vodId'],
      },
    },
    {
      name: 'list_library',
      description: '列出当前已加入飞牛影视库的条目（来自 STRM 索引）。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '可选：按片名过滤' },
          type: { type: 'string', enum: ['movie', 'tv'], description: '可选：类型过滤' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: '默认 50' },
        },
      },
    },
    {
      name: 'remove_from_library',
      description: '从影视库删除资源：默认递归删除整个资源目录（如 strmdata/庆余年 (2019)）；传 season 时只删除该季文件夹（如 Season 01），保留其它季。同时移除相关索引并刷新飞牛影视。危险操作。',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '索引 key（list_library 返回），最精确' },
          title: { type: 'string', description: '片名（可模糊；匹配到多个资源目录时需 all=true）' },
          year: { type: 'string' },
          type: { type: 'string', enum: ['movie', 'tv'] },
          sourceApiBase: { type: 'string' },
          vodId: { type: 'string' },
          season: { type: 'integer', minimum: 1, description: '可选：只删除该季的整个文件夹（1=Season 01），保留其它季；不传则删除整个资源目录' },
          all: { type: 'boolean', description: '片名匹配到多个资源目录时是否全部删除，默认 false' },
          dryRun: { type: 'boolean', description: '只返回将删除的目录/文件数，不实际删除，默认 false' },
          refreshMedia: { type: 'boolean', description: '是否刷新飞牛影视，默认 true' },
        },
      },
    },
    {
      name: 'sync_library',
      description: '触发 STRM 增量同步（6 小时定时任务的手动版：检查 URL 变化、清理失效条目、孤儿清理）。',
      inputSchema: {
        type: 'object',
        properties: {
          wait: { type: 'boolean', description: '是否等待完成，默认 true' },
          timeoutSeconds: { type: 'integer', minimum: 5, maximum: 300, description: '默认 120' },
        },
      },
    },
    {
      name: 'cleanup_orphans',
      description: '执行快扫清理：删除索引中不存在的孤儿 STRM 文件与空目录。',
      inputSchema: {
        type: 'object',
        properties: {
          wait: { type: 'boolean', description: '是否等待完成，默认 true' },
          timeoutSeconds: { type: 'integer', minimum: 5, maximum: 300, description: '默认 60' },
        },
      },
    },
    {
      name: 'get_engine_status',
      description: '查看 STRM 引擎状态、索引统计、最近同步结果、STRM 根目录等。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'refresh_media_library',
      description: '手动触发飞牛影视媒体库扫描（可指定目录列表）。',
      inputSchema: {
        type: 'object',
        properties: {
          dirList: { type: 'array', items: { type: 'string' }, description: '可选：要扫描的绝对目录；缺省为全库' },
        },
      },
    },
    {
      name: 'list_sources',
      description: '列出当前 LibreTV 配置的采集站源。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_strm_content',
      description: '读取某个已入库条目对应的 STRM 源地址（用于排查播放问题）。',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          title: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: '默认 5' },
        },
      },
    },
  ];

  async function toolSearchVideos(args) {
    const query = str(args.query);
    if (!query) throw new Error('query 不能为空');
    const limit = clampInt(args.limit, 1, 30, 10);
    let sources = getSources();
    if (Array.isArray(args.sources) && args.sources.length) {
      const wanted = args.sources.map((s) => String(s).toLowerCase());
      sources = sources.filter((s) => wanted.some((w) => s.name.toLowerCase().includes(w) || s.url.toLowerCase().includes(w)));
      if (!sources.length) throw new Error('没有匹配的源');
    }
    const outcomes = await Promise.all(
      sources.map(async (source) => {
        try {
          return await searchSource(source, query);
        } catch (err) {
          return { ok: false, source, error: (err && err.message) || '请求失败' };
        }
      })
    );
    const seen = new Set();
    const results = [];
    const failures = [];
    for (const outcome of outcomes) {
      if (!outcome.ok) {
        failures.push({ source: outcome.source.name, error: outcome.error });
        continue;
      }
      for (const item of outcome.list) {
        const dedupe = `${normalizeTitle(item.name)}|${item.year}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        results.push({
          ...item,
          sourceName: outcome.source.name,
          sourceApiBase: outcome.source.url,
        });
        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
    }
    const exact = normalizeTitle(query);
    results.sort((a, b) => {
      const ea = normalizeTitle(a.name) === exact ? 0 : 1;
      const eb = normalizeTitle(b.name) === exact ? 0 : 1;
      return ea - eb;
    });
    return { query, count: results.length, results, failures };
  }

  async function toolGetVideoDetail(args) {
    const sourceApiBase = str(args.sourceApiBase);
    const vodId = str(args.vodId);
    const detail = await cms.fetchDetail({ sourceApiBase, vodId, timeoutMs: 15000, retries: 1 });
    if (!detail.ok) throw new Error(detail.error || '获取详情失败');
    const chosen = detail.chosenLine;
    const episodes = chosen && Array.isArray(chosen.episodes) ? chosen.episodes : [];
    return {
      title: detail.vod.title,
      year: detail.vod.year,
      typeName: detail.vod.typeName,
      remarks: detail.vod.remarks,
      suggestedType: episodes.length > 1 ? 'tv' : 'movie',
      episodeCount: episodes.length,
      lines: (detail.lines || []).map((l, i) => ({
        index: i,
        name: l.name || '',
        count: Array.isArray(l.episodes) ? l.episodes.length : 0,
        hasM3u8: Boolean(l.episodes && l.episodes.some((e) => cms.isM3u8Url(e.url))),
      })),
      chosenLineIndex: chosen ? chosen.index : -1,
      chosenLineName: chosen ? chosen.name : '',
      episodes: episodes.slice(0, 20).map((e) => ({ name: e.name, url: e.url })),
      episodePreviewCount: Math.min(20, episodes.length),
      warnings: detail.warnings || [],
    };
  }

  async function toolAddToLibrary(args) {
    const sourceApiBase = str(args.sourceApiBase);
    const vodId = str(args.vodId);
    if (!/^https?:\/\//i.test(sourceApiBase)) throw new Error('sourceApiBase 必须是 http(s) 地址');
    if (!vodId) throw new Error('vodId 不能为空');
    const detail = await cms.fetchDetail({ sourceApiBase, vodId, timeoutMs: 20000, retries: 1 });
    if (!detail.ok) throw new Error(detail.error || '获取详情失败');
    const requested = str(args.type) || 'auto';
    const episodeCount = detail.chosenLine && Array.isArray(detail.chosenLine.episodes) ? detail.chosenLine.episodes.length : 0;
    const type = requested === 'movie' || requested === 'tv' ? requested : episodeCount > 1 ? 'tv' : 'movie';
    const matchedSource = getSources().find((s) => s.url === sourceApiBase);
    const payload = {
      sourceApiBase,
      sourceName: matchedSource ? matchedSource.name : '',
      sourceDetailBase: matchedSource && matchedSource.detail ? matchedSource.detail : '',
      vodId,
      vodName: str(args.name) || detail.vod.title,
      vodYear: str(args.year) || detail.vod.year || '',
      type,
    };
    // 若调用方给了 name，sourceName 用源站名匹配不到；保持空由引擎记录
    const job = enqueueJob('add', payload);
    const wait = args.wait !== false;
    if (!wait) return { jobId: job.id, status: 'queued', type, title: payload.vodName, episodeCount };
    const timeoutMs = clampInt(args.timeoutSeconds, 5, 300, 90) * 1000;
    const entry = await waitFor(() => {
      const found = allEntries().find(
        (e) => indexStore.entryKey(sourceApiBase, vodId) === e.key
      );
      return found || null;
    }, timeoutMs);
    if (!entry) {
      return {
        jobId: job.id,
        status: 'processing',
        type,
        title: payload.vodName,
        episodeCount,
        hint: '任务仍在后台处理，稍后用 list_library 查看',
      };
    }
    return {
      jobId: job.id,
      status: 'generated',
      type: entry.type,
      title: entry.title,
      year: entry.year,
      strmCount: (entry.strmPaths || []).length,
      strmPaths: entry.strmPaths || [],
      entryKey: entry.key,
    };
  }

  function toolListLibrary(args) {
    const query = str(args.query);
    const type = str(args.type);
    const limit = clampInt(args.limit, 1, 200, 50);
    let entries = allEntries();
    if (type) entries = entries.filter((e) => e.type === type);
    if (query) {
      const nq = normalizeTitle(query);
      entries = entries.filter((e) => {
        const nt = normalizeTitle(e.title);
        return nt.includes(nq) || nq.includes(nt);
      });
    }
    entries.sort((a, b) => String(b.lastSyncedAt || '').localeCompare(String(a.lastSyncedAt || '')));
    return {
      total: entries.length,
      count: Math.min(entries.length, limit),
      entries: entries.slice(0, limit).map(entrySummary),
    };
  }

  async function toolRemoveFromLibrary(args) {
    const seasonRaw = args.season;
    const seasonNum =
      seasonRaw === undefined || seasonRaw === null || seasonRaw === ''
        ? null
        : Number(seasonRaw);
    if (seasonNum !== null && (!Number.isInteger(seasonNum) || seasonNum < 1)) {
      throw new Error('season 必须是正整数（1 表示 Season 01）');
    }
    const dryRun = args.dryRun === true;
    const all = args.all === true;
    const titleQuery = str(args.title);

    let matches = matchEntries({
      key: str(args.key),
      sourceApiBase: str(args.sourceApiBase),
      vodId: str(args.vodId),
      title: titleQuery,
      year: str(args.year),
      type: str(args.type),
    });
    if (!matches.length) throw new Error('没有找到匹配的条目');
    // 标题优先精确匹配；没有精确匹配时才使用模糊结果，避免「庆余年」误删「庆余年2」
    if (titleQuery) {
      const exact = matches.filter((e) => normalizeTitle(e.title) === normalizeTitle(titleQuery));
      if (exact.length) matches = exact;
    }

    const rootEntries = new Map();
    for (const entry of matches) {
      for (const root of entryResourceRoots(entry)) {
        if (!rootEntries.has(root)) rootEntries.set(root, []);
        rootEntries.get(root).push(entry);
      }
    }
    if (!rootEntries.size) throw new Error('索引条目找不到对应的 STRM 资源目录（可能文件已被移动/删除）');

    const strmRoot = getStrmRoot();
    const rel = (p) => path.relative(strmRoot, p);
    const rootCandidates = () =>
      [...rootEntries.keys()].map((root) => ({
        resourceRoot: rel(root),
        entries: rootEntries.get(root).map((e) => e.title),
        seasons: listSeasonDirs(root).map((s) => ({ season: s.season, name: s.name })),
      }));

    let dirs = [];
    let mode = '';

    if (seasonNum !== null) {
      if (rootEntries.size > 1) {
        return {
          error: '匹配到多个资源目录，无法确定要删除哪一季；请用 key 精确指定单个条目，或先 list_library 确认',
          candidates: rootCandidates(),
        };
      }
      const [root] = rootEntries.keys();
      const seasons = listSeasonDirs(root);
      const hit = seasons.filter((s) => s.season === seasonNum);
      if (!hit.length) {
        throw new Error(
          `未找到 Season ${seasonNum}（可用季：${seasons.map((s) => s.season).join(', ') || '无 Season 目录'}）`
        );
      }
      dirs = hit.map((s) => s.dir);
      mode = 'season';
    } else {
      if (rootEntries.size > 1 && !all) {
        return {
          error: '匹配到多个资源目录（可能多季分别成目录，或模糊匹配到多部剧）；确认全部删除请传 all=true，或指定 key 精确删除',
          candidates: rootCandidates(),
        };
      }
      dirs = [...rootEntries.keys()];
      mode = 'resource';
    }

    // 安全校验：每个目录都必须在 STRM 根目录内、且不能是根目录自身
    const uniqueDirs = [...new Set(dirs.map((d) => path.resolve(d)))];
    for (const dir of uniqueDirs) assertDeletableDir(dir);

    const plan = uniqueDirs.map((dir) => ({
      dir,
      resourceRoot: rel(dir),
      files: countFilesRecursive(dir),
    }));
    const totalFiles = plan.reduce((sum, item) => sum + item.files, 0);

    if (dryRun) {
      return {
        dryRun: true,
        mode,
        dirs: plan,
        totalFiles,
        matchedEntries: matches.map(entrySummary),
      };
    }

    const deletedDirs = [];
    const failed = [];
    for (const item of plan) {
      try {
        fs.rmSync(item.dir, { recursive: true, force: true });
        deletedDirs.push(item.dir);
        log.info(`已删除资源目录: ${item.dir}（${item.files} 个文件）`);
      } catch (err) {
        failed.push({ dir: item.dir, error: (err && err.message) || '删除失败' });
      }
    }

    // 同步清理索引：删除目录内所有条目的路径；条目若还有其它季则保留并裁剪
    const index = readIndex();
    const entryTitles = new Map(matches.map((e) => [e.key, e.title]));
    const { removedKeys, prunedKeys } = removeIndexEntriesByDirs(index, deletedDirs);
    saveIndex(index);

    let refresh = { ok: false, skipped: true, reason: '未请求刷新' };
    if (args.refreshMedia !== false && deletedDirs.length) {
      refresh = await refreshMedia(deletedDirs).catch((err) => ({
        ok: false,
        error: (err && err.message) || '刷新失败',
      }));
    }

    return {
      mode,
      deletedDirs,
      deletedFiles: totalFiles,
      failed,
      removedEntries: removedKeys.map((key) => ({ key, title: entryTitles.get(key) || '' })),
      prunedEntries: prunedKeys.map((key) => ({ key, title: entryTitles.get(key) || '' })),
      keptSeasons:
        mode === 'season' && rootEntries.size === 1
          ? listSeasonDirs([...rootEntries.keys()][0]).map((s) => ({ season: s.season, name: s.name }))
          : [],
      refresh,
    };
  }

  async function waitForJob(action, timeoutMs) {
    const started = Date.now();
    const result = await waitFor(() => {
      const state = readState();
      const last = state && state.engine && state.engine.lastResult;
      if (last && last.action === action && Date.parse(last.at || '') >= started - 5000) return last;
      return null;
    }, timeoutMs);
    return result;
  }

  async function toolSyncLibrary(args) {
    const job = findPendingJob('sync') || enqueueJob('sync', {});
    const wait = args.wait !== false;
    if (!wait) return { jobId: job.id, status: 'queued' };
    const timeoutMs = clampInt(args.timeoutSeconds, 5, 300, 120) * 1000;
    const result = await waitForJob('sync', timeoutMs);
    return result ? { jobId: job.id, status: 'done', result: result.result || result } : { jobId: job.id, status: 'processing' };
  }

  async function toolCleanupOrphans(args) {
    const job = enqueueJob('cleanup', {});
    const wait = args.wait !== false;
    if (!wait) return { jobId: job.id, status: 'queued' };
    const timeoutMs = clampInt(args.timeoutSeconds, 5, 300, 60) * 1000;
    const result = await waitForJob('cleanup', timeoutMs);
    return result ? { jobId: job.id, status: 'done', result: result.result || result } : { jobId: job.id, status: 'processing' };
  }

  function toolEngineStatus() {
    const cfg = readConfig();
    const state = readState();
    const index = readIndex();
    const entries = index && index.entries ? Object.values(index.entries) : [];
    const types = {};
    for (const e of entries) types[e.type || 'unknown'] = (types[e.type || 'unknown'] || 0) + 1;
    return {
      version,
      strmRoot: cfg.strmRoot || '',
      indexCount: entries.length,
      indexTypes: types,
      engine: state.engine || {},
      fnv: state.fnv || {},
      mediaProxy: cfg.mediaProxy || { enabled: true, port: 8091 },
      mcp: { enabled: getMcpConfig().enabled, port: getMcpConfig().port },
      syncIntervalHours: cfg.syncIntervalHours || 6,
    };
  }

  async function toolRefreshMedia(args) {
    const dirList = Array.isArray(args.dirList) ? args.dirList.map((x) => str(x)).filter(Boolean) : undefined;
    return refreshMedia(dirList);
  }

  function toolListSources() {
    return { sources: getSources().map(({ key, name, url }) => ({ key, name, url })) };
  }

  function toolGetStrmContent(args) {
    const limit = clampInt(args.limit, 1, 50, 5);
    const matches = matchEntries({ key: str(args.key), title: str(args.title) });
    if (!matches.length) throw new Error('没有找到匹配的条目');
    return {
      matches: matches.slice(0, 10).map((e) => ({
        key: e.key,
        title: e.title,
        year: e.year,
        type: e.type,
        urls: (e.lastKnownUrls || []).slice(0, limit),
        strmPaths: (e.strmPaths || []).slice(0, limit),
      })),
    };
  }

  const toolHandlers = {
    search_videos: toolSearchVideos,
    get_video_detail: toolGetVideoDetail,
    add_to_library: toolAddToLibrary,
    list_library: toolListLibrary,
    remove_from_library: toolRemoveFromLibrary,
    sync_library: toolSyncLibrary,
    cleanup_orphans: toolCleanupOrphans,
    get_engine_status: toolEngineStatus,
    refresh_media_library: toolRefreshMedia,
    list_sources: toolListSources,
    get_strm_content: toolGetStrmContent,
  };

  // ---------------------------------------------------------------------------
  // JSON-RPC / MCP
  // ---------------------------------------------------------------------------

  function rpcOk(id, result) {
    return { jsonrpc: '2.0', id, result };
  }
  function rpcError(id, code, message, data) {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    return { jsonrpc: '2.0', id, error };
  }

  function resourcesList() {
    return {
      resources: [
        { uri: 'libretv://library', name: 'STRM 影视库索引', mimeType: 'application/json', description: '当前已加入媒体库的条目' },
        { uri: 'libretv://status', name: '引擎状态', mimeType: 'application/json', description: '同步/队列/飞牛影视状态' },
        { uri: 'libretv://sources', name: '采集源列表', mimeType: 'application/json', description: 'LibreTV 配置的 CMS 源' },
      ],
    };
  }

  async function resourcesRead(uri) {
    if (uri === 'libretv://library') return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(toolListLibrary({ limit: 200 }), null, 2) }] };
    if (uri === 'libretv://status') return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(toolEngineStatus(), null, 2) }] };
    if (uri === 'libretv://sources') return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(toolListSources(), null, 2) }] };
    throw new Error(`未知资源: ${uri}`);
  }

  async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return rpcError(null, -32600, 'Invalid Request');
    }
    const id = msg.id;
    const method = str(msg.method);
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    if (!method) return id === undefined ? null : rpcError(id, -32600, '缺少 method');
    // 通知：不返回响应
    if (id === undefined) return null;

    try {
      switch (method) {
        case 'initialize': {
          const requested = str(params.protocolVersion);
          const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
          return rpcOk(id, {
            protocolVersion,
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
            },
            serverInfo: { name: 'libretv-fnos', version },
            instructions:
              'LibreTV-fnOS 媒体库管理 MCP。可搜索采集站资源、加入飞牛影视库（生成 STRM）、列出/删除库条目、触发同步与媒体库扫描。删除类操作需谨慎。',
          });
        }
        case 'ping':
          return rpcOk(id, {});
        case 'tools/list':
          return rpcOk(id, { tools });
        case 'tools/call': {
          const name = str(params.name);
          const handler = toolHandlers[name];
          if (!handler) return rpcError(id, -32602, `未知工具: ${name}`);
          const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
          log.info(`调用工具 ${name}`);
          try {
            const data = await handler(args);
            return rpcOk(id, {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
              structuredContent: data,
              isError: false,
            });
          } catch (err) {
            const message = (err && err.message) || String(err);
            log.warn(`工具 ${name} 失败: ${message}`);
            return rpcOk(id, {
              content: [{ type: 'text', text: `错误: ${message}` }],
              isError: true,
            });
          }
        }
        case 'resources/list':
          return rpcOk(id, resourcesList());
        case 'resources/templates/list':
          return rpcOk(id, { resourceTemplates: [] });
        case 'resources/read': {
          const uri = str(params.uri);
          return rpcOk(id, await resourcesRead(uri));
        }
        case 'prompts/list':
          return rpcOk(id, { prompts: [] });
        default:
          return rpcError(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      return rpcError(id, -32603, (err && err.message) || 'Internal error');
    }
  }

  function jsonResponse(res, status, body, extraHeaders = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      ...extraHeaders,
    });
    res.end(text);
  }

  function authToken(req) {
    const auth = String(req.headers.authorization || '');
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
    const headerToken = req.headers['x-mcp-token'];
    if (typeof headerToken === 'string') return headerToken.trim();
    return '';
  }

  function corsHeaders() {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-MCP-Token, MCP-Protocol-Version, Mcp-Session-Id',
    };
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error('请求体过大'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const parsed = (() => {
      try {
        return new URL(req.url || '/', 'http://127.0.0.1');
      } catch {
        return null;
      }
    })();
    const pathname = parsed ? parsed.pathname : '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    if (pathname === '/health') {
      jsonResponse(res, 200, { ok: true, name: 'libretv-fnos-mcp', version, tools: tools.length });
      return;
    }
    if (pathname !== '/mcp' && pathname !== '/') {
      jsonResponse(res, 404, { error: 'not found' }, corsHeaders());
      return;
    }

    const mcpCfg = getMcpConfig();
    if (!mcpCfg.enabled) {
      jsonResponse(res, 403, rpcError(null, -32000, 'MCP 服务已在设置中禁用'), corsHeaders());
      return;
    }
    if (!safeEqual(authToken(req), mcpCfg.token)) {
      jsonResponse(res, 401, rpcError(null, -32001, '未授权：请配置 Authorization: Bearer <MCP token>'), {
        ...corsHeaders(),
        'WWW-Authenticate': 'Bearer',
      });
      return;
    }

    if (req.method === 'GET') {
      // Streamable HTTP 的 GET(SSE) 未实现；按规范返回 405 让客户端使用 POST
      res.writeHead(405, { Allow: 'POST', ...corsHeaders() });
      res.end();
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(200, corsHeaders());
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, GET, DELETE, OPTIONS', ...corsHeaders() });
      res.end();
      return;
    }

    let text;
    try {
      text = await readBody(req);
    } catch (err) {
      jsonResponse(res, 413, rpcError(null, -32000, (err && err.message) || '读取请求失败'), corsHeaders());
      return;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      jsonResponse(res, 400, rpcError(null, -32700, 'Parse error'), corsHeaders());
      return;
    }
    const isBatch = Array.isArray(payload);
    const messages = isBatch ? payload : [payload];
    // 纯通知（无 id）返回 202 无正文
    if (messages.every((m) => !m || m.id === undefined)) {
      for (const m of messages) {
        if (m && m.method === 'notifications/initialized') log.info('客户端已初始化');
      }
      res.writeHead(202, corsHeaders());
      res.end();
      return;
    }
    const responses = [];
    for (const m of messages) {
      const r = await handleMessage(m);
      if (r !== null && r !== undefined) responses.push(r);
    }
    jsonResponse(res, 200, isBatch ? responses : responses[0] || {}, {
      ...corsHeaders(),
      'MCP-Protocol-Version': PROTOCOL_VERSIONS[0],
    });
  });

  server.on('error', (err) => log.error(`MCP 服务监听失败: ${err && err.message}`));

  let stopped = false;
  return {
    start() {
      return new Promise((resolve) => {
        ensureMcpConfig();
        server.listen(port, '0.0.0.0', () => {
          log.info(`MCP 已启动: http://0.0.0.0:${port}/mcp（工具 ${tools.length} 个）`);
          resolve(true);
        });
        setTimeout(() => resolve(false), 3000).unref();
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        server.close();
      } catch {
        /* ignore */
      }
    },
    _internal: { tools, toolHandlers, ensureMcpConfig, getMcpConfig, handleMessage, authToken },
  };
}

module.exports = { createMcpServer, DEFAULT_PORT, VERSION };
