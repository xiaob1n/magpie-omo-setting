const REASONING_PRESETS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'];

const OMO_TOKEN = document.querySelector('meta[name="omo-token"]')?.content || '';

const bootParams = new URLSearchParams(location.search);
const bootTheme = bootParams.get('theme');
if (bootTheme === 'dark' || bootTheme === 'light') document.documentElement.dataset.theme = bootTheme;
const bootLang = bootParams.get('lang');
if (bootLang) document.documentElement.lang = bootLang;

function apiFetch(path, init = {}) {
  return fetch(path.replace(/^\//, ''), { ...init, headers: { ...(init.headers || {}), 'X-Omo-Token': OMO_TOKEN } }).then(async res => {
    if (!res.ok) { const data = await res.json(); throw new Error(data.error || `HTTP ${res.status}`); }
    return res;
  });
}

let baseDoc = { path: '~/.omo/omo.jsonc', revision: '', status: 'ready', categories: [], agents: [] };
let draft = [];
let availableModels = [];
let expandedKeys = new Set();
let isSaving = false;
let modelPickerTarget = null;

function cloneDraft(categories, agents) {
  const result = [];
  for (const cat of categories || []) {
    result.push({
      scope: 'categories',
      name: cat.name,
      status: cat.status || 'ready',
      error: cat.error || '',
      reasoning: cat.reasoning || '',
      customReasoning: cat.reasoning && !REASONING_PRESETS.includes(cat.reasoning),
      models: (cat.models || []).map((m) => ({ ...m })),
    });
  }
  for (const ag of agents || []) {
    result.push({
      scope: 'agents',
      name: ag.name,
      status: ag.status || 'ready',
      error: ag.error || '',
      reasoning: ag.reasoning || '',
      customReasoning: ag.reasoning && !REASONING_PRESETS.includes(ag.reasoning),
      models: (ag.models || []).map((m) => ({ ...m })),
    });
  }
  return result;
}

function isDirty() {
  const original = cloneDraft(baseDoc.categories, baseDoc.agents);
  if (original.length !== draft.length) return true;
  for (let i = 0; i < original.length; i++) {
    const o = original[i];
    const d = draft[i];
    if (!o || !d) return true;
    if (o.reasoning !== d.reasoning) return true;
    if (o.models.length !== d.models.length) return true;
    for (let j = 0; j < o.models.length; j++) {
      if (o.models[j].model !== d.models[j].model || o.models[j].index !== d.models[j].index || o.models[j].object !== d.models[j].object) return true;
    }
  }
  return false;
}

function updateButtons() {
  const dirty = isDirty();
  const btnCancel = document.getElementById('btnCancel');
  const btnSave = document.getElementById('btnSave');
  if (btnCancel) btnCancel.disabled = isSaving || !dirty;
  if (btnSave) btnSave.disabled = isSaving || !dirty;
}

function showNotice(msg, isSuccess = false) {
  const banner = document.getElementById('noticeBanner');
  const msgEl = document.getElementById('noticeMsg');
  if (!banner || !msgEl) return;
  msgEl.textContent = msg;
  banner.className = `omo-cat-banner ${isSuccess ? 'success' : ''}`;
  banner.hidden = false;
}

function hideNotice() {
  const banner = document.getElementById('noticeBanner');
  if (banner) banner.hidden = true;
}

async function loadCategories() {
  try {
    const res = await apiFetch('/api/omo/categories');
    const data = await res.json();
    baseDoc = data;
    document.getElementById('configPath').textContent = data.path || '~/.omo/omo.jsonc';
    draft = cloneDraft(data.categories, data.agents);
    if (data.status === 'error') showNotice(data.error || '配置解析失败');
    else if (data.status === 'missing') showNotice('配置文件不存在，请先创建 OmO 配置');
    renderList();
    updateButtons();
  } catch (err) {
    showNotice(`加载配置失败: ${err.message}`);
  }
}

async function loadModels() {
  try {
    const res = await apiFetch('/api/models');
    const json = await res.json();
    availableModels = json.data || [];
  } catch {
    availableModels = [];
  }
}

