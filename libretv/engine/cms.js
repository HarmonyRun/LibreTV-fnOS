'use strict';

/**
 * 苹果 CMS V10 请求与解析（纯函数为主，便于单测）。
 *
 * 搜索：{api}?ac=videolist&wd={keyword}
 * 详情：{api}?ac=videolist&ids={id}
 *
 * vod_play_url：`线路1$$$线路2`，线路内 `集名$URL#集名$URL`。
 * 多线路选择策略（Lead 实测补充）：
 *   1) 优先选「m3u8 占比最高」的线路（全部/主要剧集为 .m3u8 的线路优先，避免 line0 的 /share/ 网页中转页）
 *   2) 其次任意包含 .m3u8 的线路
 *   3) 都无 m3u8 时退化为第一条含 http(s) 剧集的线路，并标记 no-m3u8 警告
 */

const naming = require('./naming');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 1;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function str(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value.trim() : String(value).trim();
}

function buildQueryUrl(apiBase, params) {
  const raw = str(apiBase);
  if (!raw) throw new Error('apiBase 不能为空');
  const url = new URL(raw);
  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, value === undefined || value === null ? '' : String(value));
  }
  return url.href;
}

/** 搜索地址 */
function searchUrl(apiBase, keyword) {
  return buildQueryUrl(apiBase, { ac: 'videolist', wd: keyword === undefined || keyword === null ? '' : keyword });
}

/** 详情地址 */
function detailUrl(apiBase, vodId) {
  return buildQueryUrl(apiBase, { ac: 'videolist', ids: vodId === undefined || vodId === null ? '' : vodId });
}

function requestHeaders(extra) {
  return {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    ...(extra || {}),
  };
}

/**
 * GET JSON 文本，15s 超时，失败（网络/5xx）重试 1 次。
 * 返回 {status,text}；4xx/5xx/网络错误抛出带 status 的 Error。
 */
async function fetchJson(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持 fetch');
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const retries = Number.isFinite(options.retries) ? Math.max(0, options.retries) : DEFAULT_RETRIES;
  const attempts = retries + 1;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let res;
    try {
      const signal =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(timeoutMs)
          : undefined;
      res = await fetchImpl(url, {
        method: 'GET',
        headers: requestHeaders(options.headers),
        redirect: 'follow',
        signal,
      });
    } catch (err) {
      lastError = new Error(`网络错误: ${(err && err.message) || err}`);
      if (attempt < attempts - 1) continue;
      throw lastError;
    }

    const status = Number(res && res.status) || 0;
    let text = '';
    try {
      text = typeof res.text === 'function' ? await res.text() : '';
    } catch (err) {
      lastError = new Error(`读取响应失败: ${(err && err.message) || err}`);
      if (attempt < attempts - 1) continue;
      throw lastError;
    }

    if (status >= 500) {
      lastError = new Error(`HTTP ${status}`);
      lastError.status = status;
      if (attempt < attempts - 1) continue;
      throw lastError;
    }
    if (status >= 400) {
      const error = new Error(`HTTP ${status}`);
      error.status = status;
      if (status === 404) error.notFound = true;
      throw error;
    }
    return { status, text };
  }
  throw lastError || new Error('请求失败');
}

