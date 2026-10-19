import { decodePathTarget, handleProxyRequest } from '@/lib/proxy-handlers';

export const runtime = 'nodejs';

/** 旧路径形式的通用代理：/api/proxy/<encodeURIComponent(target)>，保持兼容（详见 proxy-handlers.ts） */
export async function GET(req: Request, ctx: { params: Promise<{ url: string }> }) {
  const { url: encodedUrl } = await ctx.params;
  return handleProxyRequest(req, decodePathTarget(encodedUrl));
}
