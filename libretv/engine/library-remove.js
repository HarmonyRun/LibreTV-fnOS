'use strict';

/**
 * 「从媒体库移除」共享逻辑（MCP remove_from_library 与引擎 remove 队列任务共用）。
 *
 * 数据源：strm-index.json 的 entries + STRM 根目录。
 * 流程：匹配条目 → 解析资源目录（第一层目录，可只删某一季）→ 计划 → 删目录 →
 *       按删除目录裁剪/移除索引条目。
 * 本模块只做纯计算与文件系统操作，不读写索引文件、不触发媒体库刷新（由调用方负责）。
 */

const fs = require('fs');
const path = require('path');
const { isInside } = require('./fs-util');

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 片名归一化：去空白、季后缀与常见标点，用于模糊匹配（避免「庆余年」误删「庆余年2」时配合精确优先） */
function normalizeTitle(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/第[一二三四五六七八九十百零\d]+季/g, '')
    .replace(/season\s*\d+/g, '')
    .replace(/[：:·・,，.。!！?？'"“”‘’()（）\[\]【】\-_—–/\\|]/g, '');
}

/** 从目录名解析季度：Season 01 / S01 / 第1季 / 第一季；无法解析返回 null */
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

/** 资源根目录 = strmRoot 下的第一层目录（如 庆余年 第一季 (2019)） */
function resourceRootOfPath(root, absPath) {
  if (!root) return null;
  const abs = path.resolve(String(absPath));
  if (!isInside(root, abs) || abs === root) return null;
  const first = path.relative(root, abs).split(path.sep)[0];
  if (!first || first === '..') return null;
  return path.join(root, first);
}

/** 条目涉及的所有资源根目录（去重） */
function entryResourceRoots(root, entry) {
  const roots = new Set();
  for (const p of (entry && entry.strmPaths) || []) {
    const r = resourceRootOfPath(root, p);
    if (r) roots.add(r);
  }
  return [...roots];
}

/** 资源目录下的 Season 目录列表（升序） */
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

/** 递归统计目录内文件数（失败返回 0） */
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

/**
 * 按 key / 来源+id / 标题（+年份/类型）匹配索引条目。
 * @param {Array<{key:string}>} entries allEntries() 形态（每项含 key）
 * @param {object} args {key?, sourceApiBase?, vodId?, title?, year?, type?}
 */
function matchEntries(entries, args = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const key = typeof args.key === 'string' ? args.key.trim() : '';
  const sourceApiBase = typeof args.sourceApiBase === 'string' ? args.sourceApiBase.trim().replace(/\/+$/, '') : '';
  const vodId = args.vodId === undefined || args.vodId === null ? '' : String(args.vodId).trim();
  const year = args.year === undefined || args.year === null ? '' : String(args.year).trim();
  const type = typeof args.type === 'string' ? args.type : '';

  if (key) return list.filter((e) => e.key === key);
  if (sourceApiBase && vodId) return list.filter((e) => e.key === `${sourceApiBase}::${vodId}`);
  const nq = normalizeTitle(args.title);
  return list.filter((e) => {
    if (type && e.type && e.type !== type) return false;
    if (year && e.year && String(e.year) !== year) return false;
    if (!nq) return false;
    const nt = normalizeTitle(e.title);
    return nt === nq || nt.includes(nq) || nq.includes(nt);
  });
}

/** 校验待删除目录：必须在 STRM 根目录内且不是根目录自身 */
function assertDeletableDir(root, dir) {
  const abs = path.resolve(dir);
  if (!root) throw new Error('STRM 根目录未配置');
  if (!isInside(root, abs) || abs === path.resolve(root)) {
    throw new Error(`拒绝删除目录（不在 STRM 根目录内或为根目录）: ${abs}`);
  }
  return abs;
}

/** 计算多资源目录歧义时的候选信息（供 MCP/UI 提示用户用 key 精确指定） */
function candidatesForRoots(root, rootEntries) {
  const rel = (p) => path.relative(root, p);
  return [...rootEntries.keys()].map((resourceRoot) => ({
    resourceRoot: rel(resourceRoot),
    entries: rootEntries.get(resourceRoot).map((e) => e.title),
    seasons: listSeasonDirs(resourceRoot).map((s) => ({ season: s.season, name: s.name })),
  }));
}

/**
 * 解析移除计划（不产生副作用）。
 * @param {object} options {entries, root, args:{key?,title?,year?,type?,sourceApiBase?,vodId?,season?,all?}}
 * @returns {{ok:true, mode, seasonNum, matches, roots, plan, totalFiles}
 *          |{ok:false, error, candidates?}}
 */
function planRemoval({ entries, root, args = {} } = {}) {
  if (!root) return { ok: false, error: 'STRM 根目录未配置' };
  const seasonRaw = args.season;
  let seasonNum = null;
  if (seasonRaw !== undefined && seasonRaw !== null && seasonRaw !== '') {
    seasonNum = Number(seasonRaw);
    if (!Number.isInteger(seasonNum) || seasonNum < 1) {
      return { ok: false, error: 'season 必须是正整数（1 表示 Season 01）' };
    }
  }
  const all = args.all === true;
  const titleQuery = typeof args.title === 'string' ? args.title : '';

  let matches = matchEntries(entries, args);
  if (matches.length === 0) return { ok: false, error: '没有找到匹配的条目' };
  // 标题优先精确匹配；没有精确匹配时才使用模糊结果，避免「庆余年」误删「庆余年2」
  if (titleQuery.trim()) {
    const nq = normalizeTitle(titleQuery);
    const exact = matches.filter((e) => normalizeTitle(e.title) === nq);
    if (exact.length) matches = exact;
  }

  const rootEntries = new Map();
  for (const entry of matches) {
    for (const resourceRoot of entryResourceRoots(root, entry)) {
      if (!rootEntries.has(resourceRoot)) rootEntries.set(resourceRoot, []);
      rootEntries.get(resourceRoot).push(entry);
    }
  }
  if (!rootEntries.size) {
    return { ok: false, error: '索引条目找不到对应的 STRM 资源目录（可能文件已被移动/删除）' };
  }

  const candidates = () => candidatesForRoots(root, rootEntries);
  let dirs = [];
  let mode = '';

  if (seasonNum !== null) {
    if (rootEntries.size > 1) {
      return {
        ok: false,
        error: '匹配到多个资源目录，无法确定要删除哪一季；请用 key 精确指定单个条目，或先 list_library 确认',
        candidates: candidates(),
      };
    }
    const [onlyRoot] = rootEntries.keys();
    const seasons = listSeasonDirs(onlyRoot);
    const hit = seasons.filter((s) => s.season === seasonNum);
    if (!hit.length) {
      return {
        ok: false,
        error: `未找到 Season ${seasonNum}（可用季：${seasons.map((s) => s.season).join(', ') || '无 Season 目录'}）`,
      };
    }
    dirs = hit.map((s) => s.dir);
    mode = 'season';
  } else {
    if (rootEntries.size > 1 && !all) {
      return {
        ok: false,
        error: '匹配到多个资源目录（可能多季分别成目录，或模糊匹配到多部剧）；确认全部删除请传 all=true，或指定 key 精确删除',
        candidates: candidates(),
      };
    }
    dirs = [...rootEntries.keys()];
    mode = 'resource';
  }

  // 安全校验：每个目录都必须在 STRM 根目录内、且不能是根目录自身
  const uniqueDirs = [...new Set(dirs.map((d) => path.resolve(d)))];
  for (const dir of uniqueDirs) assertDeletableDir(root, dir);

  const rel = (p) => path.relative(root, p);
  const plan = uniqueDirs.map((dir) => ({
    dir,
    resourceRoot: rel(dir),
    files: countFilesRecursive(dir),
  }));
  const totalFiles = plan.reduce((sum, item) => sum + item.files, 0);

  return {
    ok: true,
    mode,
    seasonNum,
    matches,
    roots: uniqueDirs,
    plan,
    totalFiles,
  };
}

/**
 * 执行删除（递归删除计划中的目录）。返回实际删除结果；单目录失败不影响其它目录。
 * @returns {{deletedDirs:string[], deletedFiles:number, failed:Array<{dir,error}>}}
 */
function applyRemoval(plan) {
  const deletedDirs = [];
  const failed = [];
  let deletedFiles = 0;
  for (const item of Array.isArray(plan) ? plan : []) {
    try {
      fs.rmSync(item.dir, { recursive: true, force: true });
      deletedDirs.push(item.dir);
      deletedFiles += Number(item.files) || 0;
    } catch (err) {
      failed.push({ dir: item.dir, error: (err && err.message) || '删除失败' });
    }
  }
  return { deletedDirs, deletedFiles, failed };
}

/**
 * 按已删除目录裁剪索引：条目所有路径都命中 → 移除条目；部分命中 → 裁剪路径与 URL。
 * @returns {{removedKeys:string[], prunedKeys:string[]}}
 */
function removeIndexEntriesByDirs(index, dirs) {
  const removedKeys = [];
  const prunedKeys = [];
  const list = (Array.isArray(dirs) ? dirs : []).map((dir) => path.resolve(String(dir)));
  if (!index || !index.entries) return { removedKeys, prunedKeys };
  for (const [key, entry] of Object.entries(index.entries)) {
    const paths = Array.isArray(entry.strmPaths) ? entry.strmPaths : [];
    const urls = Array.isArray(entry.lastKnownUrls) ? entry.lastKnownUrls : [];
    const keep = [];
    paths.forEach((p, i) => {
      const abs = path.resolve(String(p));
      const hit = list.some((dir) => isInside(dir, abs));
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

module.exports = {
  CN_NUM,
  normalizeTitle,
  parseSeasonNumber,
  resourceRootOfPath,
  entryResourceRoots,
  listSeasonDirs,
  countFilesRecursive,
  matchEntries,
  assertDeletableDir,
  planRemoval,
  applyRemoval,
  removeIndexEntriesByDirs,
};
