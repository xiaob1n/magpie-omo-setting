import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parse, parseTree, findNodeAtLocation, modify, applyEdits, createScanner, SyntaxKind } from 'jsonc-parser';

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

function patchModelItems(text, keys, selections) {
  const arr = findNodeAtLocation(parseTree(text, [], { allowTrailingComma: true }), keys);
  const items = arr.children;
  let out = text;
  if (items.length === selections.length && selections.every(({ index }, i) => index === i)) {
    for (const [i, { index, value }] of selections.entries()) {
      const at = object(value) ? [...keys, index, 'model'] : [...keys, i];
      const next = object(value) ? value.model : value;
      const item = items[index];
      const model = object(value) ? findNodeAtLocation(item, ['model']) : item;
      if (model.value === next) continue;
      out = applyEdits(out, modify(out, at, next, {}));
    }
    return out;
  }

  // 只搬移保留项的原文。按语法节点定位结尾，避免 jsonc-parser 删末项时残留一个字符。
  const close = arr.offset + arr.length - 1;
  const lead = text.slice(arr.offset + 1, items[0]?.offset ?? close);
  let firstLead = '';
  let headerEol = '';
  if (items.length) {
    // '[' 同一行的说明留在数组开头；换行后的首项说明随条目移动。
    const scanner = createScanner(lead);
    let newline = -1;
    let lineHeader = false;
    let firstEol = '';
    for (let kind = scanner.scan(); kind !== SyntaxKind.EOF; kind = scanner.scan()) {
      if (newline < 0) {
        if (kind === SyntaxKind.LineCommentTrivia) lineHeader = true;
        if (kind === SyntaxKind.LineBreakTrivia) {
          newline = scanner.getTokenOffset();
          firstEol = scanner.getTokenValue();
        }
      }
      if (newline >= 0 && (kind === SyntaxKind.LineCommentTrivia || kind === SyntaxKind.BlockCommentTrivia)) {
        firstLead = lead.slice(newline);
        if (lineHeader) headerEol = firstEol;
        break;
      }
    }
  }
  const chunks = items.map((item, i) => {
    const end = item.offset + item.length;
    const gap = text.slice(end, items[i + 1]?.offset ?? close);
    const scanner = createScanner(gap);
    let split = gap.length;
    let comma = -1;
    let commentEol = '';
    let lineComment = false;
    // 行尾注释跟前一项，换行后的独立注释跟下一项。
    for (let kind = scanner.scan(); kind !== SyntaxKind.EOF; kind = scanner.scan()) {
      const at = scanner.getTokenOffset();
      if (kind === SyntaxKind.CommaToken) comma = at;
      if (split !== gap.length) continue;
      if (kind === SyntaxKind.LineCommentTrivia) lineComment = true;
      if (kind === SyntaxKind.LineBreakTrivia) {
        split = at;
        if (lineComment) commentEol = gap.slice(at, at + scanner.getTokenLength());
      }
    }
    const tail = gap.slice(0, split);
    const following = comma < split ? gap.slice(split) : gap.slice(split, comma) + gap.slice(comma + 1);
    return { item, end, tail, following, comma, commentEol };
  });
  const last = chunks.at(-1);
  const footer = last?.following ?? '';
  const trailingComma = last && last.comma >= 0;
  const leading = index => index === 0 ? firstLead : index > 0 ? chunks[index - 1].following : '';
  const body = selections.map(({ index, value }, i) => {
    const wantComma = i < selections.length - 1 || trailingComma;
    if (index === undefined) return JSON.stringify(value) + (wantComma ? ',' : '');
    const { item, end, tail, comma, commentEol } = chunks[index];
    const model = object(value) ? findNodeAtLocation(item, ['model']) : item;
    const next = object(value) ? value.model : value;
    const content = model.value === next ? text.slice(item.offset, end) :
      text.slice(item.offset, model.offset) + JSON.stringify(next) + text.slice(model.offset + model.length, end);
    const commaInTail = comma >= 0 && comma < tail.length;
    const attached = commaInTail && !wantComma ? tail.slice(0, comma) + tail.slice(comma + 1) : tail;
    const following = i + 1 < selections.length ? leading(selections[i + 1].index) : footer;
    // 行注释的换行固定在数组头，同时也是当前首项的起始换行。
    const prefix = i === 0 && headerEol ? leading(index).replace(/^(?:\r\n|\r|\n)/, '') : leading(index);
    return prefix + content + (wantComma && !commaInTail ? ',' : '') + attached +
      (/^[\r\n]/.test(following) ? '' : commentEol);
  }).join('');

  // 删除模型时只丢弃 JSON token，原注释保留在数组尾部。
  const kept = new Set(selections.map(({ index }) => index));
  const notes = chunks.map(({ item, end, tail }, i) => {
    if (kept.has(i)) return '';
    const raw = leading(i) + text.slice(item.offset, end) + tail;
    const scanner = createScanner(raw);
    let trivia = '';
    let commented = false;
    for (let kind = scanner.scan(); kind !== SyntaxKind.EOF; kind = scanner.scan()) {
      const comment = kind === SyntaxKind.LineCommentTrivia || kind === SyntaxKind.BlockCommentTrivia;
      if (comment || kind === SyntaxKind.Trivia || kind === SyntaxKind.LineBreakTrivia) {
        trivia += raw.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength());
      }
      commented ||= comment;
    }
    return commented ? '\n' + trivia + '\n' : '';
  }).join('');
  return text.slice(0, arr.offset + 1) + lead.slice(0, lead.length - firstLead.length) + headerEol + body + footer + notes + text.slice(close);
}

export function saveOmoCategories(revision, changes) {
  if (typeof revision !== 'string' || !Array.isArray(changes)) throw new ConfigError('revision 与 changes 格式错误');
  const file = getOmoConfigPath();
  if (!fs.existsSync(file)) throw new ConfigError('配置文件不存在', 404);
  const raw = fs.readFileSync(file, 'utf8');
  if (revision !== crypto.createHash('sha256').update(raw).digest('hex')) throw new ConfigError('OmO 配置文件已被外部修改，请刷新后再保存', 409);
  const root = parseConfig(raw);
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  let out = raw.slice(bom.length);
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
      const selections = change.models.map(item => {
        if (!object(item) || typeof item.model !== 'string' || !item.model.trim() ||
          Object.keys(item).some(key => !['model', 'index'].includes(key))) throw new ConfigError('模型格式错误');
        if (item.index !== undefined) {
          if (!Number.isInteger(item.index) || item.index < 0 || item.index >= original.length || used.has(item.index)) throw new ConfigError('模型索引无效');
          used.add(item.index);
        }
        const model = item.model.trim();
        const previous = original[item.index];
        return { index: item.index, value: object(previous) ? { ...previous, model } : model };
      });
      // 逐元素编辑，避免整段替换把数组内部的注释一并删掉
      if (Array.isArray(target.models)) out = patchModelItems(out, [scope, name, 'models'], selections);
      else patch([scope, name, 'models'], selections.map(({ value }) => value));
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
    fs.writeFileSync(tmp, bom + out, { encoding: 'utf8', mode: fs.statSync(file).mode & 0o777, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return readOmoCategories();
}
