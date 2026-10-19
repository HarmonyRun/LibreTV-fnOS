import fs from 'node:fs';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * MCP 代理入口（同源 8090）：把 /api/mcp 转发到应用内 MCP 服务（默认 127.0.0.1:8092）。
 *
 * - 目的：让只能访问 LibreTV Web 端口（8090）的客户端也能使用 MCP；
 * - 鉴权由 MCP 服务负责（Authorization: Bearer <config.mcp.token>），本路由不做会话守卫；
 * - 所有请求/响应原样透传（含 401/405/JSON-RPC 错误）。
 */

function getDataDir(): string {
  return process.env.LIBRETV_DATA_DIR || process.env.TRIM_PKGVAR || path.join(process.cwd(), 'var');
}

function getMcpPort(): number {
  const envPort = Number(process.env.LIBRETV_MCP_PORT);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(getDataDir(), 'config.json'), 'utf8')) as {
      mcp?: { port?: number };
    };
    const port = Number(cfg?.mcp?.port);
    if (Number.isFinite(port) && port > 0) return port;
  } catch {
    /* ignore */
  }
  return 8092;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

function forwardHeaders(req: Request): Headers {
  const out = new Headers();
  for (const name of ['authorization', 'content-type', 'accept', 'x-mcp-token', 'mcp-protocol-version', 'mcp-session-id']) {
    const value = req.headers.get(name);
    if (value) out.set(name, value);
  }
  return out;
}

async function proxy(req: Request): Promise<Response> {
  const port = getMcpPort();
  const url = `http://127.0.0.1:${port}/mcp`;
  const init: RequestInit = {
    method: req.method,
    headers: forwardHeaders(req),
    cache: 'no-store',
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = await req.text();
  }
  try {
    const upstream = await fetch(url, init);
    const headers = new Headers();
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
    });
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'MCP 服务不可用';
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32000, message: `MCP 服务未启动或不可达: ${message}` } },
      { status: 502 }
    );
  }
}

export async function GET(req: Request) {
  return proxy(req);
}
export async function POST(req: Request) {
  return proxy(req);
}
export async function DELETE(req: Request) {
  return proxy(req);
}
export async function OPTIONS(req: Request) {
  return proxy(req);
}
