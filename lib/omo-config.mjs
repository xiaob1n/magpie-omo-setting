import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parse, parseTree, findNodeAtLocation, modify, applyEdits } from 'jsonc-parser';

const NAMED_AGENTS = ['explore', 'librarian', 'plan-consultant', 'plan-reviewer'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const owns = (value, key) => Object.hasOwn(value, key);

export class ConfigError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function getOmoConfigPath() {
  if (process.env.OMO_CONFIG_PATH) return process.env.OMO_CONFIG_PATH;
  const base = path.join(process.env.HOME || os.homedir(), '.omo');
  return fs.existsSync(path.join(base, 'omo.jsonc')) ? path.join(base, 'omo.jsonc') :
    fs.existsSync(path.join(base, 'omo.json')) ? path.join(base, 'omo.json') : path.join(base, 'omo.jsonc');
}

export function parseConfig(text) {
  const errors = [];
  const root = parse(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
  if (errors.length || !object(root)) throw new ConfigError('配置须为合法 JSONC 对象');
  for (const scope of ['categories', 'agents']) {
    if (owns(root, scope) && !object(root[scope])) throw new ConfigError(`${scope} 须为对象`);
  }
  return root;
}

export function stripJSONC(text) {
  const errors = [];
  const value = parse(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
  if (errors.length) throw new ConfigError('JSONC 解析错误');
  return JSON.stringify(value);
}

function parseEntry(name, value, named) {
  const entry = { name, status: 'ready', models: [], reasoning: null };
  if (value === undefined && named) return entry;
  if (!object(value)) return { ...entry, status: 'error', error: '配置项须为对象' };
  if (owns(value, 'reasoning')) {
    if (typeof value.reasoning !== 'string' || !value.reasoning.trim()) return { ...entry, status: 'error', error: 'reasoning 须为非空字符串' };
    entry.reasoning = value.reasoning.trim();
  }
  let models = value.models;
  if (named && models === undefined && value.model) models = [value.model];
  if (models === undefined && (value.model || value.fallback_models)) return { ...entry, status: 'legacy' };
  if (models === undefined) return entry;
  if (!Array.isArray(models)) return { ...entry, status: 'error', error: 'models 须为数组' };
  for (const [index, model] of models.entries()) {
    const id = object(model) ? model.model : model;
    if (typeof id !== 'string' || !id.trim()) return { ...entry, status: 'error', error: `models[${index}] 格式不正确` };
    entry.models.push({ model: id.trim(), index, object: object(model) });
  }
  return entry;
}

export function readOmoCategories() {
  const file = getOmoConfigPath();
  const result = { path: file, revision: '', status: 'missing', categories: [], agents: [] };
  if (!fs.existsSync(file)) return result;
  const raw = fs.readFileSync(file, 'utf8');
  result.revision = crypto.createHash('sha256').update(raw).digest('hex');
  try {
    const root = parseConfig(raw);
    return { ...result, status: 'ready',
      categories: Object.entries(root.categories || {}).map(([name, value]) => parseEntry(name, value, false)),
      agents: NAMED_AGENTS.map(name => parseEntry(name, root.agents?.[name], true)),
    };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return { ...result, status: 'error', error: err.message };
  }
}

const MODEL_FMT = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

// 按索引就地改 models 数组：未改的元素与它们旁边的注释原样保留
// 重排只搬原文片段：每个元素连同它后面的注释与换行整段搬走，一个字节都不重写
function reorderRawItems(text, keys, order) {
  const root = parseTree(text, [], { allowTrailingComma: true });
  const arr = findNodeAtLocation(root, keys);
  if (!arr || !Array.isArray(arr.children) || arr.children.length !== order.length) return null;
  const n = arr.children.length;
  const close = arr.offset + arr.length - 1;
  const chunks = arr.children.map((el, i) => text.slice(el.offset, i + 1 < n ? arr.children[i + 1].offset : close));
  const lead = text.slice(arr.offset + 1, arr.children[0].offset);
  const setComma = (chunk, len, want) => {
    for (let i = len; i < chunk.length; i++) {
      if (chunk[i] === ',') return want ? chunk : chunk.slice(0, i) + chunk.slice(i + 1);
    }
    return want ? chunk.slice(0, len) + ',' + chunk.slice(len) : chunk;
  };
  const prefix = lead.includes('\n') ? lead : '';
  const body = prefix + order.map((j, k) => setComma(chunks[j], arr.children[j].length, k < order.length - 1)).join('');
  return text.slice(0, arr.offset + 1) + body + text.slice(close);
}

function patchModelItems(text, keys, original, models, indexes = []) {
  // 纯重排（条目内容不变、只是换位置）：整段搬原文
  if (indexes.length === original.length && indexes.every((j) => Number.isInteger(j)) &&
      new Set(indexes).size === original.length &&
      indexes.every((j) => j >= 0 && j < original.length) &&
      indexes.every((j, k) => JSON.stringify(original[j]) === JSON.stringify(models[k]))) {
    const moved = reorderRawItems(text, keys, indexes);
    if (moved) return moved;
  }
  let out = text;
  const edit = (path, value) => { out = applyEdits(out, modify(out, path, value, MODEL_FMT)); };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const common = Math.min(original.length, models.length);
  for (let i = 0; i < common; i++) {
    if (same(original[i], models[i])) continue;
    if (object(original[i]) && object(models[i])) {
      const restOld = { ...original[i] };
      delete restOld.model;
      const restNew = { ...models[i] };
      delete restNew.model;
      // 只改了模型名就只动 model 字段，对象里的其他键与注释不动
      if (same(restOld, restNew)) edit([...keys, i, 'model'], models[i].model);
      else edit([...keys, i], models[i]);
    } else {
      edit([...keys, i], models[i]);
    }
  }
  for (let i = common; i < models.length; i++) edit([...keys, i], models[i]);
  for (let i = original.length - 1; i >= models.length; i--) edit([...keys, i], undefined);
  return out;
}

export function saveOmoCategories(revision, changes) {
  if (typeof revision !== 'string' || !Array.isArray(changes)) throw new ConfigError('revision 与 changes 格式错误');
  const file = getOmoConfigPath();
  if (!fs.existsSync(file)) throw new ConfigError('配置文件不存在', 404);
  const raw = fs.readFileSync(file, 'utf8');
  if (revision !== crypto.createHash('sha256').update(raw).digest('hex')) throw new ConfigError('OmO 配置文件已被外部修改，请刷新后再保存', 409);
  const root = parseConfig(raw);
  let out = raw;
  const seen = new Set();
  const patch = (keys, value) => { out = applyEdits(out, modify(out, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })); };
  for (const change of changes) {
    if (!object(change) || !['categories', 'agents'].includes(change.scope) || typeof change.name !== 'string' ||
      ['__proto__', 'prototype', 'constructor'].includes(change.name) || !change.name ||
      Object.keys(change).some(key => !['scope', 'name', 'models', 'reasoning'].includes(key))) throw new ConfigError('修改项格式错误');
    const { scope, name } = change;
    const key = `${scope}:${name}`;
    if (seen.has(key)) throw new ConfigError('修改项重复');
    seen.add(key);
    const exists = owns(root[scope] || {}, name);
    if (!exists && !(scope === 'agents' && NAMED_AGENTS.includes(name))) throw new ConfigError(`配置项 ${name} 不存在`);
    const target = exists ? root[scope][name] : {};
    const entry = parseEntry(name, target, scope === 'agents');
    if (entry.status === 'error' || (entry.status === 'legacy' && owns(change, 'models'))) throw new ConfigError('错误配置项或旧版模型只读');
    if (owns(change, 'models')) {
      if (!Array.isArray(change.models) || !change.models.length) throw new ConfigError('models 须为非空数组');
      const original = target.models ?? (target.model ? [target.model] : []);
      const used = new Set();
      const models = change.models.map(item => {
        if (!object(item) || typeof item.model !== 'string' || !item.model.trim() ||
          Object.keys(item).some(key => !['model', 'index'].includes(key))) throw new ConfigError('模型格式错误');
        if (item.index !== undefined) {
          if (!Number.isInteger(item.index) || item.index < 0 || item.index >= original.length || used.has(item.index)) throw new ConfigError('模型索引无效');
          used.add(item.index);
        }
        return object(original[item.index]) ? { ...original[item.index], model: item.model.trim() } : item.model.trim();
      });
      // 逐元素编辑，避免整段替换把数组内部的注释一并删掉
      if (Array.isArray(target.models)) out = patchModelItems(out, [scope, name, 'models'], original, models, change.models.map((item) => item.index));
      else patch([scope, name, 'models'], models);
      if (owns(target, 'model')) patch([scope, name, 'model'], undefined);
    }
    if (owns(change, 'reasoning')) {
      if (!object(change.reasoning) || !owns(change.reasoning, 'value') ||
        !(change.reasoning.value === null || typeof change.reasoning.value === 'string')) throw new ConfigError('reasoning 格式错误');
      patch([scope, name, 'reasoning'], change.reasoning.value?.trim() || undefined);
    }
  }
  parseConfig(out);
  const tmp = `${file}.tmp.${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmp, out, { encoding: 'utf8', mode: fs.statSync(file).mode & 0o777, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return readOmoCategories();
}
