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
  if (cfg.useMagpieSync) {
    const magpieSync = getMagpieSyncConfig();
    if (magpieSync && magpieSync.url && magpieSync.user && magpieSync.password) {
      return {
        url: magpieSync.url.endsWith('/') ? magpieSync.url : magpieSync.url + '/',
        user: magpieSync.user,
        password: magpieSync.password,
        remotePath: cfg.remotePath || 'magpie/omo/omo.jsonc',
        source: 'magpie',
      };
    }
  }

  return {
    url: cfg.url ? (cfg.url.endsWith('/') ? cfg.url : cfg.url + '/') : '',
    user: cfg.user || '',
    password: cfg.password || '',
    remotePath: cfg.remotePath || 'magpie/omo/omo.jsonc',
    source: 'custom',
  };
}

// 构造 Basic Auth 请求头
function makeAuthHeader(user, password) {
  return 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
}

// 递归确保 WebDAV 上的各级父目录已创建
async function ensureRemoteDirectories(baseUrl, remotePath, authHeader) {
  const segments = remotePath.split('/').filter(Boolean);
  segments.pop(); // 移除文件名，保留目录列表

  let currentPath = '';
  for (const seg of segments) {
    currentPath += `${seg}/`;
    const checkUrl = new URL(currentPath, baseUrl).href;
    const probe = await fetch(checkUrl, {
      method: 'PROPFIND',
      headers: { 'Authorization': authHeader, 'Depth': '0' },
    });

    if (probe.status === 404) {
      const mk = await fetch(checkUrl, {
        method: 'MKCOL',
        headers: { 'Authorization': authHeader },
      });
      if (!mk.ok && mk.status !== 405 && mk.status !== 201) {
        throw new Error(`创建远端目录 ${currentPath} 失败: HTTP ${mk.status}`);
      }
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
    const res = await fetch(creds.url, {
      method: 'PROPFIND',
      headers: {
        'Authorization': authHeader,
        'Depth': '0',
      },
    });

    if (res.status === 401) {
      return { ok: false, error: 'WebDAV 认证失败，请检查用户名或应用密码' };
    }
    if (res.status === 207 || res.ok) {
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

  const content = fs.readFileSync(localFile, 'utf-8');
  const authHeader = makeAuthHeader(creds.user, creds.password);

  // 确保父目录存在
  await ensureRemoteDirectories(creds.url, creds.remotePath, authHeader);

  const fileUrl = new URL(creds.remotePath, creds.url).href;
  const res = await fetch(fileUrl, {
    method: 'PUT',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: content,
  });

  if (!res.ok && res.status !== 201 && res.status !== 204) {
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
  const fileUrl = new URL(creds.remotePath, creds.url).href;

  const res = await fetch(fileUrl, {
    method: 'GET',
    headers: { 'Authorization': authHeader },
  });

  if (res.status === 404) {
    throw new Error('远端未找到 OmO 配置文件');
  }
  if (!res.ok) {
    throw new Error(`下载失败: HTTP ${res.status} ${res.statusText}`);
  }

  const remoteContent = await res.text();

  // 校验下载内容是否为合法 JSONC
  try {
    parseConfig(remoteContent);
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
    fs.writeFileSync(tmpPath, remoteContent, {encoding:'utf-8',mode:0o600,flag:'wx'});
    fs.renameSync(tmpPath, localFile);
  } finally { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); }

  const now = new Date().toISOString();
  saveWebdavConfig({ lastSync: now });

  const revision = crypto.createHash('sha256').update(remoteContent).digest('hex');

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
      const fileUrl = new URL(creds.remotePath, creds.url).href;
      const res = await fetch(fileUrl, {
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
  };
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new ConfigError('WebDAV 配置须为对象');
  for (const [key, value] of Object.entries(config)) {
    if (key === 'useMagpieSync' && typeof value === 'boolean') continue;
    if (key === 'lastSync' && (value === null || typeof value === 'string')) continue;
    if (!['url','user','password','remotePath'].includes(key) || typeof value !== 'string') throw new ConfigError('WebDAV 配置字段无效');
    if (key === 'url' && value) {
      let url;
      try { url = new URL(value); } catch { throw new ConfigError('WebDAV 地址无效'); }
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new ConfigError('WebDAV 地址无效');
    }
    if (key === 'remotePath' && (!value || value.startsWith('/') || value.split('/').some(segment => segment === '..' || segment === '.') || /[\\?#:]/.test(value) || /%/i.test(value))) throw new ConfigError('WebDAV 云端路径无效');
  }
}
