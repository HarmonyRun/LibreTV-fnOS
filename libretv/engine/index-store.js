'use strict';

/**
 * strm-index.json 持久化（契约 4.3）。
 *
 * key = sourceApiBase.trim().replace(/\/+$/,'') + '::' + vodId
 * 结构：{ version:1, updatedAt:ISO, entries:{ [key]: entry } }
 *
 * 写入必须原子（tmp + rename）；文件损坏时备份为
 * `strm-index.json.corrupt-<timestamp>.bak` 后重建空索引。
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteJson, ensureDir, readJsonSafe } = require('./fs-util');

const INDEX_VERSION = 1;

function indexPath(dataDir) {
  return path.join(path.resolve(dataDir), 'strm-index.json');
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string');
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = {
    type: raw.type === 'tv' ? 'tv' : 'movie',
    title: typeof raw.title === 'string' ? raw.title : String(raw.title || ''),
    year: typeof raw.year === 'string' ? raw.year : raw.year == null ? '' : String(raw.year),
    sourceName: typeof raw.sourceName === 'string' ? raw.sourceName : '',
    sourceApiBase: typeof raw.sourceApiBase === 'string' ? raw.sourceApiBase : '',
    vodId: raw.vodId == null ? '' : String(raw.vodId),
    strmPaths: stringArray(raw.strmPaths),
    lastKnownUrls: stringArray(raw.lastKnownUrls),
    lastSyncedAt: typeof raw.lastSyncedAt === 'string' ? raw.lastSyncedAt : '',
    consecutiveFailures: Number.isFinite(Number(raw.consecutiveFailures))
      ? Math.max(0, Math.trunc(Number(raw.consecutiveFailures)))
      : 0,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : '',
  };
  // 契约 4.3 之外的扩展字段：warnings（如 no-m3u8），仅在有值时保留
  if (Array.isArray(raw.warnings) && raw.warnings.length > 0) {
    entry.warnings = stringArray(raw.warnings);
  }
  return entry;
}

function normalizeIndex(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = raw.entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return null;
  const clean = {};
  for (const [key, value] of Object.entries(entries)) {
    const entry = normalizeEntry(value);
    if (entry) clean[key] = entry;
  }
  return {
    version: INDEX_VERSION,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    entries: clean,
  };
}

function createEmptyIndex() {
  return { version: INDEX_VERSION, updatedAt: new Date().toISOString(), entries: {} };
}

function entryKey(sourceApiBase, vodId) {
  const base = String(sourceApiBase === undefined || sourceApiBase === null ? '' : sourceApiBase)
    .trim()
    .replace(/\/+$/, '');
  const id = String(vodId === undefined || vodId === null ? '' : vodId).trim();
  return `${base}::${id}`;
}

function backupCorruptFile(file) {
  const safeStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.corrupt-${safeStamp}.bak`;
  try {
    fs.copyFileSync(file, backup);
    return backup;
  } catch {
    return '';
  }
}

/**
 * 读取索引。文件不存在/损坏时都不会抛异常：
 *   - 不存在 → 空索引（不写盘）
 *   - 损坏 → 备份 + 原子重建空索引
 */
function loadIndex(dataDir) {
  const file = indexPath(dataDir);
  const result = readJsonSafe(file);
  if (result.ok) {
    const normalized = normalizeIndex(result.value);
    if (normalized) return normalized;
    const backup = backupCorruptFile(file);
    try {
      atomicWriteJson(file, createEmptyIndex());
    } catch {
      /* 重建失败时仍返回空索引，后续 saveIndex 会再尝试 */
    }
    if (backup) {
      // 用 console 兜底：index-store 不依赖 logger，调用方可在上层记录
      console.warn(`[engine] strm-index.json 结构损坏，已备份到 ${backup}`);
    }
    return createEmptyIndex();
  }
  // ENOENT：首次运行
  if (result.error && result.error.code === 'ENOENT') return createEmptyIndex();

  const backup = backupCorruptFile(file);
  try {
    atomicWriteJson(file, createEmptyIndex());
  } catch {
    /* ignore */
  }
  if (backup) {
    console.warn(`[engine] strm-index.json 损坏，已备份到 ${backup}`);
  }
  return createEmptyIndex();
}

/** 原子保存索引；返回实际落盘的对象（updatedAt 会被刷新） */
function saveIndex(dataDir, index) {
  const file = indexPath(dataDir);
  ensureDir(path.dirname(file));
  const normalized = normalizeIndex(index) || createEmptyIndex();
  normalized.version = INDEX_VERSION;
  normalized.updatedAt = new Date().toISOString();
  atomicWriteJson(file, normalized);
  return normalized;
}

/** 写入/覆盖条目，返回索引 key */
function upsertEntry(index, entry) {
  const normalized = normalizeEntry(entry);
  if (!normalized) throw new Error('无效的索引条目');
  const key = entryKey(normalized.sourceApiBase, normalized.vodId);
  index.entries[key] = normalized;
  return key;
}

/** 删除条目，返回是否删除成功 */
function removeEntry(index, key) {
  if (!index || !index.entries || !Object.prototype.hasOwnProperty.call(index.entries, key)) {
    return false;
  }
  delete index.entries[key];
  return true;
}

function findEntry(index, sourceApiBase, vodId) {
  if (!index || !index.entries) return null;
  const key = entryKey(sourceApiBase, vodId);
  const entry = index.entries[key];
  return entry ? { key, entry } : null;
}

/** 索引中所有被引用的绝对路径（用于孤儿清理差集） */
function collectStrmPaths(index) {
  const set = new Set();
  if (!index || !index.entries) return set;
  for (const entry of Object.values(index.entries)) {
    for (const p of entry.strmPaths || []) {
      if (typeof p === 'string' && p) set.add(path.resolve(p));
    }
  }
  return set;
}

module.exports = {
  INDEX_VERSION,
  indexPath,
  entryKey,
  createEmptyIndex,
  normalizeIndex,
  loadIndex,
  saveIndex,
  upsertEntry,
  removeEntry,
  findEntry,
  collectStrmPaths,
  // 简写别名
  upsert: upsertEntry,
  remove: removeEntry,
};
