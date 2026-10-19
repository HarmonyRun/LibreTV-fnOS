import { decodePathTarget, handleLiveStreamRequest } from '@/lib/proxy-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 旧路径形式的直播流代理：/api/live/stream/<encodeURIComponent(target)>，保持兼容 */
export async function GET(req: Request, ctx: { params: Promise<{ url: string }> }) {
  const { url: encodedUrl } = await ctx.params;
  return handleLiveStreamRequest(req, decodePathTarget(encodedUrl));
}
