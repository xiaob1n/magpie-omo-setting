import { test, expect } from 'bun:test';
import fs from 'node:fs';
import vm from 'node:vm';

function ui(options = {}) {
  const elements = new Map();
  const docListeners = new Map();
  const winListeners = new Map();
  const intervals = [];
  const element = () => ({children:[],hidden:false,style:{},value:'',textContent:'',append(...children){this.children.push(...children)},focus(){},set innerHTML(value){this.children=[]},get innerHTML(){return ''}});
  const addListener = (map) => (type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  };
  const document = {
    hidden: false,
    createElement: element,
    querySelector(){return {content:'fixture-token'}},
    getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id)},
    addEventListener: addListener(docListeners),
  };
  const requests = [];
  const defaultFetch = async (url, init) => {
    requests.push({url, init});
    return {ok:true,json:async()=>url.includes('categories')?{path:'fixture',status:'ready',revision:'fixture',categories:[],agents:[]}:url.includes('models')?{data:[]}:{configured:false}};
  };
  const context = vm.createContext({
    document, Set, console, URLSearchParams, location:{search:''},
    addEventListener: addListener(winListeners),
    setInterval: (fn, ms) => { intervals.push({fn, ms}); return intervals.length; },
    clearInterval: () => {},
    fetch: async (url, init) => {
      if (options.fetch) {
        requests.push({url, init});
        return options.fetch(url, init);
      }
      return defaultFetch(url, init);
    },
  });
  vm.runInContext(fs.readFileSync(new URL('../ui/app.js',import.meta.url),'utf8'),context);
  return {
    document,
    requests,
    intervals,
    emitDoc: (type) => (docListeners.get(type) || []).forEach((fn) => fn()),
    emitWin: (type) => (winListeners.get(type) || []).forEach((fn) => fn()),
    run: code => vm.runInContext(code, context),
  };
}

test('equal model identifiers reordered by original index are dirty and transmitted', async () => {
  const app=ui();
  await app.run('Promise.resolve()');
  app.run(`baseDoc={revision:'r',categories:[{name:'quick',models:[{model:'same',index:0,object:true},{model:'same',index:1,object:true}]}],agents:[]};draft=cloneDraft(baseDoc.categories,[]);draft[0].models.reverse()`);
  expect(app.run('isDirty()')).toBe(true);
  await app.run('saveChanges()');
  const saved=app.requests.find(r=>r.init.method==='POST');
  expect(saved.url).toBe('api/omo/categories');
  expect(JSON.parse(saved.init.body).changes[0].models.map(m=>m.index)).toEqual([1,0]);
});

test('collapsed cards show primary model and invalid entries expose no editable controls', () => {
  const app=ui();
  const ready=app.run(`renderCard({scope:'categories',name:'quick',status:'ready',models:[{model:'magpie/cpa/foo',index:0}],reasoning:''})`);
  expect(ready.children[1].textContent).toBe('magpie/cpa/foo');
  expect(ready.children.at(-1).hidden).toBe(true);
  for(const status of ['error']) {
    const card=app.run(`renderCard({scope:'categories',name:'broken',status:'${status}',error:'bad',models:[]})`);
    expect(card.children.length).toBe(1);
    expect(card.children[0].children[1].textContent).toContain('只读');
  }
});

test('restoring requires affirmative in-page choice and cancellation sends no request', async () => {
  const app=ui();
  await app.run('Promise.resolve()');
  const before=app.requests.length;
  const cancelled=app.run('downloadWebdav()');
  expect(app.document.getElementById('confirmModal').hidden).toBe(false);
  app.document.getElementById('btnConfirmNo').onclick();
  await cancelled;
  expect(app.requests.slice(before).filter(r=>r.init.method==='POST')).toEqual([]);
  const accepted=app.run('downloadWebdav()');
  app.document.getElementById('btnConfirmYes').onclick();
  await accepted;
  expect(app.requests.filter(r=>r.url==='api/webdav/download').length).toBe(1);
});

test('document missing and error states remain visible', async () => {
  const app=ui();
  await app.run('Promise.resolve()');
  app.run(`baseDoc={status:'missing'};renderList()`);
  expect(app.document.getElementById('catList').textContent).toContain('不存在');
  app.run(`baseDoc={status:'error',error:'parse failed'};renderList()`);
  expect(app.document.getElementById('catList').textContent).toBe('parse failed');
});

