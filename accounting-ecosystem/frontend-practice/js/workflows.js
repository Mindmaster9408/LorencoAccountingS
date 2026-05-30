var esc = PracticeAPI.escHtml;

async function initWorkflows() {
  if (!AUTH.requireAuth()) return;
  LAYOUT.init('tasks');
  await Promise.all([loadTemplates(), loadClients()]);
}

async function loadClients() {
  try {
    var res = await PracticeAPI.fetch('/api/practice/clients?is_active=true');
    if (!res.ok) return;
    var d = await res.json();
    var opts = (d.clients || []).map(function(c){ return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('');
    document.getElementById('gClient').innerHTML = '<option value="">None</option>' + opts;
  } catch(e) {}
}

async function loadTemplates() {
  try {
    var res = await PracticeAPI.fetch('/api/practice/workflows/templates');
    if (!res.ok) throw new Error('Load failed');
    var d = await res.json();
    var list = d.templates || [];
    var wrap = document.getElementById('workflowsWrap');
    if (!list.length) { wrap.innerHTML = '<div class="empty"><h3>No templates</h3><p>Create a workflow template to get started.</p></div>'; return; }
    wrap.innerHTML = list.map(function(t){
      return '<div class="card"><div class="card-title">' + esc(t.name) + '</div><div class="card-body">' + (t.description || '') + '</div>' +
        '<div class="card-actions"><button class="btn btn-ghost" onclick="openGenerateModal(' + t.id + ')">Generate</button>' +
        '<button class="btn btn-ghost" onclick="editTemplate(' + t.id + ')">Edit</button></div></div>';
    }).join('');
  } catch(e) {
    document.getElementById('workflowsWrap').innerHTML = '<div class="error-banner">Failed to load templates</div>';
  }
}

function openGenerateModal(templateId) {
  window._selectedTemplateId = templateId;
  document.getElementById('generateModal').classList.add('show');
}

function closeModal(id) { document.getElementById(id).classList.remove('show'); }

async function submitGenerate(e) {
  e.preventDefault();
  var templateId = window._selectedTemplateId;
  var clientId = document.getElementById('gClient').value || null;
  var start = document.getElementById('gStart').value || null;
  try {
    var res = await PracticeAPI.fetch('/api/practice/workflows/generate', { method: 'POST', body: JSON.stringify({ template_id: templateId, client_id: clientId, start_date: start }) });
    var d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Failed');
    PracticeAPI.showToast('Generated ' + (d.tasks ? d.tasks.length : 0) + ' tasks');
    closeModal('generateModal');
  } catch (err) { PracticeAPI.showToast('❌ ' + err.message, true); }
  return false;
}

function editTemplate(id) {
  window.location.href = '/practice/workflow-template.html?id=' + id;
}

initWorkflows();
