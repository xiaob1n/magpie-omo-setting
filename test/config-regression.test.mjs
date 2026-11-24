import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, parseConfig, readOmoCategories, saveOmoCategories } from '../lib/omo-config.mjs';

const envKeys = ['HOME', 'MAGPIE_CONFIG_DIR', 'OMO_CONFIG_PATH'];
let oldEnv;
let tmpDir;
let file;

beforeEach(() => {
  oldEnv = envKeys.map(key => process.env[key]);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-regression-'));
  file = path.join(tmpDir, 'omo.jsonc');
  process.env.HOME = tmpDir;
  process.env.MAGPIE_CONFIG_DIR = path.join(tmpDir, 'magpie');
  process.env.OMO_CONFIG_PATH = file;
});

afterEach(() => {
  envKeys.forEach((key, i) => {
    if (oldEnv[i] === undefined) delete process.env[key];
    else process.env[key] = oldEnv[i];
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test.each([
  ['string', '"a", "b"', /"models"\s*:\s*\[\s*"a"\s*\]/],
  ['object', '"a", {"model":"b"}', /"models"\s*:\s*\[\s*"a"\s*\]/],
  ['item before a trailing comma', '"a", "b",', /"models"\s*:\s*\[\s*"a"\s*,\s*\]/],
])('removes the last %s without leaving a token before the closing bracket', (_kind, models, expected) => {
  const raw = `{"categories":{"quick":{"models":[${models}]}}}`;
  fs.writeFileSync(file, raw);
  const doc = readOmoCategories();
  expect(doc.status).toBe('ready');
  const saved = saveOmoCategories(doc.revision, [{ scope: 'categories', name: 'quick', models: [{ model: 'a', index: 0 }] }]);
  expect(saved.categories[0].models.map(item => item.model)).toEqual(['a']);
  expect(readOmoCategories()).toEqual(saved);
  expect(fs.readFileSync(file, 'utf8')).toMatch(expected);
});

test('moves edited retained objects without losing comments, BOM, metadata, or EOF formatting', () => {
  const raw = '\uFEFF' + `{
  // 全局注释
  "categories": {"quick": {
    "models": [/* 数组开头 */
      {"model":"a", /* a 元数据 */ "temperature":0.1}, // a 行尾, ]
      {"model":"b", /* b 元数据 */ "vendor":{"x":true}}, // b 行尾
      "c" /* 将删除模型的说明 */,
    ],
    "untouched": {"x":1}
  }},
  "other": [1,2,],
} // 文件末尾`;
  fs.writeFileSync(file, raw, { mode: 0o640 });
  const doc = readOmoCategories();
  saveOmoCategories(doc.revision, [{ scope: 'categories', name: 'quick', models: [
    { model: 'b2', index: 1 }, { model: 'a', index: 0 }, { model: 'new' },
  ] }]);

  const saved = fs.readFileSync(file, 'utf8');
  expect(parseConfig(saved)).toEqual({ categories: { quick: {
    models: [{ model: 'b2', vendor: { x: true } }, { model: 'a', temperature: 0.1 }, 'new'],
    untouched: { x: 1 },
  } }, other: [1, 2] });
  expect(saved.startsWith('\uFEFF{\n  // 全局注释')).toBe(true);
  expect(saved.endsWith('} // 文件末尾')).toBe(true);
  expect(saved).toContain('"other": [1,2,]');
  expect(saved).toContain('/* 数组开头 */');
  expect(saved).toContain('/* 将删除模型的说明 */');
  expect(saved).toMatch(/\{"model":"b2", \/\* b 元数据 \*\/ "vendor":\{"x":true\}\}, \/\/ b 行尾/);
  expect(saved).toMatch(/\{"model":"a", \/\* a 元数据 \*\/ "temperature":0\.1\}, \/\/ a 行尾, \]/);
  expect(fs.statSync(file).mode & 0o777).toBe(0o640);
});

test('removes an earlier object without removing its interior or adjacent comments', () => {
  const raw = `{"categories":{"quick":{"models":[
    {"model":"a", /* 旧模型说明 */ "extra":true}, // 第一项行尾
    // 第二项开头
    {"model":"b", /* 保留模型说明 */ "extra":false} // 第二项行尾
  ]}}}`;
  fs.writeFileSync(file, raw);
  saveOmoCategories(readOmoCategories().revision, [{ scope: 'categories', name: 'quick', models: [{ model: 'b', index: 1 }] }]);
  const saved = fs.readFileSync(file, 'utf8');
  expect(parseConfig(saved).categories.quick.models).toEqual([{ model: 'b', extra: false }]);
  for (const comment of ['/* 旧模型说明 */', '// 第一项行尾', '// 第二项开头', '/* 保留模型说明 */', '// 第二项行尾']) {
    expect(saved).toContain(comment);
  }
});

test('appends to a commented empty array but does not allow removing its final model', () => {
  fs.writeFileSync(file, '{"categories":{"quick":{"models":[/* 空模型列表 */]}}}');
  const doc = readOmoCategories();
  expect(doc.categories[0].models).toEqual([]);
  const saved = saveOmoCategories(doc.revision, [{ scope: 'categories', name: 'quick', models: [{ model: 'first' }] }]);
  expect(saved.categories[0].models.map(item => item.model)).toEqual(['first']);
  const raw = fs.readFileSync(file, 'utf8');
  expect(raw).toContain('/* 空模型列表 */');
  expect(() => saveOmoCategories(saved.revision, [{ scope: 'categories', name: 'quick', models: [] }])).toThrow(ConfigError);
  expect(fs.readFileSync(file, 'utf8')).toBe(raw);
});

test.each([['LF', '\n'], ['CRLF', '\r\n']])('append keeps a line comment and outer bytes unchanged with %s', (_kind, eol) => {
  const before = '\uFEFF{"unknown": {"x":1},"categories":{"q":{"models":[';
  const after = '] , "other":true}}}';
  fs.writeFileSync(file, before + '"a" // only A' + eol + after);

  saveOmoCategories(readOmoCategories().revision, [{ scope: 'categories', name: 'q', models: [
    { model: 'a', index: 0 }, { model: 'b' },
  ] }]);

  const saved = fs.readFileSync(file, 'utf8');
  expect(saved.startsWith(before)).toBe(true);
  expect(saved.endsWith(after)).toBe(true);
  expect(saved.slice(before.length, -after.length)).toMatch(new RegExp(`^"a", // only A${eol}[ \\t]*"b"(?:${eol}[ \\t]*)?$`));
});

test('reorder moves a full-line comment with the next item and a line-end comment with the previous item', () => {
  const before = '{"unknown": {"x":1},"categories":{"q":{"models":[';
  const after = '] , "other":true}}}';
  fs.writeFileSync(file, before + '/* array intro */ "a", // only A\n // only B\n "b"' + after);

  saveOmoCategories(readOmoCategories().revision, [{ scope: 'categories', name: 'q', models: [
    { model: 'b', index: 1 }, { model: 'a', index: 0 },
  ] }]);

  const saved = fs.readFileSync(file, 'utf8');
  expect(saved.startsWith(before)).toBe(true);
  expect(saved.endsWith(after)).toBe(true);
  expect(saved.slice(before.length, -after.length)).toMatch(/^\/\* array intro \*\/[ \t]*\n[ \t]*\/\/ only B\n[ \t]*"b",\s*"a" \/\/ only A\n[ \t]*$/);
});

test.each([['LF', '', '\n'], ['CRLF with inline header', '/* array intro */', '\r\n']])(
  'reorder moves the first item’s full-line annotation with %s', (_kind, header, eol) => {
    const before = '{"unknown": {"x":1},"categories":{"q":{"models":[' + header;
    const after = '] , "other":true}}}';
    const a = `${eol} // explanation for A${eol} "a"`;
    const b = `${eol} // explanation for B${eol} "b"`;
    fs.writeFileSync(file, before + a + ',' + b + eol + after);

    saveOmoCategories(readOmoCategories().revision, [{ scope: 'categories', name: 'q', models: [
      { model: 'b', index: 1 }, { model: 'a', index: 0 },
    ] }]);

    expect(fs.readFileSync(file, 'utf8')).toBe(before + b + ',' + a + eol + after);
  },
);

test.each([
  ['LF line', '\n', '// array header'], ['CRLF line', '\r\n', '// array header'],
  ['LF block', '\n', '/* array header */'], ['CRLF block', '\r\n', '/* array header */'],
])('HTTP reorder keeps both models and their annotations with a %s header', async (_kind, eol, header) => {
  const before = '{"categories":{"q":{"models":[ ' + header;
  const note = `${eol} // only A${eol} "a"`;
  const after = ']}}}';
  fs.writeFileSync(file, before + note + ', "b"' + after);

  const { startServer } = await import('../index.mjs');
  const server = startServer({ port: 0 });
  try {
    const page = await fetch(server.url);
    const token = /name="omo-token" content="([^"]+)"/.exec(await page.text())[1];
    const url = new URL('/api/omo/categories', server.url);
    const headers = { Origin: 'null', 'X-Omo-Token': token, 'Content-Type': 'application/json' };
    const initial = await fetch(url, { headers });
    expect(initial.status).toBe(200);
    const { revision } = await initial.json();
    const saved = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ revision, changes: [
      { scope: 'categories', name: 'q', models: [{ model: 'b', index: 1 }, { model: 'a', index: 0 }] },
    ] }) });
    expect(saved.status).toBe(200);
    expect((await saved.json()).categories[0].models.map(item => item.model)).toEqual(['b', 'a']);
    const readback = await fetch(url, { headers });
    expect(readback.status).toBe(200);
    expect((await readback.json()).categories[0].models.map(item => item.model)).toEqual(['b', 'a']);
    const gap = header.startsWith('//') ? eol : '';
    expect(fs.readFileSync(file, 'utf8')).toBe(before + gap + '"b",' + note + ' ' + after);
  } finally {
    server.stop(true);
  }
});
