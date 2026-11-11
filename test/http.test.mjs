import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchGatewayModels } from '../lib/gateway.mjs';

test('HTTP token, CORS, Host, errors and revision CAS protect actual config writes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'omo-http-'));
  const previous = {HOME:process.env.HOME,OMO_CONFIG_PATH:process.env.OMO_CONFIG_PATH,MAGPIE_OMO_PORT:process.env.MAGPIE_OMO_PORT};
  process.env.HOME = dir;
  process.env.OMO_CONFIG_PATH = path.join(dir,'omo.jsonc');
  const occupied = Bun.serve({hostname:'127.0.0.1',port:0,fetch(){return new Response('occupied')}});
  process.env.MAGPIE_OMO_PORT = String(occupied.port);
  let server;
  try {
    fs.writeFileSync(process.env.OMO_CONFIG_PATH,'{\n// keep comment\n"unknown":{"enabled":true},"categories":{"quick":{"models":["old"]}}}');
    const plugin = await import('../index.mjs');
    expect(plugin.default.id).toBe('magpie-omo-setting');
    expect(typeof plugin.default.server).toBe('function');
    server = plugin.startServer({port:0});
    const base = server.url.href;
    const page = await fetch(base);
    expect(page.headers.get('access-control-allow-origin')).toBeNull();
    const token = /name="omo-token" content="([^"]+)"/.exec(await page.text())[1];
    const request = (route, init = {}) => fetch(new URL(route,base),init);
    const headers = {Origin:'null','X-Omo-Token':token,'Content-Type':'application/json'};
    const ok = await request('api/omo/categories',{headers});
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('null');
    const doc = await ok.json();
    const denied = await request('api/omo/categories',{headers:{Origin:'null'}});
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBe('null');
    const foreign = await request('api/omo/categories',{headers:{...headers,Origin:'https://foreign.invalid'}});
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    const forged = await request('api/omo/categories',{headers:{...headers,Host:'foreign.invalid'}});
    expect(forged.status).toBe(403);
    expect(forged.headers.get('access-control-allow-origin')).toBe('null');
    const preflight = await request('api/omo/categories',{method:'OPTIONS',headers:{Origin:'null'}});
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('X-Omo-Token');
    const malformed = await request('api/webdav/config',{method:'POST',headers,body:'{'});
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get('access-control-allow-origin')).toBe('null');
    const invalid = await request('api/omo/categories',{method:'POST',headers,body:JSON.stringify({revision:doc.revision,changes:[{scope:'bad',name:'quick'}]})});
    expect(invalid.status).toBe(400);
    const saved = await request('api/omo/categories',{method:'POST',headers,body:JSON.stringify({revision:doc.revision,changes:[{scope:'categories',name:'quick',models:[{model:'magpie/cpa/new',index:0}]}]})});
    expect(saved.status).toBe(200);
    const raw = fs.readFileSync(process.env.OMO_CONFIG_PATH,'utf8');
    expect(raw).toContain('// keep comment');
    expect(Bun.JSONC.parse(raw).unknown).toEqual({enabled:true});
    expect(Bun.JSONC.parse(raw).categories.quick.models).toEqual(['magpie/cpa/new']);
    const stale = await request('api/omo/categories',{method:'POST',headers,body:JSON.stringify({revision:doc.revision,changes:[]})});
    expect(stale.status).toBe(409);
    expect(stale.headers.get('access-control-allow-origin')).toBe('null');
    console.log(`HTTP smoke port=${server.port}: valid token 200, absent token 403, foreign origin no ACAO, forged Host 403, stale revision 409; comments and unknown keys preserved`);
  } finally {
    server?.stop(true);
    occupied.stop(true);
    for (const [key,value] of Object.entries(previous)) {if(value===undefined)delete process.env[key];else process.env[key]=value;}
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('gateway model identifiers use OmO provider namespace exactly once', async () => {
  const previous = process.env.MAGPIE_ADDR;
  const gateway = Bun.serve({hostname:'127.0.0.1',port:0,fetch(){return Response.json({data:[{id:'cpa/foo',owned_by:'cpa'},{id:'magpie/cpa/bar'}]})}});
  process.env.MAGPIE_ADDR = `${gateway.hostname}:${gateway.port}`;
  try { expect((await fetchGatewayModels()).map(m=>m.id)).toEqual(['magpie/cpa/foo','magpie/cpa/bar']); }
  finally {gateway.stop(true);if(previous===undefined)delete process.env.MAGPIE_ADDR;else process.env.MAGPIE_ADDR=previous;}
});
