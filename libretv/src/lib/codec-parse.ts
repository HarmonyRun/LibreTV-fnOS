import { createDecipheriv } from 'node:crypto';

/**
 * 直接从媒体分片里解析分辨率。
 *
 * 存在的理由：大量采集源给的是**单码率 m3u8**（甚至 mp4 直链），master playlist 里
 * 没有 #EXT-X-STREAM-INF:RESOLUTION，服务端光靠读 m3u8 永远拿不到画质。
 * 但分辨率其实就写在视频流的编码数据里——H.264 的 SPS NAL、MP4 的 VisualSampleEntry。
 * 所以「测不出」时拉一小段分片前缀，从编码层把它挖出来。
 *
 * 只做够用的部分：读前缀（几十 KB，SPS 必然在分片开头）、只解析必要的头部字段。
 * 不做完整 demux，也不解码像素。
 */

export interface MediaResolution {
  width: number;
  height: number;
}

/** H.264 里带 chroma_format_idc 等扩展字段的 profile（Baseline/Main 没有这些） */
const H264_HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/** chroma_format_idc → [SubWidthC, SubHeightC]，用于把裁剪偏移换算成像素 */
function chromaSubsampling(chromaFormatIdc: number): [number, number] {
  switch (chromaFormatIdc) {
    case 1: // 4:2:0
      return [2, 2];
    case 2: // 4:2:2
      return [2, 1];
    default: // 0 单色 / 3 4:4:4
      return [1, 1];
  }
}

/** 按位读取器：SPS 是变长位流（exp-golomb），不能按字节读 */
class BitReader {
  private pos = 0;

  constructor(private readonly data: Uint8Array) {}