async function loadWebdavStatus() {
  const badge = document.getElementById('syncBadge');
  const dot = document.getElementById('syncDot');
  const text = document.getElementById('syncText');
  try {
    const res = await apiFetch('/api/webdav/status');
    const data = await res.json();

    if (!data.configured) {
      dot.className = 'omo-sync-dot offline';
      text.textContent = 'WebDAV: 未配置';
      return;
    }

    dot.className = 'omo-sync-dot online';
    const src = data.source === 'magpie' ? '坚果云/magpie' : '自定义';
    const lastTime = data.lastSync ? new Date(data.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '未同步';
    const auto = data.autoSync || {};
    const autoLabel = {
      uploaded: '刚自动上传',
      unchanged: '本机无改动',
      conflict: '远端已改，暂停自动上传',
      failed: '自动同步失败',
      skipped: '自动同步待配置',
      idle: '自动同步待启动',
    }[auto.lastResult] || '自动同步';
    text.textContent = `WebDAV (${src}) · 每 3 分钟 · ${lastTime} · ${autoLabel}`;
    text.title = auto.lastError ? `${autoLabel}：${auto.lastError}` : '每 3 分钟把本机改动上传一次；远端被其他设备改过时不会覆盖任何一侧';
  } catch {
    dot.className = 'omo-sync-dot offline';
    text.textContent = 'WebDAV: 连接异常';
  }
}

function renderList() {
  const container = document.getElementById('catList');
  container.innerHTML = '';
  if (baseDoc.status !== 'ready') {
    container.textContent = baseDoc.status === 'missing' ? '配置文件不存在' : (baseDoc.error || '配置无法读取');
    return;
  }

  const scopes = [
    { id: 'agents', title: '子代理 (Subagents)', list: draft.filter((d) => d.scope === 'agents') },
    { id: 'categories', title: '任务类别 (Categories)', list: draft.filter((d) => d.scope === 'categories') },
  ];

  for (const sec of scopes) {
    const sectionEl = document.createElement('section');
    sectionEl.className = 'omo-cat-section';

    const label = document.createElement('div');
    label.className = 'omo-cat-section-label';
    label.textContent = sec.title;
    sectionEl.append(label);
    if (!sec.list.length) {
      const empty = document.createElement('div');
      empty.textContent = '暂无配置项';
      sectionEl.append(empty);
    }

    for (const item of sec.list) {
      const card = renderCard(item);
      sectionEl.append(card);
    }

    container.append(sectionEl);
  }
}

function renderCard(item) {
  const card = document.createElement('div');
  card.className = 'omo-cat-category';
  const rowKey = `${item.scope}:${item.name}`;

  const head = document.createElement('div');
  head.className = 'omo-cat-head';

  const title = document.createElement('span');
  title.className = 'ag-tier';
  title.textContent = item.name;
  if (item.status === 'error') {
    const status = document.createElement('span');
    status.textContent = item.status === 'legacy' ? '旧版配置（只读）' : `配置错误（只读）: ${item.error}`;
    head.append(title, status);
    card.append(head);
    return card;
  }

  const reasonWrap = document.createElement('div');
  reasonWrap.className = 'omo-cat-reason';

  const reasonSelect = document.createElement('select');
  const optDefault = document.createElement('option');
  optDefault.value = '';
  optDefault.textContent = '推理档位: 默认';
  reasonSelect.append(optDefault);

  for (const r of REASONING_PRESETS) {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = `推理档位: ${r}`;
    if (!item.customReasoning && item.reasoning === r) opt.selected = true;
    reasonSelect.append(opt);
  }

  const optCustom = document.createElement('option');
  optCustom.value = '__custom__';
  optCustom.textContent = '自定义档位…';
  if (item.customReasoning) optCustom.selected = true;
  reasonSelect.append(optCustom);

  const customInput = document.createElement('input');
  customInput.type = 'text';
  customInput.className = 'omo-cat-reason-custom';
  customInput.placeholder = '自定义档位';
  customInput.value = item.customReasoning ? item.reasoning : '';
  customInput.style.display = item.customReasoning ? 'inline-block' : 'none';

  reasonSelect.onchange = () => {
    if (reasonSelect.value === '__custom__') {
      item.customReasoning = true;
      item.reasoning = customInput.value;
      customInput.style.display = 'inline-block';
      customInput.focus();
    } else {
      item.customReasoning = false;
      item.reasoning = reasonSelect.value;
      customInput.style.display = 'none';
    }
    updateButtons();
  };

  customInput.oninput = () => {
    item.reasoning = customInput.value.trim();
    updateButtons();
  };

  reasonWrap.append(reasonSelect, customInput);
  head.append(title, reasonWrap);
  card.append(head);
  if (item.status === 'legacy') {
    const status = document.createElement('span');
    status.textContent = '旧版模型配置（模型只读，可编辑推理档位）';
    card.append(status);
    return card;
  }
  const primary = document.createElement('button');
  primary.type = 'button';
  primary.className = 'omo-cat-model-btn';
  primary.textContent = item.models[0]?.model || '尚未配置模型，点击添加';
  primary.onclick = () => openModelModal(item.scope, item.name, item.models.length ? 0 : -1, !item.models.length);
  card.append(primary);

  const modelsBox = document.createElement('div');
  modelsBox.className = 'omo-cat-models';
  modelsBox.hidden = !expandedKeys.has(rowKey);

  item.models.forEach((m, idx) => {
    const row = document.createElement('div');
    row.className = 'omo-cat-model-row';

    const pickBtn = document.createElement('button');
    pickBtn.type = 'button';
    pickBtn.className = 'omo-cat-model-btn';
    pickBtn.textContent = m.model;
    pickBtn.onclick = () => openModelModal(item.scope, item.name, idx, false);
    row.append(pickBtn);

    if (m.object) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = '参数对象';
      row.append(b);
    }

    const acts = document.createElement('span');
    acts.className = 'omo-cat-model-acts';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'icon';
    upBtn.textContent = '↑';
    upBtn.disabled = idx === 0;
    upBtn.onclick = () => {
      const [moved] = item.models.splice(idx, 1);
      item.models.splice(idx - 1, 0, moved);
      renderList();
      updateButtons();
    };

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'icon';
    downBtn.textContent = '↓';
    downBtn.disabled = idx >= item.models.length - 1;
    downBtn.onclick = () => {
      const [moved] = item.models.splice(idx, 1);
      item.models.splice(idx + 1, 0, moved);
      renderList();
      updateButtons();
    };

    const rmBtn = document.createElement('button');
    rmBtn.type = 'button';
    rmBtn.className = 'icon';
    rmBtn.textContent = '×';
    rmBtn.disabled = item.models.length <= 1;
    rmBtn.onclick = () => {
      item.models.splice(idx, 1);
      renderList();
      updateButtons();
    };

    acts.append(upBtn, downBtn, rmBtn);
    row.append(acts);
    modelsBox.append(row);
  });

  const addModelBtn = document.createElement('button');
  addModelBtn.type = 'button';
  addModelBtn.textContent = '+ 添加备选模型';
  addModelBtn.style.alignSelf = 'flex-start';
  addModelBtn.onclick = () => openModelModal(item.scope, item.name, -1, true);
  modelsBox.append(addModelBtn);

  const disclosure = document.createElement('button');
  disclosure.type = 'button';
  disclosure.className = 'omo-cat-disclosure';
  const extraCount = Math.max(0, item.models.length - 1);
  disclosure.textContent = extraCount > 0 ? `› 展开 ${extraCount} 个备用模型` : '› 查看/添加更多备选模型';
  disclosure.onclick = () => {
    if (expandedKeys.has(rowKey)) {
      expandedKeys.delete(rowKey);
      modelsBox.hidden = true;
    } else {
      expandedKeys.add(rowKey);
      modelsBox.hidden = false;
    }
  };

  card.append(disclosure, modelsBox);
  return card;
}