/** 是否 m3u8 直链 */
function isM3u8Url(url) {
  return /\.m3u8(?:[?#]|$)/i.test(str(url));
}

/**
 * 相对 URL 补全：优先使用 sourceApiBase 的 origin（契约 5）。
 * 非 http(s) 协议或无法解析时返回 ''。
 */
function resolveUrl(rawUrl, sourceApiBase) {
  const value = str(rawUrl);
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('//')) {
    try {
      return `${new URL(str(sourceApiBase)).protocol}${value}`;
    } catch {
      return '';
    }
  }
  // 其它协议（ftp/magnet/ed2k 等）不写入 STRM
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return '';
  const base = str(sourceApiBase);
  if (!/^https?:\/\//i.test(base)) return '';
  try {
    return new URL(value, new URL(base).origin + '/').href;
  } catch {
    return '';
  }
}

/**
 * 解析 vod_play_url 为线路数组。
 * @returns {Array<{index:number,name:string,episodes:Array<{title,url,season,episode}>}>}
 */
function parsePlayUrl(playUrl, options = {}) {
  const raw = str(playUrl);
  if (!raw) return [];
  const sourceApiBase = str(options.sourceApiBase);
  const playFrom = str(options.playFrom);
  const fromParts = playFrom ? playFrom.split('$$$') : [];
  const lineSegments = raw.split('$$$');
  const lines = [];

  for (let lineIndex = 0; lineIndex < lineSegments.length; lineIndex += 1) {
    const segment = str(lineSegments[lineIndex]);
    if (!segment) continue;
    const lineName = str(fromParts[lineIndex]) || `线路${lineIndex + 1}`;
    const episodes = [];
    const segments = segment.split('#');
    for (const rawEpisode of segments) {
      const episodeText = str(rawEpisode);
      if (!episodeText) continue;
      let title = '';
      let url = '';
      const dollarIndex = episodeText.indexOf('$');
      if (dollarIndex >= 0) {
        title = str(episodeText.slice(0, dollarIndex));
        url = str(episodeText.slice(dollarIndex + 1));
      } else {
        url = episodeText;
      }
      const resolved = resolveUrl(url, sourceApiBase);
      if (!resolved) continue;
      // 解析顺序：集标题 → 线路名 → 默认值；季号默认 1，集号默认数组序
      const parsedTitle = naming.extractSeasonEpisode(title);
      const lineSeason = naming.extractSeason(lineName);
      let season = parsedTitle.season;
      if (season === null) season = lineSeason;
      if (season === null) season = 1;
      let episode = parsedTitle.episode;
      if (episode === null) episode = episodes.length + 1;
      episodes.push({
        title: title || `第${episodes.length + 1}集`,
        url: resolved,
        season,
        episode,
      });
    }
    if (episodes.length > 0) {
      lines.push({ index: lineIndex, name: lineName, episodes });
    }
  }
  return lines;
}

/**
 * 选择线路：m3u8 占比最高者优先（全部 m3u8 > 部分 m3u8），同分取靠前线路，
 * 都没有 m3u8 时取第一条有效线路并标记 no-m3u8。
 * @returns {{index:number,name:string,episodes:Array,m3u8Ratio:number,m3u8Count:number,reason:string,noM3u8:boolean}|null}
 */
function choosePlayLine(lines) {
  if (!Array.isArray(lines)) return null;
  const valid = lines.filter((line) => line && Array.isArray(line.episodes) && line.episodes.length > 0);
  if (valid.length === 0) return null;

  let best = null;
  let bestRatio = -1;
  let bestCount = -1;
  for (const line of valid) {
    const m3u8Count = line.episodes.filter((ep) => isM3u8Url(ep.url)).length;
    const ratio = m3u8Count / line.episodes.length;
    if (ratio > bestRatio || (ratio === bestRatio && m3u8Count > bestCount)) {
      best = line;
      bestRatio = ratio;
      bestCount = m3u8Count;
    }
  }

  let reason = 'no-m3u8';
  let noM3u8 = true;
  if (bestCount > 0 && bestRatio === 1) {
    reason = 'all-m3u8';
    noM3u8 = false;
  } else if (bestCount > 0) {
    reason = 'partial-m3u8';
    noM3u8 = false;
  }
  return {
    index: best.index,
    name: best.name,
    episodes: best.episodes,
    m3u8Ratio: bestRatio,
    m3u8Count: bestCount,
    reason,
    noM3u8,
  };
}

function normalizeCode(code) {
  const n = Number(code);
  return Number.isFinite(n) ? n : NaN;
}

function extractVodList(data) {
  const tryValue = (value) => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      if (value.vod_id != null || value.vod_name != null || value.vod_play_url != null) return [value];
    }
    return undefined;
  };
  const candidates = [
    data.list,
    data.vod,
    data.data,
    data.data && data.data.list,
    data.data && data.data.vod,
    data.result && data.result.list,
    data.result && data.result.vod,
  ];
  for (const candidate of candidates) {
    const list = tryValue(candidate);
    if (list !== undefined) return list;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'list') && data.list == null) return [];
  if (Object.prototype.hasOwnProperty.call(data, 'vod') && data.vod == null) return [];
  return null;
}

function detailResponseError(message, extra) {
  return {
    ok: false,
    notFound: false,
    transient: true,
    error: message,
    ...(extra || {}),
  };
}

