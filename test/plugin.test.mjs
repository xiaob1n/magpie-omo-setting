import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { stripJSONC, readOmoCategories, saveOmoCategories } from '../lib/omo-config.mjs';
import { getWebdavStatus, testWebdavConnection, uploadToWebdav, downloadFromWebdav, saveWebdavConfig } from '../lib/webdav.mjs';

describe('magpie-omo-setting core logic', () => {
  let tmpDir;
  let tmpConfigPath;
  let oldHome;
  let oldConfig;
  let oldMagpie;
  let dav;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-test-'));
    tmpConfigPath = path.join(tmpDir, 'omo.jsonc');
    oldHome = process.env.HOME;
    oldConfig = process.env.OMO_CONFIG_PATH;
    oldMagpie = process.env.MAGPIE_CONFIG_DIR;
    process.env.HOME = tmpDir;
    process.env.MAGPIE_CONFIG_DIR = path.join(tmpDir,'.config/magpie');
    process.env.OMO_CONFIG_PATH = tmpConfigPath;
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldConfig === undefined) delete process.env.OMO_CONFIG_PATH; else process.env.OMO_CONFIG_PATH = oldConfig;
    if (oldMagpie === undefined) delete process.env.MAGPIE_CONFIG_DIR; else process.env.MAGPIE_CONFIG_DIR = oldMagpie;
    dav?.stop(true);
    dav = null;
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('stripJSONC strips comments and trailing commas while preserving strings', () => {
    const raw = `{
      // single line comment
      "url": "https://example.com/api", /* multi-line
      comment */
      "list": ["a", "b",],
    }`;
    const parsed = JSON.parse(stripJSONC(raw));
    expect(parsed.url).toBe('https://example.com/api');
    expect(parsed.list).toEqual(['a', 'b']);
  });

  test('readOmoCategories and saveOmoCategories preserve comments and enforce revision CAS', () => {
    const initial = `{
  // Top comment
  "categories": {
    "quick": {
      "models": ["model-a", { "model": "model-b", "temperature": 0.2 }],
      "reasoning": "low"
    }
  },
  "agents": {
    "explore": {
      "models": ["model-explore"],
      "reasoning": "medium"
    }
  },
  // Extra setting comment
  "telemetry": { "enabled": true }
}`;
    fs.writeFileSync(tmpConfigPath, initial, 'utf-8');

    const doc = readOmoCategories();
    expect(doc.status).toBe('ready');
    expect(doc.categories.length).toBe(1);
    expect(doc.categories[0].name).toBe('quick');
    expect(doc.categories[0].models[1].object).toBe(true);

    const updated = saveOmoCategories(doc.revision, [
      {
        scope: 'categories',
        name: 'quick',
        reasoning: { value: 'high' },
        models: [
          { model: 'model-b-updated', index: 1 },
          { model: 'model-a', index: 0 },
        ],
      },
      {
        scope: 'agents',
        name: 'explore',
        reasoning: { value: 'max' },
      },
    ]);

    expect(updated.revision).not.toBe(doc.revision);
    expect(updated.categories[0].reasoning).toBe('high');
    expect(updated.categories[0].models[0].model).toBe('model-b-updated');
    expect(updated.categories[0].models[0].object).toBe(true);

    const savedRaw = fs.readFileSync(tmpConfigPath, 'utf-8');
    expect(savedRaw).toContain('// Top comment');
    expect(savedRaw).toContain('// Extra setting comment');
    expect(savedRaw).toContain('"temperature": 0.2');

    expect(() => {
      saveOmoCategories('0'.repeat(64), []);
    }).toThrow();
  });

  test('WebDAV status, upload and download roundtrip', async () => {
    let stored = null;
    dav = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
      if (req.headers.get('authorization') !== 'Basic ' + Buffer.from('fixture:secret').toString('base64')) return new Response('', {status:401});
      if (req.method === 'PROPFIND') return new Response('', {status:207});
      if (req.method === 'PUT') { stored = await req.text(); return new Response('', {status:201}); }
      if (req.method === 'GET' && stored !== null) return new Response(stored);
      return new Response('', {status:404});
    }});
    const credentials = {useMagpieSync:false, url:dav.url.href, user:'fixture', password:'secret'};
    const sampleContent = JSON.stringify({
      categories: {
        quick: { models: ['magpie/cpa/deepseek-v4.1-flash'], reasoning: 'low' },
      },
      agents: {
        explore: { models: ['magpie/cpa/deepseek-v4.1-flash'], reasoning: 'max' },
      },
    }, null, 2);
    fs.writeFileSync(tmpConfigPath, sampleContent, 'utf-8');

    const testRemotePath = 'magpie/omo/omo-test-roundtrip.jsonc';
    const conn = await testWebdavConnection({ ...credentials, remotePath: testRemotePath });
    expect(conn.ok).toBe(true);

    const up = await uploadToWebdav({ ...credentials, remotePath: testRemotePath });
    expect(up.ok).toBe(true);

    fs.writeFileSync(tmpConfigPath, '{"categories":{}}', 'utf-8');
    const down = await downloadFromWebdav({ ...credentials, remotePath: testRemotePath });
    expect(down.ok).toBe(true);

    const restored = fs.readFileSync(tmpConfigPath, 'utf-8');
    expect(restored).toContain('magpie/cpa/deepseek-v4.1-flash');
  });

  test('JSONC preserves comma-brace text inside strings', () => {
    expect(JSON.parse(stripJSONC('{"text":",}",}')).text).toBe(',}');
  });

  test('patches direct keys despite comments and creates missing named agents', () => {
    const initial = '{\n// "categories": { "quick": {} }\n"unknown":{"models":null,"reasoning":3},"categories":{"quick":{"unknown":{"models":[]},"models":[{"model":"same","temperature":0.2}, {"model":"same","temperature":0.9}],"reasoning":"low"}}}';
    fs.writeFileSync(tmpConfigPath, initial);
    const doc = readOmoCategories();
    saveOmoCategories(doc.revision, [{scope:'categories',name:'quick',models:[{model:'same',index:1},{model:'same',index:0}],reasoning:{value:null}}, {scope:'agents',name:'librarian',models:[{model:'magpie/cpa/test'}]}]);
    const raw = fs.readFileSync(tmpConfigPath,'utf8');
    const root = Bun.JSONC.parse(raw);
    expect(raw).toContain('// "categories":');
    expect(root.unknown).toEqual({models:null,reasoning:3});
    expect(root.categories.quick.models.map(m=>m.temperature)).toEqual([0.9,0.2]);
    expect(root.categories.quick.reasoning).toBeUndefined();
    expect(root.categories.quick.unknown.models).toEqual([]);
    expect(root.agents.librarian.models).toEqual(['magpie/cpa/test']);
  });

  test.each([null, {}, [{scope:'bad',name:'quick',models:[]}], [{scope:'categories',name:'quick',models:[{model:42}]}], [{scope:'categories',name:'__proto__',models:[]}]])('rejects unsafe changes without writing %j', changes => {
    const raw = '{"categories":{"quick":{"models":["old"]}}}';
    fs.writeFileSync(tmpConfigPath,raw);
    expect(()=>saveOmoCategories(readOmoCategories().revision,changes)).toThrow();
    expect(fs.readFileSync(tmpConfigPath,'utf8')).toBe(raw);
  });

  test('saved password survives blank connection field and credentials stay private', async () => {
    dav = Bun.serve({hostname:'127.0.0.1',port:0,fetch(req) {
      return new Response('',{status:req.headers.get('authorization') === 'Basic '+Buffer.from('fixture:saved-secret').toString('base64') ? 207 : 401});
    }});
    const safe = saveWebdavConfig({useMagpieSync:false,url:dav.url.href,user:'fixture',password:'saved-secret'});
    expect(safe.password).toBeUndefined();
    const configFile = path.join(tmpDir,'.config/magpie/omo-webdav.json');
    fs.chmodSync(configFile,0o644);
    saveWebdavConfig({remotePath:'fixture/config.jsonc'});
    expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
    expect((await testWebdavConnection({password:''})).ok).toBe(true);
    expect(JSON.stringify(await getWebdavStatus())).not.toContain('saved-secret');
  });

  test.each(['not json', 'null', '[]', '{"agents":3}'])('invalid DAV download leaves local config and directory intact %s', async content => {
    dav = Bun.serve({hostname:'127.0.0.1',port:0,fetch(){return new Response(content)}});
    const original = '{"categories":{}}';
    fs.writeFileSync(tmpConfigPath,original);
    await expect(downloadFromWebdav({useMagpieSync:false,url:dav.url.href,user:'fixture',password:'secret'})).rejects.toThrow();
    expect(fs.readFileSync(tmpConfigPath,'utf8')).toBe(original);
    expect(fs.readdirSync(tmpDir)).toEqual(['omo.jsonc']);
  });

  test.each([{password:3},{url:'file:///tmp/remote'},{remotePath:'../escape'},{useMagpieSync:'yes'},{password:'secret',extra:true}])('invalid DAV settings never write %j', config => {
    expect(()=>saveWebdavConfig(config)).toThrow();
    expect(fs.existsSync(path.join(tmpDir,'.config/magpie/omo-webdav.json'))).toBe(false);
  });

  test.each(['null','[]','{"categories":3}','{"agents":null}'])('invalid root is reported without throwing %s', content => {
    fs.writeFileSync(tmpConfigPath,content);
    expect(readOmoCategories().status).toBe('error');
  });

  test('legacy reasoning remains editable while model list is read-only', () => {
    fs.writeFileSync(tmpConfigPath,'{"categories":{"quick":{"model":"old","reasoning":"low"}}}');
    const doc=readOmoCategories();
    saveOmoCategories(doc.revision,[{scope:'categories',name:'quick',reasoning:{value:'high'}}]);
    const root=Bun.JSONC.parse(fs.readFileSync(tmpConfigPath,'utf8'));
    expect(root.categories.quick).toEqual({model:'old',reasoning:'high'});
    expect(()=>saveOmoCategories(readOmoCategories().revision,[{scope:'categories',name:'quick',models:[{model:'new'}]}])).toThrow();
  });

  test.each([3,'',null])('malformed reasoning is read-only %j', reasoning => {
    fs.writeFileSync(tmpConfigPath,JSON.stringify({categories:{quick:{models:['old'],reasoning}}}));
    const doc=readOmoCategories();
    expect(doc.categories[0].status).toBe('error');
    expect(()=>saveOmoCategories(doc.revision,[{scope:'categories',name:'quick',reasoning:{value:'high'}}])).toThrow();
  });

  test('editing a model keeps comments inside the models array', () => {
    fs.writeFileSync(tmpConfigPath, `{
  "categories": {
    "quick": {
      "models": [
        "a", // keep-a
        // keep-b above
        "b",
        {"model": "c", "temperature": 0.3} // keep-c
      ]
    }
  }
}`, 'utf8');
    const doc = readOmoCategories();
    saveOmoCategories(doc.revision, [{ scope: 'categories', name: 'quick', models: [
      { model: 'a', index: 0 }, { model: 'b', index: 1 }, { model: 'c2', index: 2 },
    ] }]);
    const raw = fs.readFileSync(tmpConfigPath, 'utf8');
    expect(raw).toContain('// keep-a');
    expect(raw).toContain('// keep-b above');
    expect(raw).toContain('// keep-c');
    expect(raw).toContain('"temperature": 0.3');
    expect(Bun.JSONC.parse(raw).categories.quick.models[2].model).toBe('c2');
  });

  test('BOM input is editable and removing the final model is rejected', () => {
    fs.writeFileSync(tmpConfigPath,'\uFEFF{"categories":{"quick":{"models":["old"]}}}');
    const doc=readOmoCategories();
    expect(doc.status).toBe('ready');
    expect(()=>saveOmoCategories(doc.revision,[{scope:'categories',name:'quick',models:[]}])).toThrow();
    expect(saveOmoCategories(doc.revision,[{scope:'categories',name:'quick',reasoning:{value:'high'}}]).categories[0].reasoning).toBe('high');
  });
});
