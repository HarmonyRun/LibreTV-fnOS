import {
  decryptAes128CbcPrefix,
  looksLikeMp4,
  parseMp4VideoResolution,
  parseTsVideoResolution,
} from './codec-parse';
import { cmsRequestHeaders, parseDetail, parseDetailPageHtml } from './cms-parser';
import { fetchUpstream } from './fetch-utils';
import { inferHeightFromBitrate } from './quality';
import { checkUpstreamAllowed } from './ssrf';
import type { QualityProbeItem, QualityProbeResult, SourceConfig } from './types';

/**
 * 服务端画质探测。
 *
 * 画质不在 CMS 搜索接口里，只写在 m3u8 内部（#EXT-X-STREAM-INF 的 RESOLUTION），
 * 所以「搜索阶段就知道哪个源是 1080P」只能靠真实拉取一次播放列表。
 *
 * 两级策略：
 * 1. 多码率源：master playlist 里就有各档位分辨率，解析文本即可（最快）；
 * 2. 单码率源（大量采集站如此）：m3u8 里什么都没有，下沉到分片本身，
 *    从 H.264 的 SPS / MP4 的 VisualSampleEntry 里把分辨率挖出来。
 *
 * 剩下的盲区只有两种，前端按「未知」而非「标清」展示：
 * - HEVC/H.265 的 TS 分片（SPS 跳过逻辑复杂，暂无可靠实现）；
 * - 有防盗链或要求特殊鉴权的源：请求被拒。
 */

/** m3u8 读取上限：master playlist 通常 < 1KB，媒体列表可能几百 KB，只读够解析的头部 */
const M3U8_MAX_BYTES = 64 * 1024;

/** 分片前缀：SPS / moov 必然在开头，96KB 足够，不必为几十 MB 的分片买单 */
const SEGMENT_PREFIX_BYTES = 96 * 1024;

/** fMP4 的 init segment 很小，moov 就在里面 */
const INIT_PREFIX_BYTES = 64 * 1024;

/** 单条探测总死线：与搜索的单源死线同量级，避免一个慢源拖住整批 */
export const QUALITY_PROBE_TIMEOUT_MS = 8000;

/**
 * 分片解析的独立预算。
 * 走这条路径意味着 m3u8 已经拿到了，此时源本身是好的；若分片下载慢而耗尽总死线，
 * 会把「已探到但没探出画质」误报成「探测失败」，所以单独限一笔更短的预算。
 */
const SEGMENT_BUDGET_MS = 4000;

/** 从 m3u8 文本解析最高档的短边高度；非 master playlist（无 STREAM-INF）返回 undefined */
export function parseBestHeight(text: string): number | undefined {
  if (!text.includes('#EXT-X-STREAM-INF')) return undefined;
  let best: number | undefined;
  let pending: { bandwidth: number; height?: number } | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const bandwidth = parseInt(line.match(/BANDWIDTH=(\d+)/)?.[1] || '0', 10);
      const resolution = line.match(/RESOLUTION=(\d+)x(\d+)/);
      // 取短边而非第二个数字：档位本就按短边定义（720P = 1280×720 的 720），
      // 采集站常把宽高写反（如把 1280×720 写成 720x1280），按 height 取会得到 1280 → 标成 2K
      pending = {
        bandwidth,
        height: resolution
          ? Math.min(parseInt(resolution[1], 10), parseInt(resolution[2], 10))
          : undefined,
      };
      continue;
    }
    if (!line || line.startsWith('#') || !pending) continue;
    // 只有 BANDWIDTH 的源站按常见转码参数反推高度，与播放器的档位命名口径一致
    const height = pending.height ?? (pending.bandwidth > 0 ? inferHeightFromBitrate(pending.bandwidth) : undefined);
    if (height && (best === undefined || height > best)) best = height;
    pending = undefined;
  }
  return best;
}

