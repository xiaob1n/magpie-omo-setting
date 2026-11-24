import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { getOmoConfigPath, parseConfig, ConfigError } from './omo-config.mjs';

// WebDAV 配置文件存放路径
function getWebdavConfigFile() {
  const dir = process.env.MAGPIE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.config', 'magpie');
  return path.join(dir, 'omo-webdav.json');
}

// 获取 magpie 自身的 WebDAV 同步配置 (~/.config/magpie/sync.json)
function getMagpieSyncConfig() {
  const syncPath = path.join(process.env.MAGPIE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.config', 'magpie'), 'sync.json');
  if (!fs.existsSync(syncPath)) return null;
  try {
    const raw = fs.readFileSync(syncPath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

// 读取当前 WebDAV 配置
export function getWebdavConfig() {
  const configFile = getWebdavConfigFile();
  let custom = {
    useMagpieSync: true,
    url: '',
    user: '',
    password: '',
    remotePath: 'magpie/omo/omo.jsonc',
    lastSync: null,
  };

  if (fs.existsSync(configFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      custom = { ...custom, ...data };
    } catch {
      // 保持默认
    }
  }

  return custom;
}

// 保存 WebDAV 配置
export function saveWebdavConfig(newConfig) {
  validateConfig(newConfig);
  const configFile = getWebdavConfigFile();
  const current = getWebdavConfig();
  const merged = { ...current, ...newConfig };
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  if (newConfig.password === '') merged.password = current.password;
  fs.writeFileSync(configFile, JSON.stringify(merged, null, 2), {encoding:'utf-8', mode:0o600});
  fs.chmodSync(configFile, 0o600);
  const { password, ...safe } = merged;
  return safe;
}

// 解析实际生效的连接凭证与目标 URL
export function resolveEffectiveCredentials(customConfig) {
  if (customConfig !== undefined && customConfig !== null) validateConfig(customConfig);
  const baseCfg = getWebdavConfig();
  const cfg = (customConfig && Object.keys(customConfig).length > 0)
    ? { ...baseCfg, ...customConfig }
    : baseCfg;
  if (customConfig?.password === '') cfg.password = baseCfg.password;
  const magpie = cfg.useMagpieSync ? getMagpieSyncConfig() : null;
  const magpieUrl = webdavUrl(magpie?.url);
  const inherited = magpieUrl && magpie.user && magpie.password;
  const { user, password } = inherited ? magpie : cfg;
  const base = inherited ? magpieUrl : webdavUrl(cfg.url);
  if (base && !base.pathname.endsWith('/')) base.pathname += '/';
  return {
    url: base?.href || '',
    user: user || '',
    password: password || '',
    remotePath: cfg.remotePath || 'magpie/omo/omo.jsonc',
    source: inherited ? 'magpie' : 'custom',
  };
}

function webdavUrl(value) {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
}

// 构造 Basic Auth 请求头
function makeAuthHeader(user, password) {
  return 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
}

function remoteUrl(baseUrl, remotePath) {
  const url = new URL(baseUrl);
  url.pathname += remotePath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  if (remotePath.endsWith('/')) url.pathname += '/';
  return url.href;
}

async function requestWebdav(url, options) {
  const signal = options.signal ?? AbortSignal.timeout(10_000);
  const res = await fetch(url, { ...options, signal });
  if (options.method !== 'GET' || !res.ok) await res.body?.cancel();
  return res;
}

// 递归确保 WebDAV 上的各级父目录已创建
async function ensureRemoteDirectories(baseUrl, remotePath, authHeader) {
  const segments = remotePath.split('/').filter(Boolean);
  segments.pop(); // 移除文件名，保留目录列表

  let currentPath = '';
  for (const seg of segments) {
    currentPath += `${seg}/`;
    const checkUrl = remoteUrl(baseUrl, currentPath);
    const probe = await requestWebdav(checkUrl, {
      method: 'PROPFIND',
      headers: { 'Authorization': authHeader, 'Depth': '0' },
    });

    if (probe.status === 404) {
      const mk = await requestWebdav(checkUrl, {
        method: 'MKCOL',
        headers: { 'Authorization': authHeader },
      });
      if (!mk.ok && mk.status !== 405) {
        throw new Error(`创建远端目录 ${currentPath} 失败: HTTP ${mk.status}`);
      }
    } else if (!probe.ok) {
      throw new Error(`检查远端目录 ${currentPath} 失败: HTTP ${probe.status}`);
    }
  }
}

// 测试 WebDAV 连通性
export async function testWebdavConnection(customConfig) {
  const creds = resolveEffectiveCredentials(customConfig);
  if (!creds.url || !creds.user || !creds.password) {
    return { ok: false, error: 'WebDAV 地址或认证凭据未填写' };
  }

  try {
    const authHeader = makeAuthHeader(creds.user, creds.password);
    const res = await requestWebdav(creds.url, {
      method: 'PROPFIND',
      headers: {
        'Authorization': authHeader,
        'Depth': '0',
      },
    });

    if (res.status === 401) {
      return { ok: false, error: 'WebDAV 认证失败，请检查用户名或应用密码' };
    }
    if (res.ok) {
      return { ok: true, message: 'WebDAV 连接成功' };
    }

    return { ok: false, error: `服务器返回状态码: ${res.status} ${res.statusText}` };
  } catch (err) {
    return { ok: false, error: `网络请求失败: ${err.message}` };
  }
}

// 上传本地 ~/.omo/omo.jsonc 到 WebDAV
export async function uploadToWebdav(customConfig) {
  const creds = resolveEffectiveCredentials(customConfig);
  if (!creds.url || !creds.user || !creds.password) {
    throw new Error('WebDAV 未正确配置');
  }

  const localFile = getOmoConfigPath();
  if (!fs.existsSync(localFile)) {
    throw new Error('本地 OmO 配置文件不存在');
  }

  const content = fs.readFileSync(localFile);
  const authHeader = makeAuthHeader(creds.user, creds.password);

  // 确保父目录存在
  await ensureRemoteDirectories(creds.url, creds.remotePath, authHeader);

  const fileUrl = remoteUrl(creds.url, creds.remotePath);
  const res = await requestWebdav(fileUrl, {
    method: 'PUT',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: content,
  });

  if (!res.ok) {
    throw new Error(`上传失败: HTTP ${res.status} ${res.statusText}`);
  }

  const now = new Date().toISOString();
  saveWebdavConfig({ lastSync: now });

  return {
    ok: true,
    fileUrl,
    lastSync: now,
  };
}

// 从 WebDAV 下载远端配置并覆盖到本地 ~/.omo/omo.jsonc（带本地自动备份）
export async function downloadFromWebdav(customConfig) {
  const creds = resolveEffectiveCredentials(customConfig);
  if (!creds.url || !creds.user || !creds.password) {
    throw new Error('WebDAV 未正确配置');
  }

  const authHeader = makeAuthHeader(creds.user, creds.password);
  const fileUrl = remoteUrl(creds.url, creds.remotePath);

  const res = await requestWebdav(fileUrl, {
    method: 'GET',
    headers: { 'Authorization': authHeader },
  });

  if (res.status === 404) {
    throw new Error('远端未找到 OmO 配置文件');
  }
  if (!res.ok) {
    throw new Error(`下载失败: HTTP ${res.status} ${res.statusText}`);
  }

  const remoteBytes = Buffer.from(await res.arrayBuffer());

  // 校验下载内容是否为合法 JSONC
  try {
    parseConfig(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(remoteBytes));
  } catch (err) {
    throw new Error(`远端文件非合法 JSON/JSONC: ${err.message}`);
  }

  const localFile = getOmoConfigPath();
  if (fs.existsSync(localFile)) {
    const backupFile = `${localFile}.bak.${Date.now()}`;
    fs.copyFileSync(localFile, backupFile);
  } else {
    const parentDir = path.dirname(localFile);
    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
  }

  const tmpPath = `${localFile}.tmp.${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmpPath, remoteBytes, {mode:0o600,flag:'wx'});
    fs.renameSync(tmpPath, localFile);
  } finally { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); }

  const now = new Date().toISOString();
  const revision = sha256(remoteBytes);
  // 刚拉下来的内容就是当前双方的一致点，自动同步不要在下一轮又把它传回去
  saveWebdavConfig({ lastSync: now, lastUploadedRevision: revision, lastRemoteHash: revision });

  return {
    ok: true,
    path: localFile,
    revision,
    lastSync: now,
  };
}

// 获取 WebDAV 状态摘要信息（用于前端展示，脱敏密码）
export async function getWebdavStatus() {
  const cfg = getWebdavConfig();
  const creds = resolveEffectiveCredentials(cfg);

  const configured = Boolean(creds.url && creds.user && creds.password);

  let remoteInfo = null;
  if (configured) {
    try {
      const authHeader = makeAuthHeader(creds.user, creds.password);
      const fileUrl = remoteUrl(creds.url, creds.remotePath);
      const res = await requestWebdav(fileUrl, {
        method: 'HEAD',
        headers: { 'Authorization': authHeader },
        signal: AbortSignal.timeout(3000),
      });

      if (res.ok) {
        remoteInfo = {
          exists: true,
          lastModified: res.headers.get('last-modified'),
          etag: res.headers.get('etag'),
          contentLength: res.headers.get('content-length'),
        };
      } else if (res.status === 404) {
        remoteInfo = { exists: false };
      }
    } catch {
      // 忽略探测失败
    }
  }

  return {
    configured,
    useMagpieSync: cfg.useMagpieSync,
    source: creds.source,
    url: creds.url,
    user: creds.user,
    remotePath: creds.remotePath,
    lastSync: cfg.lastSync,
    remote: remoteInfo,
    autoSync: getAutoSyncState(),
  };
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new ConfigError('WebDAV 配置须为对象');
  for (const [key, value] of Object.entries(config)) {
    if (key === 'useMagpieSync' && typeof value === 'boolean') continue;
    if (key === 'lastSync' && (value === null || typeof value === 'string')) continue;
    if ((key === 'lastUploadedRevision' || key === 'lastRemoteHash') && (value === null || typeof value === 'string')) continue;
    if (!['url','user','password','remotePath'].includes(key) || typeof value !== 'string') throw new ConfigError('WebDAV 配置字段无效');
    if (key === 'url' && value && !webdavUrl(value)) throw new ConfigError('WebDAV 地址无效');
    if (key === 'remotePath' && (!value || value.startsWith('/') || value.split('/').some(segment => segment === '..' || segment === '.') || /[\\?#:]/.test(value) || /%/i.test(value))) throw new ConfigError('WebDAV 云端路径无效');
  }
}

// ---- 自动同步：每三分钟把本机改动上传一次，绝不自动覆盖本地 ----

export const AUTO_SYNC_MS = 3 * 60 * 1000;

let autoState = { lastAttempt: null, lastResult: 'idle', lastError: null, lastUploadAt: null };

export function getAutoSyncState() {
  return { ...autoState, intervalMs: AUTO_SYNC_MS };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// 只在「本机改过、且远端自上次上传后没被别人改过」时上传。
// 两边都改了就不动，留给用户决定，避免静默覆盖任何一侧。
export async function autoSyncTick(customConfig) {
  autoState = { ...autoState, lastAttempt: new Date().toISOString() };
  const done = (result, error = null) => {
    autoState = { ...autoState, lastResult: result, lastError: error };
    return getAutoSyncState();
  };

  try {
    const cfg = getWebdavConfig();
    const creds = resolveEffectiveCredentials(customConfig);
    if (!creds.url || !creds.user || !creds.password) return done('skipped', 'WebDAV 未配置');

    const localFile = getOmoConfigPath();
    if (!fs.existsSync(localFile)) return done('skipped', '本地 OmO 配置文件不存在');

    const localBytes = fs.readFileSync(localFile);
    const localHash = sha256(localBytes);
    if (cfg.lastUploadedRevision === localHash) return done('unchanged');

    const authHeader = makeAuthHeader(creds.user, creds.password);
    const fileUrl = remoteUrl(creds.url, creds.remotePath);
    const probe = await requestWebdav(fileUrl, { method: 'GET', headers: { 'Authorization': authHeader } });

    let remoteHash = null;
    if (probe.ok) remoteHash = sha256(Buffer.from(await probe.arrayBuffer()));
    else if (probe.status !== 404) throw new Error(`读取远端失败: HTTP ${probe.status}`);

    if (remoteHash && cfg.lastRemoteHash && remoteHash !== cfg.lastRemoteHash) {
      return done('conflict', '远端已被其他设备修改，本次自动上传已跳过');
    }

    if (probe.status === 404) await ensureRemoteDirectories(creds.url, creds.remotePath, authHeader);
    const up = await requestWebdav(fileUrl, {
      method: 'PUT',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json; charset=utf-8' },
      body: localBytes,
    });
    if (!up.ok) throw new Error(`上传失败: HTTP ${up.status}`);

    const now = new Date().toISOString();
    saveWebdavConfig({ lastUploadedRevision: localHash, lastRemoteHash: localHash, lastSync: now });
    autoState = { ...autoState, lastUploadAt: now };
    return done('uploaded');
  } catch (err) {
    return done('failed', err.message);
  }
}
