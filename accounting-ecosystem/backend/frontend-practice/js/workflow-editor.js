var esc = PracticeAPI.escHtml;

window._reorderTimer = null;
window._reorderLock = false;

async function initEditor() {
  if (!AUTH.requireAuth()) return;
  LAYOUT.init('tasks');
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  if (id) await loadTemplate(id);
  else renderEmptyEditor();
}

function renderEmptyEditor() {
  document.getElementById('editorWrap').innerHTML = '<div class="card"><div class="card-body">' +
    '<label>Name</label><input id="tName" />' +
    '<label>Description</label><textarea id="tDesc"></textarea>' +
    '<div class="card-actions"><button class="btn btn-primary" onclick="saveTemplate()">Create Template</button></div>' +
    '</div></div>';
}

async function loadTemplate(id) {
  try {
    var res = await PracticeAPI.fetch('/api/practice/workflows/templates/' + id);
    if (!res.ok) throw new Error('Load failed');
    var d = await res.json();
    renderEditor(d.template);
  } catch (e) { document.getElementById('editorWrap').innerHTML = '<div class="error-banner">Failed to load template</div>'; }
}

function renderEditor(t) {
  window._currentTemplate = t;
  var html = '<div class="card"><div class="card-body">' +
    '<label>Name</label><input id="tName" value="' + esc(t.name || '') + '" />' +
    '<label>Description</label><textarea id="tDesc">' + (t.description || '') + '</textarea>' +
    '<div class="card-actions"><button class="btn btn-primary" onclick="saveTemplate(' + t.id + ')">Save</button></div>' +
    '</div></div>';
  html += '<div id="stepsWrap"><h3>Steps</h3><div id="stepsList"></div><div class="card-actions"><button class="btn btn-primary" onclick="openAddStep()">Add Step</button></div></div>';
  document.getElementById('editorWrap').innerHTML = html;
  loadSteps(t.id);
}

async function saveTemplate(id) {
  var body = { name: document.getElementById('tName').value, description: document.getElementById('tDesc').value };
  try {
    var url = '/api/practice/workflows/templates' + (id ? '/' + id : '');
    var method = id ? 'PUT' : 'POST';
    var res = await PracticeAPI.fetch(url, { method: method, body: JSON.stringify(body) });
    var d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Save failed');
    PracticeAPI.showToast('Template saved');
    if (!id) window.location.href = '/practice/workflow-template.html?id=' + d.template.id;
  } catch (err) { PracticeAPI.showToast('❌ ' + err.message, true); }
}

async function loadSteps(templateId) {
  try {
    var res = await PracticeAPI.fetch('/api/practice/workflows/templates/' + templateId + '/steps');
    var d = await res.json();
    var list = d.steps || [];
    document.getElementById('stepsList').innerHTML = list.map(function(s){
      return '<div class="card small" data-step-id="' + s.id + '"><div class="card-title">' + esc(s.title) + '</div><div class="card-body">' + (s.description||'') + '</div>' +
        '<div class="card-actions">' +
        '<button class="btn btn-ghost" onclick="moveUp(this)">↑</button>' +
        '<button class="btn btn-ghost" onclick="moveDown(this)">↓</button>' +
        '<button class="btn btn-ghost" onclick="editStep(' + s.id + ')">Edit</button>' +
        '<button class="btn btn-danger" onclick="deleteStep(' + s.id + ')">Delete</button>' +
        '</div></div>';
    }).join('');
    enableReorderControls();
  } catch(e) { document.getElementById('stepsList').innerHTML = '<div class="error-banner">Failed to load steps</div>'; }
}

function openAddStep() {
  var html = '<div class="card"><div class="card-body">' +
    '<label>Title</label><input id="sTitle" />' +
    '<label>Description</label><textarea id="sDesc"></textarea>' +
    '<label>Due offset days</label><input id="sOffset" type="number" value="0" />' +
    '<div class="card-actions"><button class="btn btn-primary" onclick="addStep()">Add</button></div>' +
    '</div></div>';
  document.getElementById('stepsList').insertAdjacentHTML('beforeend', html);
}

