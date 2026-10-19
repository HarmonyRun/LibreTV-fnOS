#!/usr/bin/env node
'use strict';

/**
 * MCP stdio 桥接：把只支持 stdio 的 MCP 客户端转发到 LibreTV-fnOS 的 HTTP MCP 服务。
 *
 * 用法：
 *   node mcp/stdio-bridge.js --url http://<NAS-IP>:8092/mcp --token <MCP_TOKEN>
 *   或环境变量：MCP_URL / MCP_TOKEN
 *
 * 客户端配置（以 stdio 为例）：
 *   command: node
 *   args: ["/path/to/stdio-bridge.js", "--url", "http://192.168.1.100:8092/mcp", "--token", "xxx"]
 */

const readline = require('readline');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--url' && argv[i + 1]) out.url = argv[++i];
    else if (a === '--token' && argv[i + 1]) out.token = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.error('用法: node mcp/stdio-bridge.js --url http://<NAS-IP>:8092/mcp --token <MCP_TOKEN>');
  process.exit(0);
}
const URL_ = args.url || process.env.MCP_URL || 'http://127.0.0.1:8092/mcp';
const TOKEN = args.token || process.env.MCP_TOKEN || '';
if (!TOKEN) {
  console.error('[stdio-bridge] 缺少 token：--token 或 MCP_TOKEN');
  process.exit(2);
}

async function forward(message) {
  const isNotification = message && typeof message === 'object' && message.id === undefined;
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(message),
    });
    if (res.status === 202) return null;
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return {
        jsonrpc: '2.0',
        id: message && message.id !== undefined ? message.id : null,
        error: { code: -32000, message: `上游返回非 JSON: ${text.slice(0, 200)}` },
      };
    }
  } catch (err) {
    if (isNotification) return null;
    return {
      jsonrpc: '2.0',
      id: message && message.id !== undefined ? message.id : null,
      error: { code: -32000, message: `无法连接 ${URL_}: ${(err && err.message) || err}` },
    };
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let queue = Promise.resolve();

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'
    );
    return;
  }
  queue = queue.then(async () => {
    const response = await forward(message);
    if (response !== null && response !== undefined) {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  });
});

rl.on('close', () => {
  queue.finally(() => process.exit(0));
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