  readBits(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.data[this.pos >> 3];
      if (byte === undefined) throw new Error('位流已耗尽');
      value = (value << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return value;
  }

  /** 无符号 exp-golomb */
  readUE(): number {
    let zeros = 0;
    while (this.readBits(1) === 0) {
      zeros++;
      if (zeros > 32) throw new Error('非法的 exp-golomb 编码');
    }
    if (zeros === 0) return 0;
    return (1 << zeros) - 1 + this.readBits(zeros);
  }

  /** 有符号 exp-golomb（scaling list 与部分语法元素用） */
  readSE(): number {
    const k = this.readUE();
    return k % 2 === 1 ? (k + 1) / 2 : -k / 2;
  }
}

/**
 * 去掉防竞争字节：编码时把 00 00 00 / 00 00 01 之类的序列插成 00 00 03 xx，
 * 解析前必须还原，否则后续的 exp-golomb 会读到错误的值。
 */
export function unescapeRbsp(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (let i = 0; i < src.length; i++) {
    const byte = src[i];
    if (zeros === 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return new Uint8Array(out);
}

/** 跳过 scaling list：High profile 常见，跳错位数后面全乱 */
function skipScalingLists(reader: BitReader, chromaFormatIdc: number): void {
  const count = chromaFormatIdc !== 3 ? 8 : 12;
  for (let i = 0; i < count; i++) {
    if (reader.readBits(1) === 0) continue;
    const size = i < 6 ? 16 : 64;
    for (let j = 0; j < size; j++) reader.readSE();
  }
}

/**
 * 解析 H.264 SPS 得到画面尺寸。
 * 读到 vui_parameters 就停——后面的字段对分辨率没有影响。
 */
export function parseH264Sps(rbsp: Uint8Array): MediaResolution | undefined {
  try {
    const reader = new BitReader(rbsp);
    const profileIdc = reader.readBits(8);
    reader.readBits(8); // constraint_set flags + reserved
    reader.readBits(8); // level_idc
    reader.readUE(); // seq_parameter_set_id

    let chromaFormatIdc = 1;
    if (H264_HIGH_PROFILES.has(profileIdc)) {
      chromaFormatIdc = reader.readUE();
      if (chromaFormatIdc === 3) reader.readBits(1); // separate_colour_plane_flag
      reader.readUE(); // bit_depth_luma_minus8
      reader.readUE(); // bit_depth_chroma_minus8
      reader.readBits(1); // qpprime_y_zero_transform_bypass_flag
      if (reader.readBits(1)) skipScalingLists(reader, chromaFormatIdc);
    }

    reader.readUE(); // log2_max_frame_num_minus4
    const picOrderCntType = reader.readUE();
    if (picOrderCntType === 0) {
      reader.readUE(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType === 1) {
      reader.readBits(1); // delta_pic_order_always_zero_flag
      reader.readSE(); // offset_for_non_ref_pic
      reader.readSE(); // offset_for_top_to_bottom_field
      const cycles = reader.readUE();
      for (let i = 0; i < cycles; i++) reader.readSE();
    }

    reader.readUE(); // max_num_ref_frames
    reader.readBits(1); // gaps_in_frame_num_value_allowed_flag
    const widthInMbs = reader.readUE() + 1;
    const heightInMapUnits = reader.readUE() + 1;
    const frameMbsOnly = reader.readBits(1);
    if (!frameMbsOnly) reader.readBits(1); // mb_adaptive_frame_field_flag
    reader.readBits(1); // direct_8x8_inference_flag

    const cropped = reader.readBits(1);
    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;
    if (cropped) {
      cropLeft = reader.readUE();
      cropRight = reader.readUE();
      cropTop = reader.readUE();
      cropBottom = reader.readUE();
    }

    let width = widthInMbs * 16;
    // 隔行扫描时每帧占两个 field，高度要翻倍
    let height = (2 - frameMbsOnly) * heightInMapUnits * 16;
    if (cropped) {
      const [subWidthC, subHeightC] = chromaSubsampling(chromaFormatIdc);
      width -= (cropLeft + cropRight) * subWidthC;
      height -= (cropTop + cropBottom) * subHeightC * (2 - frameMbsOnly);
    }
    if (width <= 0 || height <= 0) return undefined;
    return { width, height };
  } catch {
    // 位流不规则/被截断：宁可返回「未知」，也不要给出一个错的分辨率
    return undefined;
  }
}

/** Annex-B 流的起始码位置（00 00 01） */
function findStartCodes(es: Uint8Array, limit = 64): number[] {
  const positions: number[] = [];
  for (let i = 2; i < es.length && positions.length < limit; i++) {
    if (es[i] === 1 && es[i - 1] === 0 && es[i - 2] === 0) positions.push(i + 1);
  }
  return positions;
}

/** 在 Annex-B 基本流里找 SPS（NAL type 7）的 RBSP */
export function findH264Sps(es: Uint8Array): Uint8Array | undefined {
  const starts = findStartCodes(es);
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] - 3 : es.length;
    if (to <= from) continue;
    const nal = es.subarray(from, to);
    if ((nal[0] & 0x1f) === 7) return unescapeRbsp(nal.subarray(1));
  }
  return undefined;
}

// ——— MPEG-TS ———

const TS_PACKET_SIZE = 188;
const MAX_ES_BYTES = 256 * 1024;

interface TsPacket {
  pid: number;
  payloadStart: boolean;
  payload: Uint8Array;
}

/** 定位 TS 同步位置：允许前面有 padding，靠连续 3 个包头的 0x47 判定 */
function findTsOffset(buf: Uint8Array): number {
  const max = Math.min(buf.length, TS_PACKET_SIZE * 4);
  for (let i = 0; i < max; i++) {
    if (
      buf[i] === 0x47 &&
      buf[i + TS_PACKET_SIZE] === 0x47 &&
      buf[i + TS_PACKET_SIZE * 2] === 0x47
    ) {
      return i;
    }
  }
  // 退化：只要第一个字节是 0x47 就试（有些分片起始处只有一两个包）
  return buf[0] === 0x47 ? 0 : -1;
}

function* readTsPackets(buf: Uint8Array, start: number): Generator<TsPacket> {
  for (let i = start; i + TS_PACKET_SIZE <= buf.length; i += TS_PACKET_SIZE) {
    if (buf[i] !== 0x47) continue; // 同步丢失，跳过这个包
    const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
    const payloadStart = (buf[i + 1] & 0x40) !== 0;
    const hasAdaptation = (buf[i + 3] & 0x20) !== 0;
    const hasPayload = (buf[i + 3] & 0x10) !== 0;
    if (!hasPayload) continue;
    let payloadBegin = i + 4;
    if (hasAdaptation) payloadBegin += 1 + buf[i + 4];
    if (payloadBegin >= i + TS_PACKET_SIZE) continue;
    yield { pid, payloadStart, payload: buf.subarray(payloadBegin, i + TS_PACKET_SIZE) };
  }
}

/** PAT：返回第一个节目对应的 PMT PID */
function parsePat(payload: Uint8Array): number {
  const begin = 1 + payload[0]; // 跳过 pointer_field
  if (begin + 8 > payload.length) return -1;
  if (payload[begin] !== 0x00) return -1;
  const sectionLength = ((payload[begin + 1] & 0x0f) << 8) | payload[begin + 2];
  const end = begin + 3 + sectionLength - 4; // 末尾 4 字节是 CRC
  for (let p = begin + 8; p + 4 <= end && p + 4 <= payload.length; p += 4) {
    const programNumber = (payload[p] << 8) | payload[p + 1];
    if (programNumber === 0) continue; // NIT，不是节目
    return ((payload[p + 2] & 0x1f) << 8) | payload[p + 3];
  }
  return -1;
}

/** PMT：返回 H.264 视频轨的 PID（0x1b）。HEVC(0x24) 不解析——见文件末尾说明 */
function parsePmt(payload: Uint8Array): number {
  const begin = 1 + payload[0];
  if (begin + 12 > payload.length) return -1;
  if (payload[begin] !== 0x02) return -1;
  const sectionLength = ((payload[begin + 1] & 0x0f) << 8) | payload[begin + 2];
  const end = begin + 3 + sectionLength - 4;
  const programInfoLength = ((payload[begin + 10] & 0x0f) << 8) | payload[begin + 11];
  let p = begin + 12 + programInfoLength;
  while (p + 5 <= end && p + 5 <= payload.length) {
    const streamType = payload[p];
    const pid = ((payload[p + 1] & 0x1f) << 8) | payload[p + 2];
    const esInfoLength = ((payload[p + 3] & 0x0f) << 8) | payload[p + 4];
    if (streamType === 0x1b) return pid;
    p += 5 + esInfoLength;
  }
  return -1;
}

/** 把指定 PID（或全部 PID）的 PES 载荷拼成连续的基本流 */
function collectElementaryStream(buf: Uint8Array, start: number, videoPid: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const packet of readTsPackets(buf, start)) {
    // videoPid < 0 表示 PMT 解析失败，退化为拼所有包——多数源只有一个视频轨
    if (videoPid >= 0 && packet.pid !== videoPid) continue;
    let payload = packet.payload;
    if (packet.payloadStart) {
      // PES 头：起始码 00 00 01 + stream_id + 长度 + 可选头
      if (payload.length > 9 && payload[0] === 0 && payload[1] === 0 && payload[2] === 1) {
        const esBegin = 9 + payload[8];
        if (esBegin >= payload.length) continue;
        payload = payload.subarray(esBegin);
      }
    }
    chunks.push(payload);
    total += payload.length;
    if (total >= MAX_ES_BYTES) break;
  }
  const es = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    es.set(chunk, offset);
    offset += chunk.length;
  }
  return es;
}

