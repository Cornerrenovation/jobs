/* Corner Studio: the hiring CRM. Talks to /studio/api (a Worker on D1); Cloudflare Access has already signed the viewer in. */
(function () {
  "use strict";
  const API = "/studio/api/";
  const $ = (s, el) => (el || document).querySelector(s);
  const h = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const today = () => new Date().toISOString().slice(0, 10);
  const fmt = (iso) => { if (!iso) return ""; const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
  const STAGES = ["applied", "triaged", "confirmed", "messaged", "replied", "screen booked", "screen done", "interview booked", "interview done",
    "work sample", "references", "offer", "hired", "declined", "not now", "pool R1"];
  const BOARD = [["Applied", ["applied"]], ["Triaged", ["triaged"]], ["Shortlisted", ["confirmed"]], ["Messaged", ["messaged"]], ["Replied", ["replied"]],
    ["Screen", ["screen booked", "screen done"]], ["Interview", ["interview booked", "interview done"]], ["Work sample", ["work sample"]],
    ["References", ["references"]], ["Offer", ["offer"]], ["Hired", ["hired"]], ["Closed", ["declined", "not now", "pool R1"]]];
  const CALLS = ["", "Shortlist", "Hold", "Decline"];
  const whoName = (by) => !by ? "" : by === "claude" || /\.access$/.test(by) || /^u_/.test(by) ? "Claude" : by.replace(/@.*/, "").replace(/^\w/, (c) => c.toUpperCase());
  const state = { view: "pipeline", boot: null, roleFilter: "all", role: null, filter: "all", candidates: null, outreach: null, templates: null, search: "" };
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };

  async function api(path, method, body) {
    const r = await fetch(API + path, { method: method || "GET", credentials: "same-origin",
      headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { notice("Your sign-in expired. Reload the page to sign in again.", true); throw new Error("unauthorized"); }
    if (r.status === 503) { notice("Sign-in isn't switched on for the studio yet, so the data can't load. Kostya enables Cloudflare Access once; then this page works.", true); throw new Error("not configured"); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) { notice(j.error || ("Request failed: " + r.status), true); throw new Error(j.error || r.status); }
    return j;
  }
  function notice(text, bad) { const n = $("#notice"); n.textContent = text || ""; n.hidden = !text; n.classList.toggle("bad", !!bad); }

  // ---------- data ----------
  async function loadBoot() { state.boot = await api("bootstrap"); $("#who").textContent = state.boot.who; }
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
      if (state.view === "pipeline") await renderPipeline(view);
      else if (state.view === "candidates") await renderCandidates(view);
      else if (state.view === "outreach") await renderOutreach(view);
      else if (state.view === "templates") await renderTemplates(view);
      else if (state.view === "checklists") renderChecklists(view);
      else if (state.view === "week") await renderDocView(view, "this-week");
      else if (state.view === "posts") await renderDocView(view, "posts");
      else if (state.view === "activity") await renderActivity(view);
    } catch (e) { if (!$("#notice").textContent) notice(String(e.message || e), true); view.innerHTML = ""; }
  }

  function roleChips(onChange) {
    const chips = [["all", "All roles"]].concat(roles().map((r) => [r.id, r.short]));
    return `<div class="chips" data-rolechips>${chips.map(([id, n]) => `<button type="button" class="chip" data-role="${h(id)}" aria-pressed="${state.roleFilter === id}">${h(n)}</button>`).join("")}</div>`;
  }
  function bindRoleChips(el, onChange) {
    el.querySelectorAll("[data-rolechips] .chip").forEach((b) => b.addEventListener("click", () => { state.roleFilter = b.dataset.role; onChange(); }));
  }
  const callPill = (c) => c ? `<span class="pill ${c === "Shortlist" ? "ok" : c === "Decline" ? "bad" : "warn"}">${h(c)}</span>` : "";

  // ---------- pipeline ----------
  async function renderPipeline(view) {
    if (!state.candidates) await loadCandidates();
    const list = state.candidates.filter((c) => state.roleFilter === "all" || c.role_id === state.roleFilter);
    view.innerHTML = `<div class="viewhead"><div><h2>Pipeline</h2><div class="sub">${list.length} candidates · drag a card to move it, click it to open the record</div></div>${roleChips()}</div>
      <div class="board">${BOARD.map(([title, stages]) => {
        const cards = list.filter((c) => stages.includes(c.stage || "applied"));
        return `<div class="col" data-stages="${h(stages.join("|"))}"><div class="colhead"><h3>${h(title)}</h3><b>${cards.length}</b></div>${cards.map(cardHtml).join("")}</div>`;
      }).join("")}</div>`;
    bindRoleChips(view, () => renderPipeline(view));
    view.querySelectorAll(".card").forEach((c) => {
      c.addEventListener("click", () => openCandidate(c.dataset.id));
      c.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", c.dataset.id); e.dataTransfer.effectAllowed = "move"; });
    });
    view.querySelectorAll(".col").forEach((col) => {
      col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("over"); });
      col.addEventListener("dragleave", () => col.classList.remove("over"));
      col.addEventListener("drop", async (e) => {
        e.preventDefault(); col.classList.remove("over");
        const id = e.dataTransfer.getData("text/plain"); const stage = col.dataset.stages.split("|")[0];
        const c = state.candidates.find((x) => x.id === id); if (!c || c.stage === stage) return;
        c.stage = stage; await api("candidates/" + id, "PATCH", { stage }); state.boot = null; await loadBoot(); renderPipeline(view);
      });
    });
  }
  function cardHtml(c) {
    return `<button type="button" class="card" draggable="true" data-id="${h(c.id)}"><span class="name">${h(c.name)}</span>
      <span class="meta"><span>${h(roleName(c.role_id))}</span>${c.sources ? `<span>${h(c.sources)}</span>` : ""}${c.due ? `<span>due ${h(fmt(c.due))}</span>` : ""}</span>
      <span class="row">${c.agent_call ? `<span class="pill">${h("agent: " + c.agent_call)}</span>` : ""}${callPill(c.your_call)}${c.knockout && c.knockout !== "none" ? `<span class="pill bad">${h(c.knockout)}</span>` : ""}</span></button>`;
  }

  // ---------- candidates ----------
  async function renderCandidates(view) {
    if (!state.candidates) await loadCandidates();
    const q = state.search.trim().toLowerCase();
    const list = state.candidates.filter((c) => (state.roleFilter === "all" || c.role_id === state.roleFilter) &&
      (!q || [c.name, c.headline, c.location, c.sources, c.email, c.stage, c.your_call, c.agent_call].join(" ").toLowerCase().includes(q)));
    view.innerHTML = `<div class="viewhead"><div><h2>Candidates</h2><div class="sub">${list.length} of ${state.candidates.length}</div></div>
      <div class="toolbar"><input type="search" id="q" placeholder="Search name, headline, source, stage" value="${h(state.search)}">${roleChips()}<button type="button" class="btn" id="add">Add candidate</button></div></div>
      ${list.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Role</th><th>Source</th><th>Applied</th><th>Agent call</th><th>Your call</th><th>Stage</th><th>Next step</th><th>Due</th></tr></thead><tbody>
      ${list.map((c) => `<tr class="clickable" data-id="${h(c.id)}"><td><span class="name">${h(c.name)}</span><br><span class="muted">${h(c.headline || c.location || "")}</span></td><td>${h(roleName(c.role_id))}</td><td>${h(c.sources)}</td><td>${h(fmt(c.applied))}</td><td>${h(c.agent_call)}</td><td>${callPill(c.your_call)}</td><td><span class="pill">${h(c.stage || "applied")}</span></td><td>${h(c.next_step)}</td><td>${h(fmt(c.due))}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">No candidates yet. They arrive from the jobs site, LinkedIn and Work.ua through the daily check-in, or add one by hand.</div>`}`;
    $("#q", view).addEventListener("input", (e) => { state.search = e.target.value; renderCandidates(view); });
    const qel = $("#q", view); qel.focus(); qel.setSelectionRange(qel.value.length, qel.value.length);
    bindRoleChips(view, () => renderCandidates(view));
    view.querySelectorAll("tr.clickable").forEach((tr) => tr.addEventListener("click", () => openCandidate(tr.dataset.id)));
    $("#add", view).addEventListener("click", () => openCandidate(null));
  }
  function openCandidate(id) {
    const c = id ? state.candidates.find((x) => x.id === id) : { stage: "applied", role_id: state.roleFilter !== "all" ? state.roleFilter : (roles()[0] || {}).id };
    const sel = (name, opts, val) => `<select name="${name}">${opts.map((o) => `<option value="${h(o)}" ${o === (val || "") ? "selected" : ""}>${h(o || "–")}</option>`).join("")}</select>`;
    const ro = (k, v, isLink) => v ? `<dt>${h(k)}</dt><dd>${isLink ? `<a href="${h(v)}" target="_blank" rel="noopener">${h(v.replace(/^https?:\/\/(www\.)?/, ""))}</a>` : h(v)}</dd>` : "";
    openDrawer(id ? c.name : "New candidate", `
      ${id ? `<dl class="kv">${ro("ID", c.id)}${ro("Role", roleName(c.role_id))}${ro("LinkedIn", c.linkedin, true)}${ro("Email", c.email)}${ro("Location", c.location)}${ro("Sources", c.sources)}
        ${ro("Applied", c.applied)}${ro("Headline", c.headline)}${ro("English", c.english)}${ro("Screening", c.screening)}${ro("Site answer", c.site_answer)}${ro("CV / portfolio", c.cv, /^https?:/.test(c.cv || ""))}
        ${ro("Knockout", c.knockout)}${ro("Agent call", c.agent_call && (c.agent_call + (c.confidence ? " · " + c.confidence : "")))}${ro("Why", c.why)}${ro("Doubt to probe", c.doubt)}${ro("Latest reply", c.latest_reply)}${ro("Last contact", c.last_contact)}</dl>` : ""}
      <form class="form" id="cform">
        ${id ? "" : `<label class="full"><span class="lbl">Name</span><input name="name" required></label><label><span class="lbl">Role</span>${sel("role_id", roles().map((r) => r.id), c.role_id)}</label><label><span class="lbl">Source</span><input name="sources" placeholder="LinkedIn UA, referral…"></label><label class="full"><span class="lbl">LinkedIn</span><input name="linkedin" type="url"></label><label><span class="lbl">Email</span><input name="email" type="email"></label><label><span class="lbl">Location</span><input name="location"></label>`}
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
  async function renderOutreach(view) {
    if (!state.outreach) await loadOutreach();
    const list = state.outreach;
    const counts = {}; list.forEach((o) => { counts[o.status || "queued"] = (counts[o.status || "queued"] || 0) + 1; });
    const due = list.filter((o) => o.due && o.due <= today() && !o.replied).length;
    const groups = {}; list.forEach((o) => { (groups[o.campaign + " · " + (o.batch || "")] = groups[o.campaign + " · " + (o.batch || "")] || []).push(o); });
    view.innerHTML = `<div class="viewhead"><div><h2>Outreach</h2><div class="sub">${list.length} prospects · ${due} due today or earlier</div></div>
      <div class="chips">${Object.entries(counts).map(([k, n]) => `<span class="chip" aria-pressed="false">${h(k)} <b>${n}</b></span>`).join("")}</div></div>
      <p class="muted" style="margin:0 0 6px">Sequence: invite → message 1 after acceptance → follow-up at +3 and +5 working days. Pressing a button records today's date and sets the next action.</p>
      ${Object.entries(groups).map(([g, rows]) => `<div class="group"><h3>${h(g)}</h3><div class="tablewrap"><table><thead><tr><th>Prospect</th><th>Hook</th><th>Status</th><th>Next action</th><th>Due</th><th>Latest reply</th><th>Record</th></tr></thead><tbody>
        ${rows.map((o) => `<tr><td><span class="name">${o.linkedin ? `<a href="${h(o.linkedin)}" target="_blank" rel="noopener">${h(o.name)}</a>` : h(o.name)}</span><br><span class="muted">${h(o.company || o.location || "")}</span></td>
          <td>${h(o.hook)}</td><td><span class="pill ${o.replied ? "ok" : o.status === "withdrawn" || o.status === "closed" ? "" : "warn"}">${h(o.status || "queued")}</span></td>
          <td>${h(o.next_action)}</td><td>${o.due && o.due <= today() && !o.replied ? `<b>${h(fmt(o.due))}</b>` : h(fmt(o.due))}</td><td>${h(o.latest_reply)}</td>
          <td class="actions">${nextActions(o).map(([label, patch]) => `<button type="button" class="btn ghost small" data-id="${h(o.id)}" data-patch='${h(JSON.stringify(patch))}'>${h(label)}</button>`).join("")}<button type="button" class="btn ghost small" data-note="${h(o.id)}">Notes</button></td></tr>`).join("")}
      </tbody></table></div></div>`).join("") || '<div class="empty">No prospects queued.</div>'}`;
    view.querySelectorAll("button[data-patch]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true; await api("outreach/" + b.dataset.id, "PATCH", JSON.parse(b.dataset.patch)); state.outreach = null; state.boot = null; renderOutreach(view);
    }));
    view.querySelectorAll("button[data-note]").forEach((b) => b.addEventListener("click", () => {
      const o = list.find((x) => x.id === b.dataset.note);
      openDrawer(o.name, `<dl class="kv"><dt>Company</dt><dd>${h(o.company)}</dd><dt>Hook</dt><dd>${h(o.hook)}</dd><dt>Dates</dt><dd>${["invite_sent", "accepted", "message1_sent", "followup1_sent", "followup2_sent", "replied"].filter((k) => o[k]).map((k) => `${k.replace(/_/g, " ")}: ${fmt(o[k])}`).join(" · ") || "–"}</dd></dl>
        <form class="form" id="oform"><label class="full"><span class="lbl">Latest reply</span><textarea name="latest_reply">${h(o.latest_reply)}</textarea></label><label class="full"><span class="lbl">Notes</span><textarea name="notes">${h(o.notes)}</textarea></label><div class="formfoot full"><button type="submit" class="btn">Save</button></div></form>`);
      $("#oform").addEventListener("submit", async (e) => { e.preventDefault(); await api("outreach/" + o.id, "PATCH", Object.fromEntries(new FormData(e.target).entries())); state.outreach = null; closeDrawer(); renderOutreach(view); });
    }));
  }

  // ---------- templates ----------
  async function renderTemplates(view) {
    if (!state.templates) await loadTemplates();
    view.innerHTML = `<div class="viewhead"><div><h2>Templates</h2><div class="sub">Outreach texts with variables. Only templates marked Approved go out.</div></div></div>
      ${state.templates.map((t) => `<form class="tpl" data-id="${h(t.id)}"><div><div class="eyebrow">Step ${h(t.step)} · ${h(t.channel)}${t.limit_ && t.limit_ !== "–" ? " · " + h(t.limit_) : ""}</div><h3 style="margin:4px 0 8px">${h(t.id)}</h3>
        <label><span class="lbl">Text</span><textarea name="text" rows="4">${h(t.text)}</textarea></label><p class="muted" style="margin:6px 0 0;font-size:12.5px">When: ${h(t.when_)} · Variables: ${h(t.variables)}</p></div>
        <div class="meta"><label><span class="lbl">Approved</span><select name="approved">${["", "Yes", "No", "Edit"].map((o) => `<option value="${o}" ${o === (t.approved || "") ? "selected" : ""}>${o || "not yet"}</option>`).join("")}</select></label>
        <label><span class="lbl">Notes</span><input name="notes" value="${h(t.notes)}"></label><div class="formfoot"><span class="saved"></span><button type="submit" class="btn">Save</button></div><span class="muted mono">${h(t.version)}</span></div></form>`).join("")}`;
    view.querySelectorAll("form.tpl").forEach((f) => f.addEventListener("submit", async (e) => {
      e.preventDefault(); await api("templates/" + f.dataset.id, "PATCH", Object.fromEntries(new FormData(f).entries())); $(".saved", f).textContent = "Saved"; state.templates = null;
    }));
  }

  // ---------- checklists ----------
  function renderChecklists(view) {
    const b = state.boot, steps = b.steps, total = steps.length;
    const doneSet = new Set(b.ticks.filter((t) => t.done).map((t) => t.role_id + "~" + t.step_id));
    const tickOf = (rid, sid) => b.ticks.find((t) => t.role_id === rid && t.step_id === sid);
    const count = (rid) => steps.filter((s) => doneSet.has(rid + "~" + s.id)).length;
    if (!state.role || !roles().find((r) => r.id === state.role)) state.role = store.get("studio-role") && roles().find((r) => r.id === store.get("studio-role")) ? store.get("studio-role") : (roles()[0] || {}).id;
    const role = roles().find((r) => r.id === state.role);
    const notes = {}; b.role_steps.forEach((rs) => { notes[rs.role_id + "~" + rs.step_id] = rs; });
    const phases = []; steps.forEach((s) => { let p = phases.find((x) => x.key === s.phase); if (!p) { p = { key: s.phase, title: s.phase_title, steps: [] }; phases.push(p); } p.steps.push(s); });
    view.innerHTML = `<div class="viewhead"><div><h2>Checklists</h2><div class="sub">The ${total} steps every search follows, one list per role</div></div><button type="button" class="btn" id="newsearch">New search</button></div>
      <div class="cards">${roles().map((r) => `<button type="button" class="rcard" data-role="${h(r.id)}" aria-pressed="${r.id === state.role}"><span class="pill ${r.state === "live" ? "ok" : r.state === "pool" ? "warn" : ""}">${h(r.state === "live" ? "Live" : r.state === "pool" ? "Quiet pool" : r.state || "planned")}</span><span class="cname">${h(r.short)}</span><span class="muted" style="font-size:12.5px">Owner · ${h(r.owner || "–")}</span><span class="bar"><span style="width:${Math.round(100 * count(r.id) / total)}%"></span></span><span class="mono muted"><b style="color:var(--ink);font-weight:500">${count(r.id)}</b> / ${total}</span></button>`).join("")}</div>
      ${role ? `<div class="rolebar"><div class="rtabs">${roles().map((r) => `<button type="button" class="rtab" data-role="${h(r.id)}" aria-pressed="${r.id === state.role}">${h(r.short)}<b>${count(r.id)}</b></button>`).join("")}</div>
        <div class="filters">${["all", "open", "done"].map((f) => `<button type="button" data-filter="${f}" aria-pressed="${state.filter === f}">${f[0].toUpperCase() + f.slice(1)}</button>`).join("")}</div></div>
      <section class="role" data-filter="${h(state.filter)}"><div class="rolehead"><div><span class="eyebrow">Owner · ${h(role.owner || "–")}</span><h2>${h(role.name)}</h2><p class="muted">${h(role.status)} <button type="button" class="edit" id="editrole">edit</button></p></div><div class="rolestat"><span class="big">${count(role.id)}</span><span class="muted">of ${total} steps done</span></div></div><div class="bar"><span style="width:${Math.round(100 * count(role.id) / total)}%"></span></div>
      ${phases.map((p) => `<div class="phase"><h3>${h(p.title)} <span>${p.steps.filter((s) => doneSet.has(role.id + "~" + s.id)).length} / ${p.steps.length}</span></h3><ul class="steps">
        ${p.steps.map((s) => { const key = role.id + "~" + s.id, done = doneSet.has(key), t = tickOf(role.id, s.id), rs = notes[key] || {}; let links = []; try { links = JSON.parse(rs.links || "[]"); } catch (e) {}
          return `<li class="step ${done ? "done" : ""}"><input type="checkbox" class="tick" id="t-${h(key)}" data-key="${h(key)}" ${done ? "checked" : ""}><div class="stepbody"><label for="t-${h(key)}" class="stitle">${h(s.title)}</label>
            <p class="snote" data-note="${h(key)}">${h(rs.note || "")}<button type="button" class="edit" data-editnote="${h(key)}">${rs.note ? "edit" : "add a note"}</button></p>
            ${links.length ? `<div class="chips">${links.map((l) => l.target.startsWith("doc:") ? `<button type="button" class="chip link" data-doc="${h(l.target.slice(4))}">${h(l.label)}</button>` : `<a class="chip link" href="${h(l.target.startsWith("art:") ? "https://claude.ai/artifact/" + l.target.slice(4) : l.target)}" target="_blank" rel="noopener">${h(l.label)}</a>`).join("")}</div>` : ""}
            <details class="what"><summary>What this step means</summary><p>${h(s.what)}</p></details>
            <span class="smeta">${done && t ? "Done " + fmt(t.at) + " · by " + h(whoName(t.by)) : ""}</span></div></li>`; }).join("")}</ul></div>`).join("")}</section>` : '<div class="empty">No searches yet. Start one with "New search".</div>'}`;
    view.querySelectorAll("[data-role]").forEach((el) => el.addEventListener("click", () => { state.role = el.dataset.role; store.set("studio-role", state.role); renderChecklists(view); }));
    view.querySelectorAll(".filters button").forEach((el) => el.addEventListener("click", () => { state.filter = el.dataset.filter; renderChecklists(view); }));
    view.querySelectorAll("input.tick").forEach((cb) => cb.addEventListener("change", async () => {
      const [rid, sid] = cb.dataset.key.split("~"); cb.disabled = true;
      await api(`roles/${rid}/steps/${sid}/tick`, "PATCH", { done: cb.checked }); state.boot = null; await loadBoot(); renderChecklists(view);
    }));
    view.querySelectorAll("[data-editnote]").forEach((btn) => btn.addEventListener("click", () => {
      const key = btn.dataset.editnote, p = view.querySelector(`[data-note="${CSS.escape(key)}"]`), cur = (notes[key] || {}).note || "";
      p.innerHTML = `<textarea rows="3" style="margin:4px 0">${h(cur)}</textarea><div class="formfoot"><button type="button" class="btn ghost small" data-cancel>Cancel</button><button type="button" class="btn small" data-save>Save note</button></div>`;
      $("[data-cancel]", p).addEventListener("click", () => renderChecklists(view));
      $("[data-save]", p).addEventListener("click", async () => { const [rid, sid] = key.split("~"); await api(`roles/${rid}/steps/${sid}`, "PATCH", { note: $("textarea", p).value }); state.boot = null; await loadBoot(); renderChecklists(view); });
    }));
    view.querySelectorAll("[data-doc]").forEach((b) => b.addEventListener("click", () => openDoc(b.dataset.doc)));
    $("#newsearch", view).addEventListener("click", () => {
      openDrawer("New search", `<form class="form" id="rform"><label class="full"><span class="lbl">Role name</span><input name="name" required placeholder="Technical Designer"></label><label><span class="lbl">Short name</span><input name="short" placeholder="TD"></label><label><span class="lbl">Owner</span><input name="owner" placeholder="Kostya"></label>
        <label><span class="lbl">State</span><select name="state"><option value="planned">Planned</option><option value="live">Live</option><option value="pool">Quiet pool</option></select></label><label class="full"><span class="lbl">Status line</span><input name="status" placeholder="Opens when the first TA Manager round is hired"></label>
        <div class="formfoot full"><button type="submit" class="btn">Create the checklist</button></div></form>`);
      $("#rform").addEventListener("submit", async (e) => { e.preventDefault(); const r = await api("roles", "POST", Object.fromEntries(new FormData(e.target).entries())); state.role = r.id; store.set("studio-role", r.id); state.boot = null; closeDrawer(); await loadBoot(); renderChecklists(view); });
    });
    const er = $("#editrole", view); if (er) er.addEventListener("click", () => {
      openDrawer("Edit search", `<form class="form" id="rform"><label class="full"><span class="lbl">Role name</span><input name="name" value="${h(role.name)}"></label><label><span class="lbl">Short name</span><input name="short" value="${h(role.short)}"></label><label><span class="lbl">Owner</span><input name="owner" value="${h(role.owner)}"></label>
        <label><span class="lbl">State</span><select name="state">${["planned", "live", "pool", "closed"].map((o) => `<option value="${o}" ${o === role.state ? "selected" : ""}>${o}</option>`).join("")}</select></label><label class="full"><span class="lbl">Status line</span><input name="status" value="${h(role.status)}"></label>
        <div class="formfoot full"><button type="submit" class="btn">Save</button></div></form>`);
      $("#rform").addEventListener("submit", async (e) => { e.preventDefault(); await api("roles/" + role.id, "PATCH", Object.fromEntries(new FormData(e.target).entries())); state.boot = null; closeDrawer(); await loadBoot(); renderChecklists(view); });
    });
  }

  // ---------- This week and Posts: the launch kit, rendered by the checklist builder and synced as documents ----------
  async function renderDocView(view, slug) {
    const d = await api("docs/" + slug);
    view.innerHTML = `<section class="kit ${slug}">${d.html || "<p class='muted'>Not synced yet.</p>"}</section>`;
    const done = state.boot.ticks.filter((t) => t.done).length, total = state.boot.steps.length * state.boot.roles.length;
    view.querySelectorAll('[data-count="all"]').forEach((e) => { e.textContent = done; });
    view.querySelectorAll(".kpi b").forEach((b) => { if (/\/ 140$/.test(b.textContent)) b.innerHTML = `${done} / ${total}`; });
    view.querySelectorAll('a[href="#posts"]').forEach((a) => { a.removeAttribute("target"); a.addEventListener("click", (e) => { e.preventDefault(); setView("posts"); window.scrollTo(0, 0); }); });
    view.querySelectorAll("pre").forEach((pre) => {
      const box = document.createElement("div"); box.className = "post";
      const bar = document.createElement("div"); bar.className = "postbar";
      const lab = document.createElement("span"); lab.className = "label"; lab.textContent = pre.textContent.trim().split("\n")[0].slice(0, 48);
      const btn = document.createElement("button"); btn.className = "copy"; btn.type = "button"; btn.textContent = "Copy";
      btn.addEventListener("click", () => {
        const t = pre.textContent.replace(/\n$/, "");
        const ok = () => { btn.textContent = "Copied"; btn.classList.add("done"); setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("done"); }, 1600); };
        const pick = () => { const r = document.createRange(); r.selectNodeContents(pre); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); btn.textContent = "Selected: press ⌘C"; };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(ok, pick); else pick();
      });
      pre.parentNode.insertBefore(box, pre); bar.appendChild(lab); bar.appendChild(btn); box.appendChild(bar); box.appendChild(pre);
    });
  }

  // ---------- activity ----------
  async function renderActivity(view) {
    const rows = await api("activity?limit=200");
    view.innerHTML = `<div class="viewhead"><div><h2>Activity</h2><div class="sub">Every change, newest first</div></div></div>
      <div class="act">${rows.map((a) => `<div><span class="mono muted">${h(new Date(a.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}</span><span>${h(a.who)}</span><span>${h(a.summary)}</span></div>`).join("") || '<div class="empty">Nothing yet.</div>'}</div>`;
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

  const start = (location.hash || "").slice(1) || store.get("studio-view") || "checklists";
  setView(["checklists", "week", "posts", "pipeline", "candidates", "outreach", "templates", "activity"].includes(start) ? start : "checklists");
})();
