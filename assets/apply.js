// Corner Careers: application form. Posts JSON (CV as base64) to the Apps Script web app set in config.js.
// Sent as text/plain so the browser makes no CORS preflight (Apps Script can't answer one).
// Each attempt reuses one submission id, so a retry after a timeout can't create a second application.
(function () {
  var form = document.getElementById('applyForm');
  if (!form) return;
  var ENDPOINT = (window.CORNER_JOBS && window.CORNER_JOBS.endpoint) || '';
  var MAX_MB = 10;
  var ANSWER_MAX = 1500; // keep in step with build.py and apps-script/Code.gs
  var OK_EXT = /\.(pdf|doc|docx)$/i;
  var started = Date.now();
  var submissionId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
  var status = document.getElementById('applyStatus');
  var btn = document.getElementById('applyBtn');
  var btnLabel = btn.querySelector('.lbl');
  var drop = document.getElementById('cvDrop');
  var cvInput = document.getElementById('f-cv');
  var cvName = document.getElementById('cvName');

  if (!ENDPOINT) {
    show('info', 'Preview: applications are not connected yet. The form checks your answers but does not send them.');
  }

  cvInput.addEventListener('change', function () {
    var f = cvInput.files && cvInput.files[0];
    drop.classList.toggle('has', !!f);
    cvName.textContent = f ? f.name + ' · ' + (f.size / 1048576).toFixed(1) + ' MB' : 'Choose a file or drop it here';
    clearErr('cv');
  });
  ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function () { drop.classList.add('has'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function () { if (!cvInput.files.length) drop.classList.remove('has'); }); });
  form.querySelectorAll('input,select,textarea').forEach(function (el) {
    el.addEventListener('input', function () { clearErr(el.name); });
  });

  function field(name) { return form.querySelector('[data-field="' + name + '"]'); }
  function setErr(name, text) {
    var f = field(name); if (!f) return;
    f.classList.add('bad'); var m = f.querySelector('.msg'); if (m) m.textContent = text;
  }
  function clearErr(name) {
    var f = field(name); if (!f) return;
    f.classList.remove('bad'); var m = f.querySelector('.msg'); if (m) m.textContent = '';
  }
  function show(kind, html) {
    status.hidden = false; status.className = 'notice ' + kind; status.innerHTML = html;
  }
  function normUrl(v) {
    v = (v || '').trim(); if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    try { var u = new URL(v); return u.href; } catch (e) { return null; }
  }
  function validate() {
    var ok = true, v = {};
    v.name = form.elements['name'].value.trim();
    if (v.name.length < 2) { setErr('name', 'Please enter your full name.'); ok = false; }
    v.email = form.elements['email'].value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) { setErr('email', 'Please enter a valid email address.'); ok = false; }
    v.linkedin = normUrl(form.elements['linkedin'].value);
    if (!v.linkedin || !/linkedin\.com\//i.test(v.linkedin)) { setErr('linkedin', 'Please paste the link to your LinkedIn profile.'); ok = false; }
    v.english = form.elements['english'].value;
    if (!v.english) { setErr('english', 'Please choose your level of English.'); ok = false; }
    var f = cvInput.files && cvInput.files[0];
    if (!f) { setErr('cv', 'Please attach your CV.'); ok = false; }
    else if (!OK_EXT.test(f.name)) { setErr('cv', 'Please attach a PDF or Word file.'); ok = false; }
    else if (f.size > MAX_MB * 1048576) { setErr('cv', 'The file is larger than ' + MAX_MB + ' MB. Please attach a smaller file.'); ok = false; }
    v.cvFile = f;
    v.portfolio = form.elements['portfolio'] ? normUrl(form.elements['portfolio'].value) : '';
    if (v.portfolio === null) { setErr('portfolio', 'This link doesn’t look right. Please check it.'); ok = false; }
    v.answer = form.elements['answer'] ? form.elements['answer'].value.trim() : '';
    if (form.elements['answer'] && form.elements['answer'].required && v.answer.length < 2) { setErr('answer', 'Please answer this question.'); ok = false; }
    if (form.elements['hours']) {
      var h = form.querySelector('input[name="hours"]:checked'); v.hours = h ? h.value : '';
      if (!v.hours) { setErr('hours', 'Please choose Yes or No.'); ok = false; }
    }
    if (v.answer.length > ANSWER_MAX) { setErr('answer', 'Please keep it under ' + ANSWER_MAX + ' characters.'); ok = false; }
    return ok ? v : null;
  }
  function readB64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(file);
    });
  }
  function busy(on) {
    btn.disabled = on;
    btn.querySelector('.trace').classList.toggle('run', on);
    btnLabel.textContent = on ? 'Sending your application…' : 'Send application';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (form.elements['company_site'].value) return; // honeypot: bots fill hidden fields
    var v = validate();
    if (!v) { show('err', 'Please fix the fields marked in red.'); var b = form.querySelector('.bad input,.bad select,.bad textarea'); if (b) b.focus(); return; }
    if (!ENDPOINT) { show('info', 'Everything looks right. This is a preview, so nothing was sent.'); return; }
    busy(true); status.hidden = true;
    readB64(v.cvFile).then(function (data) {
      var payload = {
        id: submissionId, job: form.dataset.job, jobTitle: form.dataset.title,
        name: v.name, email: v.email, linkedin: v.linkedin, english: v.english, portfolio: v.portfolio || '', answer: v.answer, hours: v.hours || '',
        cv: { name: v.cvFile.name, type: v.cvFile.type || 'application/octet-stream', size: v.cvFile.size, data: data },
        page: location.href, elapsedSec: Math.round((Date.now() - started) / 1000)
      };
      var ctrl = new AbortController(); var t = setTimeout(function () { ctrl.abort(); }, 90000);
      return fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), signal: ctrl.signal })
        .then(function (r) { clearTimeout(t); return r.json(); });
    }).then(function (res) {
      if (res && res.ok) {
        form.hidden = true;
        show('ok', '<strong>Thank you, ' + escapeHtml(v.name.split(' ')[0]) + '. Your application is in.</strong><br>We review every application carefully. If there’s a match, we’ll email you at ' + escapeHtml(v.email) + ' to schedule a conversation.');
        status.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        throw new Error((res && res.error) || 'unknown');
      }
    }).catch(function () {
      busy(false);
      show('err', 'We couldn’t confirm that your application arrived. Please press <b>Send application</b> again; you won’t be counted twice. If it keeps failing, email your CV to <span class="sel">hello@cornerrenovation.com</span> with the role in the subject.');
    });
  });

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
})();
