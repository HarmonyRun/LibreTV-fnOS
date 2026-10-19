'use strict';

/**
 * STRM 自动化引擎核心（契约第 4/5/6/7 节）。
 *
 * 数据流：
 *   config.json（只读） + queue/*.json（Next 写）
 *        ↓
 *   拉取 CMS 详情 → 按命名规范生成 .strm → 原子写 strm-index.json
 *        ↓
 *   变更目录去重后调用飞牛影视刷新；失败降级 utimes + state.fnv.lastMode="fallback"
 *
 * 与 Web 进程共享 var/ 目录，通过文件通信；state.json / strm-index.json 由本引擎独占写。
 */

const fs = require('fs');
const path = require('path');

const naming = require('./naming');
const cms = require('./cms');
const indexStore = require('./index-store');
const { atomicWriteFile, atomicWriteJson, ensureDir, isInside, removeFileQuiet } = require('./fs-util');
const { createLogger } = require('./logger');
const { FnvClient, matchLibraries } = require('./fnv-client');
const { resolveFnvSecrets } = require('./fnv-secrets');

const DEFAULT_SYNC_INTERVAL_HOURS = 6;
const MIN_SYNC_INTERVAL_HOURS = 1;
const MAX_SYNC_INTERVAL_HOURS = 168;
const QUEUE_POLL_MS = 2000;
const STATE_HEARTBEAT_MS = 30000;
const DEFAULT_SYNC_DELAY_MS = 200;
const FAILED_KEEP = 50;
const DELETE_AFTER_FAILURES = 3;
const DEFAULT_FNV_BASE_URL = 'http://127.0.0.1:5666';
const DEFAULT_FNV_APP_NAME = 'trimemedia-web';

function toIso(ms) {
  return new Date(ms).toISOString();
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function emptySyncResult() {
  return { checked: 0, updated: 0, deleted: 0, orphansDeleted: 0, errors: 0 };
}

/** state.engine.lastResult 只保留概要，避免把全部 URL 写进 state.json */
function summarizeResult(action, result) {
  if (!result || typeof result !== 'object') return result === undefined ? null : result;
  if (action === 'sync') {
    const out = {};
    for (const key of ['checked', 'updated', 'deleted', 'orphansDeleted', 'errors']) {
      if (Number.isFinite(result[key])) out[key] = result[key];
    }
    if (result.skipped) out.skipped = true;
    return out;
  }
  if (action === 'add' || action === 'refresh') {
    return {
      ok: result.ok !== false,
      key: result.key || '',
      title: result.title || '',
      type: result.type || '',
      year: result.year || '',
      files: Array.isArray(result.strmPaths) ? result.strmPaths.length : 0,
      urls: Array.isArray(result.lastKnownUrls) ? result.lastKnownUrls.length : 0,
      removed: result.removed || 0,
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
    };
  }
  if (action === 'cleanup') {
    return { orphansDeleted: result.orphansDeleted || 0, dirsRemoved: result.dirsRemoved || 0 };
  }
  return { ok: result.ok !== false };
}

function countJsonFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  // 注意：这里不能 unref——同步循环 await 它时若没有其它 ref 句柄，
  // CLI 进程会在等待期间提前退出（表现为 sync 只跑一半）。
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSourceApiBase(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!/^https?:\/\//i.test(raw)) return '';
  return raw.replace(/\/+$/, '');
}

function normalizeSyncIntervalHours(config) {
  let hours = Number(config && config.syncIntervalHours);
  if (!Number.isFinite(hours) || hours <= 0) hours = DEFAULT_SYNC_INTERVAL_HOURS;
  return Math.min(MAX_SYNC_INTERVAL_HOURS, Math.max(MIN_SYNC_INTERVAL_HOURS, hours));
}

function normalizeFnvConfig(raw) {
  const f = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const pick = (value) => (typeof value === 'string' ? value.trim() : '');
  const config = {
    enabled: f.enabled !== false,
    baseUrl:
      typeof f.baseUrl === 'string' && f.baseUrl.trim()
        ? f.baseUrl.trim().replace(/\/+$/, '')
        : DEFAULT_FNV_BASE_URL,
    appName: typeof f.appName === 'string' && f.appName.trim() ? f.appName.trim() : DEFAULT_FNV_APP_NAME,
    username: pick(f.username),
    password: typeof f.password === 'string' ? f.password : '',
    secretString: pick(f.secretString),
    apiKey: pick(f.apiKey),
    libraryName: pick(f.libraryName),
  };
  return config;
}

/** 递归收集 .strm 文件（不跟随符号链接，避免越界） */
function walkStrmFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.strm$/i.test(entry.name)) out.push(path.resolve(full));
    }
  };
  walk(root);
  return out;
}

/** 递归收集所有目录（不跟随符号链接） */
function walkAllDirs(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      out.push(path.resolve(full));
      walk(full);
    }
  };
  walk(root);
  return out;
}

/** 自底向上删除空目录；绝不删除 root 本身 */
function pruneEmptyDirs(root, startDir) {
  let removed = 0;
  let current = path.resolve(startDir);
  while (isInside(root, current)) {
    try {
      const entries = fs.readdirSync(current);
      if (entries.length > 0) break;
      fs.rmdirSync(current);
      removed += 1;
    } catch {
      break;
    }
    current = path.dirname(current);
  }
  return removed;
}

function sameUrlList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * 创建引擎实例（不启动定时器，便于单测 / CLI）。
 * @param {object} options
 * @param {string} options.dataDir 数据目录（必填）
 * @param {object} [options.logger] 外部 logger（{log,info,warn,error}）
 * @param {Function} [options.fetchImpl] 注入 fetch，默认全局 fetch
 * @param {Function} [options.now] 注入时钟，默认 Date.now
 * @param {number} [options.syncDelayMs] 同步条目间隔，默认 200ms
 */
