import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const localConfig = '{\n  // 保留原始 JSONC\n  "categories": {},\n}\n';
const custom = { useMagpieSync: false, user: 'fixture', password: 'fixture-only' };
const auth = 'Basic ' + Buffer.from(`${custom.user}:${custom.password}`).toString('base64');
let dir, originalEnv, dav, webdav;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'omo-dav-regression-'));
  const env = { HOME: dir, MAGPIE_CONFIG_DIR: join(dir, 'magpie'), OMO_CONFIG_PATH: join(dir, 'omo.jsonc') };
  originalEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  mkdirSync(env.MAGPIE_CONFIG_DIR);
  writeFileSync(env.OMO_CONFIG_PATH, localConfig);
  webdav = await import('../lib/webdav.mjs');
});

afterEach(() => {
  dav?.stop(true);
  dav = undefined;
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

function serve(handler) {
  dav = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    if (req.headers.get('authorization') !== auth) return new Response(null, { status: 401 });
    return handler(req, new URL(req.url));
  } });
  return { ...custom, url: dav.url.href };
}

function serveBytes(initial = null) {
  const remote = { bytes: initial, puts: 0 };
  const creds = serve(async (req, url) => {
    if (url.pathname !== '/config.jsonc') return new Response(null, { status: 404 });
    if (req.method === 'GET') return new Response(remote.bytes, { status: remote.bytes ? 200 : 404 });
    if (req.method !== 'PUT') return new Response(null, { status: 405 });
    remote.bytes = Buffer.from(await req.arrayBuffer());
    remote.puts++;
    return new Response(null, { status: 201 });
  });
  return { remote, creds: { ...creds, remotePath: 'config.jsonc' } };
}

test('manual download preserves BOM bytes and records their exact hash', async () => {
  const bytes = Buffer.from('\uFEFF' + localConfig);
  const { creds } = serveBytes(bytes);

  const result = await webdav.downloadFromWebdav(creds);

  expect(readFileSync(process.env.OMO_CONFIG_PATH).equals(bytes)).toBe(true);
  const hash = createHash('sha256').update(bytes).digest('hex');
  expect(result.revision).toBe(hash);
  expect(webdav.getWebdavConfig()).toMatchObject({ lastUploadedRevision: hash, lastRemoteHash: hash });
});