/** 解析 TS 分片得到分辨率 */
export function parseTsVideoResolution(buf: Uint8Array): MediaResolution | undefined {
  const start = findTsOffset(buf);
  if (start < 0) return undefined;

  let pmtPid = -1;
  let videoPid = -1;
  for (const packet of readTsPackets(buf, start)) {
    if (!packet.payloadStart) continue;
    if (pmtPid < 0 && packet.pid === 0x0000) {
      pmtPid = parsePat(packet.payload);
      continue;
    }
    if (pmtPid >= 0 && packet.pid === pmtPid) {
      videoPid = parsePmt(packet.payload);
      break;
    }
  }

  const es = collectElementaryStream(buf, start, videoPid);
  if (es.length === 0) return undefined;
  const sps = findH264Sps(es);
  if (!sps) return undefined;
  return parseH264Sps(sps);
}

// ——— MP4 / fMP4 ———

/** 承载分辨率的 visual sample entry */
const VISUAL_BOXES = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'mp4v', 'encv', 'dvh1', 'dvhe']);
/** 需要继续下钻的容器 box，值为其头部长度（stsd 是 full box，多了 4 字节） */
const CONTAINER_BOXES: Record<string, number> = {
  moov: 8,
  trak: 8,
  mdia: 8,
  minf: 8,
  stbl: 8,
  stsd: 16,
};