function createEngine(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.cwd());
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  const syncDelayMs = Number.isFinite(options.syncDelayMs) && options.syncDelayMs >= 0 ? options.syncDelayMs : DEFAULT_SYNC_DELAY_MS;
  const fnvBundleDir =
    typeof options.fnvBundleDir === 'string' && options.fnvBundleDir.trim()
      ? options.fnvBundleDir.trim()
      : process.env.LIBRETV_FNV_BUNDLE_DIR || '';
  const logger = createLogger({ dataDir, sink: options.logger });

  const paths = {
    dataDir,
    config: path.join(dataDir, 'config.json'),
    queueDir: path.join(dataDir, 'queue'),
    processingDir: path.join(dataDir, 'queue', 'processing'),
    failedDir: path.join(dataDir, 'queue', 'failed'),
    indexPath: path.join(dataDir, 'strm-index.json'),
    statePath: path.join(dataDir, 'state.json'),
    setupMarker: path.join(dataDir, 'setup-needed'),
    logFile: logger.file,
  };

  ensureDir(dataDir);
  ensureDir(paths.queueDir);
  ensureDir(paths.processingDir);
  ensureDir(paths.failedDir);

  const state = {
    setupNeeded: true,
    engine: {
      pid: process.pid,
      startedAt: '',
      lastTickAt: '',
      lastSyncAt: '',
      lastSyncResult: emptySyncResult(),
      queuePending: 0,
      processingJob: '',
      lastResult: null,
    },
    fnv: {
      configured: false,
      lastOkAt: '',
      lastError: '',
      lastMode: 'disabled',
      endpoint: '',
      secretSource: '',
      matchedLibraries: [],
    },
    paths: {
      strmRoot: '',
      indexCount: 0,
      setupNeeded: true,
    },
  };

  let started = false;
  let stopped = false;
  let ticking = false;
  let syncing = false;
  let tickTimer = null;
  let nextSyncAt = 0;
  let syncIntervalMs = 0;
  let lastStateWriteAt = 0;
  let stateDirty = true;
  let configErrorLogged = false;
  let lastMkdirAttemptAt = 0;
  let lastMkdirRoot = '';
  let fnvClient = null;
  let fnvClientSignature = '';
  let resolvedFnvSecrets = null;
  let resolvedFnvSignature = '';
  const pendingRefreshDirs = new Set();

  // ---------------------------------------------------------------- 配置 ----
  function readConfig() {
    try {
      const raw = fs.readFileSync(paths.config, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('config.json 顶层不是对象');
      }
      configErrorLogged = false;
      return parsed;
    } catch (err) {
      if (err && err.code !== 'ENOENT' && !configErrorLogged) {
        configErrorLogged = true;
        logger.warn(`读取 config.json 失败，将按空配置继续: ${err.message}`);
      }
      return {};
    }
  }

  function resolveStrmRoot(config) {
    const raw = config && typeof config.strmRoot === 'string' ? config.strmRoot.trim() : '';
    if (!raw || !path.isAbsolute(raw)) return '';
    return path.resolve(raw);
  }

  function updateSetupMarker() {
    try {
      if (state.setupNeeded) {
        if (!fs.existsSync(paths.setupMarker)) {
          atomicWriteFile(paths.setupMarker, 'STRM_ROOT_NOT_CONFIGURED\n');
        }
      } else if (fs.existsSync(paths.setupMarker)) {
        fs.unlinkSync(paths.setupMarker);
      }
    } catch {
      /* best effort */
    }
  }

  /**
   * 校验/创建 STRM 根目录；未配置返回 ''，并标记 setupNeeded（不阻塞 Web）。
   * 已配置但不存在时按分钟节流尝试 mkdir。
   */
  function ensureStrmRoot(config) {
    const configuredRoot = resolveStrmRoot(config);
    let available = '';
    if (configuredRoot) {
      try {
        if (fs.statSync(configuredRoot).isDirectory()) available = configuredRoot;
      } catch {
        /* not exists */
      }
      if (!available) {
        const t = now();
        if (lastMkdirRoot !== configuredRoot || t - lastMkdirAttemptAt > 60000) {
          lastMkdirRoot = configuredRoot;
          lastMkdirAttemptAt = t;
          try {
            fs.mkdirSync(configuredRoot, { recursive: true });
            logger.info(`已创建 STRM 根目录 ${configuredRoot}`);
            available = configuredRoot;
          } catch (err) {
            logger.error(`创建 STRM 根目录失败 ${configuredRoot}: ${err.message}`);
          }
        }
        if (!available) {
          try {
            if (fs.statSync(configuredRoot).isDirectory()) available = configuredRoot;
          } catch {
            /* ignore */
          }
        }
      }
    }

    const setupNeeded = !available;
    if (state.setupNeeded !== setupNeeded) {
      state.setupNeeded = setupNeeded;
      state.paths.setupNeeded = setupNeeded;
      markStateDirty();
      if (setupNeeded) {
        logger.warn('尚未配置可用的 STRM 根目录，引擎仅轮询队列（state.setupNeeded=true）');
      } else {
        logger.info('STRM 根目录已就绪');
      }
    }
    state.paths.strmRoot = configuredRoot;
    updateSetupMarker();
    return available;
  }

  /**
   * 解析签名密钥（三级来源：config → 影视前端 bundle → 内置常量），按配置签名缓存；
   * 只记录来源，不记录密钥原文。
   */
  function getResolvedFnvSecrets(fnvConfig) {
    const signature = JSON.stringify({
      enabled: fnvConfig.enabled,
      username: fnvConfig.username,
      password: fnvConfig.password,
      secretString: fnvConfig.secretString,
      apiKey: fnvConfig.apiKey,
      bundleDir: fnvBundleDir,
    });
    if (resolvedFnvSecrets && resolvedFnvSignature === signature) return resolvedFnvSecrets;

    const resolved = resolveFnvSecrets({
      enabled: fnvConfig.enabled,
      username: fnvConfig.username,
      password: fnvConfig.password,
      secretString: fnvConfig.secretString,
      apiKey: fnvConfig.apiKey,
      bundleDir: fnvBundleDir,
    });
    state.fnv.secretSource = resolved.source || '';
    state.fnv.configured = resolved.configured;
    markStateDirty();
    if (resolved.configured) {
      logger.info(
        `飞牛影视签名密钥来源: ${resolved.source}（secret=${
          resolved.sources.secretString
        }, apiKey=${resolved.sources.apiKey}${resolved.bundleFiles.length > 0 ? `, bundle=${resolved.bundleFiles[0]}` : ''}）`
      );
    } else if (fnvConfig.enabled) {
      logger.warn('飞牛影视已启用但缺少媒体账号/密码，自动刷新未启用');
    }
    resolvedFnvSecrets = resolved;
    resolvedFnvSignature = signature;
    return resolved;
  }

  function updateFnvFlags(config) {
    const fnvConfig = normalizeFnvConfig(config && config.fnv);
    const resolved = getResolvedFnvSecrets(fnvConfig);
    const changed = state.fnv.configured !== resolved.configured;
    state.fnv.configured = resolved.configured;
    state.fnv.secretSource = resolved.source || '';
    if (!resolved.configured) {
      if (state.fnv.lastMode !== 'disabled') {
        state.fnv.lastMode = 'disabled';
        markStateDirty();
      }
    } else if (state.fnv.lastMode === 'disabled') {
      state.fnv.lastMode = 'idle';
      markStateDirty();
    }
    return { fnvConfig, resolved, changed };
  }

  // ------------------------------------------------------------ state/日志 ----
  function markStateDirty() {
    stateDirty = true;
  }

  function buildState() {
    return {
      setupNeeded: Boolean(state.setupNeeded),
      engine: { ...state.engine },
      fnv: { ...state.fnv, matchedLibraries: state.fnv.matchedLibraries.map((item) => ({ ...item })) },
      paths: { ...state.paths },
    };
  }

  function writeState(force = false) {
    const t = now();
    if (!force && !stateDirty && t - lastStateWriteAt < STATE_HEARTBEAT_MS) return false;
    try {
      atomicWriteJson(paths.statePath, buildState());
      lastStateWriteAt = t;
      stateDirty = false;
    } catch (err) {
      logger.error(`写 state.json 失败: ${err.message}`);
    }
    return true;
  }

  function refreshQueuePending() {
    const count = countJsonFiles(paths.queueDir);
    if (state.engine.queuePending !== count) {
      state.engine.queuePending = count;
      markStateDirty();
    }
    return count;
  }

  // ---------------------------------------------------------------- 索引 ----
  function loadIndexSafe() {
    let index;
    try {
      index = indexStore.loadIndex(dataDir);
    } catch (err) {
      logger.error(`读取索引失败，使用空索引: ${err.message}`);
      index = indexStore.createEmptyIndex();
    }
    state.paths.indexCount = Object.keys(index.entries).length;
    return index;
  }

  function saveIndexSafe(index) {
    try {
      indexStore.saveIndex(dataDir, index);
      state.paths.indexCount = Object.keys(index.entries).length;
      markStateDirty();
    } catch (err) {
      logger.error(`写 strm-index.json 失败: ${err.message}`);
      throw err;
    }
  }

  // ------------------------------------------------------------- STRM 规划 ----
  function selectEpisodes(detail, type) {
    const line = detail && detail.chosenLine;
    const episodes = line && Array.isArray(line.episodes) ? line.episodes : [];
    if (episodes.length === 0) return [];
    if (type === 'tv') {
      return episodes.map((ep) => ({
        url: ep.url,
        season: ep.season,
        episode: ep.episode,
        title: ep.title,
      }));
    }
    // 电影：即使线路里意外带多集，也只生成一个文件（取第一条）
    return [{ url: episodes[0].url, season: 1, episode: 1, title: episodes[0].title }];
  }

  function buildPlan({ root, type, title, year, episodes }) {
    const plan = [];
    const seen = new Set();
    for (const episode of episodes) {
      const relative =
        type === 'tv'
          ? naming.episodeRelativePath(title, year, episode.season, episode.episode)
          : naming.movieRelativePath(title, year);
      const absPath = path.resolve(root, relative);
      if (!isInside(root, absPath)) continue;
      if (seen.has(absPath)) continue;
      seen.add(absPath);
      plan.push({ absPath, url: episode.url, relative });
    }
    return plan;
  }

  function refreshDirOf(root, strmPath) {
    const dir = path.dirname(path.resolve(strmPath));
    const rel = path.relative(root, dir);
    const first = rel.split(path.sep)[0];
    if (!first || first === '..' || path.isAbsolute(first)) return root;
    return path.join(root, first);
  }

  function claimedPathsExcept(index, key) {
    const claimed = new Set();
    for (const [otherKey, entry] of Object.entries(index.entries || {})) {
      if (otherKey === key) continue;
      for (const p of entry.strmPaths || []) claimed.add(path.resolve(p));
    }
    return claimed;
  }

  /** 删除旧索引路径中已不再生成的 STRM（跳过其它条目仍引用的路径） */
  function removeStalePaths({ root, index, key, oldPaths, newPaths }) {
    const newSet = new Set(newPaths.map((p) => path.resolve(p)));
    const claimed = claimedPathsExcept(index, key);
    let removed = 0;
    for (const oldPath of oldPaths || []) {
      const absPath = path.resolve(oldPath);
      if (newSet.has(absPath) || claimed.has(absPath)) continue;
      if (!isInside(root, absPath)) continue;
      try {
        fs.unlinkSync(absPath);
        removed += 1;
        pruneEmptyDirs(root, path.dirname(absPath));
      } catch (err) {
        if (err && err.code !== 'ENOENT') logger.warn(`删除旧 STRM 失败 ${absPath}: ${err.message}`);
      }
    }
    return removed;
  }

  /** 删除某个索引条目的全部 STRM；返回 {removed, dirs} */
  function deleteEntryFiles(root, index, key, entry) {
    const claimed = claimedPathsExcept(index, key);
    const dirs = new Set();
    let removed = 0;
    for (const p of entry.strmPaths || []) {
      const absPath = path.resolve(p);
      if (claimed.has(absPath) || !isInside(root, absPath)) continue;
      dirs.add(refreshDirOf(root, absPath));
      try {
        fs.unlinkSync(absPath);
        removed += 1;
        pruneEmptyDirs(root, path.dirname(absPath));
      } catch (err) {
        if (err && err.code !== 'ENOENT') logger.warn(`删除 STRM 失败 ${absPath}: ${err.message}`);
      }
    }
    return { removed, dirs: [...dirs] };
  }

  // ------------------------------------------------------------ 飞牛刷新 ----
  function getFnvClient(fnvConfig, resolved) {
    const signature = JSON.stringify({
      ...fnvConfig,
      secretString: resolved.secretString,
      apiKey: resolved.apiKey,
    });
    if (fnvClient && fnvClientSignature === signature) return fnvClient;
    fnvClient = new FnvClient({
      enabled: fnvConfig.enabled,
      baseUrl: fnvConfig.baseUrl,
      appName: fnvConfig.appName,
      username: fnvConfig.username,
      password: fnvConfig.password,
      secretString: resolved.secretString,
      apiKey: resolved.apiKey,
      libraryName: fnvConfig.libraryName,
      fetchImpl,
      logger,
    });
    fnvClientSignature = signature;
    return fnvClient;
  }

  function fnvFallback(dirs, message) {
    state.fnv.lastError = message;
    state.fnv.lastMode = 'fallback';
    markStateDirty();
    logger.warn(`飞牛影视刷新失败，降级为 utimes 变更目录: ${message}`);
    const t = new Date(now());
    for (const dir of dirs) {
      try {
        fs.utimesSync(dir, t, t);
      } catch {
        /* best effort */
      }
    }
    return { ok: false, mode: 'fallback', error: message };
  }

  function queueRefreshDirs(dirs) {
    for (const dir of dirs || []) {
      if (typeof dir === 'string' && dir) pendingRefreshDirs.add(path.resolve(dir));
    }
  }

  function uniqueRefreshDirs(rawDirs) {
    const existing = [];
    const seen = new Set();
    for (const raw of rawDirs || []) {
      if (typeof raw !== 'string' || !raw) continue;
      const abs = path.resolve(raw);
      if (seen.has(abs)) continue;
      seen.add(abs);
      try {
        if (fs.statSync(abs).isDirectory()) existing.push(abs);
      } catch {
        /* 已删除的目录无法 utimes，忽略 */
      }
    }
    return existing;
  }

  /**
   * 刷新飞牛影视媒体库（自动匹配 libraryName / strmRoot）。
   * 一次调用把所有变更目录合并为 dir_list；带 dir_list 失败时降级全库扫描一次，
   * 仍失败则 fallback：日志 + utimes + state.fnv.lastMode="fallback"。
   */
  async function refreshDirs(rawDirs) {
    const requested = [...new Set((rawDirs || []).filter((d) => typeof d === 'string' && d))];
    if (requested.length === 0) return { ok: true, skipped: true, reason: 'no-dirs' };
    const config = readConfig();
    const fnvConfig = normalizeFnvConfig(config.fnv);
    const resolvedSecrets = getResolvedFnvSecrets(fnvConfig);
    state.fnv.configured = resolvedSecrets.configured;
    if (!resolvedSecrets.configured) {
      if (state.fnv.lastMode !== 'disabled') {
        state.fnv.lastMode = 'disabled';
        markStateDirty();
      }
      return { ok: true, skipped: true, reason: 'not-configured' };
    }
    const root = resolveStrmRoot(config) || state.paths.strmRoot;
    const existing = uniqueRefreshDirs(requested);
    const client = getFnvClient(fnvConfig, resolvedSecrets);

    let listResult;
    try {
      listResult = await client.listLibraries();
    } catch (err) {
      return fnvFallback(existing, `获取媒体库列表异常: ${err.message}`);
    }
    if (!listResult.ok) {
      state.fnv.endpoint = listResult.endpoint || client.activeEndpoint || '';
      markStateDirty();
      return fnvFallback(existing, listResult.error || '获取媒体库列表失败');
    }
    state.fnv.endpoint = listResult.endpoint || client.activeEndpoint || '';
    markStateDirty();
    const libraries = listResult.libraries || [];
    const match = matchLibraries(libraries, { libraryName: fnvConfig.libraryName, strmRoot: root });
    state.fnv.matchedLibraries = match.matched.map((item) => ({ guid: item.guid, name: item.name }));
    markStateDirty();

    if (match.matched.length === 0) {
      // 字段名未知/路径不匹配时把完整媒体库 JSON 写日志，便于后续适配
      logger.warn(
        `未能自动匹配飞牛影视媒体库（reason=${match.reason}），媒体库列表: ${safeJson(
          libraries.map((item) => ({ guid: item.guid, name: item.name, paths: item.paths, raw: item.raw }))
        )}`
      );
      return fnvFallback(existing, `未匹配到媒体库（${match.reason}）`);
    }
    if (match.reason === 'single-library') {
      logger.info(`飞牛影视未提供媒体库路径字段，回退到唯一媒体库: ${match.matched[0].name || match.matched[0].guid}`);
    }

    // dir_list 用本次变更目录；若目录都已被删除，则退化为全库扫描
    const dirList = existing.length > 0 ? existing : [];
    const results = [];
    for (const library of match.matched) {
      let result = await client.refreshLibrary(library.guid, dirList);
      if (!result.ok && dirList.length > 0) {
        logger.warn(
          `媒体库 ${library.name || library.guid} 带 dir_list 刷新失败，降级为全库扫描: ${result.error}`
        );
        const retry = await client.refreshLibrary(library.guid, []);
        if (retry.ok) result = { ...retry, fallbackFullScan: true };
      }
      results.push({
        guid: library.guid,
        name: library.name,
        ok: Boolean(result.ok),
        error: result.error || '',
        endpoint: result.endpoint || '',
      });
      if (result.ok) {
        logger.info(
          `飞牛影视刷新成功 library=${library.name || library.guid} guid=${library.guid} dirs=${dirList.length}${
            result.fallbackFullScan ? ' (全库扫描)' : ''
          }`
        );
      } else {
        logger.warn(`媒体库 ${library.name || library.guid} 刷新失败: ${result.error}`);
      }
    }

    const succeeded = results.filter((item) => item.ok);
    if (succeeded.length === 0) {
      return fnvFallback(existing, results.map((item) => item.error).filter(Boolean).join('; ') || '刷新媒体库失败');
    }
    const failed = results.filter((item) => !item.ok);
    state.fnv.endpoint = succeeded[0].endpoint || listResult.endpoint || client.activeEndpoint || '';
    state.fnv.lastOkAt = toIso(now());
    state.fnv.lastMode = 'api';
    state.fnv.lastError = failed.map((item) => `${item.name || item.guid}: ${item.error}`).join('; ');
    markStateDirty();
    return {
      ok: true,
      mode: 'api',
      endpoint: state.fnv.endpoint,
      matched: state.fnv.matchedLibraries,
      results,
      dirs: dirList,
    };
  }

  async function flushRefresh() {
    if (pendingRefreshDirs.size === 0) return { ok: true, skipped: true, reason: 'no-pending-dirs' };
    const dirs = [...pendingRefreshDirs];
    pendingRefreshDirs.clear();
    return refreshDirs(dirs);
  }

  // --------------------------------------------------------------- 队列 ----
  function recoverProcessingJobs() {
    const names = [];
    try {
      names.push(...fs.readdirSync(paths.processingDir).filter((name) => name.endsWith('.json')));
    } catch {
      return;
    }
    for (const name of names) {
      const from = path.join(paths.processingDir, name);
      const to = path.join(paths.queueDir, name);
      try {
        if (fs.existsSync(to)) {
          removeFileQuiet(from);
          continue;
        }
        fs.renameSync(from, to);
        logger.warn(`恢复上次未处理完的队列任务: ${name}`);
      } catch {
        /* ignore */
      }
    }
  }

  function pruneFailedJobs() {
    try {
      const names = fs
        .readdirSync(paths.failedDir)
        .filter((name) => name.endsWith('.json'))
        .sort();
      const extra = names.length - FAILED_KEEP;
      for (let i = 0; i < extra; i += 1) removeFileQuiet(path.join(paths.failedDir, names[i]));
    } catch {
      /* ignore */
    }
  }

  /** 消费 queue/*.json（按文件名排序），成功删除、失败移到 queue/failed/ */
  async function processQueueOnce() {
    ensureDir(paths.queueDir);
    ensureDir(paths.processingDir);
    ensureDir(paths.failedDir);
    const names = (() => {
      try {
        return fs.readdirSync(paths.queueDir).filter((name) => name.endsWith('.json')).sort();
      } catch (err) {
        logger.error(`读取队列目录失败: ${err.message}`);
        return [];
      }
    })();
    const summary = { processed: 0, succeeded: 0, failed: 0, jobs: [] };

    for (const name of names) {
      if (stopped) break;
      const sourcePath = path.join(paths.queueDir, name);
      const workPath = path.join(paths.processingDir, name);
      try {
        fs.renameSync(sourcePath, workPath);
      } catch (err) {
        if (err && err.code === 'ENOENT') continue;
        logger.error(`取走队列任务失败 ${name}: ${err.message}`);
        continue;
      }

      state.engine.processingJob = name;
      markStateDirty();
      let job = null;
      let jobId = name;
      let action = '';
      let jobOk = false;
      try {
        const text = fs.readFileSync(workPath, 'utf8');
        job = JSON.parse(text);
        if (!job || typeof job !== 'object' || Array.isArray(job)) throw new Error('任务 JSON 顶层不是对象');
        jobId = typeof job.id === 'string' && job.id ? job.id : name;
        action = typeof job.action === 'string' ? job.action : '';
        const payload = job.payload && typeof job.payload === 'object' && !Array.isArray(job.payload) ? job.payload : {};
        let result;
        switch (action) {
          case 'add':
            result = await handleAdd(payload);
            break;
          case 'refresh':
            result = await handleRefresh(payload);
            break;
          case 'sync':
            result = await syncAll();
            break;
          case 'cleanup':
            result = await handleCleanup();
            break;
          default:
            throw new Error(`未知任务类型: ${action || '(空)'}`);
        }
        removeFileQuiet(workPath);
        summary.succeeded += 1;
        jobOk = true;
        state.engine.lastResult = { at: toIso(now()), action, jobId, ok: true, result: summarizeResult(action, result) };
        logger.info(`队列任务完成 ${jobId} (${action})`);
      } catch (err) {
        const message = (err && err.message) || String(err);
        summary.failed += 1;
        state.engine.lastResult = { at: toIso(now()), action, jobId, ok: false, error: message };
        logger.error(`队列任务失败 ${jobId} (${action || '?'}): ${message}`);
        try {
          ensureDir(paths.failedDir);
          fs.renameSync(workPath, path.join(paths.failedDir, name));
          pruneFailedJobs();
        } catch (moveErr) {
          logger.error(`移动失败任务到 failed/ 失败: ${moveErr.message}`);
          removeFileQuiet(workPath);
        }
      } finally {
        state.engine.processingJob = '';
        summary.processed += 1;
        summary.jobs.push({ name, action, ok: jobOk });
        markStateDirty();
        refreshQueuePending();
      }
    }

    // 一次批量处理结束后统一刷新（目录列表去重）
    try {
      await flushRefresh();
    } catch (err) {
      logger.warn(`队列处理后刷新媒体库异常: ${err.message}`);
    }
    state.engine.lastTickAt = toIso(now());
    refreshQueuePending();
    writeState(false);
    return summary;
  }

  // ----------------------------------------------------------------- add ----
  /**
   * 新增/刷新单个条目：拉取详情 → 生成/覆写全部 STRM → 更新索引 → 记录待刷新目录。
   */
  async function handleAdd(payload = {}) {
    const config = readConfig();
    const root = ensureStrmRoot(config);
    if (!root) throw new Error('未配置可用的 STRM 根目录（请在设置中配置 strmRoot）');

    const sourceApiBase = normalizeSourceApiBase(payload.sourceApiBase);
    if (!sourceApiBase) throw new Error('sourceApiBase 无效（必须以 http:// 或 https:// 开头）');
    const vodId = payload.vodId === undefined || payload.vodId === null ? '' : String(payload.vodId).trim();
    if (!vodId) throw new Error('vodId 不能为空');

    const detail = await cms.fetchDetail({
      sourceApiBase,
      vodId,
      sourceDetailBase: payload.sourceDetailBase,
      vodName: payload.vodName,
      fetchImpl,
    });
    if (!detail.ok) {
      throw new Error(detail.notFound ? '源站中不存在该条目' : `拉取详情失败: ${detail.error}`);
    }

    const vod = detail.vod || {};
    const title = (payload.vodName && String(payload.vodName).trim()) || vod.title || `vod-${vodId}`;
    const year = naming.normalizeYear(payload.vodYear || vod.year || '');
    let type = payload.type === 'tv' || payload.type === 'movie' ? payload.type : '';
    if (!type) type = detail.chosenUrls.length > 1 ? 'tv' : 'movie';
    const episodes = selectEpisodes(detail, type);
    if (episodes.length === 0) throw new Error('未解析到可用的播放地址（vod_play_url 为空或格式不支持）');
    if (detail.chosenLine && detail.chosenLine.noM3u8) {
      logger.warn(
        `所选线路不含 .m3u8，可能无法直接播放（type=${type}, ${title}）: line=${detail.chosenLine.name}`
      );
    }

    const plan = buildPlan({ root, type, title, year, episodes });
    if (plan.length === 0) throw new Error('未能生成有效的 STRM 路径');

    const index = loadIndexSafe();
    const key = indexStore.entryKey(sourceApiBase, vodId);
    const previous = index.entries[key] || null;

    for (const item of plan) {
      ensureDir(path.dirname(item.absPath));
      atomicWriteFile(item.absPath, item.url + '\n');
    }
    const newPaths = plan.map((item) => item.absPath);
    const removed = removeStalePaths({
      root,
      index,
      key,
      oldPaths: previous ? previous.strmPaths : [],
      newPaths,
    });

    const warnings = detail.warnings && detail.warnings.length > 0 ? [...detail.warnings] : [];
    const entry = {
      type,
      title: String(title).trim(),
      year,
      sourceName: (payload.sourceName && String(payload.sourceName).trim()) || (previous && previous.sourceName) || '',
      sourceApiBase,
      vodId,
      strmPaths: newPaths,
      lastKnownUrls: plan.map((item) => item.url),
      lastSyncedAt: toIso(now()),
      consecutiveFailures: 0,
      lastError: '',
    };
    if (warnings.length > 0) entry.warnings = warnings;
    indexStore.upsertEntry(index, entry);
    saveIndexSafe(index);

    queueRefreshDirs(plan.map((item) => refreshDirOf(root, item.absPath)));
    logger.info(
      `已生成 STRM: ${entry.title}${year ? ` (${year})` : ''} type=${type} files=${newPaths.length} key=${key}`
    );
    return {
      ok: true,
      key,
      type,
      title: entry.title,
      year,
      warnings,
      strmPaths: newPaths,
      removed,
      lastKnownUrls: entry.lastKnownUrls,
    };
  }

  /** 按索引刷新单个条目（queue action=refresh） */
  async function handleRefresh(payload = {}) {
    const sourceApiBase = normalizeSourceApiBase(payload.sourceApiBase);
    const vodId = payload.vodId === undefined || payload.vodId === null ? '' : String(payload.vodId).trim();
    const index = loadIndexSafe();
    let key = '';
    let entry = null;
    if (sourceApiBase && vodId) {
      key = indexStore.entryKey(sourceApiBase, vodId);
      entry = index.entries[key] || null;
    }
    if (!entry && vodId) {
      for (const [candidateKey, candidate] of Object.entries(index.entries)) {
        if (candidate.vodId === vodId) {
          key = candidateKey;
          entry = candidate;
          break;
        }
      }
    }
    if (!entry) {
      throw new Error(`索引中不存在该条目: ${key || vodId || '(空参数)'}`);
    }
    return handleAdd({
      sourceApiBase: entry.sourceApiBase || sourceApiBase,
      sourceDetailBase: payload.sourceDetailBase,
      vodId: entry.vodId,
      vodName: payload.vodName || entry.title,
      vodYear: payload.vodYear || entry.year,
      type: payload.type || entry.type,
      sourceName: payload.sourceName || entry.sourceName,
    });
  }

  // ---------------------------------------------------------------- sync ----
  /**
   * 增量同步：逐条重新拉详情，URL 变化则覆写；明确不存在连续 3 次才删除；
   * 网络/临时错误同样累计失败次数但保留文件，日志中区分。
   */
  async function handleSync() {
    const config = readConfig();
    const root = ensureStrmRoot(config);
    const stats = emptySyncResult();
    if (!root) {
      logger.warn('未配置 STRM 根目录，跳过增量同步');
      return stats;
    }
    const index = loadIndexSafe();
    const entries = Object.entries(index.entries);
    const changedDirs = [];
    let mutated = false;

    for (let i = 0; i < entries.length; i += 1) {
      if (stopped) break;
      const [key, entry] = entries[i];
      stats.checked += 1;
      try {
        const detail = await cms.fetchDetail({
          sourceApiBase: entry.sourceApiBase,
          vodId: entry.vodId,
          fetchImpl,
        });
        if (detail.ok && Array.isArray(detail.chosenUrls) && detail.chosenUrls.length > 0) {
          const type = entry.type === 'tv' ? 'tv' : entry.type === 'movie' ? 'movie' : 'movie';
          const urls = detail.chosenUrls;
          const changed = !sameUrlList(entry.lastKnownUrls || [], urls);
          if (changed) {
            const episodes = selectEpisodes(detail, type);
            const plan = buildPlan({ root, type, title: entry.title, year: entry.year, episodes });
            if (plan.length === 0) throw new Error('生成 STRM 路径失败');
            for (const item of plan) {
              ensureDir(path.dirname(item.absPath));
              atomicWriteFile(item.absPath, item.url + '\n');
            }
            const newPaths = plan.map((item) => item.absPath);
            removeStalePaths({
              root,
              index,
              key,
              oldPaths: entry.strmPaths || [],
              newPaths,
            });
            entry.strmPaths = newPaths;
            entry.lastKnownUrls = plan.map((item) => item.url);
            entry.lastSyncedAt = toIso(now());
            entry.consecutiveFailures = 0;
            entry.lastError = '';
            if (detail.chosenLine && detail.chosenLine.noM3u8) entry.warnings = ['no-m3u8'];
            else delete entry.warnings;
            if (detail.chosenLine && detail.chosenLine.noM3u8) {
              logger.warn(`同步条目所选线路不含 .m3u8: ${entry.title || key}`);
            }
            changedDirs.push(...plan.map((item) => refreshDirOf(root, item.absPath)));
            mutated = true;
            stats.updated += 1;
            logger.info(`同步更新条目: ${entry.title || key} urls=${urls.length}`);
          } else {
            const warnings = detail.chosenLine && detail.chosenLine.noM3u8 ? ['no-m3u8'] : [];
            const warningsChanged = warnings.length !== (entry.warnings || []).length;
            if (warningsChanged) {
              if (warnings.length > 0) entry.warnings = warnings;
              else delete entry.warnings;
              mutated = true;
            }
            entry.lastSyncedAt = toIso(now());
            entry.consecutiveFailures = 0;
            entry.lastError = '';
            mutated = true;
          }
        } else if (detail.ok) {
          // 详情存在但解析不到播放地址：按错误累计，不立即删除
          entry.consecutiveFailures = (entry.consecutiveFailures || 0) + 1;
          entry.lastError = '未解析到可用的播放地址';
          entry.lastSyncedAt = toIso(now());
          stats.errors += 1;
          mutated = true;
          logger.warn(
            `同步条目无播放地址: ${entry.title || key}（连续失败 ${entry.consecutiveFailures}/${DELETE_AFTER_FAILURES}）`
          );
        } else if (detail.notFound) {
          entry.consecutiveFailures = (entry.consecutiveFailures || 0) + 1;
          entry.lastError = '源站条目不存在';
          entry.lastSyncedAt = toIso(now());
          mutated = true;
          logger.warn(
            `同步条目明确不存在: ${entry.title || key}（连续失败 ${entry.consecutiveFailures}/${DELETE_AFTER_FAILURES}）`
          );
          if (entry.consecutiveFailures >= DELETE_AFTER_FAILURES) {
            const deletion = deleteEntryFiles(root, index, key, entry);
            changedDirs.push(...deletion.dirs);
            indexStore.removeEntry(index, key);
            stats.deleted += 1;
            logger.warn(
              `条目连续 ${DELETE_AFTER_FAILURES} 次确认不存在，已删除 STRM（${deletion.removed} 个）并移除索引: ${
                entry.title || key
              }`
            );
          }
        } else {
          entry.consecutiveFailures = (entry.consecutiveFailures || 0) + 1;
          entry.lastError = detail.error || '网络/临时错误';
          entry.lastSyncedAt = toIso(now());
          stats.errors += 1;
          mutated = true;
          logger.warn(
            `同步网络/临时错误（保留文件）: ${entry.title || key} - ${entry.lastError}（连续失败 ${
              entry.consecutiveFailures
            }/${DELETE_AFTER_FAILURES}）`
          );
        }
      } catch (err) {
        entry.consecutiveFailures = (entry.consecutiveFailures || 0) + 1;
        entry.lastError = (err && err.message) || String(err);
        entry.lastSyncedAt = toIso(now());
        stats.errors += 1;
        mutated = true;
        logger.warn(`同步条目异常（保留文件）: ${entry.title || key} - ${entry.lastError}`);
      }
      if (i < entries.length - 1) await sleep(syncDelayMs);
    }

    if (mutated) saveIndexSafe(index);
    else state.paths.indexCount = Object.keys(index.entries).length;
    queueRefreshDirs(changedDirs);
    logger.info(
      `增量同步检查完成: checked=${stats.checked} updated=${stats.updated} deleted=${stats.deleted} errors=${stats.errors}`
    );
    return stats;
  }

  // ------------------------------------------------------------- cleanup ----
  /** 快扫清理孤儿 .strm，并清理因此变空的 Season/剧名目录（不删 root/非 .strm） */
  async function handleCleanup() {
    const config = readConfig();
    const root = ensureStrmRoot(config);
    const stats = { orphansDeleted: 0, dirsRemoved: 0 };
    if (!root) {
      logger.warn('未配置 STRM 根目录，跳过清理');
      return stats;
    }
    const index = loadIndexSafe();
    const claimed = indexStore.collectStrmPaths(index);
    const affectedDirs = new Set();

    for (const file of walkStrmFiles(root)) {
      if (claimed.has(file)) continue;
      if (!isInside(root, file)) continue;
      try {
        fs.unlinkSync(file);
        stats.orphansDeleted += 1;
        affectedDirs.add(refreshDirOf(root, file));
        stats.dirsRemoved += pruneEmptyDirs(root, path.dirname(file));
      } catch (err) {
        logger.warn(`删除孤儿 STRM 失败 ${file}: ${err.message}`);
      }
    }

    // 清理因此变空的 Season/剧名目录（深层优先；仅处理孤儿删除涉及的目录）
    const dirsToPrune = [...affectedDirs]
      .filter((dir) => isInside(root, dir))
      .sort((a, b) => b.length - a.length);
    for (const dir of dirsToPrune) {
      stats.dirsRemoved += pruneEmptyDirs(root, dir);
    }

    if (stats.orphansDeleted > 0 || stats.dirsRemoved > 0) {
      queueRefreshDirs([...affectedDirs]);
      logger.info(`清理完成: 孤儿 STRM ${stats.orphansDeleted} 个，空目录 ${stats.dirsRemoved} 个`);
    } else {
      logger.info('清理完成: 没有孤儿 STRM');
    }
    return stats;
  }

  // -------------------------------------------------------------- syncAll ----
  /** 全量增量同步：handleSync + cleanup + refresh（一次刷新所有变更目录） */
  async function syncAll() {
    if (syncing) {
      logger.warn('已有同步任务进行中，跳过本次同步');
      return { skipped: true, reason: 'already-syncing', ...emptySyncResult() };
    }
    syncing = true;
    const result = emptySyncResult();
    try {
      const syncStats = await handleSync();
      result.checked = syncStats.checked;
      result.updated = syncStats.updated;
      result.deleted = syncStats.deleted;
      result.errors = syncStats.errors;

      const cleanupStats = await handleCleanup();
      result.orphansDeleted = cleanupStats.orphansDeleted;

      try {
        await flushRefresh();
      } catch (err) {
        logger.warn(`同步后刷新媒体库异常: ${err.message}`);
      }

      state.engine.lastSyncAt = toIso(now());
      state.engine.lastSyncResult = { ...result };
      state.engine.lastResult = { at: toIso(now()), action: 'sync', ok: true, result: { ...result } };
      logger.info(`全量同步完成: ${safeJson(result)}`);
    } catch (err) {
      result.errors += 1;
      state.engine.lastSyncAt = toIso(now());
      state.engine.lastSyncResult = { ...result };
      state.engine.lastResult = { at: toIso(now()), action: 'sync', ok: false, error: err.message };
      logger.error(`全量同步失败: ${err.message}`);
    } finally {
      syncing = false;
      markStateDirty();
      writeState(true);
    }
    return result;
  }

  // ------------------------------------------------------------- 调度器 ----
  function updateSyncSchedule(config) {
    const intervalMs = normalizeSyncIntervalHours(config) * 60 * 60 * 1000;
    const t = now();
    if (syncIntervalMs === 0) {
      syncIntervalMs = intervalMs;
      nextSyncAt = t + intervalMs;
      return;
    }
    if (intervalMs !== syncIntervalMs) {
      syncIntervalMs = intervalMs;
      nextSyncAt = Math.min(nextSyncAt || t + intervalMs, t + intervalMs);
      logger.info(`同步间隔已更新为 ${(intervalMs / 3600000).toFixed(2)} 小时`);
      markStateDirty();
    }
  }

  /** 单次心跳：配置重读 + 队列消费 + 到点同步（首次同步不会立即执行） */
  async function tick() {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const config = readConfig();
      const root = ensureStrmRoot(config);
      updateFnvFlags(config);
      updateSyncSchedule(config);
      state.engine.lastTickAt = toIso(now());
      refreshQueuePending();

      await processQueueOnce();

      if (root && !syncing && now() >= nextSyncAt) {
        nextSyncAt = now() + syncIntervalMs;
        await syncAll();
      }
      writeState(false);
    } catch (err) {
      logger.error(`引擎心跳异常: ${(err && err.stack) || err}`);
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (started) return engine;
    started = true;
    stopped = false;
    recoverProcessingJobs();
    const config = readConfig();
    const root = ensureStrmRoot(config);
    updateFnvFlags(config);
    updateSyncSchedule(config);
    state.engine.startedAt = toIso(now());
    state.engine.lastTickAt = toIso(now());
    refreshQueuePending();
    const index = loadIndexSafe();
    state.paths.indexCount = Object.keys(index.entries).length;
    if (!root) {
      logger.warn('STRM 引擎已启动，但未配置可用的 STRM 根目录（setupNeeded=true）');
    }
    writeState(true);

    tickTimer = setInterval(() => {
      tick().catch((err) => logger.error(`引擎定时任务异常: ${(err && err.stack) || err}`));
    }, QUEUE_POLL_MS);
    if (tickTimer && typeof tickTimer.unref === 'function') tickTimer.unref();

    logger.info(
      `STRM 引擎已启动 dataDir=${dataDir} strmRoot=${root || '未配置'} 同步间隔=${(
        syncIntervalMs / 3600000
      ).toFixed(2)}h 队列轮询=${QUEUE_POLL_MS}ms`
    );
    // 启动即跑一次队列处理；首次全量同步延迟到间隔到达或手动触发
    tick().catch((err) => logger.error(`引擎启动首轮处理异常: ${(err && err.stack) || err}`));
    return engine;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    started = false;
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    state.engine.processingJob = '';
    refreshQueuePending();
    markStateDirty();
    writeState(true);
    logger.info('STRM 引擎已停止');
  }

  const engine = {
    dataDir,
    paths,
    logger,
    get state() {
      return buildState();
    },
    getEngineState: buildState,
    readConfig,
    start,
    stop,
    tick,
    processQueueOnce,
    handleAdd,
    handleRefresh,
    handleSync,
    handleCleanup,
    syncAll,
    refreshDirs,
    flushRefresh,
    getFnvClientSnapshot() {
      return fnvClient;
    },
  };

  return engine;
}

module.exports = {
  createEngine,
  QUEUE_POLL_MS,
  DEFAULT_SYNC_INTERVAL_HOURS,
  MIN_SYNC_INTERVAL_HOURS,
  MAX_SYNC_INTERVAL_HOURS,
  DELETE_AFTER_FAILURES,
  FAILED_KEEP,
  // 内部工具导出便于单测
  walkStrmFiles,
  walkAllDirs,
  pruneEmptyDirs,
  normalizeSyncIntervalHours,
  normalizeFnvConfig,
  normalizeSourceApiBase,
  sameUrlList,
};