function openModelModal(scope, name, index, isAdd) {
  modelPickerTarget = { scope, name, index, isAdd };
  const modal = document.getElementById('modelModal');
  const title = document.getElementById('modelModalTitle');
  const searchInput = document.getElementById('txtModelSearch');
  title.textContent = `${name}: ${isAdd ? '添加模型' : '替换模型'}`;
  searchInput.value = '';
  renderModelOptions('');
  modal.hidden = false;
  searchInput.focus();
}

function closeModelModal() {
  document.getElementById('modelModal').hidden = true;
  modelPickerTarget = null;
}

function renderModelOptions(query) {
  const box = document.getElementById('modelListBox');
  box.innerHTML = '';
  const q = query.toLowerCase().trim();
  const filtered = availableModels.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));

  if (!filtered.length) {
    box.innerHTML = '<div style="padding: 12px; color: var(--muted); text-align: center;">未找到匹配模型，可使用上方输入框输入自定义模型</div>';
    return;
  }

  for (const m of filtered) {
    const item = document.createElement('div');
    item.className = 'model-item';
    item.textContent = m.id;
    item.onclick = () => selectModel(m.id);
    box.append(item);
  }
}

function selectModel(modelName) {
  if (!modelPickerTarget) return;
  const target = draft.find((d) => d.scope === modelPickerTarget.scope && d.name === modelPickerTarget.name);
  if (target) {
    if (modelPickerTarget.isAdd) {
      target.models.push({ model: modelName, object: false });
    } else if (typeof modelPickerTarget.index === 'number' && target.models[modelPickerTarget.index]) {
      target.models[modelPickerTarget.index].model = modelName;
    }
    renderList();
    updateButtons();
  }
  closeModelModal();
}