test('manual download refuses invalid UTF-8 without replacing the local file', async () => {
  const original = Buffer.from('\uFEFF' + localConfig);
  writeFileSync(process.env.OMO_CONFIG_PATH, original);
  const bytes = Buffer.concat([Buffer.from('{"note":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  const { creds } = serveBytes(bytes);

  const outcome = await webdav.downloadFromWebdav(creds).then(() => 'accepted', err => err.message);

  expect({ outcome, originalPreserved: readFileSync(process.env.OMO_CONFIG_PATH).equals(original) }).toEqual({
    outcome: expect.stringContaining('远端文件非合法 JSON/JSONC'), originalPreserved: true,
  });
});

test('auto sync uploads a local edit when the BOM-bearing remote is byte-identical', async () => {
  const { remote, creds } = serveBytes();
  const first = Buffer.from('\uFEFF{}');
  writeFileSync(process.env.OMO_CONFIG_PATH, first);
  expect((await webdav.autoSyncTick(creds)).lastResult).toBe('uploaded');
  expect(remote.bytes.equals(first)).toBe(true);
  const edited = Buffer.from('\uFEFF{"x":1}');
  writeFileSync(process.env.OMO_CONFIG_PATH, edited);

  expect((await webdav.autoSyncTick(creds)).lastResult).toBe('uploaded');
  expect(remote.bytes.equals(edited)).toBe(true);
  expect(remote.puts).toBe(2);
});

test('auto sync refuses to overwrite a remote whose only change is a BOM', async () => {
  const { remote, creds } = serveBytes();
  writeFileSync(process.env.OMO_CONFIG_PATH, '{}');
  expect((await webdav.autoSyncTick(creds)).lastResult).toBe('uploaded');
  const theirs = Buffer.from('\uFEFF{}');
  remote.bytes = theirs;
  writeFileSync(process.env.OMO_CONFIG_PATH, '{"v":2}');

  expect((await webdav.autoSyncTick(creds)).lastResult).toBe('conflict');
  expect(remote.bytes.equals(theirs)).toBe(true);
  expect(remote.puts).toBe(1);
});

test('active Magpie WebDAV credentials override custom credentials; active S3 does not', async () => {
  const config = serve(() => new Response(null, { status: 207 }));
  const syncFile = join(process.env.MAGPIE_CONFIG_DIR, 'sync.json');
  const writeSync = (url, password) => writeFileSync(syncFile, JSON.stringify({
    url, user: config.user, password, passphrase: 'fixture-passphrase',
  }));
  webdav.saveWebdavConfig({ ...config, useMagpieSync: true, password: 'wrong-fixture-password' });
  writeSync(config.url, config.password);
  expect((await webdav.testWebdavConnection()).ok).toBe(true);
  expect(await webdav.testWebdavConnection({ useMagpieSync: false })).toMatchObject({ ok: false, error: expect.stringContaining('认证失败') });

  webdav.saveWebdavConfig({ password: config.password });
  writeSync('s3://fixture-bucket', 'fixture-s3-key');
  expect((await webdav.testWebdavConnection()).ok).toBe(true);
});

test('automatic first upload creates missing WebDAV collections before storing the file', async () => {
  const collections = new Set(['/']);
  let stored;
  const creds = serve(async (req, url) => {
    const parent = url.pathname.replace(/[^/]+\/?$/, '');
    if (req.method === 'PROPFIND') return new Response(null, { status: collections.has(url.pathname) ? 207 : 404 });
    if (req.method === 'MKCOL' && collections.has(parent)) {
      collections.add(url.pathname);
      return new Response(null, { status: 201 });
    }
    if (req.method === 'PUT' && collections.has(parent)) {
      stored = await req.text();
      return new Response(null, { status: 201 });
    }
    return new Response(null, { status: req.method === 'GET' ? 404 : 409 });
  });

  const result = await webdav.autoSyncTick(creds);
  expect(result).toMatchObject({ lastResult: 'uploaded', lastError: null });
  expect(stored).toBe(localConfig);
});

test('upload stops when an ancestor PROPFIND returns 503, even when PUT could succeed', async () => {
  let stored = false;
  const creds = serve(req => {
    if (req.method === 'PUT') { stored = true; return new Response(null, { status: 201 }); }
    return new Response('temporarily unavailable', { status: 503 });
  });

  await expect(webdav.uploadToWebdav(creds)).rejects.toThrow(/HTTP 503/);
  expect(stored).toBe(false);
});

test('manual upload and download use the same encoded path under the base collection', async () => {
  const collection = '/dav/base/%20%E8%B5%84%E6%96%99/';
  const file = `${collection}%E9%85%8D%E7%BD%AE.jsonc`;
  let stored;
  const creds = serve(async (req, url) => {
    if (req.method === 'PROPFIND' && url.pathname === collection) return new Response('<multistatus/>', { status: 207 });
    if (url.pathname !== file) return new Response(null, { status: 404 });
    if (req.method === 'PUT') {
      stored = await req.text();
      return new Response('created', { status: 201 });
    }
    if (req.method === 'GET') return new Response(stored);
    return new Response(null, { status: 405 });
  });
  creds.url += 'dav/base?fixture=1';
  creds.remotePath = ' 资料//配置.jsonc';

  const uploaded = await webdav.uploadToWebdav(creds);
  expect(new URL(uploaded.fileUrl).search).toBe('?fixture=1');
  expect(stored).toBe(localConfig);
  writeFileSync(process.env.OMO_CONFIG_PATH, '{}');
  await webdav.downloadFromWebdav(creds);
  expect(readFileSync(process.env.OMO_CONFIG_PATH, 'utf8')).toBe(localConfig);
});

test('connection check releases the unused PROPFIND body without waiting for it to finish', async () => {
  const { promise: cancelled, resolve } = Promise.withResolvers();
  const creds = serve(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('<multistatus>')); },
    cancel: resolve,
  }), { status: 207 }));

  expect((await webdav.testWebdavConnection(creds)).ok).toBe(true);
  await expect(Promise.race([
    cancelled.then(() => 'cancelled'),
    Bun.sleep(1500).then(() => 'response still open'),
  ])).resolves.toBe('cancelled');
});

test('download aborts a stalled HTTP body and leaves the local config intact', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"categories":');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const operation = webdav.downloadFromWebdav({ ...custom, url: `http://127.0.0.1:${server.address().port}` });
  const settled = operation.then(() => 'unexpected success', err => err.name);
  let breaker;
  try {
    const outcome = await Promise.race([settled, new Promise(resolve => {
      breaker = setTimeout(resolve, 12_000, 'download still pending');
    })]);
    expect(outcome).toBe('TimeoutError');
    expect(readFileSync(process.env.OMO_CONFIG_PATH, 'utf8')).toBe(localConfig);
  } finally {
    clearTimeout(breaker);
    server.close();
    server.closeAllConnections();
    await settled;
  }
}, 15_000);
