'use strict';

/**
 * STRM 命名规范（契约第 5 节）。
 *
 * 电影：<root>/<片名> (<年份>)/<片名> (<年份>).strm
 * 剧集：<root>/<剧名> (<年份>)/Season NN/<剧名> - SxxExx.strm
 * 年份缺失时省略 " (<年份>)"；季号默认 01；无法解析集号时按数组序 1..N。
 */

const path = require('path');

/** 非法文件名字符 → 全角安全字符（保留可读性，避免出现路径分隔符） */
const FULLWIDTH_MAP = {
  '\\': '＼',
  '/': '／',
  ':': '：',
  '*': '＊',
  '?': '？',
  '"': '＂',
  '<': '＜',
  '>': '＞',
  '|': '｜',
};

const ILLEGAL_CHARS_RE = /[\\/:*?"<>|]/g;
// 控制字符（含 DEL）统一替换为空格
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;

const MAX_NAME_LENGTH = 120;
const DEFAULT_TITLE = 'Untitled';

/** 清洗单个文件/目录名：非法字符替换、去首尾空格与点、空标题回退 Untitled */
function safeName(input) {
  let name = input === undefined || input === null ? '' : String(input);
  name = name.replace(CONTROL_CHARS_RE, ' ');
  name = name.replace(ILLEGAL_CHARS_RE, (ch) => FULLWIDTH_MAP[ch] || ' ');
  // 折叠连续空白
  name = name.replace(/\s+/g, ' ').trim();
  // 去掉首尾的点（Windows / SMB 共享对末尾点不友好）
  name = name.replace(/^\.+/, '').replace(/\.+$/, '').trim();
  if (name.length > MAX_NAME_LENGTH) name = name.slice(0, MAX_NAME_LENGTH).trim();
  name = name.replace(/^\.+/, '').replace(/\.+$/, '').trim();
  return name || DEFAULT_TITLE;
}

/** 年份归一化：从 2021 / "2021-05-01" / 2021.0 中提取 4 位年份，失败返回 '' */
function normalizeYear(input) {
  if (input === undefined || input === null) return '';
  const text = String(input).trim();
  if (!text) return '';
  const match = text.match(/(?:19|20)\d{2}/);
  if (!match) return '';
  return match[0];
}

/** 两位补零（超过两位时保留原样，如 123 → "123"） */
function pad2(value) {
  let n = Number(value);
  if (!Number.isFinite(n)) n = 0;
  n = Math.trunc(n);
  if (n < 0) n = 0;
  return String(n).padStart(2, '0');
}

/** "片名 (2021)" 或 "片名" */
function displayName(title, year) {
  const name = safeName(title);
  const y = normalizeYear(year);
  return y ? `${name} (${y})` : name;
}

/** 电影目录/文件相对路径 */
function movieRelativePath(title, year) {
  const base = displayName(title, year);
  return path.join(base, `${base}.strm`);
}

/** 剧集相对路径 */
function episodeRelativePath(title, year, season, episode) {
  const name = safeName(title);
  const y = normalizeYear(year);
  const folder = y ? `${name} (${y})` : name;
  const seasonNo = pad2(season);
  const code = `S${seasonNo}E${pad2(episode)}`;
  return path.join(folder, `Season ${seasonNo}`, `${name} - ${code}.strm`);
}

/** SxxExx 形式的集号 */
function formatEpisodeCode(season, episode) {
  return `S${pad2(season)}E${pad2(episode)}`;
}

const CN_DIGITS = {
  零: 0,
  '〇': 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 };

/** 中文数字/阿拉伯数字 → 整数（支持 一、十二、二十三、一百零五） */
function cnToNumber(input) {
  const text = String(input === undefined || input === null ? '' : input).trim();
  if (!text) return NaN;
  if (/^\d+$/.test(text)) return parseInt(text, 10);
  let section = 0;
  let number = 0;
  for (const ch of text) {
    if (ch in CN_DIGITS) {
      number = CN_DIGITS[ch];
    } else if (ch in CN_UNITS) {
      if (number === 0) number = 1;
      section += number * CN_UNITS[ch];
      number = 0;
    } else {
      return NaN;
    }
  }
  return section + number;
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const int = Math.trunc(n);
  return int >= 0 ? int : fallback;
}

const SEASON_EPISODE_RE = /S(\d{1,2})\s*[._-]?\s*E(\d{1,4})/i;
const SEASON_CN_RE = /第\s*([0-9零〇一二两三四五六七八九十百千]+)\s*季/;
const SEASON_EN_RE = /season\s*(\d{1,3})/i;
const EPISODE_CN_RE = /第\s*([0-9零〇一二两三四五六七八九十百千]+)\s*[集话話期]/;
const EPISODE_PREFIX_RE = /\bEP?\s*(\d{1,4})\b/i;
const EPISODE_PURE_NUMBER_RE = /^\s*(\d{1,4})\s*$/;

/** 只解析季号，返回 null 表示未找到 */
function extractSeason(text) {
  const src = text === undefined || text === null ? '' : String(text);
  let match = src.match(SEASON_EPISODE_RE);
  if (match) return toPositiveInt(match[1], null);
  match = src.match(SEASON_CN_RE);
  if (match) {
    const n = cnToNumber(match[1]);
    return Number.isFinite(n) ? toPositiveInt(n, null) : null;
  }
  match = src.match(SEASON_EN_RE);
  if (match) return toPositiveInt(match[1], null);
  return null;
}

/** 只解析集号，返回 null 表示未找到 */
function extractEpisode(text) {
  const src = text === undefined || text === null ? '' : String(text);
  let match = src.match(SEASON_EPISODE_RE);
  if (match) return toPositiveInt(match[2], null);
  match = src.match(EPISODE_CN_RE);
  if (match) {
    const n = cnToNumber(match[1]);
    return Number.isFinite(n) ? toPositiveInt(n, null) : null;
  }
  match = src.match(EPISODE_PREFIX_RE);
  if (match) return toPositiveInt(match[1], null);
  match = src.match(EPISODE_PURE_NUMBER_RE);
  if (match) return toPositiveInt(match[1], null);
  return null;
}

/** 只提取标题中的季/集，缺失的字段为 null（供 CMS 解析做多级回退） */
function extractSeasonEpisode(text) {
  const src = text === undefined || text === null ? '' : String(text);
  const se = src.match(SEASON_EPISODE_RE);
  if (se) {
    return { season: toPositiveInt(se[1], null), episode: toPositiveInt(se[2], null) };
  }
  return { season: extractSeason(src), episode: extractEpisode(src) };
}

/**
 * 解析剧集标题中的季/集。
 * @param {string} text 剧集标题（可能为空）
 * @param {number} [fallbackEpisode] 解析失败时使用的集号（通常为数组下标 +1）
 * @param {number} [fallbackSeason=1] 解析失败时使用的季号
 * @returns {{season:number, episode:number, seasonParsed:boolean, episodeParsed:boolean}}
 */
function parseSeasonEpisode(text, fallbackEpisode, fallbackSeason) {
  const src = text === undefined || text === null ? '' : String(text);
  let season = null;
  let episode = null;
  const se = src.match(SEASON_EPISODE_RE);
  if (se) {
    season = toPositiveInt(se[1], null);
    episode = toPositiveInt(se[2], null);
  } else {
    season = extractSeason(src);
    episode = extractEpisode(src);
  }
  const seasonParsed = season !== null;
  const episodeParsed = episode !== null;
  return {
    season: seasonParsed ? season : toPositiveInt(fallbackSeason, 1),
    episode: episodeParsed ? episode : toPositiveInt(fallbackEpisode, 1),
    seasonParsed,
    episodeParsed,
  };
}

module.exports = {
  DEFAULT_TITLE,
  FULLWIDTH_MAP,
  safeName,
  normalizeYear,
  pad2,
  displayName,
  movieRelativePath,
  episodeRelativePath,
  formatEpisodeCode,
  cnToNumber,
  extractSeason,
  extractEpisode,
  extractSeasonEpisode,
  parseSeasonEpisode,
};
