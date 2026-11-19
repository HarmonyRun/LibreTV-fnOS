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
const libraryRemove = require('./library-remove');

const DEFAULT_SYNC_INTERVAL_HOURS = 6;
const MIN_SYNC_INTERVAL_HOURS = 1;
const MAX_SYNC_INTERVAL_HOURS = 168;
const QUEUE_POLL_MS = 2000;
const STATE_HEARTBEAT_MS = 30000;
const DEFAULT_SYNC_DELAY_MS = 200;
const FAILED_KEEP = 50;
const DELETE_AFTER_FAILURES = 3;
/** 空资源目录回收：默认每 5 分钟扫描一次；目录 mtime 超过 5 分钟且 0 个 .strm 才删除，避免与入库任务竞争 */
const EMPTY_DIR_SCAN_INTERVAL_MS = 5 * 60 * 1000;
const EMPTY_DIR_GRACE_MS = 5 * 60 * 1000;
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
  return {
    checked: 0,
    updated: 0,
    deleted: 0,
    orphansDeleted: 0,
    episodesAdded: 0,
    filesRestored: 0,
    manualRemoved: 0,
    migrated: 0,
    errors: 0,
  };
}

/** state.engine.lastResult 只保留概要，避免把全部 URL 写进 state.json */
function summarizeResult(action, result) {
  if (!result || typeof result !== 'object') return result === undefined ? null : result;
  if (action === 'sync') {
    const out = {};
    for (const key of [
      'checked',
      'updated',
      'deleted',
      'orphansDeleted',
      'episodesAdded',
      'filesRestored',
      'manualRemoved',
      'migrated',
      'errors',
    ]) {
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
    return {
      orphansDeleted: result.orphansDeleted || 0,
      dirsRemoved: result.dirsRemoved || 0,
      emptyDirsRemoved: result.emptyDirsRemoved || 0,
      emptyDirsFilesRemoved: result.emptyDirsFilesRemoved || 0,
      entriesRemoved: result.entriesRemoved || 0,
    };
  }
  if (action === 'remove') {
    // 只保留计数，避免把目录/条目原文写进 state.json
    return {
      ok: result.ok !== false,
      dryRun: result.dryRun === true,
      mode: result.mode || '',
      dirsRemoved: Array.isArray(result.deletedDirs)
        ? result.deletedDirs.length
        : Number(result.totalDirs) || 0,
      deletedFiles: Number(result.deletedFiles) || 0,
      entriesRemoved: Array.isArray(result.removedEntries) ? result.removedEntries.length : 0,
      prunedEntries: Array.isArray(result.prunedEntries) ? result.prunedEntries.length : 0,
      failed: Array.isArray(result.failed) ? result.failed.length : 0,
    };
  }
  if (action === 'migrate') {
    // 换源迁移只保留计数与少量条目概要，避免 state.json 膨胀
    return {
      ok: result.ok !== false,
      dryRun: result.dryRun === true,
      checked: Number(result.checked) || 0,
      migrated: Number(result.migrated) || 0,
      skipped: Number(result.skipped) || 0,
      failed: Number(result.failed) || 0,
      entries: Array.isArray(result.entries)
        ? result.entries.slice(0, 20).map((item) => ({
            title: item && item.title ? String(item.title) : '',
            from: item && item.from ? String(item.from) : '',
            to: item && item.to ? String(item.to) : '',
            files: Number(item && item.files) || 0,
          }))
        : [],
    };
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

/** 递归统计目录内文件数；读取失败返回 -1（调用方应跳过删除） */
function countFilesRecursive(dir) {
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return -1;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(full);
      else count += 1;
    }
  }
  return count;
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
  let nextEmptyScanAt = 0;
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

  function writePlanFiles(plan) {
    for (const item of plan) {
      ensureDir(path.dirname(item.absPath));
      atomicWriteFile(item.absPath, item.url + '\n');
    }
  }

  function refreshDirOf(root, strmPath) {
    const dir = path.dirname(path.resolve(strmPath));
    const rel = path.relative(root, dir);
    const first = rel.split(path.sep)[0];
    if (!first || first === '..' || path.isAbsolute(first)) return root;
    return path.join(root, first);
  }

  /** 索引条目列表（[{key, ...entry}]，供共享移除模块匹配用） */
  function allIndexEntries(index) {
    return Object.entries(index.entries || {}).map(([key, entry]) => ({ key, ...entry }));
  }

  /**
   * 计划里涉及的第一层资源目录是否全部不存在。
   * 用于识别「用户在飞牛影视里把整部剧删掉」：此时不应把缺失文件当成误删去补写。
   */
  function areAllResourceRootsMissing(root, plan) {
    const roots = new Set((plan || []).map((item) => refreshDirOf(root, item.absPath)));
    if (roots.size === 0) return false;
    for (const dir of roots) {
      try {
        if (fs.statSync(dir).isDirectory()) return false;
      } catch {
        /* 不存在：继续检查其它目录 */
      }
    }
    return true;
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
          case 'remove':
            result = await handleRemove(payload);
            break;
          case 'migrate':
            result = await handleMigrate(payload);
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

  // -------------------------------------------------------------- remove ----
  /**
   * 从媒体库移除条目（queue action=remove）。
   *
   * 与 MCP remove_from_library 共用 engine/library-remove 的计划/删除/索引裁剪逻辑，
   * 由设置页「移除」按钮与 MCP 工具共同使用。语义：
   *   - 默认删除整个资源目录（第一层目录，含 nfo/海报等所有文件）；
   *   - 传 season 时只删该季目录，其余季保留（索引条目被裁剪而非删除）；
   *   - dryRun=true 只返回计划，不改动文件与索引；
   *   - 先写索引再删文件：即使删除中途失败，残留文件也会被孤儿清理回收，不会反向复活。
   */
  async function handleRemove(payload = {}) {
    const config = readConfig();
    const root = ensureStrmRoot(config);
    if (!root) throw new Error('未配置可用的 STRM 根目录（请在设置中配置 strmRoot）');
    const index = loadIndexSafe();
    const plan = libraryRemove.planRemoval({
      entries: allIndexEntries(index),
      root,
      args: payload,
    });
    if (!plan.ok) {
      const err = new Error(plan.error || '移除计划生成失败');
      err.candidates = plan.candidates;
      throw err;
    }
    const titles = new Map(plan.matches.map((entry) => [entry.key, entry.title]));

    if (payload.dryRun === true) {
      return {
        ok: true,
        dryRun: true,
        mode: plan.mode,
        totalDirs: plan.plan.length,
        totalFiles: plan.totalFiles,
        dirs: plan.plan,
        matchedEntries: plan.matches.map((entry) => ({
          key: entry.key,
          title: entry.title,
          year: entry.year || '',
          type: entry.type || '',
        })),
      };
    }

    // 先裁剪/移除索引再删文件：崩溃时残留文件会被孤儿清理删除，避免「移除后又被同步补回」
    const { removedKeys, prunedKeys } = libraryRemove.removeIndexEntriesByDirs(index, plan.roots);
    saveIndexSafe(index);
    const applied = libraryRemove.applyRemoval(plan.plan);
    if (applied.failed.length > 0) {
      logger.warn(
        `部分资源目录删除失败（索引已移除，残留文件将由孤儿清理回收）: ${applied.failed
          .map((item) => `${item.dir}（${item.error}）`)
          .join('; ')}`
      );
    }
    queueRefreshDirs([root]);
    logger.warn(
      `已从媒体库移除: ${plan.matches
        .map((entry) => entry.title || entry.key)
        .join('、')} mode=${plan.mode} 目录=${applied.deletedDirs.length} 文件=${applied.deletedFiles} 索引移除=${removedKeys.length} 裁剪=${prunedKeys.length}`
    );
    return {
      ok: true,
      mode: plan.mode,
      deletedDirs: applied.deletedDirs,
      deletedFiles: applied.deletedFiles,
      failed: applied.failed,
      removedEntries: removedKeys.map((key) => ({ key, title: titles.get(key) || '' })),
      prunedEntries: prunedKeys.map((key) => ({ key, title: titles.get(key) || '' })),
      keptSeasons:
        plan.mode === 'season' && plan.roots.length === 1
          ? libraryRemove.listSeasonDirs(plan.roots[0]).map((season) => ({
              season: season.season,
              name: season.name,
            }))
          : [],
    };
  }

  // ------------------------------------------------------ source migration ----
  /**
   * 换源迁移：当条目原先使用的采集源已被替换/不可达时，在当前预置源里搜索同名条目，
   * 用「原条目的 title/year」重建 STRM 并**按旧文件路径原地覆写**（文件名、目录完全不变，
   * 飞牛影视的播放进度得以保留），同时把索引 key 换到新源，后续同步/追更走新源。
   */

  function normalizeSourceBase(url) {
    return typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
  }

  /** 当前预置采集源：Map<归一化 base, 显示名> */
  function configuredSourceEntries(config) {
    const map = new Map();
    for (const item of Array.isArray(config && config.sources) ? config.sources : []) {
      const base = normalizeSourceBase(item && item.url);
      if (!base || !/^https?:\/\//i.test(base)) continue;
      const name = item && typeof item.name === 'string' && item.name.trim() ? item.name.trim() : base;
      map.set(base, name);
    }
    return map;
  }

  /** 片名归一化（换源匹配用）：去空白与常见标点，保留季/数字信息 */
  function migrationTitleKey(title) {
    return String(title || '')
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '')
      .replace(/[：:·・,，.。!！?？'"“”‘’()（）\[\]【】\-_—–/\\|]/g, '');
  }

  /** 候选评分：片名完全相同 20 分，包含关系 8 分；年份相同 +10、不同 -8 */
  function scoreMigrationCandidate(entry, vod) {
    const target = migrationTitleKey(entry.title);
    const candidate = migrationTitleKey(vod && (vod.vod_name || vod.name));
    if (!target || !candidate) return 0;
    let score = 0;
    if (candidate === target) score += 20;
    else if (candidate.includes(target) || target.includes(candidate)) score += 8;
    else return 0;
    const entryYear = String(entry.year || '').trim();
    const vodYear = naming.normalizeYear((vod && (vod.vod_year || vod.vod_pubdate)) || '');
    if (entryYear && vodYear) score += entryYear === vodYear ? 10 : -8;
    return score;
  }

  /** 在其它预置源里搜索同名条目，返回置信度足够的最佳候选；找不到返回 null */
  async function findMigrationTarget(entry, sourceMap) {
    const skipBase = normalizeSourceBase(entry.sourceApiBase);
    let best = null;
    for (const [base, name] of sourceMap) {
      if (base === skipBase) continue;
      const result = await cms.searchVods({ sourceApiBase: base, keyword: entry.title, fetchImpl });
      if (!result.ok) continue;
      for (const vod of result.list || []) {
        const score = scoreMigrationCandidate(entry, vod);
        if (score > 0 && (!best || score > best.score)) {
          best = {
            score,
            base,
            name,
            vodId: String((vod && vod.vod_id) || ''),
            vodName: String((vod && vod.vod_name) || ''),
          };
        }
      }
    }
    if (!best || !best.vodId) return null;
    // 阈值：片名完全相同，或「片名包含 + 年份相同」，避免误迁到相近剧名
    return best.score >= 18 ? best : null;
  }

  /**
   * 迁移单个条目（不写索引，只改文件；索引由调用方统一保存）。
   * 返回 {status:'migrated'|'would-migrate'|'skipped'|'failed', ...}
   */
  async function migrateEntry({ entry, oldKey, index, root, sourceMap, dryRun }) {
    const target = await findMigrationTarget(entry, sourceMap);
    if (!target) return { status: 'skipped', reason: 'no-match', title: entry.title };
    const newKey = indexStore.entryKey(target.base, target.vodId);
    if (newKey !== oldKey && index.entries[newKey]) {
      return { status: 'skipped', reason: 'key-exists', title: entry.title };
    }
    const detail = await cms.fetchDetail({ sourceApiBase: target.base, vodId: target.vodId, fetchImpl });
    if (!detail.ok || !Array.isArray(detail.chosenUrls) || detail.chosenUrls.length === 0) {
      return { status: 'failed', reason: detail.error || '详情无可用播放地址', title: entry.title };
    }
    const type = entry.type === 'tv' ? 'tv' : 'movie';
    const episodes = selectEpisodes(detail, type);
    const plan = buildPlan({ root, type, title: entry.title, year: entry.year, episodes });
    if (plan.length === 0) return { status: 'failed', reason: '生成 STRM 路径失败', title: entry.title };

    const oldPaths = (entry.strmPaths || []).map((p) => path.resolve(p));
    // 集数差异过大时宁可不迁，避免把别的剧/别的季写进原文件名
    const tolerance = Math.max(3, Math.ceil(oldPaths.length * 0.25));
    if (oldPaths.length > 0 && Math.abs(plan.length - oldPaths.length) > tolerance) {
      return { status: 'skipped', reason: '集数差异过大', title: entry.title };
    }

    const oldUrls = Array.isArray(entry.lastKnownUrls) ? entry.lastKnownUrls : [];
    const writes = [];
    const nextPaths = [];
    const nextUrls = [];
    const common = Math.min(oldPaths.length, plan.length);
    // 旧文件按序号原地覆写：文件名/目录保持不变 → 影视条目与播放进度不受影响
    for (let i = 0; i < common; i += 1) {
      nextPaths.push(oldPaths[i]);
      nextUrls.push(plan[i].url);
      writes.push({ absPath: oldPaths[i], url: plan[i].url });
    }
    // 新源比旧条目多出来的集数：按新命名生成新文件（追更）
    for (let i = oldPaths.length; i < plan.length; i += 1) {
      nextPaths.push(plan[i].absPath);
      nextUrls.push(plan[i].url);
      writes.push({ absPath: plan[i].absPath, url: plan[i].url });
    }
    // 新源缺集：保留旧文件与旧地址，不删除、不覆盖，尽量不影响已有进度
    for (let i = plan.length; i < oldPaths.length; i += 1) {
      nextPaths.push(oldPaths[i]);
      nextUrls.push(oldUrls[i] || '');
    }

    const summary = {
      status: 'migrated',
      title: entry.title,
      from: normalizeSourceBase(entry.sourceApiBase),
      to: target.base,
      files: writes.length,
      newKey,
      changedDirs: [...new Set(writes.map((item) => refreshDirOf(root, item.absPath)))],
    };
    if (dryRun) return { ...summary, status: 'would-migrate' };

    for (const item of writes) {
      if (!isInside(root, item.absPath)) continue;
      ensureDir(path.dirname(item.absPath));
      atomicWriteFile(item.absPath, item.url + '\n');
    }

    const nextEntry = {
      type: entry.type === 'tv' ? 'tv' : 'movie',
      title: entry.title,
      year: entry.year || '',
      sourceName: target.name || entry.sourceName || '',
      sourceApiBase: target.base,
      vodId: target.vodId,
      strmPaths: nextPaths,
      lastKnownUrls: nextUrls,
      lastSyncedAt: toIso(now()),
      consecutiveFailures: 0,
      lastError: '',
    };
    if (Array.isArray(entry.warnings) && entry.warnings.length > 0) nextEntry.warnings = entry.warnings.slice();
    if (newKey !== oldKey) indexStore.removeEntry(index, oldKey);
    indexStore.upsertEntry(index, nextEntry);
    logger.info(
      `换源迁移完成: ${entry.title} 源 ${summary.from || '(空)'} → ${target.base}（原地重写 ${writes.length} 个文件）`
    );
    return summary;
  }

  /**
   * 批量换源迁移。
   * mode='unconfigured'：只处理 sourceApiBase 已不在预置源列表的条目（换源后的自动迁移）
   * mode='unreachable'：只处理指定 keys（同步时网络不可达的条目）
   * mode='all'：逐条探测旧源，旧源不可用/条目不存在才迁移（手动任务）
   */
  async function runSourceMigration({ index, root, config, mode, keys, limit, dryRun }) {
    const stats = { checked: 0, migrated: 0, skipped: 0, failed: 0, entries: [] };
    const sourceMap = configuredSourceEntries(config);
    if (sourceMap.size === 0) return stats;

    const candidates = [];
    if (mode === 'unreachable') {
      for (const key of keys || []) {
        if (index.entries[key]) candidates.push([key, index.entries[key]]);
      }
    } else {
      for (const [key, entry] of Object.entries(index.entries)) {
        if (mode === 'unconfigured') {
          const base = normalizeSourceBase(entry.sourceApiBase);
          if (base && sourceMap.has(base)) continue;
        }
        candidates.push([key, entry]);
      }
    }

    const max = Number.isFinite(limit) && limit > 0 ? limit : candidates.length;
    const changedDirs = [];
    let mutated = false;
    for (const [key, entry] of candidates.slice(0, max)) {
      if (stopped) break;
      stats.checked += 1;
      try {
        if (mode === 'all') {
          // 手动迁移：旧源还能正常取详情就不动，避免无谓改写
          const probe = await cms.fetchDetail({
            sourceApiBase: entry.sourceApiBase,
            vodId: entry.vodId,
            fetchImpl,
          });
          if (probe.ok) {
            stats.skipped += 1;
            continue;
          }
        }
        const result = await migrateEntry({ entry, oldKey: key, index, root, sourceMap, dryRun });
        if (result.status === 'migrated' || result.status === 'would-migrate') {
          stats.migrated += 1;
          if (stats.entries.length < 50) {
            stats.entries.push({
              title: result.title,
              from: result.from,
              to: result.to,
              files: result.files,
            });
          }
          if (result.status === 'migrated') {
            changedDirs.push(...(result.changedDirs || []));
            mutated = true;
          }
        } else if (result.status === 'skipped') {
          stats.skipped += 1;
          if (result.reason && result.reason !== 'no-match') {
            logger.warn(`换源迁移跳过: ${result.title || entry.title} - ${result.reason}`);
          }
        } else {
          stats.failed += 1;
          if (result.reason) logger.warn(`换源迁移失败: ${result.title || entry.title} - ${result.reason}`);
        }
      } catch (err) {
        stats.failed += 1;
        logger.warn(`换源迁移异常: ${entry.title || key} - ${(err && err.message) || err}`);
      }
    }

    if (mutated) {
      saveIndexSafe(index);
      queueRefreshDirs(changedDirs);
    }
    if (stats.checked > 0) {
      logger.info(
        `换源迁移检查完成: checked=${stats.checked} migrated=${stats.migrated} skipped=${stats.skipped} failed=${stats.failed}${
          dryRun ? '（dryRun）' : ''
        }`
      );
    }
    return stats;
  }

  /** 手动触发换源迁移（queue action=migrate） */
  async function handleMigrate(payload = {}) {
    const config = readConfig();
    const root = ensureStrmRoot(config);
    if (!root) throw new Error('未配置可用的 STRM 根目录（请在设置中配置 strmRoot）');
    const sourceMap = configuredSourceEntries(config);
    if (sourceMap.size === 0) throw new Error('未配置预置采集源（config.sources 为空），无法换源迁移');
    const dryRun = payload.dryRun === true;
    const limit = Number(payload.limit) > 0 ? Math.min(500, Math.trunc(Number(payload.limit))) : 200;
    const index = loadIndexSafe();
    const stats = await runSourceMigration({ index, root, config, mode: 'all', limit, dryRun });
    return { ok: true, dryRun, ...stats };
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
    // 换源后的自动迁移：条目用的源已不在预置源列表时，先在当前源里找回同名条目并原地重建
    if (config.migrateOnSourceChange !== false) {
      try {
        const pre = await runSourceMigration({
          index,
          root,
          config,
          mode: 'unconfigured',
          limit: 10,
          dryRun: false,
        });
        stats.migrated += pre.migrated;
      } catch (err) {
        logger.warn(`换源自动迁移异常: ${(err && err.message) || err}`);
      }
    }
    const entries = Object.entries(index.entries);
    const changedDirs = [];
    let mutated = false;
    const unreachableKeys = [];

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
          const episodes = selectEpisodes(detail, type);
          const plan = buildPlan({ root, type, title: entry.title, year: entry.year, episodes });
          if (plan.length === 0) throw new Error('生成 STRM 路径失败');
          // 手动删除优先判定：不论 URL 是否变化，先看资源目录是否还在。
          // 否则「用户在飞牛影视里删掉整部剧 → 下次同步因 URL 轮换判定为更新 → 重新写回目录」的循环依然存在。
          if (config.respectManualRemoval !== false && areAllResourceRootsMissing(root, plan)) {
            indexStore.removeEntry(index, key);
            mutated = true;
            stats.manualRemoved += 1;
            logger.warn(
              `资源目录已被手动删除，按用户移除处理（不再补写）: ${entry.title || key}（${plan.length} 个文件）`
            );
          } else if (!sameUrlList(entry.lastKnownUrls || [], urls)) {
            const oldSet = new Set((entry.strmPaths || []).map((p) => path.resolve(p)));
            const added = plan.filter((item) => !oldSet.has(path.resolve(item.absPath))).length;
            writePlanFiles(plan);
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
            stats.episodesAdded += added;
            logger.info(
              `同步更新条目: ${entry.title || key} urls=${urls.length} 新增文件=${added}${
                added > 0 ? '（追更）' : ''
              }`
            );
          } else {
            // URL 列表没变，但本地 .strm 可能被删/路径名变化：补齐缺失文件，保持追更与手动清理一致
            const oldPaths = entry.strmPaths || [];
            const newPaths = plan.map((item) => item.absPath);
            const newSet = new Set(newPaths.map((p) => path.resolve(p)));
            const missing = plan.filter((item) => !fs.existsSync(item.absPath));
            const stale = oldPaths.map((p) => path.resolve(p)).filter((p) => !newSet.has(p));
            if (plan.length > 0 && (missing.length > 0 || stale.length > 0)) {
              writePlanFiles(plan);
              removeStalePaths({ root, index, key, oldPaths, newPaths });
              entry.strmPaths = newPaths;
              entry.lastKnownUrls = plan.map((item) => item.url);
              entry.lastSyncedAt = toIso(now());
              entry.consecutiveFailures = 0;
              entry.lastError = '';
              changedDirs.push(...newPaths.map((p) => refreshDirOf(root, p)));
              mutated = true;
              stats.filesRestored += missing.length;
              if (missing.length > 0) {
                logger.info(`同步补齐缺失 STRM: ${entry.title || key} 新增 ${missing.length} 个文件`);
              }
              if (stale.length > 0) {
                logger.info(`同步清理失效路径: ${entry.title || key} 移除 ${stale.length} 个旧路径`);
              }
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
          unreachableKeys.push(key);
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

    // 旧源仍在预置列表里但当前不可达（如被墙）：尝试迁移到其它可用预置源
    if (config.migrateOnSourceChange !== false && unreachableKeys.length > 0) {
      try {
        const post = await runSourceMigration({
          index,
          root,
          config,
          mode: 'unreachable',
          keys: unreachableKeys,
          limit: 10,
          dryRun: false,
        });
        stats.migrated += post.migrated;
        if (post.migrated > 0) mutated = true;
      } catch (err) {
        logger.warn(`换源兜底迁移异常: ${(err && err.message) || err}`);
      }
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

    const emptyStats = await reclaimEmptyResourceDirs();
    stats.emptyDirsRemoved = emptyStats.emptyDirsRemoved;
    stats.emptyDirsFilesRemoved = emptyStats.emptyDirsFilesRemoved;
    stats.entriesRemoved = emptyStats.entriesRemoved;

    if (stats.orphansDeleted > 0 || stats.dirsRemoved > 0 || stats.emptyDirsRemoved > 0) {
      if (affectedDirs.size > 0) queueRefreshDirs([...affectedDirs]);
      logger.info(
        `清理完成: 孤儿 STRM ${stats.orphansDeleted} 个，空目录 ${stats.dirsRemoved} 个，空资源目录 ${stats.emptyDirsRemoved} 个（${stats.emptyDirsFilesRemoved} 个文件 / ${stats.entriesRemoved} 条索引）`
      );
    } else {
      logger.info('清理完成: 没有孤儿 STRM 或空资源目录');
    }
    return stats;
  }

  /**
   * 空资源目录回收：用户可能在飞牛影视/文件管理里把某部剧的 .strm 全部删掉，
   * 此时资源目录里 0 个 .strm；超过宽限期后递归删除整个资源目录（含 nfo/海报等），
   * 并移除索引中引用该目录的条目，最后触发媒体库刷新。
   */
  async function reclaimEmptyResourceDirs() {
    const stats = { emptyDirsRemoved: 0, emptyDirsFilesRemoved: 0, entriesRemoved: 0, dirs: [] };
    const config = readConfig();
    if (config.cleanupEmptyDirs === false) return stats;
    const root = ensureStrmRoot(config);
    if (!root) return stats;
    let graceMs = EMPTY_DIR_GRACE_MS;
    const graceMinutes = Number(config.emptyDirGraceMinutes);
    if (Number.isFinite(graceMinutes) && graceMinutes > 0) {
      graceMs = Math.min(60 * 60 * 1000, Math.max(60 * 1000, graceMinutes * 60 * 1000));
    }
    let dirents;
    try {
      dirents = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return stats;
    }
    const index = loadIndexSafe();
    let mutatedIndex = false;
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      if (dirent.name.startsWith('.')) continue;
      const dir = path.join(root, dirent.name);
      if (!isInside(root, dir) || path.resolve(dir) === path.resolve(root)) continue;
      let st;
      try {
        st = fs.statSync(dir);
      } catch {
        continue;
      }
      if (now() - st.mtimeMs < graceMs) continue;
      try {
        fs.readdirSync(dir);
      } catch {
        continue;
      }
      if (walkStrmFiles(dir).length > 0) continue;
      const files = countFilesRecursive(dir);
      if (files < 0) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        logger.warn(`回收空资源目录失败 ${dir}: ${err.message}`);
        continue;
      }
      stats.emptyDirsRemoved += 1;
      stats.emptyDirsFilesRemoved += files;
      stats.dirs.push(dir);
      let removedHere = 0;
      for (const [key, entry] of Object.entries(index.entries)) {
        const paths = Array.isArray(entry.strmPaths) ? entry.strmPaths : [];
        if (paths.some((p) => isInside(dir, path.resolve(p)))) {
          delete index.entries[key];
          stats.entriesRemoved += 1;
          removedHere += 1;
          mutatedIndex = true;
        }
      }
      logger.warn(`回收空资源目录: ${dir}（0 个 .strm，${files} 个文件，${removedHere} 条索引）`);
    }
    if (mutatedIndex) saveIndexSafe(index);
    if (stats.emptyDirsRemoved > 0) {
      queueRefreshDirs([root]);
      logger.info(
        `空目录回收完成: 目录 ${stats.emptyDirsRemoved} 个，文件 ${stats.emptyDirsFilesRemoved} 个，索引 ${stats.entriesRemoved} 条`
      );
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
      result.manualRemoved = syncStats.manualRemoved;
      result.migrated = syncStats.migrated;
      result.filesRestored = syncStats.filesRestored;
      result.episodesAdded = syncStats.episodesAdded;
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

      if (root && !syncing && now() >= nextEmptyScanAt) {
        nextEmptyScanAt = now() + EMPTY_DIR_SCAN_INTERVAL_MS;
        try {
          await reclaimEmptyResourceDirs();
        } catch (err) {
          logger.warn(`空目录定时回收异常: ${err.message}`);
        }
      }

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
    nextEmptyScanAt = now() + 60 * 1000;
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
    handleRemove,
    handleMigrate,
    handleSync,
    handleCleanup,
    reclaimEmptyResourceDirs,
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