/** 媒体列表里解析分片所需的片段信息 */
export interface MediaPlaylistInfo {
  initUri?: string;
  firstSegment?: string;
  keyMethod?: string;
  keyUri?: string;
  keyIv?: Uint8Array;
  mediaSequence: number;
}

function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const value = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(value)) return undefined;
    out[i] = value;
  }
  return out;
}

/** 解析媒体列表：init segment、第一个分片、加密方式与 IV */
export function parseMediaPlaylist(text: string): MediaPlaylistInfo {
  const info: MediaPlaylistInfo = { mediaSequence: 0 };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      info.initUri = line.match(/URI="([^"]+)"/)?.[1];
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      info.keyMethod = line.match(/METHOD=([^,]+)/)?.[1]?.trim();
      info.keyUri = line.match(/URI="([^"]+)"/)?.[1];
      const iv = line.match(/IV=0x([0-9a-fA-F]+)/)?.[1];
      info.keyIv = iv ? hexToBytes(iv) : undefined;
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const seq = parseInt(line.slice(line.indexOf(':') + 1).trim(), 10);
      info.mediaSequence = Number.isNaN(seq) ? 0 : seq;
      continue;
    }
    // 第一个非注释行即首个分片（可能是相对路径）
    if (!line.startsWith('#') && info.firstSegment === undefined) {
      info.firstSegment = line;
    }
  }
  return info;
}

/** HLS 规定未显式给 IV 时用媒体序列号作大端 128 位 IV */
function defaultIv(sequence: number): Uint8Array {
  const iv = new Uint8Array(16);
  const seq = sequence >>> 0;
  iv[12] = (seq >>> 24) & 0xff;
  iv[13] = (seq >>> 16) & 0xff;
  iv[14] = (seq >>> 8) & 0xff;
  iv[15] = seq & 0xff;
  return iv;
}