/**
 * 解析详情响应 JSON 文本（纯函数）。
 * @returns 成功 {ok:true, vod, lines, chosenLine, chosenUrls, warnings}
 *          条目不存在 {ok:false, notFound:true, error}
 *          临时错误 {ok:false, notFound:false, transient:true, error}
 */
function parseDetailResponse(text, options = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return detailResponseError('响应不是合法 JSON');
  }
  return parseDetailPayload(data, options);
}

function parseDetailPayload(data, options = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return detailResponseError('响应 JSON 结构无效');
  }
  const list = extractVodList(data);
  if (list === null) {
    const code = normalizeCode(data.code);
    // 苹果 CMS：code=1 表示成功；成功但无 list 字段等价于条目不存在
    if (code === 1) {
      return { ok: false, notFound: true, error: '源站响应中不存在 list 数据' };
    }
    const msg = str(data.msg) || str(data.message);
    return detailResponseError(msg ? `源站返回错误: ${msg}` : '源站响应缺少 list/vod 字段');
  }
  if (list.length === 0) {
    const msg = str(data.msg) || str(data.message);
    return { ok: false, notFound: true, error: msg || '源站无该条目' };
  }
  const rawVod = list[0];
  if (!rawVod || typeof rawVod !== 'object') {
    return detailResponseError('响应 list[0] 不是对象');
  }

  const sourceApiBase = str(options.sourceApiBase);
  const fallbackTitle = str(options.fallbackTitle);
  const vodId = str(rawVod.vod_id) || str(options.vodId);
  const title = str(rawVod.vod_name) || fallbackTitle;
  const year = naming.normalizeYear(rawVod.vod_year || rawVod.vod_pubdate || rawVod.vod_year_text || '');
  const playUrl = str(rawVod.vod_play_url) || str(rawVod.vod_playurl);
  const playFrom = str(rawVod.vod_play_from) || str(rawVod.vod_playfrom);
  const lines = parsePlayUrl(playUrl, { playFrom, sourceApiBase });
  const chosenLine = choosePlayLine(lines);
  const chosenUrls = chosenLine ? chosenLine.episodes.map((ep) => ep.url) : [];
  const warnings = [];
  if (chosenLine && chosenLine.noM3u8) warnings.push('no-m3u8');

  return {
    ok: true,
    vod: {
      vodId,
      title,
      year,
      typeName: str(rawVod.type_name),
      remarks: str(rawVod.vod_remarks),
      pic: str(rawVod.vod_pic),
      playFrom,
    },
    lines,
    chosenLine,
    chosenUrls,
    warnings,
    raw: rawVod,
  };
}

/**
 * 请求并解析详情。永不抛出异常（网络/解析错误以 {ok:false} 返回）。
 * @param {object} options {sourceApiBase, vodId, sourceDetailBase?, fetchImpl?, timeoutMs?, retries?}
 */
async function fetchDetail(options = {}) {
  const sourceApiBase = str(options.sourceApiBase);
  if (!/^https?:\/\//i.test(sourceApiBase)) {
    return { ok: false, notFound: false, transient: false, error: 'sourceApiBase 无效' };
  }
  const vodId = str(options.vodId);
  if (!vodId) {
    return { ok: false, notFound: false, transient: false, error: 'vodId 不能为空' };
  }
  // sourceDetailBase 预留给需要爬详情页的源；当前 CMS 直连使用 sourceApiBase
  let response;
  try {
    response = await fetchJson(detailUrl(sourceApiBase, vodId), {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      retries: options.retries,
    });
  } catch (err) {
    if (err && (err.notFound || err.status === 404)) {
      return { ok: false, notFound: true, error: 'HTTP 404' };
    }
    return {
      ok: false,
      notFound: false,
      transient: true,
      error: (err && err.message) || '请求详情失败',
    };
  }
  return parseDetailResponse(response.text, {
    sourceApiBase,
    vodId,
    fallbackTitle: options.vodName,
  });
}

module.exports = {
  UA,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES,
  buildQueryUrl,
  searchUrl,
  detailUrl,
  fetchJson,
  resolveUrl,
  isM3u8Url,
  parsePlayUrl,
  choosePlayLine,
  extractVodList,
  parseDetailPayload,
  parseDetailResponse,
  fetchDetail,
};
