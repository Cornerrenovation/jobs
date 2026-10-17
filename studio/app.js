/* Corner Studio: the hiring CRM. Talks to /studio/api (a Worker on D1); Cloudflare Access has already signed the viewer in.
   One visual language throughout, taken from the Checklists view: greige cards, mono eyebrows, segmented controls, quiet buttons. */
(function () {
  "use strict";
  const API = "/studio/api/";
  const $ = (s, el) => (el || document).querySelector(s);
  const h = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const today = () => new Date().toISOString().slice(0, 10);
  const fmt = (iso) => { if (!iso) return ""; const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
  const fmtTime = (iso) => { const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); };
  const STAGES = ["applied", "triaged", "confirmed", "messaged", "replied", "screen booked", "screen done", "interview booked", "interview done",
    "work sample", "references", "offer", "hired", "declined", "not now", "pool R1"];
  const FUNNEL = [["Applied", ["applied"]], ["Triaged", ["triaged"]], ["Shortlisted", ["confirmed"]], ["Messaged", ["messaged"]], ["Replied", ["replied"]],
    ["Screen call", ["screen booked", "screen done"]], ["Interview", ["interview booked", "interview done"]], ["Work sample", ["work sample"]],
    ["References", ["references"]], ["Offer", ["offer"]], ["Hired", ["hired"]]];
  const CLOSED = ["declined", "not now", "pool R1"];
  const CALLS = ["", "Shortlist", "Hold", "Decline"];
  const VIEWS = ["week", "checklists", "pipeline", "candidates", "outreach", "templates", "activity", "posts"];
  const whoName = (by) => !by ? "" : by === "claude" || /\.access$/.test(by) || /^u_/.test(by) ? "Claude" : by.replace(/@.*/, "").replace(/^\w/, (c) => c.toUpperCase());
  const state = { view: "week", boot: null, roleFilter: "all", role: null, filter: "all", candidates: null, outreach: null, templates: null, search: "", open: {} };
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };

  async function api(path, method, body) {
    const r = await fetch(API + path, { method: method || "GET", credentials: "same-origin",
      headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { notice("Your sign-in expired. Reload the page to sign in again.", true); throw new Error("unauthorized"); }
    if (r.status === 503) { notice("Sign-in isn't switched on for the studio yet.", true); throw new Error("not configured"); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) { notice(j.error || ("Request failed: " + r.status), true); throw new Error(j.error || r.status); }
    return j;
  }
  function notice(text, bad) { const n = $("#notice"); n.textContent = text || ""; n.hidden = !text; n.classList.toggle("bad", !!bad); }

  // ---------- data ----------
  async function loadBoot() { state.boot = await api("bootstrap"); $("#who").textContent = whoName(state.boot.who) === "Claude" ? state.boot.who : state.boot.who; }
  const roles = () => state.boot.roles;
  const roleName = (id) => (roles().find((r) => r.id === id) || {}).short || id;
  async function loadCandidates() { state.candidates = await api("candidates"); }
  async function loadOutreach() { state.outreach = await api("outreach"); }
  async function loadTemplates() { state.templates = await api("templates"); }

  // ---------- shell ----------
  function setView(v) {
    state.view = v; store.set("studio-view", v);
    document.querySelectorAll("nav.views button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.view === v));
    render();
  }
  document.querySelectorAll("nav.views button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  async function render() {
    notice("");
    const view = $("#view");
    view.innerHTML = '<p class="muted">Loading…</p>';
    try {
      if (!state.boot) await loadBoot();
      if (state.view === "week") await renderDocView(view, "this-week");
      else if (state.view === "checklists") renderChecklists(view);
      else if (state.view === "pipeline") await renderPipeline(view);
      else if (state.view === "candidates") await renderCandidates(view);
      else if (state.view === "outreach") await renderOutreach(view);
      else if (state.view === "templates") await renderTemplates(view);
      else if (state.view === "activity") await renderActivity(view);
      else if (state.view === "posts") await renderDocView(view, "posts");
    } catch (e) { if (!$("#notice").textContent) notice(String(e.message || e), true); view.innerHTML = ""; }
    window.scrollTo(0, 0);
  }

  // Shared pieces
  const head = (title, sub, right) => `<div class="viewhead"><div><h2>${h(title)}</h2>${sub ? `<div class="sub">${sub}</div>` : ""}</div>${right || ""}</div>`;
  const seg = (name, items, current) => `<div class="seg" data-seg="${h(name)}">${items.map(([v, l]) => `<button type="button" data-v="${h(v)}" aria-pressed="${v === current}">${h(l)}</button>`).join("")}</div>`;
  function bindSeg(el, name, onPick) { el.querySelectorAll(`[data-seg="${name}"] button`).forEach((b) => b.addEventListener("click", () => onPick(b.dataset.v))); }
  const roleSeg = () => seg("role", [["all", "All roles"]].concat(roles().map((r) => [r.id, r.short])), state.roleFilter);
  const pill = (text, kind) => text ? `<span class="pill ${kind || ""}" title="${h(text)}">${h(text)}</span>` : "";
  const callPill = (c) => pill(c, c === "Shortlist" ? "ok" : c === "Decline" ? "bad" : c ? "warn" : "");
  const table = (cols, rows) => `<div class="tablewrap"><table><thead><tr>${cols.map((c) => `<th>${h(c)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;

  // ---------- This week and Posts: the launch kit, rendered by the checklist builder and synced as documents ----------
  async function renderDocView(view, slug) {
    const d = await api("docs/" + slug);
    const back = slug === "posts" ? `<p class="crumbs"><button type="button" class="linkbtn" data-back="checklists">← Checklists</button><span class="muted"> · </span><button type="button" class="linkbtn" data-back="week">This week</button></p>` : "";
    view.innerHTML = `${back}${slug === "posts" ? head("Posts", "Every text here is ready to paste. Settings for LinkedIn and Work.ua are folded under each post.") : ""}<section class="kit ${slug}">${d.html || "<p class='muted'>Not synced yet.</p>"}</section>`;
    const done = state.boot.ticks.filter((t) => t.done).length, total = state.boot.steps.length * state.boot.roles.length;
    view.querySelectorAll(".kpi b").forEach((b) => { if (/\/ 140$/.test(b.textContent) || b.querySelector("[data-count]")) b.innerHTML = `${done} / ${total}`; });
    view.querySelectorAll("section.posts > p.muted:first-child").forEach((p) => p.remove());
    view.querySelectorAll('a[href="#posts"]').forEach((a) => { a.removeAttribute("target"); a.addEventListener("click", (e) => { e.preventDefault(); setView("posts"); }); });
    view.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.back)));
    view.querySelectorAll("pre").forEach(copyBar);
  }
  function copyBar(pre) {
    const box = document.createElement("div"); box.className = "post";
    const bar = document.createElement("div"); bar.className = "postbar";
    const lab = document.createElement("span"); lab.className = "eyebrow"; lab.textContent = pre.textContent.trim().split("\n")[0].slice(0, 48);
    const btn = document.createElement("button"); btn.className = "btn ghost small"; btn.type = "button"; btn.textContent = "Copy";
    btn.addEventListener("click", () => {
      const t = pre.textContent.replace(/\n$/, "");
      const ok = () => { btn.textContent = "Copied"; setTimeout(() => { btn.textContent = "Copy"; }, 1600); };
      const pick = () => { const r = document.createRange(); r.selectNodeContents(pre); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); btn.textContent = "Selected: press ⌘C"; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(ok, pick); else pick();
    });
    pre.parentNode.insertBefore(box, pre); bar.appendChild(lab); bar.appendChild(btn); box.appendChild(bar); box.appendChild(pre);
  }

  // ---------- pipeline: a vertical funnel with conversions ----------
  async function renderPipeline(view) {
    if (!state.candidates) await loadCandidates();
    const list = state.candidates.filter((c) => state.roleFilter === "all" || c.role_id === state.roleFilter);
    const active = list.filter((c) => !CLOSED.includes(c.stage));
    const idx = (c) => { const i = FUNNEL.findIndex(([, st]) => st.includes(c.stage || "applied")); return i < 0 ? 0 : i; };
    const reached = FUNNEL.map((_, i) => active.filter((c) => idx(c) >= i));
    const top = reached[0].length || 1;
    const closed = list.filter((c) => CLOSED.includes(c.stage));
    const rows = FUNNEL.map(([title, stages], i) => {
      const n = reached[i].length, prev = i ? reached[i - 1].length : n, here = active.filter((c) => idx(c) === i);
      const conv = i ? (prev ? Math.round(100 * n / prev) : 0) : null, overall = i ? (reached[0].length ? Math.round(100 * n / reached[0].length) : 0) : null;
      const open = !!state.open[title];
      return `<div class="stage ${open ? "open" : ""}" data-stage="${h(title)}">
        <button type="button" class="stagerow" data-toggle="${h(title)}" aria-expanded="${open}">
          <span class="sname">${h(title)}</span>
          <span class="sbar"><span style="width:${Math.round(100 * n / top)}%"></span></span>
          <span class="snum">${n}</span>
          <span class="sconv">${conv == null ? "" : `${conv}% <small>of ${h(FUNNEL[i - 1][0].toLowerCase())}</small>`}</span>
          <span class="sconv all">${overall == null ? "" : `${overall}% <small>of applied</small>`}</span>
          <span class="snow muted">${here.length} here now</span>
        </button>
        ${open ? `<div class="stagelist">${here.length ? here.map((c) => `<button type="button" class="srow" data-id="${h(c.id)}"><span class="name">${h(c.name)}</span><span class="muted">${h(roleName(c.role_id))}${c.sources ? " · " + h(c.sources) : ""}</span>${callPill(c.your_call)}${c.due ? `<span class="muted">due ${h(fmt(c.due))}</span>` : ""}<span class="pill">${h(c.stage)}</span></button>`).join("") : `<p class="muted">Nobody at this stage right now.</p>`}</div>` : ""}
      </div>`;
    }).join("");
    view.innerHTML = head("Pipeline", `${active.length} active · ${closed.length} closed · each stage counts everyone who reached it or went further; click a stage to see who is there now`, roleSeg()) +
      `<div class="funnel">${rows}</div>
      ${closed.length ? `<div class="stage"><button type="button" class="stagerow" data-toggle="Closed" aria-expanded="${!!state.open.Closed}"><span class="sname">Closed</span><span class="sbar"></span><span class="snum">${closed.length}</span><span class="sconv"></span><span class="sconv all"></span><span class="snow muted">declined, not now, pool</span></button>
        ${state.open.Closed ? `<div class="stagelist">${closed.map((c) => `<button type="button" class="srow" data-id="${h(c.id)}"><span class="name">${h(c.name)}</span><span class="muted">${h(roleName(c.role_id))}</span><span class="pill">${h(c.stage)}</span></button>`).join("")}</div>` : ""}</div>` : ""}
      ${list.length ? "" : `<div class="card empty">No candidates yet. They arrive from the jobs site, LinkedIn and Work.ua through the daily check-in, or you add one under Candidates.</div>`}`;
    bindSeg(view, "role", (v) => { state.roleFilter = v; renderPipeline(view); });
    view.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => { state.open[b.dataset.toggle] = !state.open[b.dataset.toggle]; renderPipeline(view); }));
    view.querySelectorAll(".srow").forEach((b) => b.addEventListener("click", () => openCandidate(b.dataset.id)));
  }

  // ---------- candidates ----------
  async function renderCandidates(view) {
    if (!state.candidates) await loadCandidates();
    const q = state.search.trim().toLowerCase();
    const list = state.candidates.filter((c) => (state.roleFilter === "all" || c.role_id === state.roleFilter) &&
      (!q || [c.name, c.headline, c.location, c.sources, c.email, c.stage, c.your_call, c.agent_call].join(" ").toLowerCase().includes(q)));
    view.innerHTML = head("Candidates", `${list.length} of ${state.candidates.length}`, `<button type="button" class="btn" id="add">Add candidate</button>`) +
      `<div class="toolbar"><input type="search" id="q" placeholder="Search name, headline, source, stage" value="${h(state.search)}">${roleSeg()}</div>
      ${list.length ? table(["Name", "Role", "Source", "Applied", "Agent call", "Your call", "Stage", "Next step", "Due"],
        list.map((c) => `<tr class="clickable" data-id="${h(c.id)}"><td><span class="name">${h(c.name)}</span><br><span class="muted">${h(c.headline || c.location || "")}</span></td><td>${h(roleName(c.role_id))}</td><td>${h(c.sources)}</td><td>${h(fmt(c.applied))}</td><td>${h(c.agent_call)}</td><td>${callPill(c.your_call)}</td><td>${pill(c.stage || "applied")}</td><td>${h(c.next_step)}</td><td>${h(fmt(c.due))}</td></tr>`))
        : `<div class="card empty">No candidates yet. They arrive from the jobs site, LinkedIn and Work.ua through the daily check-in, or add one by hand.</div>`}`;
    const qel = $("#q", view);
    qel.addEventListener("input", (e) => { state.search = e.target.value; renderCandidates(view); qel.focus(); });
    if (q) { qel.focus(); qel.setSelectionRange(qel.value.length, qel.value.length); }
    bindSeg(view, "role", (v) => { state.roleFilter = v; renderCandidates(view); });
    view.querySelectorAll("tr.clickable").forEach((tr) => tr.addEventListener("click", () => openCandidate(tr.dataset.id)));
    $("#add", view).addEventListener("click", () => openCandidate(null));
  }
  function openCandidate(id) {
    const c = id ? state.candidates.find((x) => x.id === id) : { stage: "applied", role_id: state.roleFilter !== "all" ? state.roleFilter : (roles()[0] || {}).id };
    const sel = (name, opts, val, labels) => `<select name="${name}">${opts.map((o, i) => `<option value="${h(o)}" ${o === (val || "") ? "selected" : ""}>${h(labels ? labels[i] : (o || "–"))}</option>`).join("")}</select>`;
    const ro = (k, v, isLink) => v ? `<dt>${h(k)}</dt><dd>${isLink ? `<a href="${h(v)}" target="_blank" rel="noopener">${h(v.replace(/^https?:\/\/(www\.)?/, ""))}</a>` : h(v)}</dd>` : "";
    openDrawer(id ? c.name : "New candidate", `
      ${id ? `<dl class="kv">${ro("ID", c.id)}${ro("Role", roleName(c.role_id))}${ro("LinkedIn", c.linkedin, true)}${ro("Email", c.email)}${ro("Location", c.location)}${ro("Sources", c.sources)}
        ${ro("Applied", c.applied)}${ro("Headline", c.headline)}${ro("English", c.english)}${ro("Screening", c.screening)}${ro("Site answer", c.site_answer)}${ro("CV / portfolio", c.cv, /^https?:/.test(c.cv || ""))}
        ${ro("Knockout", c.knockout)}${ro("Agent call", c.agent_call && (c.agent_call + (c.confidence ? " · " + c.confidence : "")))}${ro("Why", c.why)}${ro("Doubt to probe", c.doubt)}${ro("Latest reply", c.latest_reply)}${ro("Last contact", c.last_contact)}</dl>` : ""}
      <form class="form" id="cform">
        ${id ? "" : `<label class="full"><span class="lbl">Name</span><input name="name" required></label><label><span class="lbl">Role</span>${sel("role_id", roles().map((r) => r.id), c.role_id, roles().map((r) => r.short))}</label><label><span class="lbl">Source</span><input name="sources" placeholder="LinkedIn UA, referral…"></label><label class="full"><span class="lbl">LinkedIn</span><input name="linkedin" type="url"></label><label><span class="lbl">Email</span><input name="email" type="email"></label><label><span class="lbl">Location</span><input name="location"></label>`}
        <label><span class="lbl">Your call</span>${sel("your_call", CALLS, c.your_call)}</label>
        <label><span class="lbl">Stage</span>${sel("stage", STAGES, c.stage || "applied")}</label>
        <label class="full"><span class="lbl">Your reason</span><input name="your_reason" value="${h(c.your_reason)}"></label>
        <label><span class="lbl">Next step</span><input name="next_step" value="${h(c.next_step)}"></label>
        <label><span class="lbl">Due</span><input name="due" type="date" value="${h((c.due || "").slice(0, 10))}"></label>
        <label class="full"><span class="lbl">Notes</span><textarea name="notes">${h(c.notes)}</textarea></label>
        <div class="formfoot full"><span class="saved" id="csaved"></span><button type="submit" class="btn">${id ? "Save" : "Add"}</button></div>
      </form>`);
    $("#cform").addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      if (id) await api("candidates/" + id, "PATCH", data); else await api("candidates", "POST", data);
      $("#csaved").textContent = "Saved"; state.candidates = null; state.boot = null;
      await loadBoot(); await loadCandidates(); render(); if (id) openCandidate(id); else closeDrawer();
    });
  }

  // ---------- outreach ----------
  const addWorkDays = (from, n) => { const d = new Date(from + "T12:00:00"); let k = 0; while (k < n) { d.setDate(d.getDate() + 1); if (d.getDay() % 6) k++; } return d.toISOString().slice(0, 10); };
  function nextActions(o) {
    const t = today(), acts = [];
    if (o.replied) return [];
    if (!o.invite_sent) acts.push(["Invite sent", { invite_sent: t, step: "1", status: "invited", next_action: "wait for acceptance", due: addWorkDays(t, 10) }]);
    else if (!o.accepted) acts.push(["Accepted", { accepted: t, step: "2", status: "accepted", next_action: "message-1", due: addWorkDays(t, 1) }],
      ["Withdrawn", { status: "withdrawn", next_action: "", due: "" }]);
    else if (!o.message1_sent) acts.push(["Message 1 sent", { message1_sent: t, step: "3", status: "messaged", next_action: "follow-up-1", due: addWorkDays(t, 3) }]);
    else if (!o.followup1_sent) acts.push(["Follow-up 1 sent", { followup1_sent: t, step: "4", status: "followed up", next_action: "follow-up-2", due: addWorkDays(t, 5) }]);
    else if (!o.followup2_sent) acts.push(["Follow-up 2 sent", { followup2_sent: t, status: "closed", next_action: "", due: "" }]);
    if (o.invite_sent) acts.push(["Replied", { replied: t, status: "replied", next_action: "Kostya replies", due: t }]);
    return acts;
  }
  const shortStatus = (s) => (s || "queued").replace(/^queued.*/, "queued");
  async function renderOutreach(view) {
    if (!state.outreach) await loadOutreach();
    if (!state.templates) await loadTemplates();
    const list = state.outreach;
    const counts = {}; list.forEach((o) => { const k = shortStatus(o.status); counts[k] = (counts[k] || 0) + 1; });
    const due = list.filter((o) => o.due && o.due <= today() && !o.replied).length;
    const unapproved = state.templates.filter((t) => t.approved !== "Yes").length;
    const groups = {}; list.forEach((o) => { const g = (o.campaign || "") + (o.batch ? " · batch " + o.batch : ""); (groups[g] = groups[g] || []).push(o); });
    view.innerHTML = head("Outreach", `${list.length} prospects · ${due} due today or earlier · ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")}`) +
      (unapproved ? `<div class="card note"><b>${unapproved} of ${state.templates.length} templates aren't approved yet.</b> Nothing is sent until they are. <button type="button" class="linkbtn" data-go="templates">Review templates</button></div>` : "") +
      `<p class="muted">Sequence: invite with a note → message 1 after acceptance → follow-up at +3 and +5 working days. Pressing a button records today's date and sets the next action.</p>
      ${Object.entries(groups).map(([g, rows]) => `<div class="group"><span class="eyebrow">${h(g)}</span>${table(["Prospect", "Hook", "Status", "Next action", "Due", "Latest reply", "Actions"],
        rows.map((o) => `<tr><td><span class="name">${o.linkedin ? `<a href="${h(o.linkedin)}" target="_blank" rel="noopener">${h(o.name)}</a>` : h(o.name)}</span><br><span class="muted">${h(o.company || o.location || "")}</span></td>
          <td class="wrapcell">${h(o.hook)}</td><td>${pill(shortStatus(o.status), o.replied ? "ok" : ["withdrawn", "closed"].includes(o.status) ? "" : "warn")}</td>
          <td>${h(o.next_action)}</td><td>${o.due && o.due <= today() && !o.replied ? `<b>${h(fmt(o.due))}</b>` : h(fmt(o.due))}</td><td class="wrapcell">${h(o.latest_reply)}</td>
          <td class="actions">${nextActions(o).map(([label, patch]) => `<button type="button" class="btn ghost small" data-id="${h(o.id)}" data-patch='${h(JSON.stringify(patch))}'>${h(label)}</button>`).join("")}<button type="button" class="btn ghost small" data-open="${h(o.id)}">Open</button></td></tr>`))}</div>`).join("") || '<div class="card empty">No prospects queued.</div>'}`;
    view.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.go)));
    view.querySelectorAll("button[data-patch]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true; await api("outreach/" + b.dataset.id, "PATCH", JSON.parse(b.dataset.patch)); state.outreach = null; state.boot = null; renderOutreach(view);
    }));
    view.querySelectorAll("button[data-open]").forEach((b) => b.addEventListener("click", () => {
      const o = list.find((x) => x.id === b.dataset.open);
      openDrawer(o.name, `<dl class="kv"><dt>Company</dt><dd>${h(o.company)}</dd><dt>LinkedIn</dt><dd><a href="${h(o.linkedin)}" target="_blank" rel="noopener">${h((o.linkedin || "").replace(/^https?:\/\/(www\.)?/, ""))}</a></dd><dt>Hook</dt><dd>${h(o.hook)}</dd><dt>Dates</dt><dd>${["invite_sent", "accepted", "message1_sent", "followup1_sent", "followup2_sent", "replied"].filter((k) => o[k]).map((k) => `${k.replace(/_/g, " ")}: ${fmt(o[k])}`).join(" · ") || "–"}</dd></dl>
        <form class="form" id="oform"><label class="full"><span class="lbl">Latest reply</span><textarea name="latest_reply">${h(o.latest_reply)}</textarea></label><label class="full"><span class="lbl">Notes</span><textarea name="notes">${h(o.notes)}</textarea></label><div class="formfoot full"><button type="submit" class="btn">Save</button></div></form>`);
      $("#oform").addEventListener("submit", async (e) => { e.preventDefault(); await api("outreach/" + o.id, "PATCH", Object.fromEntries(new FormData(e.target).entries())); state.outreach = null; closeDrawer(); renderOutreach(view); });
    }));
  }

  // ---------- templates ----------
  async function renderTemplates(view) {
    if (!state.templates) await loadTemplates();
    const approved = state.templates.filter((t) => t.approved === "Yes").length;
    view.innerHTML = head("Templates", `${approved} of ${state.templates.length} approved · only approved templates go out; variables are filled from each prospect's row`) +
      state.templates.map((t) => `<form class="card tpl" data-id="${h(t.id)}">
        <div class="tplhead"><div><span class="eyebrow">Step ${h(t.step)} · ${h(t.channel)}${t.limit_ && t.limit_ !== "–" ? " · " + h(t.limit_) : ""}</span><h3>${h(t.id)}</h3></div>${pill(t.approved === "Yes" ? "approved" : t.approved === "Edit" ? "needs edits" : t.approved === "No" ? "rejected" : "not reviewed", t.approved === "Yes" ? "ok" : t.approved ? "warn" : "")}</div>
        <label><span class="lbl">Text</span><textarea name="text" rows="4">${h(t.text)}</textarea></label>
        <p class="muted small">When: ${h(t.when_)} · Variables: ${h(t.variables)}</p>
        <div class="tplfoot"><label class="inline"><span class="lbl">Approved</span>${seg("approved-" + t.id, [["Yes", "Yes"], ["Edit", "Needs edits"], ["No", "No"]], t.approved)}<input type="hidden" name="approved" value="${h(t.approved)}"></label>
          <label class="grow"><span class="lbl">Notes</span><input name="notes" value="${h(t.notes)}"></label>
          <div class="formfoot"><span class="saved"></span><button type="submit" class="btn">Save</button></div></div></form>`).join("");
    view.querySelectorAll("form.tpl").forEach((f) => {
      bindSeg(f, "approved-" + f.dataset.id, (v) => { $('input[name="approved"]', f).value = v; f.querySelectorAll(`[data-seg] button`).forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === v)); });
      f.addEventListener("submit", async (e) => { e.preventDefault(); await api("templates/" + f.dataset.id, "PATCH", Object.fromEntries(new FormData(f).entries())); state.templates = null; renderTemplates(view); });
    });
  }

  // ---------- checklists ----------
  function renderChecklists(view) {
    const b = state.boot, steps = b.steps, total = steps.length;
    const doneSet = new Set(b.ticks.filter((t) => t.done).map((t) => t.role_id + "~" + t.step_id));
    const tickOf = (rid, sid) => b.ticks.find((t) => t.role_id === rid && t.step_id === sid);
    const count = (rid) => steps.filter((s) => doneSet.has(rid + "~" + s.id)).length;
    if (!state.role || !roles().find((r) => r.id === state.role)) state.role = roles().find((r) => r.id === store.get("studio-role")) ? store.get("studio-role") : (roles()[0] || {}).id;
    const role = roles().find((r) => r.id === state.role);
    const notes = {}; b.role_steps.forEach((rs) => { notes[rs.role_id + "~" + rs.step_id] = rs; });
    const phases = []; steps.forEach((s) => { let p = phases.find((x) => x.key === s.phase); if (!p) { p = { key: s.phase, title: s.phase_title, steps: [] }; phases.push(p); } p.steps.push(s); });
    const chipFor = (l) => l.target === "#posts" ? `<button type="button" class="chip link" data-posts>${h(l.label)}</button>`
      : l.target.startsWith("doc:") ? `<button type="button" class="chip link" data-doc="${h(l.target.slice(4))}">${h(l.label)}</button>`
      : `<a class="chip link" href="${h(l.target.startsWith("art:") ? "https://claude.ai/artifact/" + l.target.slice(4) : l.target)}" target="_blank" rel="noopener">${h(l.label)}</a>`;
    view.innerHTML = head("Checklists", `The ${total} steps every search follows, one list per role`, `<button type="button" class="btn" id="newsearch">New search</button>`) +
      `<div class="cards">${roles().map((r) => `<button type="button" class="rcard" data-role="${h(r.id)}" aria-pressed="${r.id === state.role}">${pill(r.state === "live" ? "Live" : r.state === "pool" ? "Quiet pool" : r.state || "planned", r.state === "live" ? "ok" : r.state === "pool" ? "warn" : "")}<span class="cname">${h(r.short)}</span><span class="muted small">Owner · ${h(r.owner || "–")}</span><span class="bar"><span style="width:${Math.round(100 * count(r.id) / total)}%"></span></span><span class="mono muted"><b>${count(r.id)}</b> / ${total}</span></button>`).join("")}</div>
      ${role ? `<div class="rolebar"><div class="rtabs">${roles().map((r) => `<button type="button" class="rtab" data-role="${h(r.id)}" aria-pressed="${r.id === state.role}">${h(r.short)}<b>${count(r.id)}</b></button>`).join("")}</div>${seg("filter", [["all", "All"], ["open", "Open"], ["done", "Done"]], state.filter)}</div>
      <section class="role" data-filter="${h(state.filter)}"><div class="rolehead"><div><span class="eyebrow">Owner · ${h(role.owner || "–")}</span><h2>${h(role.name)}</h2><p class="muted">${h(role.status)}<button type="button" class="edit" id="editrole">edit</button></p></div><div class="rolestat"><span class="big">${count(role.id)}</span><span class="muted">of ${total} steps done</span></div></div><div class="bar"><span style="width:${Math.round(100 * count(role.id) / total)}%"></span></div>
      ${phases.map((p) => `<div class="phase"><h3>${h(p.title)} <span>${p.steps.filter((s) => doneSet.has(role.id + "~" + s.id)).length} / ${p.steps.length}</span></h3><ul class="steps">
        ${p.steps.map((s) => { const key = role.id + "~" + s.id, done = doneSet.has(key), t = tickOf(role.id, s.id), rs = notes[key] || {}; let links = []; try { links = JSON.parse(rs.links || "[]"); } catch (e) {}
          return `<li class="step ${done ? "done" : ""}"><input type="checkbox" class="tick" id="t-${h(key)}" data-key="${h(key)}" ${done ? "checked" : ""}><div class="stepbody"><label for="t-${h(key)}" class="stitle">${h(s.title)}</label>
            <p class="snote" data-note="${h(key)}">${h(rs.note || "")}<button type="button" class="edit" data-editnote="${h(key)}">${rs.note ? "edit" : "add a note"}</button></p>
            ${links.length ? `<div class="chips">${links.map(chipFor).join("")}</div>` : ""}
            <details class="what"><summary>What this step means</summary><p>${h(s.what)}</p></details>
            <span class="smeta">${done && t ? "Done " + fmt(t.at) + " · by " + h(whoName(t.by)) : ""}</span></div></li>`; }).join("")}</ul></div>`).join("")}</section>` : '<div class="card empty">No searches yet. Start one with "New search".</div>'}`;
    view.querySelectorAll("[data-role]").forEach((el) => el.addEventListener("click", () => { state.role = el.dataset.role; store.set("studio-role", state.role); renderChecklists(view); }));
    bindSeg(view, "filter", (v) => { state.filter = v; renderChecklists(view); });
    view.querySelectorAll("input.tick").forEach((cb) => cb.addEventListener("change", async () => {
      const [rid, sid] = cb.dataset.key.split("~"); cb.disabled = true;
      await api(`roles/${rid}/steps/${sid}/tick`, "PATCH", { done: cb.checked }); state.boot = null; await loadBoot(); renderChecklists(view);
    }));
    view.querySelectorAll("[data-editnote]").forEach((btn) => btn.addEventListener("click", () => {
      const key = btn.dataset.editnote, p = view.querySelector(`[data-note="${CSS.escape(key)}"]`), cur = (notes[key] || {}).note || "";
      p.innerHTML = `<textarea rows="3">${h(cur)}</textarea><div class="formfoot"><button type="button" class="btn ghost small" data-cancel>Cancel</button><button type="button" class="btn small" data-save>Save note</button></div>`;
      $("[data-cancel]", p).addEventListener("click", () => renderChecklists(view));
      $("[data-save]", p).addEventListener("click", async () => { const [rid, sid] = key.split("~"); await api(`roles/${rid}/steps/${sid}`, "PATCH", { note: $("textarea", p).value }); state.boot = null; await loadBoot(); renderChecklists(view); });
    }));
    view.querySelectorAll("[data-doc]").forEach((b) => b.addEventListener("click", () => openDoc(b.dataset.doc)));
    view.querySelectorAll("[data-posts]").forEach((b) => b.addEventListener("click", () => setView("posts")));
    const roleForm = (title, r, onSubmit) => {
      openDrawer(title, `<form class="form" id="rform"><label class="full"><span class="lbl">Role name</span><input name="name" value="${h(r.name || "")}" required placeholder="Technical Designer"></label><label><span class="lbl">Short name</span><input name="short" value="${h(r.short || "")}" placeholder="TD"></label><label><span class="lbl">Owner</span><input name="owner" value="${h(r.owner || "")}" placeholder="Kostya"></label>
        <label><span class="lbl">State</span><select name="state">${[["planned", "Planned"], ["live", "Live"], ["pool", "Quiet pool"], ["closed", "Closed"]].map(([v, l]) => `<option value="${v}" ${v === (r.state || "planned") ? "selected" : ""}>${l}</option>`).join("")}</select></label><label class="full"><span class="lbl">Status line</span><input name="status" value="${h(r.status || "")}" placeholder="Opens when the first TA Manager round is hired"></label>
        <div class="formfoot full"><button type="submit" class="btn">${r.id ? "Save" : "Create the checklist"}</button></div></form>`);
      $("#rform").addEventListener("submit", async (e) => { e.preventDefault(); await onSubmit(Object.fromEntries(new FormData(e.target).entries())); state.boot = null; closeDrawer(); await loadBoot(); renderChecklists(view); });
    };
    $("#newsearch", view).addEventListener("click", () => roleForm("New search", {}, async (d) => { const r = await api("roles", "POST", d); state.role = r.id; store.set("studio-role", r.id); }));
    const er = $("#editrole", view); if (er) er.addEventListener("click", () => roleForm("Edit search", role, (d) => api("roles/" + role.id, "PATCH", d)));
  }

  // ---------- activity ----------
  async function renderActivity(view) {
    const rows = await api("activity?limit=200");
    view.innerHTML = head("Activity", "Every change, newest first") +
      (rows.length ? table(["When", "Who", "What"], rows.map((a) => `<tr><td class="mono muted nowrap">${h(fmtTime(a.at))}</td><td class="nowrap">${h(whoName(a.who))}</td><td class="wrapcell">${h(a.summary)}</td></tr>`)) : '<div class="card empty">Nothing yet.</div>');
  }

  // ---------- drawer and documents ----------
  function openDrawer(title, html) { $("#dtitle").textContent = title; $("#dbody").innerHTML = html; $("#drawer").hidden = false; $("#scrim").hidden = false; }
  function closeDrawer() { $("#drawer").hidden = true; $("#scrim").hidden = true; }
  $("#dclose").addEventListener("click", closeDrawer); $("#scrim").addEventListener("click", closeDrawer);
  async function openDoc(slug) {
    const d = await api("docs/" + slug); const dlg = $("#docview");
    $("#doctitle").textContent = d.title || slug; $("#docpath").textContent = d.path || ""; $("#docbody").innerHTML = d.html || "<p>Not found.</p>"; $("#docbody").scrollTop = 0;
    dlg.showModal ? dlg.showModal() : dlg.setAttribute("open", "");
  }
  $("#docclose").addEventListener("click", () => $("#docview").close());
  $("#docview").addEventListener("click", (e) => { if (e.target === $("#docview")) $("#docview").close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer(); });

  const start = (location.hash || "").slice(1) || store.get("studio-view") || "week";
  setView(VIEWS.includes(start) ? start : "week");
})();