/** 只读取响应体前 maxBytes 字节：分片动辄几十 MB，全量拉取纯属浪费 */
async function readBytesPrefix(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // 提前放弃剩余 body：不 cancel 会让连接挂着等上游写完
    reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** 只读取响应体前 maxBytes 字符（m3u8 用） */
async function readTextPrefix(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}

/** 源站根地址：探测时作为 Referer，绕过最常见的 Referer 防盗链 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** 探测阶段的请求头：与播放时的表现尽量一致，避免被防盗链拦下 */
function probeHeaders(source: SourceConfig): Record<string, string> {
  return {
    'User-Agent': cmsRequestHeaders()['User-Agent'],
    Referer: `${originOf(source.url)}/`,
    Accept: '*/*',
  };
}

function resolveUrl(base: string, ref: string): string | undefined {
  try {
    return new URL(ref, base).toString();
  } catch {
    return undefined;
  }
}

/** 拉取一段字节前缀；SSRF 拦截或请求失败都返回 undefined */
async function fetchBytesPrefix(
  url: string,
  maxBytes: number,
  source: SourceConfig,
  signal: AbortSignal
): Promise<Uint8Array | undefined> {
  const verdict = await checkUpstreamAllowed(url);
  if (!verdict.ok) return undefined;
  const res = await fetchUpstream(url, {
    timeoutMs: 6000,
    headers: probeHeaders(source),
    signal,
  });
  if (!res.ok) return undefined;
  return readBytesPrefix(res, maxBytes);
}

/**
 * 从分片本身解析分辨率（单码率源的兜底路径）。
 * 返回 undefined 表示仍测不出——前端显示「未知」，待播放后由实测补上。
 */
async function probeSegmentResolution(
  text: string,
  playlistUrl: string,
  source: SourceConfig,
  signal: AbortSignal
): Promise<number | undefined> {
  const list = parseMediaPlaylist(text);
  if (!list.firstSegment) return undefined;

  // fMP4：moov 在 init segment 里，比媒体分片小得多且一定含分辨率，优先走这条
  if (list.initUri) {
    const initUrl = resolveUrl(playlistUrl, list.initUri);
    if (initUrl) {
      const buf = await fetchBytesPrefix(initUrl, INIT_PREFIX_BYTES, source, signal);
      const found = buf ? parseMp4VideoResolution(buf) : undefined;
      if (found) return found.height;
    }
  }

  const segmentUrl = resolveUrl(playlistUrl, list.firstSegment);
  if (!segmentUrl) return undefined;
  let buf = await fetchBytesPrefix(segmentUrl, SEGMENT_PREFIX_BYTES, source, signal);
  if (!buf || buf.length === 0) return undefined;

  if (list.keyMethod && list.keyMethod !== 'NONE') {
    // SAMPLE-AES 是按采样加密的，服务端拿不到分片级的解密上下文，直接放弃
    if (list.keyMethod !== 'AES-128' || !list.keyUri) return undefined;
    const keyUrl = resolveUrl(playlistUrl, list.keyUri);
    if (!keyUrl) return undefined;
    const key = await fetchBytesPrefix(keyUrl, 32, source, signal);
    if (!key || key.length < 16) return undefined;
    buf = decryptAes128CbcPrefix(buf, key, list.keyIv ?? defaultIv(list.mediaSequence));
  }

  // 按内容判断容器比按扩展名可靠：不少源的分片没有扩展名
  if (looksLikeMp4(buf)) return parseMp4VideoResolution(buf)?.height;
  return parseTsVideoResolution(buf)?.height;
}

/** 取影片的播放地址列表（与 /api/detail 同逻辑：列表接口优先，拿不到再爬详情页） */
async function fetchEpisodes(source: SourceConfig, id: string, signal: AbortSignal): Promise<string[]> {
  const api = `${source.url.replace(/\/+$/, '')}?ac=videolist&ids=${encodeURIComponent(id)}`;
  const res = await fetchUpstream(api, { timeoutMs: 6000, headers: cmsRequestHeaders(), signal });
  if (res.ok) {
    try {
      const detail = parseDetail(await res.json(), source);
      if (detail.episodes.length > 0) return detail.episodes;
    } catch {
      // 列表接口无内容 → 继续尝试详情页
    }
  }

  // detail 缺失时用接口地址的 origin 推导详情页根地址（与 /api/detail 的推导口径一致）
  const detailRoot = (source.detail || originOf(source.url)).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(detailRoot)) return [];
  const verdict = await checkUpstreamAllowed(detailRoot);
  if (!verdict.ok) return [];
  const detailRes = await fetchUpstream(`${detailRoot}/index.php/vod/detail/id/${id}.html`, {
    timeoutMs: 6000,
    headers: { 'User-Agent': cmsRequestHeaders()['User-Agent'] },
    signal,
  });
  if (!detailRes.ok) return [];
  return parseDetailPageHtml(await detailRes.text(), source).episodes;
}

/**
 * 探测顺序：中间集优先，探不出再退到最后一集。
 *
 * 取中间集是因为部分源第一集是预告/广告片；但采集站常有个别集的分片缺失、加密或换过编码，
 * 中间集恰好命中这种集，整部剧就一直是「未知」——用户不点进播放器的话没有实测回填的机会，
 * 一次探不出等于永久未知，所以电视剧（多集）补一次最后一集。
 * 单集影片（电影）无集可换，直接返回唯一那一集。
 */
export function probeEpisodeOrder(episodes: string[]): string[] {
  if (episodes.length < 2) return episodes.slice(0, 1);
  const mid = episodes[Math.floor(episodes.length / 2)] ?? episodes[0];
  const last = episodes[episodes.length - 1];
  return mid === last ? [mid] : [mid, last];
}

