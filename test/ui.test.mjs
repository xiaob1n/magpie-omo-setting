import { test, expect } from 'bun:test';
import fs from 'node:fs';
import vm from 'node:vm';

function ui() {
  const elements = new Map();
  const element = () => ({children:[],hidden:false,style:{},value:'',textContent:'',append(...children){this.children.push(...children)},focus(){},set innerHTML(value){this.children=[]},get innerHTML(){return ''}});
  const document = {createElement:element,querySelector(){return {content:'fixture-token'}},getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id)}};
  const requests = [];
  const context = vm.createContext({document,Set,console,fetch:async (url,init) => {
    requests.push({url,init});
    return {ok:true,json:async()=>url.includes('categories')?{path:'fixture',status:'ready',revision:'fixture',categories:[],agents:[]}:url.includes('models')?{data:[]}:{configured:false}};
  }});
  vm.runInContext(fs.readFileSync(new URL('../ui/app.js',import.meta.url),'utf8'),context);
  return {document,requests,run:code=>vm.runInContext(code,context)};
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
