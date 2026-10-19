import { describe, expect, it, vi } from 'vitest';
import { probeEpisodeOrder, probeQuality } from './quality-probe';
import type { SourceConfig } from './types';

const mocks = vi.hoisted(() => ({ fetchUpstream: vi.fn() }));
vi.mock('./fetch-utils', () => ({ fetchUpstream: mocks.fetchUpstream }));
// 探测 대상由用例自己提供，跳过 SSRF 校验（那是 ssrf.test.ts 的职责）
vi.mock('./ssrf', () => ({ checkUpstreamAllowed: () => Promise.resolve({ ok: true }) }));

/**
 * 集成测试：验证「m3u8 测不出 → 下沉到分片解析」这条降级链路真的接通。
 * 解析器本身由 codec-parse.test.ts 覆盖，这里关心的是拼接环节：
 * 什么时候该走分片、请求哪个 URL、失败时该返回什么。
 */

const SOURCE: SourceConfig = { key: 'demo', name: 'demo', url: 'https://api.test/api.php/provide/vod' };
const PLAYLIST_URL = 'https://cdn.test/2024/01/abc/index.m3u8';

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720/index.m3u8
`;

const SINGLE_TS = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:10.0,
seg0.ts
#EXT-X-ENDLIST
`;

const FMP4 = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MAP:URI="init.mp4"
#EXTINF:10.0,
seg0.m4s
#EXT-X-ENDLIST
`;

// ——— 最小 TS/SPS 构造（只够解析出 1920x1080） ———

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

function buildSps1080(): Uint8Array {
  const w = new BitWriter();
  w.writeBits(100, 8); // High profile
  w.writeBits(0, 8);
  w.writeBits(40, 8); // level
  w.writeUE(0); // sps id
  w.writeUE(1); // chroma 4:2:0
  w.writeUE(0);
  w.writeUE(0);
  w.writeBits(0, 1);
  w.writeBits(0, 1); // 无 scaling list
  w.writeUE(0); // log2_max_frame_num
  w.writeUE(0); // pic_order_cnt_type
  w.writeUE(2);
  w.writeUE(2); // max_num_ref_frames
  w.writeBits(0, 1);
  w.writeUE(119); // 120 MBs → 1920
  w.writeUE(67); // 68 → 1088
  w.writeBits(1, 1); // frame_mbs_only
  w.writeBits(1, 1); // direct_8x8_inference
  w.writeBits(1, 1); // frame_cropping
  w.writeUE(0);
  w.writeUE(0);
  w.writeUE(0);
  w.writeUE(4); // 1088 - 4*2 = 1080
  w.writeBits(1, 1); // vui_present
  return w.toBytes();
}

const TS_SIZE = 188;

function tsPacket(pid: number, payload: Uint8Array, payloadStart: boolean): Uint8Array {
  const packet = new Uint8Array(TS_SIZE).fill(0xff);
  packet[0] = 0x47;
  packet[1] = (payloadStart ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
  packet[2] = pid & 0xff;
  packet[3] = 0x10;
  packet.set(payload.subarray(0, TS_SIZE - 4), 4);
  return packet;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function section(tableId: number, body: number[], length: number): Uint8Array {
  return concat([new Uint8Array([0, tableId, 0xb0, length]), new Uint8Array(body)]);
}

function buildTs(): Uint8Array {
  const pmtPid = 0x1000;
  const videoPid = 0x0100;
  const pat = section(0x00, [0, 1, 0xc1, 0, 0, 0, 1, 0xe0 | (pmtPid >> 8), pmtPid & 0xff, 0, 0, 0, 0], 0x0d);
  const pmt = section(
    0x02,
    [0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00, 0x1b, 0xe1, 0x00, 0xf0, 0x00, 0, 0, 0, 0],
    0x12
  );
  const es = concat([
    new Uint8Array([0, 0, 0, 1]),
    concat([new Uint8Array([0x67]), buildSps1080()]),
    new Uint8Array([0, 0, 0, 1, 0x68, 0xeb]),
  ]);
  const pes = new Uint8Array(9 + es.length);
  pes.set([0, 0, 1, 0xe0], 0);
  pes[4] = (es.length >> 8) & 0xff;
  pes[5] = es.length & 0xff;
  pes[6] = 0x80;
  pes[8] = 0;
  pes.set(es, 9);
  return concat([tsPacket(0, pat, true), tsPacket(pmtPid, pmt, true), tsPacket(videoPid, pes, true)]);
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(8 + payload.length);
  buf[0] = (buf.length >>> 24) & 0xff;
  buf[1] = (buf.length >>> 16) & 0xff;
  buf[2] = (buf.length >>> 8) & 0xff;
  buf[3] = buf.length & 0xff;
  buf.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4);
  buf.set(payload, 8);
  return buf;
}

function buildInitMp4(): Uint8Array {
  const entry = new Uint8Array(40);
  entry[24] = (1920 >> 8) & 0xff;
  entry[25] = 1920 & 0xff;
  entry[26] = (1080 >> 8) & 0xff;
  entry[27] = 1080 & 0xff;
  const stsd = concat([new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), box('avc1', entry)]);
  return box('moov', box('trak', box('mdia', box('minf', box('stbl', box('stsd', stsd))))));
}

/** 二进制响应：Uint8Array 直接交给 Response 在 TS 下类型不匹配，取底层 ArrayBuffer */
function bytesResponse(bytes: Uint8Array): Response {
  return new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 });
}

/** 按 URL 返回不同的上游响应；未匹配返回 404 */
function route(url: string): Response {
  if (url.includes('ac=videolist')) {
    // CMS 的 vod_play_url 是「集名$地址」格式，裸 URL 会被解析成空
    const body = JSON.stringify({ list: [{ vod_id: '123', vod_name: '测试影片', vod_play_url: `第1集$${PLAYLIST_URL}` }] });
    return new Response(body, { status: 200 });
  }
  if (url === PLAYLIST_URL) return new Response(currentPlaylist, { status: 200 });
  if (url.endsWith('.ts')) return bytesResponse(buildTs());
  if (url.endsWith('init.mp4')) return bytesResponse(buildInitMp4());
  return new Response('not found', { status: 404 });
}

let currentPlaylist = SINGLE_TS;

function urls(): string[] {
  return mocks.fetchUpstream.mock.calls.map((call) => call[0] as string);
}

describe('probeEpisodeOrder', () => {
  it('多集：中间集优先，最后一集作为换集重试的对象', () => {
    expect(probeEpisodeOrder(['a', 'b', 'c'])).toEqual(['b', 'c']);
    expect(probeEpisodeOrder(['a', 'b', 'c', 'd', 'e'])).toEqual(['c', 'e']);
  });

  it('两集时不重复：中间集就是最后一集', () => {
    expect(probeEpisodeOrder(['a', 'b'])).toEqual(['b']);
  });

  it('单集影片（电影）只有一集可探', () => {
    expect(probeEpisodeOrder(['a'])).toEqual(['a']);
    expect(probeEpisodeOrder([])).toEqual([]);
  });
});

describe('probeQuality 降级到分片解析', () => {
  it('多码率 master playlist 直接解析档位，不再下载分片', async () => {
    currentPlaylist = MASTER;
    mocks.fetchUpstream.mockImplementation((url: string) => Promise.resolve(route(url)));

    const result = await probeQuality({ source: SOURCE, id: '123' });
    expect(result.height).toBe(1080);
    // 详情接口 + m3u8，仅此两次：多码率源没有理由再拉分片
    expect(urls()).toEqual([
      'https://api.test/api.php/provide/vod?ac=videolist&ids=123',
      PLAYLIST_URL,
    ]);
  });

  it('单码率 m3u8：下沉到 TS 分片，从 SPS 拿到 1080', async () => {
    currentPlaylist = SINGLE_TS;
    mocks.fetchUpstream.mockImplementation((url: string) => Promise.resolve(route(url)));

    const result = await probeQuality({ source: SOURCE, id: '123' });
    expect(result.height).toBe(1080);
    // 关键：m3u8 里的 seg0.ts 是相对路径，必须按播放列表地址拼对
    expect(urls()).toContain('https://cdn.test/2024/01/abc/seg0.ts');
  });

  it('fMP4：优先取 init segment（moov 在里面），不去下载媒体分片', async () => {
    currentPlaylist = FMP4;
    mocks.fetchUpstream.mockImplementation((url: string) => Promise.resolve(route(url)));

    const result = await probeQuality({ source: SOURCE, id: '123' });
    expect(result.height).toBe(1080);
    expect(urls()).toContain('https://cdn.test/2024/01/abc/init.mp4');
    expect(urls().some((u) => u.endsWith('.m4s'))).toBe(false);
  });

  it('SAMPLE-AES 加密：服务端解不开，放弃而不是给出错误分辨率', async () => {
    currentPlaylist = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://fairplay"
#EXTINF:10.0,
seg0.ts
`;
    mocks.fetchUpstream.mockImplementation((url: string) => Promise.resolve(route(url)));

    const result = await probeQuality({ source: SOURCE, id: '123' });
    expect(result.height).toBeUndefined();
    expect(result.error).toBeUndefined(); // 是「测不出」，不是探测失败
  });

  it('分片拿不到：仍算探到（m3u8 是通的），只当作画质未知', async () => {
    currentPlaylist = SINGLE_TS;
    mocks.fetchUpstream.mockImplementation((url: string) => {
      if (url.endsWith('.ts')) return Promise.resolve(new Response('', { status: 404 }));
      return Promise.resolve(route(url));
    });

    const result = await probeQuality({ source: SOURCE, id: '123' });
    expect(result.height).toBeUndefined();
    // 不能因为分片下载失败就把一个可用源标成「未探到」
    expect(result.error).toBeUndefined();
  });

  it('mp4 直链：直接解析 moov，不经过 m3u8', async () => {
    mocks.fetchUpstream.mockImplementation((url: string) => {
      if (url.includes('ac=videolist')) {
        const body = JSON.stringify({
          list: [{ vod_id: '123', vod_name: 'x', vod_play_url: '正片$https://cdn.test/movie.mp4' }],
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      }
      if (url.endsWith('.mp4')) return Promise.resolve(bytesResponse(buildInitMp4()));
      return Promise.resolve(new Response('', { status: 404 }));
    });

    const result = await probeQuality({ source: SOURCE, id: '123' });
    expect(result.height).toBe(1080);
  });

  it('电视剧单码率：中间集探不出时换最后一集再探', async () => {
    // 中间集的分片缺失（采集站常见），最后一集正常 —— 不换集就永远「未知」
    const EP2 = 'https://cdn.test/2024/01/abc/2/index.m3u8';
    const EP3 = 'https://cdn.test/2024/01/abc/3/index.m3u8';
    mocks.fetchUpstream.mockClear();
    mocks.fetchUpstream.mockImplementation((url: string) => {
      if (url.includes('ac=videolist')) {
        const body = JSON.stringify({
          list: [
            {
              vod_id: '123',
              vod_name: '测试剧',
              vod_play_url: `第1集$https://cdn.test/2024/01/abc/1/index.m3u8#第2集$${EP2}#第3集$${EP3}`,
            },
          ],
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      }
      if (url === EP2 || url === EP3) return Promise.resolve(new Response(SINGLE_TS, { status: 200 }));
      if (url.endsWith('/2/seg0.ts')) return Promise.resolve(new Response('', { status: 404 }));
      if (url.endsWith('.ts')) return Promise.resolve(bytesResponse(buildTs()));
      return Promise.resolve(new Response('not found', { status: 404 }));
    });

    const result = await probeQuality({ source: SOURCE, id: '123' });
    expect(result.height).toBe(1080);
    expect(result.error).toBeUndefined();
    // 两集都请求过：中间集先探，探不到才轮到最后一集
    expect(urls()).toContain(EP2);
    expect(urls()).toContain(EP3);
  });

  it('单集影片不重复探测同一地址', async () => {
    currentPlaylist = SINGLE_TS;
    mocks.fetchUpstream.mockClear();
    mocks.fetchUpstream.mockImplementation((url: string) => Promise.resolve(route(url)));

    await probeQuality({ source: SOURCE, id: '123' });
    expect(urls().filter((u) => u === PLAYLIST_URL)).toHaveLength(1);
  });

  it('无效的源地址：返回错误而不是静默「未知」', async () => {
    const result = await probeQuality({ source: { ...SOURCE, url: 'not-a-url' }, id: '123' });
    expect(result.error).toBeDefined();
    expect(result.height).toBeUndefined();
  });
});