/** 探测单集地址：m3u8 走清单 → 分片两级，mp4 直链直接读 moov */
async function probeEpisode(
  target: string,
  source: SourceConfig,
  merged: AbortSignal,
  signal?: AbortSignal
): Promise<{ height?: number; error?: string }> {
  // 末尾允许 ?query / #fragment：不少源在 .m3u8 后挂鉴权参数或分片锚点
  const isM3u8 = /\.m3u8([?#]|$)/i.test(target);

  if (!isM3u8) {
    // mp4 直链：moov 里有分辨率。未 faststart 的文件 moov 在尾部，前缀拿不到 → 仍未知
    if (!/\.mp4([?#]|$)/i.test(target)) return {};
    const buf = await fetchBytesPrefix(target, SEGMENT_PREFIX_BYTES, source, merged);
    return { height: buf ? parseMp4VideoResolution(buf)?.height : undefined };
  }

  const res = await fetchUpstream(target, {
    timeoutMs: 6000,
    headers: probeHeaders(source),
    signal: merged,
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const text = await readTextPrefix(res, M3U8_MAX_BYTES);

  const height = parseBestHeight(text);
  if (height !== undefined) return { height };

  // 单码率媒体列表：m3u8 里没有档位信息，下沉到分片挖分辨率
  return { height: await withSegmentBudget(target, text, source, merged, signal) };
}

/**
 * 探测单条「源 + 影片」的画质。
 * 返回的 height 为 undefined 表示「测不出」（单码率 / 直链 / 被拒），而非请求失败——
 * 失败时带 error，前端据此区分「未知」与「探测失败」两种状态。
 */
export async function probeQuality(item: QualityProbeItem, signal?: AbortSignal): Promise<QualityProbeResult> {
  const { source, id } = item;
  const base: QualityProbeResult = { sourceKey: source.key, vodId: id };

  if (!/^https?:\/\//.test(source.url || '') || !/^[\w-]+$/.test(id)) {
    return { ...base, error: '无效的源或影片 ID' };
  }
  const verdict = await checkUpstreamAllowed(source.url);
  if (!verdict.ok) return { ...base, error: verdict.reason };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('画质探测超时', 'TimeoutError')), QUALITY_PROBE_TIMEOUT_MS);
  // 客户端断开（关闭面板/切页）与单条死线合并为一个 signal
  const signals = signal ? [signal, controller.signal] : [controller.signal];
  const merged = AbortSignal.any(signals);

  try {
    const episodes = await fetchEpisodes(source, id, merged);
    if (episodes.length === 0) return { ...base, error: '未找到播放资源' };

    const startedAt = Date.now();
    let lastError: string | undefined;
    for (const target of probeEpisodeOrder(episodes)) {
      const r = await probeEpisode(target, source, merged, signal);
      if (r.height !== undefined) return { ...base, height: r.height };
      if (r.error) lastError = r.error;
      // 源站级拒绝（401/403）换集也不会变，不必再耗一轮超时
      if (lastError && /^HTTP (401|403)$/.test(lastError)) break;
      // 慢源换集重试会把 8s 总死线打穿，反而把「未知」变成「探测失败」：时间过半就不再换集
      if (Date.now() - startedAt > QUALITY_PROBE_TIMEOUT_MS / 2) break;
    }
    return lastError ? { ...base, error: lastError } : base;
  } catch (err) {
    // 客户端主动中止：不算失败，也不该污染缓存
    if (signal?.aborted) throw err;
    return { ...base, error: err instanceof Error ? err.message : '探测失败' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 分片解析阶段的独立预算。
 * 走到这里说明 m3u8 已经拿到、源是通的，所以这一阶段的失败只当作「没探出画质」，
 * 不能升级成探测失败——否则前端会把一个好源标成「未探到」。
 */
async function withSegmentBudget(
  playlistUrl: string,
  text: string,
  source: SourceConfig,
  merged: AbortSignal,
  clientSignal?: AbortSignal
): Promise<number | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('分片解析超时', 'TimeoutError')), SEGMENT_BUDGET_MS);
  try {
    return await probeSegmentResolution(text, playlistUrl, source, AbortSignal.any([merged, controller.signal]));
  } catch {
    if (clientSignal?.aborted) throw new DOMException('已取消', 'AbortError');
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
