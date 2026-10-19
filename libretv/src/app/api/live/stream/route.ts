import { handleLiveStreamRequest } from '@/lib/proxy-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 查询串形式的直播流代理：/api/live/stream?url=<encodeURIComponent(target)>。
 * 查询串不参与网关路径归一化，全平台行为一致；旧路径形式仍由 [url] 路由兼容。
 */
export async function GET(req: Request) {
  const targetUrl = new URL(req.url).searchParams.get('url');
  if (!targetUrl) {
    return new Response(JSON.stringify({ error: '缺少 url 参数' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return handleLiveStreamRequest(req, targetUrl);
}