async function saveChanges() {
  if (isSaving || !isDirty()) return;
  isSaving = true;
  updateButtons();
  hideNotice();

  const changes = [];
  const origList = cloneDraft(baseDoc.categories, baseDoc.agents);

  for (let i = 0; i < draft.length; i++) {
    const d = draft[i];
    const o = origList[i];
    const change = { scope: d.scope, name: d.name };
    let hasChange = false;

    if (!o || o.reasoning !== d.reasoning) {
      change.reasoning = { value: d.reasoning ? d.reasoning : null };
      hasChange = true;
    }

    const modelsChanged = !o || o.models.length !== d.models.length || d.models.some((m, idx) => !o.models[idx] || o.models[idx].model !== m.model || o.models[idx].index !== m.index || o.models[idx].object !== m.object);
    if (modelsChanged) {
      change.models = d.models.map((m) => ({
        model: m.model,
        index: typeof m.index === 'number' ? m.index : undefined,
      }));
      hasChange = true;
    }

    if (hasChange) changes.push(change);
  }

  try {
    const res = await apiFetch('/api/omo/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: baseDoc.revision, changes }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || '保存失败');
    }

    baseDoc = data;
    draft = cloneDraft(data.categories, data.agents);
    renderList();
    showNotice('OmO 配置保存成功！重启 OmO CLI 后生效。', true);
  } catch (err) {
    showNotice(`保存错误: ${err.message}`);
  } finally {
    isSaving = false;
    updateButtons();
  }
}

async function uploadWebdav() {
  hideNotice();
  try {
    const res = await apiFetch('/api/webdav/upload', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '上传失败');
    showNotice('已成功备份上传至 WebDAV 云端！', true);
    await loadWebdavStatus();
  } catch (err) {
    showNotice(`WebDAV 上传失败: ${err.message}`);
  }
}

async function downloadWebdav() {
  if (!await confirmInPage('从云端恢复将覆盖本地配置和未保存编辑，覆盖前会自动备份本地文件。确定继续？')) return;
  hideNotice();
  try {
    const res = await apiFetch('/api/webdav/download', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '拉取失败');
    showNotice('已从 WebDAV 恢复最新配置！', true);
    await loadCategories();
    await loadWebdavStatus();
  } catch (err) {
    showNotice(`WebDAV 拉取失败: ${err.message}`);
  }
}

async function openWebdavModal() {
  const modal = document.getElementById('webdavModal');
  const chkMagpie = document.getElementById('chkUseMagpieSync');
  const txtUrl = document.getElementById('txtWebdavUrl');
  const txtUser = document.getElementById('txtWebdavUser');
  const txtPass = document.getElementById('txtWebdavPassword');
  const txtRemote = document.getElementById('txtRemotePath');
  const testResult = document.getElementById('webdavTestResult');

  testResult.textContent = '';
  try {
    const res = await apiFetch('/api/webdav/status');
    const data = await res.json();
    chkMagpie.checked = Boolean(data.useMagpieSync);
    txtUrl.value = data.url || '';
    txtUser.value = data.user || '';
    txtPass.value = '';
    txtRemote.value = data.remotePath || 'magpie/omo/omo.jsonc';
    document.getElementById('customWebdavFields').style.opacity = chkMagpie.checked ? '0.5' : '1';
  } catch {
  }
  modal.hidden = false;
}

