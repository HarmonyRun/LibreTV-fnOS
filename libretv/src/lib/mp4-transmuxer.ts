/* eslint-disable @typescript-eslint/no-explicit-any -- mux.js 无完整类型定义 */
// @ts-expect-error - mux.js 没有完整的 TypeScript 类型定义
import muxjs from 'mux.js';

/**
 * MP4 转封装（基于 mux.js）。
 *
 * HLS 的 TS 分片对浏览器不可直接播放，下载产物要做 TS→fMP4 转封装：
 * mux.js 的 Transmuxer 每次 flush 产出一段 fMP4（首次含 initSegment），
 * 因此可以边下载边流式写入文件，不需要把整集聚合在内存里。
 */

/** mux.js 写 mvhd 时用的 movie timescale（90kHz） */
const MOVIE_TIMESCALE = 90_000;
/** ISO BMFF 的「时长未知」哨兵值 */
const UNKNOWN_DURATION = 0xffffffff;

function readU32(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function writeU32(buf: Uint8Array, off: number, value: number): void {
  buf[off] = (value >>> 24) & 0xff;
  buf[off + 1] = (value >>> 16) & 0xff;
  buf[off + 2] = (value >>> 8) & 0xff;
  buf[off + 3] = value & 0xff;
}

function boxType(buf: Uint8Array, off: number): string {
  return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}

/** 遍历 [start, end) 内的同级 box；遇到 size===1（64 位 largesize）或越界即放弃，避免误改 */
function walkBoxes(
  buf: Uint8Array,
  start: number,
  end: number,
  visit: (type: string, payload: number, boxEnd: number) => void
): void {
  let off = start;
  while (off + 8 <= end) {
    const size = readU32(buf, off);
    if (size < 8 || off + size > end) return;
    visit(boxType(buf, off + 4), off + 8, off + size);
    off += size;
  }
}

/**
 * 把 mux.js 初始化段里的「未知时长」哨兵值替换成真实时长。
 *
 * mux.js 的 `moov` 恒为 `mvhd(0xffffffff)`（`trak` 里 `tkhd` 同样），而它的 mvhd
 * timescale 是 90000 —— 于是任何按 mvhd 读时长的播放器/资源管理器都会得到
 * 0xFFFFFFFF / 90000 ≈ 47721.86s ≈ 13:15:21，即「每集下载出来都是 13 小时多」。
 * 与片源无关，是封装层问题，只能在写出 initSegment 前就地回填。
 *
 * 只处理 version 0（mux.js 实际产物）；version 1 的 8 字节 duration 不改写。
 */
export function patchInitSegmentDuration(init: Uint8Array, seconds: number): Uint8Array {
  if (!Number.isFinite(seconds) || seconds <= 0) return init;
  const ticks = Math.min(Math.round(seconds * MOVIE_TIMESCALE), UNKNOWN_DURATION - 1);
  // 复制一份：initSegment 由 mux.js 内部生成，直接改可能污染其复用缓冲
  const out = init.slice();
  walkBoxes(out, 0, out.length, (type, payload, boxEnd) => {
    if (type !== 'moov') return;
    walkBoxes(out, payload, boxEnd, (childType, childPayload, childEnd) => {
      if (childType === 'mvhd') {
        // payload: version(1) flags(3) creation(4) modification(4) timescale(4) duration(4)
        if (out[childPayload] === 0 && childPayload + 20 <= childEnd) {
          writeU32(out, childPayload + 16, ticks);
        }
        return;
      }
      if (childType !== 'trak') return;
      walkBoxes(out, childPayload, childEnd, (leafType, leafPayload, leafEnd) => {
        if (leafType !== 'tkhd') return;
        // payload: version(1) flags(3) creation(4) modification(4) track_ID(4) reserved(4) duration(4)
        if (out[leafPayload] === 0 && leafPayload + 24 <= leafEnd) {
          writeU32(out, leafPayload + 20, ticks);
        }
      });
    });
  });
  return out;
}

export interface StreamingTransmuxerOptions {
  /** 整集真实时长（秒）；用于回填 moov 时长，缺省则保留「未知时长」哨兵值 */
  durationSeconds?: number;
}

export class StreamingTransmuxer {
  private transmuxer: any;
  private writer?: { write(data: Uint8Array): Promise<void>; close?(): Promise<void>; abort?(): Promise<void> };
  private initWritten = false;
  private segmentCount = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private writeError: Error | undefined;
  private durationSeconds: number | undefined;

  constructor(
    writer?: { write(data: Uint8Array): Promise<void> },
    options?: StreamingTransmuxerOptions
  ) {
    this.writer = writer;
    this.durationSeconds = options?.durationSeconds;
    this.transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true });
    this.transmuxer.on('data', (segment: any) => {
      const media = new Uint8Array(segment.data);
      const data: Uint8Array = this.initWritten
        ? media
        : concat(
            this.durationSeconds
              ? patchInitSegmentDuration(new Uint8Array(segment.initSegment), this.durationSeconds)
              : new Uint8Array(segment.initSegment),
            media
          );
      this.initWritten = true;
      this.segmentCount += 1;
      // 写入串行化：写失败暂存，下一次 pushAndTransmux 时抛出
      this.writeChain = this.writeChain.then(() => this.writer?.write(data));
      this.writeChain.catch((err) => {
        this.writeError = err instanceof Error ? err : new Error(String(err));
      });
    });
  }

  setWriter(writer: { write(data: Uint8Array): Promise<void>; close?(): Promise<void>; abort?(): Promise<void> }): void {
    this.writer = writer;
  }

  getSegmentCount(): number {
    return this.segmentCount;
  }

  /** push 一个 TS 分片并立刻 flush 出 fMP4 片段 */
  async pushAndTransmux(tsData: Uint8Array): Promise<void> {
    this.transmuxer.push(tsData);
    this.transmuxer.flush();
    await this.writeChain;
    if (this.writeError) {
      const err = this.writeError;
      this.writeError = undefined;
      throw err;
    }
  }

  /** 收尾：最后一次 flush 并关闭写入流 */
  async finish(): Promise<void> {
    this.transmuxer.flush();
    await this.writeChain;
    await this.writer?.close?.();
  }

  async abort(): Promise<void> {
    try {
      await this.writer?.abort?.();
    } catch { /* 忽略 */ }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** 批量转封装：push 全部分片后一次 flush，聚合为 MP4 Blob（内存型，适合小体量） */
export function transmuxTSToMP4(tsSegments: Uint8Array[], duration?: number): Blob {
  const transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true });
  const chunks: Uint8Array[] = [];
  let initWritten = false;
  transmuxer.on('data', (segment: any) => {
    if (!initWritten) {
      const init = new Uint8Array(segment.initSegment);
      chunks.push(duration ? patchInitSegmentDuration(init, duration) : init);
      initWritten = true;
    }
    chunks.push(new Uint8Array(segment.data));
  });
  for (const ts of tsSegments) transmuxer.push(ts);
  transmuxer.flush();
  return new Blob(chunks.map((c) => c.buffer as ArrayBuffer), { type: 'video/mp4' });
}