async function addStep() {
  var t = window._currentTemplate;
  var body = { title: document.getElementById('sTitle').value, description: document.getElementById('sDesc').value, due_offset_days: parseInt(document.getElementById('sOffset').value || 0) };
  try {
    var res = await PracticeAPI.fetch('/api/practice/workflows/templates/' + t.id + '/steps', { method: 'POST', body: JSON.stringify(body) });
    var d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Add failed');
    PracticeAPI.showToast('Step added');
    loadSteps(t.id);
  } catch (err) { PracticeAPI.showToast('❌ ' + err.message, true); }
}

async function editStep(id) {
  try {
    var res = await PracticeAPI.fetch('/api/practice/workflows/templates/' + window._currentTemplate.id + '/steps');
    var d = await res.json();
    var s = (d.steps || []).find(function(x){ return x.id === id; });
    if (!s) return PracticeAPI.showToast('Step not found', true);
    var html = '<div class="card"><div class="card-body">' +
      '<label>Title</label><input id="sTitle" value="' + esc(s.title || '') + '" />' +
      '<label>Description</label><textarea id="sDesc">' + (s.description || '') + '</textarea>' +
      '<label>Due offset days</label><input id="sOffset" type="number" value="' + (s.due_offset_days||0) + '" />' +
      '<div class="card-actions"><button class="btn btn-primary" onclick="saveStep(' + s.id + ')">Save</button></div>' +
      '</div></div>';
    document.getElementById('stepsList').insertAdjacentHTML('beforeend', html);
  } catch(e) { PracticeAPI.showToast('❌ ' + e.message, true); }
}

function moveUp(btn) {
  if (window._reorderLock) return;
  var card = btn.closest('[data-step-id]');
  if (!card) return;
  var prev = card.previousElementSibling;
  if (prev) {
    card.parentNode.insertBefore(card, prev);
    scheduleReorder();
  }
}

function moveDown(btn) {
  if (window._reorderLock) return;
  var card = btn.closest('[data-step-id]');
  if (!card) return;
  var next = card.nextElementSibling;
  if (next) {
    card.parentNode.insertBefore(next, card);
    scheduleReorder();
  }
}

function scheduleReorder() {
  if (window._reorderTimer) clearTimeout(window._reorderTimer);
  window._reorderTimer = setTimeout(sendReorder, 600);
}

async function sendReorder() {
  if (window._reorderLock) return;
  var list = Array.from(document.querySelectorAll('#stepsList > [data-step-id]'));
  var stepIds = list.map(function(n){ return parseInt(n.getAttribute('data-step-id')); });
  if (!stepIds.length) return;
  window._reorderLock = true;
  disableReorderControls();
  try {
    var res = await PracticeAPI.fetch('/api/practice/workflows/templates/' + window._currentTemplate.id + '/steps/reorder', { method: 'PUT', body: JSON.stringify({ stepIds: stepIds }) });
    var d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Reorder failed');
    PracticeAPI.showToast('Order saved');
  } catch (err) {
    PracticeAPI.showToast('❌ ' + err.message, true);
    loadSteps(window._currentTemplate.id);
  } finally {
    window._reorderLock = false;
    enableReorderControls();
  }
}

function disableReorderControls() {
  var btns = document.querySelectorAll('#stepsList button');
  btns.forEach(b => b.setAttribute('disabled', 'disabled'));
}

function enableReorderControls() {
  var btns = document.querySelectorAll('#stepsList button');
  btns.forEach(b => b.removeAttribute('disabled'));
}

async function saveStep(id) {
  var body = { title: document.getElementById('sTitle').value, description: document.getElementById('sDesc').value, due_offset_days: parseInt(document.getElementById('sOffset').value || 0) };
  try {
    var res = await PracticeAPI.fetch('/api/practice/workflows/templates/' + window._currentTemplate.id + '/steps/' + id, { method: 'PUT', body: JSON.stringify(body) });
    var d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Save failed');
    PracticeAPI.showToast('Step saved');
    loadSteps(window._currentTemplate.id);
  } catch (err) { PracticeAPI.showToast('❌ ' + err.message, true); }
}

async function deleteStep(id) {
  if (!confirm('Delete this step?')) return;
  try {
    var res = await PracticeAPI.fetch('/api/practice/workflows/templates/' + window._currentTemplate.id + '/steps/' + id, { method: 'DELETE' });
    var d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Delete failed');
    PracticeAPI.showToast('Step deleted');
    loadSteps(window._currentTemplate.id);
  } catch (err) { PracticeAPI.showToast('❌ ' + err.message, true); }
}

initEditor();
