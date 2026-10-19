import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptAes128CbcPrefix,
  findH264Sps,
  looksLikeMp4,
  parseH264Sps,
  parseMp4VideoResolution,
  parseTsVideoResolution,
  unescapeRbsp,
} from './codec-parse';

/** 位写入器：手写 SPS 的二进制极易出错，用语法元素逐项构造 */
class BitWriter {
  private readonly bits: number[] = [];

  writeBits(value: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }

  writeUE(value: number): void {
    const v = value + 1;
    const width = v.toString(2).length;
    for (let i = 0; i < width - 1; i++) this.bits.push(0);
    this.writeBits(v, width);
  }

  toBytes(): Uint8Array {
    const bytes: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (this.bits[i + j] ?? 0);
      bytes.push(byte);
    }
    return new Uint8Array(bytes);
  }
}

interface SpsOptions {
  profileIdc?: number;
  widthInMbs: number;
  heightInMapUnits: number;
  frameMbsOnly?: boolean;
  cropBottom?: number;
  scalingLists?: boolean;
}

/** 构造一个最小可用的 H.264 SPS（写到 vui_parameters_present_flag 为止） */
function buildSps(opts: SpsOptions): Uint8Array {
  const profileIdc = opts.profileIdc ?? 100;
  const frameMbsOnly = opts.frameMbsOnly ?? true;
  const w = new BitWriter();
  w.writeBits(profileIdc, 8);
  w.writeBits(0, 8); // constraint flags + reserved
  w.writeBits(40, 8); // level_idc
  w.writeUE(0); // seq_parameter_set_id

  if (profileIdc === 100) {
    w.writeUE(1); // chroma_format_idc = 4:2:0
    w.writeUE(0); // bit_depth_luma_minus8
    w.writeUE(0); // bit_depth_chroma_minus8
    w.writeBits(0, 1); // qpprime_y_zero_transform_bypass_flag
    w.writeBits(opts.scalingLists ? 1 : 0, 1);
    if (opts.scalingLists) {
      // 8 组，前 6 组 16 项、后 2 组 64 项，全部 delta_scale = 0（等价于 ue(0)）
      for (let i = 0; i < 8; i++) {
        w.writeBits(1, 1); // seq_scaling_list_present_flag
        const size = i < 6 ? 16 : 64;
        for (let j = 0; j < size; j++) w.writeUE(0);
      }
    }
  }

  w.writeUE(0); // log2_max_frame_num_minus4
  w.writeUE(0); // pic_order_cnt_type
  w.writeUE(2); // log2_max_pic_order_cnt_lsb_minus4
  w.writeUE(2); // max_num_ref_frames
  w.writeBits(0, 1); // gaps_in_frame_num_value_allowed_flag
  w.writeUE(opts.widthInMbs - 1);
  w.writeUE(opts.heightInMapUnits - 1);
  w.writeBits(frameMbsOnly ? 1 : 0, 1);
  if (!frameMbsOnly) w.writeBits(1, 1); // mb_adaptive_frame_field_flag
  w.writeBits(1, 1); // direct_8x8_inference_flag
  const cropping = (opts.cropBottom ?? 0) > 0;
  w.writeBits(cropping ? 1 : 0, 1);
  if (cropping) {
    w.writeUE(0);
    w.writeUE(0);
    w.writeUE(0);
    w.writeUE(opts.cropBottom!);
  }
  w.writeBits(1, 1); // vui_parameters_present_flag（之后的内容我们不再解析）
  return w.toBytes();
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ——— H.264 SPS ———

describe('parseH264Sps', () => {
  it('1080P：宏块尺寸裁剪到 1920x1080（1088 减掉底部 4 个裁剪单位）', () => {
    expect(parseH264Sps(buildSps({ widthInMbs: 120, heightInMapUnits: 68, cropBottom: 4 }))).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('720P：无需裁剪时直接是宏块尺寸', () => {
    expect(parseH264Sps(buildSps({ widthInMbs: 80, heightInMapUnits: 45 }))).toEqual({
      width: 1280,
      height: 720,
    });
  });

  it('隔行扫描时高度按两个 field 计算', () => {
    expect(parseH264Sps(buildSps({ widthInMbs: 45, heightInMapUnits: 15, frameMbsOnly: false }))).toEqual({
      width: 720,
      height: 480,
    });
  });

  it('带 scaling list 的 High profile 也能正确跳到尺寸字段', () => {
    // scaling list 是变长的，跳过位数算错的话这里会拿到完全错误的值
    expect(parseH264Sps(buildSps({ widthInMbs: 120, heightInMapUnits: 68, cropBottom: 4, scalingLists: true }))).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('Baseline profile（无 chroma 扩展字段）', () => {
    expect(parseH264Sps(buildSps({ profileIdc: 66, widthInMbs: 80, heightInMapUnits: 45 }))).toEqual({
      width: 1280,
      height: 720,
    });
  });

  it('数据被截断时返回 undefined，而不是给出错误分辨率', () => {
    expect(parseH264Sps(new Uint8Array([0x64, 0x00]))).toBeUndefined();
    expect(parseH264Sps(new Uint8Array([]))).toBeUndefined();
  });
});

describe('unescapeRbsp', () => {
  it('去掉防竞争字节 00 00 03 → 00 00', () => {
    expect([...unescapeRbsp(new Uint8Array([0x00, 0x00, 0x03, 0x01, 0x02]))]).toEqual([0x00, 0x00, 0x01, 0x02]);
  });

  it('连续的 00 00 03 各自独立处理', () => {
    expect([...unescapeRbsp(new Uint8Array([0x00, 0x00, 0x03, 0x00, 0x00, 0x03, 0x05]))]).toEqual([
      0x00, 0x00, 0x00, 0x00, 0x05,
    ]);
  });

  it('正常数据原样返回', () => {
    expect([...unescapeRbsp(new Uint8Array([0x67, 0x42, 0x80, 0x1f]))]).toEqual([0x67, 0x42, 0x80, 0x1f]);
  });
});

describe('findH264Sps', () => {
  it('从 Annex-B 流里取出 SPS NAL（跳过 PPS）', () => {
    const sps = buildSps({ widthInMbs: 120, heightInMapUnits: 68, cropBottom: 4 });
    const es = concat([
      new Uint8Array([0x00, 0x00, 0x00, 0x01]),
      concat([new Uint8Array([0x67]), sps]),
      new Uint8Array([0x00, 0x00, 0x00, 0x01]),
      new Uint8Array([0x68, 0xeb, 0xe3, 0xcb]), // PPS
    ]);
    const found = findH264Sps(es);
    expect(found).toBeDefined();
    expect(parseH264Sps(found!)).toEqual({ width: 1920, height: 1080 });
  });

  it('没有 SPS 时返回 undefined', () => {
    expect(findH264Sps(new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x68, 0xeb]))).toBeUndefined();
  });
});

// ——— MPEG-TS ———

const TS_SIZE = 188;

function buildTsPacket(pid: number, payload: Uint8Array, payloadStart: boolean): Uint8Array {
  const packet = new Uint8Array(TS_SIZE).fill(0xff);
  packet[0] = 0x47;
  packet[1] = (payloadStart ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
  packet[2] = pid & 0xff;
  packet[3] = 0x10; // 含载荷、无自适应字段
  packet.set(payload.subarray(0, TS_SIZE - 4), 4);
  return packet;
}

/** 把 PES 拆成多个 TS 包（超过单包容量时续包 payloadStart=0） */
function packetize(pid: number, pes: Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let offset = 0;
  let first = true;
  while (offset < pes.length) {
    packets.push(buildTsPacket(pid, pes.subarray(offset, offset + TS_SIZE - 4), first));
    offset += TS_SIZE - 4;
    first = false;
  }
  return packets;
}

function buildSection(tableId: number, body: number[], sectionLength: number): Uint8Array {
  return concat([new Uint8Array([0]), new Uint8Array([tableId, 0xb0, sectionLength]), new Uint8Array(body)]);
}

function buildPat(pmtPid: number): Uint8Array {
  // program_number=1 + PMT PID + 4 字节 CRC，section_length = 13
  return buildSection(0x00, [0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (pmtPid >> 8), pmtPid & 0xff, 0, 0, 0, 0], 0x0d);
}

function buildPmt(videoPid: number, streamType = 0x1b): Uint8Array {
  const pidHigh = 0xe0 | ((videoPid >> 8) & 0x1f);
  const pidLow = videoPid & 0xff;
  // 2(program) + 1(version) + 2(section) + 2(PCR) + 2(prog_info_len) + 5(stream) + 4(CRC) = 18
  return buildSection(0x02, [0x00, 0x01, 0xc1, 0x00, 0x00, pidHigh, pidLow, 0xf0, 0x00, streamType, pidHigh, pidLow, 0xf0, 0x00, 0, 0, 0, 0], 0x12);
}

function buildPes(es: Uint8Array): Uint8Array {
  const headerLength = 0;
  const pes = new Uint8Array(9 + headerLength + es.length);
  pes.set([0x00, 0x00, 0x01, 0xe0], 0); // 起始码 + 视频 stream_id
  const length = headerLength + es.length;
  pes[4] = (length >> 8) & 0xff;
  pes[5] = length & 0xff;
  pes[6] = 0x80;
  pes[7] = 0x00;
  pes[8] = headerLength;
  pes.set(es, 9 + headerLength);
  return pes;
}

function buildTsWithSps(sps: Uint8Array): Uint8Array {
  const es = concat([
    new Uint8Array([0x00, 0x00, 0x00, 0x01]),
    concat([new Uint8Array([0x67]), sps]),
    new Uint8Array([0x00, 0x00, 0x00, 0x01]),
    new Uint8Array([0x68, 0xeb, 0xe3, 0xcb]),
  ]);
  return concat([
    buildTsPacket(0x0000, buildPat(0x1000), true),
    buildTsPacket(0x1000, buildPmt(0x0100), true),
    ...packetize(0x0100, buildPes(es)),
  ]);
}

describe('parseTsVideoResolution', () => {
  it('从 PAT → PMT → PES → SPS 链路拿到 1080P', () => {
    const ts = buildTsWithSps(buildSps({ widthInMbs: 120, heightInMapUnits: 68, cropBottom: 4 }));
    expect(parseTsVideoResolution(ts)).toEqual({ width: 1920, height: 1080 });
  });

  it('前面带 padding 时仍能定位同步字节', () => {
    const ts = buildTsWithSps(buildSps({ widthInMbs: 80, heightInMapUnits: 45 }));
    const padded = concat([new Uint8Array(37).fill(0xaa), ts]);
    expect(parseTsVideoResolution(padded)).toEqual({ width: 1280, height: 720 });
  });

  it('HEVC 轨（stream_type 0x24）不支持，返回 undefined 而不是错误值', () => {
    const es = concat([new Uint8Array([0x00, 0x00, 0x00, 0x01]), new Uint8Array([0x26, 0x01, 0x02])]);
    const ts = concat([
      buildTsPacket(0x0000, buildPat(0x1000), true),
      buildTsPacket(0x1000, buildPmt(0x0100, 0x24), true),
      ...packetize(0x0100, buildPes(es)),
    ]);
    expect(parseTsVideoResolution(ts)).toBeUndefined();
  });

  it('不是 TS 流时返回 undefined', () => {
    expect(parseTsVideoResolution(new Uint8Array(600).fill(0x5a))).toBeUndefined();
    expect(parseTsVideoResolution(new Uint8Array(0))).toBeUndefined();
  });
});

// ——— MP4 / fMP4 ———

function box(type: string, payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(8 + payload.length);
  const size = buf.length;
  buf[0] = (size >>> 24) & 0xff;
  buf[1] = (size >>> 16) & 0xff;
  buf[2] = (size >>> 8) & 0xff;
  buf[3] = size & 0xff;
  buf.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4);
  buf.set(payload, 8);
  return buf;
}

function buildVisualEntry(type: string, width: number, height: number): Uint8Array {
  const payload = new Uint8Array(40);
  payload[24] = (width >> 8) & 0xff;
  payload[25] = width & 0xff;
  payload[26] = (height >> 8) & 0xff;
  payload[27] = height & 0xff;
  return box(type, payload);
}

function buildMoov(width: number, height: number, entryType = 'avc1'): Uint8Array {
  // stsd 是 full box：version/flags(4) + entry_count(4) 之后再放 sample entry
  const stsdPayload = concat([new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), buildVisualEntry(entryType, width, height)]);
  return box('moov', box('trak', box('mdia', box('minf', box('stbl', box('stsd', stsdPayload))))));
}

describe('parseMp4VideoResolution', () => {
  it('从 moov → trak → mdia → minf → stbl → stsd → avc1 取出宽高', () => {
    expect(parseMp4VideoResolution(buildMoov(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it('HEVC 的 hvc1 / Dolby 的 dvh1 同样识别', () => {
    expect(parseMp4VideoResolution(buildMoov(3840, 2160, 'hvc1'))).toEqual({ width: 3840, height: 2160 });
    expect(parseMp4VideoResolution(buildMoov(1920, 1080, 'dvh1'))).toEqual({ width: 1920, height: 1080 });
  });

  it('init segment 常见形态：ftyp + moov', () => {
    const init = concat([box('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x6d])), buildMoov(1280, 720)]);
    expect(parseMp4VideoResolution(init)).toEqual({ width: 1280, height: 720 });
  });

  it('宽高为 0 的异常条目当作无效', () => {
    expect(parseMp4VideoResolution(buildMoov(0, 0))).toBeUndefined();
  });

  it('非 MP4 数据返回 undefined', () => {
    expect(parseMp4VideoResolution(new Uint8Array(64).fill(0x47))).toBeUndefined();
    expect(parseMp4VideoResolution(new Uint8Array(0))).toBeUndefined();
  });
});

describe('looksLikeMp4', () => {
  it('按 box 类型判断，而不是看扩展名', () => {
    expect(looksLikeMp4(box('ftyp', new Uint8Array(4)))).toBe(true);
    expect(looksLikeMp4(box('styp', new Uint8Array(4)))).toBe(true);
    expect(looksLikeMp4(concat([new Uint8Array([0x47]), new Uint8Array(60)]))).toBe(false);
  });
});

// ——— 解密 ———

describe('decryptAes128CbcPrefix', () => {
  it('解密分片前缀（只读到不完整块为止，不按 PKCS7 去 padding）', () => {
    const key = randomBytes(16);
    const iv = randomBytes(16);
    const plain = new Uint8Array(300).fill(0x7a);
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    cipher.setAutoPadding(false);
    const encrypted = new Uint8Array(
      concat([new Uint8Array(cipher.update(Buffer.from(plain.subarray(0, 288)))), new Uint8Array(11).fill(0x11)])
    );
    const out = decryptAes128CbcPrefix(encrypted, key, iv);
    expect(out.length).toBe(288); // 末尾 11 字节不构成整块，丢弃
    expect([...out]).toEqual([...plain.subarray(0, 288)]);
  });

  it('密钥或 IV 长度不足时返回空，不抛错', () => {
    expect(decryptAes128CbcPrefix(new Uint8Array(64), new Uint8Array(8), new Uint8Array(16)).length).toBe(0);
    expect(decryptAes128CbcPrefix(new Uint8Array(64), new Uint8Array(16), new Uint8Array(4)).length).toBe(0);
  });

  it('数据不足一个块时返回空', () => {
    expect(decryptAes128CbcPrefix(new Uint8Array(10), randomBytes(16), randomBytes(16)).length).toBe(0);
  });
});