function confirmInPage(message) {
  return new Promise(resolve => {
    const modal = document.getElementById('confirmModal');
    document.getElementById('confirmMessage').textContent = message;
    modal.hidden = false;
    for (const [id, value] of [['btnConfirmYes', true], ['btnConfirmNo', false]]) {
      document.getElementById(id).onclick = () => { modal.hidden = true; resolve(value); };
    }
    document.getElementById('btnConfirmNo').focus();
  });
}

function initEvents() {
  document.getElementById('btnReload').onclick = async () => {
    if (isDirty() && !await confirmInPage('放弃当前未保存的修改并重新加载吗？')) return;
    loadCategories();
  };

  document.getElementById('btnCancel').onclick = () => {
    draft = cloneDraft(baseDoc.categories, baseDoc.agents);
    renderList();
    updateButtons();
  };

  document.getElementById('btnSave').onclick = saveChanges;
  document.getElementById('btnUpload').onclick = uploadWebdav;
  document.getElementById('btnDownload').onclick = downloadWebdav;
  document.getElementById('btnWebdavConfig').onclick = openWebdavModal;
  document.getElementById('btnCloseWebdav').onclick = () => { document.getElementById('webdavModal').hidden = true; };
  document.getElementById('btnCloseModelModal').onclick = closeModelModal;
  document.getElementById('btnDismissNotice').onclick = hideNotice;

  document.getElementById('chkUseMagpieSync').onchange = (e) => {
    document.getElementById('customWebdavFields').style.opacity = e.target.checked ? '0.5' : '1';
  };

  document.getElementById('btnTestWebdav').onclick = async () => {
    const testResult = document.getElementById('webdavTestResult');
    testResult.style.color = 'var(--muted)';
    testResult.textContent = '正在测试连接...';

    const payload = {
      useMagpieSync: document.getElementById('chkUseMagpieSync').checked,
      url: document.getElementById('txtWebdavUrl').value.trim(),
      user: document.getElementById('txtWebdavUser').value.trim(),
      password: document.getElementById('txtWebdavPassword').value.trim(),
      remotePath: document.getElementById('txtRemotePath').value.trim(),
    };

    try {
      const res = await apiFetch('/api/webdav/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok) {
        testResult.style.color = 'var(--green)';
        testResult.textContent = '✓ 连接成功！';
      } else {
        testResult.style.color = 'var(--red)';
        testResult.textContent = `✗ ${data.error || '连接失败'}`;
      }
    } catch (err) {
      testResult.style.color = 'var(--red)';
      testResult.textContent = `✗ 测试请求错误: ${err.message}`;
    }
  };

  document.getElementById('btnSaveWebdav').onclick = async () => {
    const payload = {
      useMagpieSync: document.getElementById('chkUseMagpieSync').checked,
      url: document.getElementById('txtWebdavUrl').value.trim(),
      user: document.getElementById('txtWebdavUser').value.trim(),
      remotePath: document.getElementById('txtRemotePath').value.trim(),
    };
    const pass = document.getElementById('txtWebdavPassword').value.trim();
    if (pass) payload.password = pass;

    try {
      await apiFetch('/api/webdav/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      document.getElementById('webdavModal').hidden = true;
      showNotice('WebDAV 配置已更新！', true);
      await loadWebdavStatus();
    } catch (err) {
      showNotice(`保存 WebDAV 配置失败: ${err.message}`);
    }
  };

  const searchInput = document.getElementById('txtModelSearch');
  searchInput.oninput = () => renderModelOptions(searchInput.value);
  searchInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
      const val = searchInput.value.trim();
      if (val) selectModel(val);
    }
  };
  document.getElementById('btnCustomModelSubmit').onclick = () => {
    const val = searchInput.value.trim();
    if (val) selectModel(val);
  };
}

(async () => {
  initEvents();
  await loadCategories();
  await loadModels();
  await loadWebdavStatus();
  setInterval(() => { loadWebdavStatus(); }, 60000);
})();