test('model list refreshes automatically across modal open, focus, visibility, reload and interval', async () => {
  let models = [{ id: 'magpie/provider-a/m1', name: 'm1', provider: 'provider-a' }];
  let pendingFetch = Promise.resolve();
  const app = ui({
    fetch: (url) => {
      const p = Promise.resolve().then(() => {
        if (url.includes('categories')) return { ok: true, json: async () => ({ path: 'fixture', status: 'ready', revision: 'r1', categories: [], agents: [] }) };
        if (url.includes('models')) return { ok: true, json: async () => ({ data: models }) };
        return { ok: true, json: async () => ({ configured: false }) };
      });
      pendingFetch = p;
      return p;
    },
  });
  const flush = async () => {
    await pendingFetch;
    await app.run('modelsRefresh');
  };
  await flush();

  // 打开模型选择弹窗时同步刷新供应商新模型
  models = [{ id: 'magpie/provider-b/m2', name: 'm2', provider: 'provider-b' }];
  app.run(`openModelModal('categories', 'quick', 0, false)`);
  await flush();
  expect(app.document.getElementById('modelListBox').children.map((c) => c.textContent)).toEqual(['magpie/provider-b/m2']);
  expect(app.requests.filter((r) => r.url.includes('models')).at(-1).init.cache).toBe('no-store');

  // 窗口重新聚焦时自动刷新并实时更新已打开弹窗
  models = [{ id: 'magpie/provider-c/m3', name: 'm3', provider: 'provider-c' }];
  app.emitWin('focus');
  await flush();
  expect(app.document.getElementById('modelListBox').children.map((c) => c.textContent)).toEqual(['magpie/provider-c/m3']);

  // 页面不可见时不请求；切回可见时自动刷新
  const countBeforeHidden = app.requests.filter((r) => r.url.includes('models')).length;
  app.document.hidden = true;
  app.emitDoc('visibilitychange');
  expect(app.requests.filter((r) => r.url.includes('models')).length).toBe(countBeforeHidden);

  models = [{ id: 'magpie/provider-d/m4', name: 'm4', provider: 'provider-d' }];
  app.document.hidden = false;
  app.emitDoc('visibilitychange');
  await flush();
  expect(app.document.getElementById('modelListBox').children.map((c) => c.textContent)).toEqual(['magpie/provider-d/m4']);

  // 点击重新加载按钮时同时刷新模型列表
  models = [{ id: 'magpie/provider-e/m5', name: 'm5', provider: 'provider-e' }];
  await app.document.getElementById('btnReload').onclick();
  expect(app.document.getElementById('modelListBox').children.map((c) => c.textContent)).toEqual(['magpie/provider-e/m5']);

  // 定时轮询在页面可见时自动同步最新模型
  const modelInterval = app.intervals.find((t) => t.ms === 30000);
  expect(modelInterval).toBeDefined();
  models = [{ id: 'magpie/provider-f/m6', name: 'm6', provider: 'provider-f' }];
  modelInterval.fn();
  await flush();
  expect(app.document.getElementById('modelListBox').children.map((c) => c.textContent)).toEqual(['magpie/provider-f/m6']);
});

test('concurrent model refreshes deduplicate, preserve search filter, and clear when providers are empty', async () => {
  let calls = 0;
  let release;
  const app = ui({
    fetch: (url) => {
      if (url.includes('categories')) return Promise.resolve({ ok: true, json: async () => ({ path: 'fixture', status: 'ready', revision: 'r1', categories: [], agents: [] }) });
      if (url.includes('models')) {
        calls++;
        if (calls === 1) return Promise.resolve({ ok: true, json: async () => ({ data: [{ id: 'magpie/a/m1', name: 'm1' }] }) });
        return new Promise((resolve) => { release = (data) => resolve({ ok: true, json: async () => ({ data }) }); });
      }
      return Promise.resolve({ ok: true, json: async () => ({ configured: false }) });
    },
  });
  await app.run('modelsRefresh');
  expect(calls).toBe(1);

  // 打开弹窗并输入搜索词期间并发触发多次刷新，应去重为 1 次请求
  app.run(`openModelModal('categories', 'quick', 0, false)`);
  app.document.getElementById('txtModelSearch').value = 'provider-b';
  app.emitWin('focus');
  app.emitDoc('visibilitychange');
  expect(calls).toBe(2);

  release([
    { id: 'magpie/provider-a/m1', name: 'm1' },
    { id: 'magpie/provider-b/m2', name: 'm2' },
  ]);
  await app.run('modelsRefresh');
  expect(app.document.getElementById('modelListBox').children.map((c) => c.textContent)).toEqual(['magpie/provider-b/m2']);

  // 当所有供应商被关闭返回空列表时，旧模型应清空且退出加载占位
  app.document.getElementById('txtModelSearch').value = '';
  app.emitWin('focus');
  release([]);
  await app.run('modelsRefresh');
  expect(app.document.getElementById('modelListBox').children).toEqual([]);
  expect(app.run('availableModels')).toEqual([]);
});
