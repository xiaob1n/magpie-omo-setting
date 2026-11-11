import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOmoCategories, saveOmoCategories } from './lib/omo-config.mjs';
import { fetchGatewayModels } from './lib/gateway.mjs';
import {
  getWebdavStatus,
  testWebdavConnection,
  saveWebdavConfig,
  uploadToWebdav,
  downloadFromWebdav,
  autoSyncTick,
  getAutoSyncState,
  AUTO_SYNC_MS,
} from './lib/webdav.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PORT = Number(process.env.MAGPIE_OMO_PORT) || 3488;
const UI_DIR = path.join(__dirname, 'ui');
const ICON_FILE = path.join(__dirname, 'page', 'icon.svg');
const TOKEN_PLACEHOLDER = '__OMO_TOKEN__';

let TOKEN = crypto.randomUUID().replace(/-/g, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

let server = null;
let autoSyncTimer = null;

// 每三分钟把本机改动传一次；失败只记录，不打断服务
function startAutoSync() {
  if (autoSyncTimer) return;
  autoSyncTimer = setInterval(() => { autoSyncTick().catch(() => {}); }, AUTO_SYNC_MS);
  autoSyncTimer.unref?.();
}

function hostAllowed(host) {
  if (!host) return true;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

// 插件页在 sandbox="allow-scripts" 的 iframe 里，来源是 opaque，所以它的每个请求都是跨域。
// 只对 Origin: null 放行读取，且必须带上每次启动随机生成的 token，其他站点拿不到 token。
function corsHeaders(req) {
  const origin = req.headers.get('origin');
  if (origin === 'null') {
    return {
      'Access-Control-Allow-Origin': 'null',
      'Access-Control-Allow-Headers': 'X-Omo-Token, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      Vary: 'Origin',
    };
  }
  return { Vary: 'Origin' };
}

function tokenOk(req) {
  return req.headers.get('x-omo-token') === TOKEN;
}

async function route(req) {
  const url = new URL(req.url);

  if (url.pathname.startsWith('/api/')) {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (!tokenOk(req)) {
      return Response.json({ error: 'forbidden' }, { status: 403, headers: cors });
    }
    let res;
    try { res = await api(req, url); }
    catch (err) { res = Response.json({ error: err.message }, { status: err.status || (err instanceof SyntaxError ? 400 : 500) }); }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  }

  return staticFile(req, url);
}

async function api(req, url) {

  if (url.pathname === '/api/omo/categories' && req.method === 'GET') {
    return Response.json(readOmoCategories());
  }

  if (url.pathname === '/api/omo/categories' && req.method === 'POST') {
    try {
      const body = await req.json();
      return Response.json(saveOmoCategories(body.revision, body.changes));
    } catch (err) {
      const status = err.status || (err instanceof SyntaxError || err instanceof TypeError ? 400 : 500);
      return Response.json({ error: err.message }, { status });
    }
  }

  if (url.pathname === '/api/models' && req.method === 'GET') {
    return Response.json({ data: await fetchGatewayModels() });
  }

  if (url.pathname === '/api/webdav/status' && req.method === 'GET') {
    return Response.json(await getWebdavStatus());
  }

  if (url.pathname === '/api/webdav/autosync' && req.method === 'GET') {
    return Response.json(getAutoSyncState());
  }

  if (url.pathname === '/api/webdav/test' && req.method === 'POST') {
    const text = await req.text();
    const body = text ? JSON.parse(text) : {};
    return Response.json(await testWebdavConnection(body));
  }

  if (url.pathname === '/api/webdav/config' && req.method === 'POST') {
    return Response.json(saveWebdavConfig(await req.json()));
  }

  if (url.pathname === '/api/webdav/upload' && req.method === 'POST') {
    const text = await req.text();
    return Response.json(await uploadToWebdav(text ? JSON.parse(text) : null));
  }

  if (url.pathname === '/api/webdav/download' && req.method === 'POST') {
    const text = await req.text();
    return Response.json(await downloadFromWebdav(text ? JSON.parse(text) : null));
  }

  return new Response('Not Found', { status: 404 });
}

function staticFile(req, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(UI_DIR, rel);
  const inside = file === UI_DIR || file.startsWith(UI_DIR + path.sep);

  if (inside && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    if (rel === 'index.html') {
      return new Response(fs.readFileSync(file, 'utf8').replaceAll(TOKEN_PLACEHOLDER, TOKEN), {
        headers: { 'Content-Type': type, 'Cache-Control': 'no-store' },
      });
    }
    return new Response(fs.readFileSync(file), { headers: { 'Content-Type': type } });
  }

  if (url.pathname === '/icon.svg') {
    return new Response(fs.readFileSync(ICON_FILE), { headers: { 'Content-Type': 'image/svg+xml' } });
  }

  return new Response('Not Found', { status: 404 });
}

export function startServer(options = {}) {
  const port = options.port === undefined ? DEFAULT_PORT : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('无效端口');

  if (server && server.port === port) return server;
  if (server) {
    server.stop(true);
    server = null;
  }

  server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (!hostAllowed(req.headers.get('host'))) {
        return new Response('Forbidden', { status: 403, headers: urlIsApi(req) ? corsHeaders(req) : {} });
      }
      try {
        return await route(req);
      } catch (err) {
        return Response.json({ error: err?.message || String(err) }, { status: 500 });
      }
    },
  });

  startAutoSync();
  return server;
}

function urlIsApi(req) { return new URL(req.url).pathname.startsWith('/api/'); }

if (import.meta.main) startServer();

export default {
  id: 'magpie-omo-setting',
  server: async (input, options) => {
    startServer(options);
    return {};
  },
};
