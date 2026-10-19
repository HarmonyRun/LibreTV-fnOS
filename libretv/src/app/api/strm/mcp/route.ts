import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { readConfigRaw, writeConfigRaw } from '@/lib/strm-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * MCP 设置（需 LibreTV 登录）：
 * GET  → 返回 MCP 开关、端口、token（用于客户端配置）与连接说明
 * POST → { action: "regenerate" } 重新生成 token；{ action: "setEnabled", enabled: boolean } 开关
 */

const DEFAULT_PORT = 8092;

function randomToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

function readMcp(raw: Record<string, unknown>): { enabled: boolean; port: number; token: string } {
  const mcp = raw.mcp && typeof raw.mcp === 'object' && !Array.isArray(raw.mcp) ? (raw.mcp as Record<string, unknown>) : {};
  const token = typeof mcp.token === 'string' ? mcp.token : '';
  const portNumber = Number(mcp.port);
  return {
    enabled: mcp.enabled !== false,
    port: Number.isFinite(portNumber) && portNumber > 0 ? portNumber : DEFAULT_PORT,
    token,
  };
}

function payload(raw: Record<string, unknown>) {
  const mcp = readMcp(raw);
  return {
    enabled: mcp.enabled,
    port: mcp.port,
    token: mcp.token,
    endpoints: {
      /** 独立 MCP 端口（Streamable HTTP） */
      direct: `/mcp`,
      /** 经 LibreTV Web 端口的同源代理 */
      viaWeb: '/api/mcp',
    },
    docs: {
      stdioBridge: 'node mcp/stdio-bridge.js --url http://<NAS-IP>:8092/mcp --token <TOKEN>',
      authHeader: 'Authorization: Bearer <TOKEN>',
    },
  };
}

export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  try {
    const raw = await readConfigRaw();
    const mcp = readMcp(raw);
    if (!mcp.token) {
      raw.mcp = { ...(typeof raw.mcp === 'object' && raw.mcp ? (raw.mcp as Record<string, unknown>) : {}), token: randomToken() };
      await writeConfigRaw(raw);
    }
    return NextResponse.json(payload(raw));
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : '读取 MCP 配置失败', 500);
  }
}

export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonError('请求格式错误', 400);
    }
    const action = (body as { action?: unknown } | null)?.action;
    const raw = await readConfigRaw();
    const current = typeof raw.mcp === 'object' && raw.mcp ? (raw.mcp as Record<string, unknown>) : {};

    if (action === 'regenerate') {
      raw.mcp = { ...current, enabled: current.enabled !== false, port: readMcp(raw).port, token: randomToken() };
      await writeConfigRaw(raw);
      return NextResponse.json(payload(raw));
    }
    if (action === 'setEnabled') {
      const enabled = (body as { enabled?: unknown } | null)?.enabled;
      if (typeof enabled !== 'boolean') return jsonError('enabled 必须是布尔值', 400);
      raw.mcp = { ...current, enabled, port: readMcp(raw).port, token: readMcp(raw).token || randomToken() };
      await writeConfigRaw(raw);
      return NextResponse.json(payload(raw));
    }
    return jsonError('未知 action', 400);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : '更新 MCP 配置失败', 500);
  }
}
