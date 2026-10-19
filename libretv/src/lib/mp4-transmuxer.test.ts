import { describe, expect, it } from 'vitest';
import { patchInitSegmentDuration } from './mp4-transmuxer';

const u32 = (v: number) =>
  new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);

const readU32 = (b: Uint8Array, o: number) =>
  ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const payloadLen = payloads.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(8 + payloadLen);
  out.set(u32(out.length), 0);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let off = 8;
  for (const p of payloads) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** version 0 full box：version(1)+flags(3)=0，其后是若干 u32 字段 */
function fullBox(fields: number[]): Uint8Array {
  const out = new Uint8Array(4 + fields.length * 4);
  fields.forEach((v, i) => out.set(u32(v), 4 + i * 4));
  return out;
}

/** 按 mux.js 的实际布局搭最小 initSegment：ftyp + moov(mvhd + trak(tkhd)) */
function initSegment(mvhdDuration: number, tkhdDuration: number): Uint8Array {
  const ftyp = box('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x6d]));
  const mvhdBox = box('mvhd', fullBox([0, 0, 90_000, mvhdDuration])); // timescale 90000
  const tkhdBox = box('tkhd', fullBox([0, 0, 1, 0, tkhdDuration]));
  const moov = box('moov', mvhdBox, box('trak', tkhdBox));
  const out = new Uint8Array(ftyp.length + moov.length);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  return out;
}

// ftyp(12) + moov 头(8) → mvhd 头(8) → mvhd payload 起点 28
const MVHD_PAYLOAD = 12 + 8 + 8;
// + mvhd payload(20) + trak 头(8) + tkhd 头(8) → tkhd payload 起点 64
const TKHD_PAYLOAD = MVHD_PAYLOAD + 20 + 8 + 8;

describe('patchInitSegmentDuration', () => {
  it('把 mvhd/tkhd 的 0xFFFFFFFF 哨兵值替换为真实时长（90000 时基）', () => {
    const patched = patchInitSegmentDuration(initSegment(0xffffffff, 0xffffffff), 2730);
    expect(readU32(patched, MVHD_PAYLOAD + 16)).toBe(2730 * 90_000);
    expect(readU32(patched, TKHD_PAYLOAD + 20)).toBe(2730 * 90_000);
  });

  it('0xFFFFFFFF/90000 ≈ 47721.86s ≈ 13:15:21 —— 未修补时播放器看到的时长', () => {
    expect(0xffffffff / 90_000).toBeCloseTo(47721.86, 1);
  });

  it('时长非正数 / 非有限值时原样返回', () => {
    const init = initSegment(0xffffffff, 0xffffffff);
    expect(patchInitSegmentDuration(init, 0)).toEqual(init);
    expect(patchInitSegmentDuration(init, Number.NaN)).toEqual(init);
  });

  it('不修改入参缓冲', () => {
    const init = initSegment(0xffffffff, 0xffffffff);
    patchInitSegmentDuration(init, 60);
    expect(readU32(init, MVHD_PAYLOAD + 16)).toBe(0xffffffff);
  });
});