function readU32(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] << 24) >>> 0) + (buf[offset + 1] << 16) + (buf[offset + 2] << 8) + buf[offset + 3]
  );
}

function boxType(buf: Uint8Array, offset: number): string {
  return String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);
}

/**
 * VisualSampleEntry 的宽高：
 * SampleEntry(6 保留 + 2 data_reference_index) + 2 pre_defined + 2 reserved + 12 pre_defined
 * = 载荷偏移 24，宽高各 16 位固定点整数。
 */
function readVisualSampleEntry(buf: Uint8Array, boxStart: number): MediaResolution | undefined {
  const offset = boxStart + 8 + 24;
  if (offset + 4 > buf.length) return undefined;
  const width = (buf[offset] << 8) | buf[offset + 1];
  const height = (buf[offset + 2] << 8) | buf[offset + 3];
  if (width <= 0 || height <= 0) return undefined;
  return { width, height };
}

function isPrintableType(type: string): boolean {
  for (let i = 0; i < type.length; i++) {
    const code = type.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function scanBoxes(buf: Uint8Array, from: number, to: number): MediaResolution | undefined {
  let p = from;
  while (p + 8 <= to) {
    const type = boxType(buf, p + 4);
    if (!isPrintableType(type)) return undefined;
    let size = readU32(buf, p);
    let header = 8;
    if (size === 1) {
      if (p + 16 > to) return undefined;
      const high = readU32(buf, p + 8);
      const low = readU32(buf, p + 12);
      if (high !== 0) return undefined; // 超过 4GB，分片前缀里不可能
      size = low;
      header = 16;
    }
    if (size === 0) size = to - p;
    if (size < header || p + size > to) return undefined;
    if (VISUAL_BOXES.has(type)) {
      const found = readVisualSampleEntry(buf, p);
      if (found) return found;
    }
    const childHeader = CONTAINER_BOXES[type];
    if (childHeader !== undefined) {
      const found = scanBoxes(buf, p + childHeader, p + size);
      if (found) return found;
    }
    p += size;
  }
  return undefined;
}

/** 解析 MP4 / fMP4（init segment）得到分辨率 */
export function parseMp4VideoResolution(buf: Uint8Array): MediaResolution | undefined {
  return scanBoxes(buf, 0, buf.length);
}

/** 是否以 MP4 box 开头：用来在拿不到扩展名时判断分片是 fMP4 还是 TS */
export function looksLikeMp4(buf: Uint8Array): boolean {
  if (buf.length < 12) return false;
  const type = boxType(buf, 4);
  return type === 'ftyp' || type === 'styp' || type === 'moov' || type === 'moof';
}

// ——— 解密 ———

/**
 * AES-128-CBC 解密分片前缀。
 * 只处理完整的 16 字节块：我们只读了分片开头一小段，末尾必然是不完整块，
 * 交给 update 而不调用 final，否则 Node 会按 PKCS7 去 padding 并报错。
 */
export function decryptAes128CbcPrefix(buf: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  const usable = Math.floor(buf.length / 16) * 16;
  if (usable === 0 || key.length < 16 || iv.length < 16) return new Uint8Array(0);
  const decipher = createDecipheriv('aes-128-cbc', key.subarray(0, 16), iv.subarray(0, 16));
  decipher.setAutoPadding(false);
  const out = decipher.update(buf.subarray(0, usable));
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * 已知不支持：HEVC/H.265 的 SPS。
 * TS 里能识别到它的 PID，但解析尺寸要正确跳过 profile_tier_level（含 33 位保留位与
 * 子层循环），逻辑繁琐且缺少真实样本可验证，写错会静默给出错误分辨率——
 * 那比「未知」更糟。这类源仍会显示「未知」，播放一次后由播放器实测补上。
 */
