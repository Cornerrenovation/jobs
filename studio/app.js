/* Corner Studio: the hiring CRM. Talks to /studio/api (a Worker on D1); Cloudflare Access has already signed the viewer in.
   One visual language throughout, taken from the Checklists view: greige cards, mono eyebrows, segmented controls, quiet buttons. */
(function () {
  "use strict";
  const API = "/studio/api/";
  const $ = (s, el) => (el || document).querySelector(s);
  const h = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const today = () => new Date().toISOString().slice(0, 10);
  // a date without a time is a calendar day: read it at local noon, or UTC midnight shows as the day before west of Greenwich
  const fmt = (iso) => { if (!iso) return ""; const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + "T12:00:00" : iso); return isNaN(d) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
  const fmtTime = (iso) => { const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); };
  const STAGES = ["applied", "triaged", "confirmed", "messaged", "replied", "screen booked", "screen done", "interview booked", "interview done",
    "work sample", "references", "offer", "hired", "declined", "not now", "pool R1"];
  const FUNNEL = [["Applied", ["applied"]], ["Triaged", ["triaged"]], ["Shortlisted", ["confirmed"]], ["Messaged", ["messaged"]], ["Replied", ["replied"]],
    ["Screen call", ["screen booked", "screen done"]], ["Interview", ["interview booked", "interview done"]], ["Work sample", ["work sample"]],
    ["References", ["references"]], ["Offer", ["offer"]], ["Hired", ["hired"]]];
  const CLOSED = ["declined", "not now", "pool R1"];
  const CALLS = ["", "Shortlist", "Hold", "Decline"];
  // The funnel order the Worker keeps "reached" in: the furthest stage a candidate got to, even after they were closed.
  const ORDER = ["applied", "triaged", "confirmed", "messaged", "replied", "screen booked", "screen done", "interview booked", "interview done",
    "work sample", "references", "offer", "hired"];
  const STAGE_LABEL = { confirmed: "shortlisted" };
  const VIEWS = ["week", "checklists", "pipeline", "candidates", "outreach", "templates", "activity", "posts"];
  const whoName = (by) => !by ? "" : by === "claude" || /\.access$/.test(by) || /^u_/.test(by) ? "Claude" : by.replace(/@.*/, "").replace(/^\w/, (c) => c.toUpperCase());
  const state = { view: "week", boot: null, roleFilter: "all", role: null, filter: "all", candidates: null, results: null, outreach: null, templates: null, search: "", open: {},
    showClosed: false, justCreated: null };
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
  const roleOf = (id) => roles().find((r) => r.id === id) || { id, short: id, name: id };
  const roleName = (id) => roleOf(id).short || id;
  const isClosedRole = (r) => (r || {}).state === "closed";
  const openRoles = () => roles().filter((r) => !isClosedRole(r));
  const familyOf = (r) => (r && (r.family || r.id)) || "";
  const leadOf = (r) => (r && (r.lead || r.owner)) || "the hiring lead";
  async function loadCandidates() { [state.candidates, state.results] = await Promise.all([api("candidates"), api("criteria/results")]); }

  // ---------- shared candidate logic ----------
  const stageIdx = (s) => ORDER.indexOf(s || "");
  const reachedIdx = (c) => Math.max(stageIdx(c.stage || "applied"), stageIdx(c.reached));
  const reachedOf = (c) => ORDER[reachedIdx(c)] || "applied";
  const stageWord = (s) => STAGE_LABEL[s] || s || "applied";
  // Passed at least one stage: shortlisted (Your call) or got as far as the shortlist or further, in any round.
  const passedStage = (c) => c.your_call === "Shortlist" || reachedIdx(c) >= stageIdx("confirmed");
  const sourceOf = (c) => (c.referred_by || "").trim() ? "Referral" : ((c.sources || "").split(/[,;·]/)[0].trim() || "Not recorded");
  const samePerson = (a, b) => (a.linkedin && b.linkedin && a.linkedin.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase() === b.linkedin.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase())
    || (a.email && b.email && a.email.trim().toLowerCase() === b.email.trim().toLowerCase()) || (!a.linkedin && !a.email && a.name && a.name.trim().toLowerCase() === (b.name || "").trim().toLowerCase());
  function criteriaFor(roleId) {
    const all = state.boot.criteria || [], own = all.filter((k) => k.role_id === roleId);
    return own.length ? own : all.filter((k) => k.role_id === familyOf(roleOf(roleId)));
  }
  const resultsFor = (cid) => (state.results || []).filter((x) => x.candidate_id === cid);
  function matchSummary(c) {
    const res = resultsFor(c.id), n = { met: 0, "not met": 0, unclear: 0 };
    res.forEach((x) => { if (x.result in n) n[x.result]++; });
    return res.length ? `${n.met} met · ${n["not met"]} not met · ${n.unclear} unclear` : "";
  }
  // First-three calibration: the first three a role sends to its hiring lead wait for a yes or no with a reason before more go.
  function calibration(roleId) {
    const sent = (state.candidates || []).filter((c) => c.role_id === roleId && c.sent_to_lead).sort((a, b) => (a.sent_to_lead + a.id).localeCompare(b.sent_to_lead + b.id));
    const first = sent.slice(0, 3), answered = first.filter((c) => c.lead_call && (c.lead_reason || "").trim()).length;
    return { sent, first, answered, open: first.length < 3 || answered === 3, done: first.length === 3 && answered === 3 };
  }
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
      else if (state.view === "checklists") await renderChecklists(view);
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
  const roleSeg = () => seg("role", [["all", "All roles"]].concat(openRoles().map((r) => [r.id, r.short]), roles().some(isClosedRole) ? [["closed", "Earlier rounds"]] : []), state.roleFilter);
  const inRole = (c) => state.roleFilter === "all" || c.role_id === state.roleFilter || (state.roleFilter === "closed" && isClosedRole(roleOf(c.role_id)));
  const pill = (text, kind) => text ? `<span class="pill ${kind || ""}" title="${h(text)}">${h(text)}</span>` : "";
  const callPill = (c) => pill(c, c === "Shortlist" ? "ok" : c === "Decline" ? "bad" : c ? "warn" : "");
  const table = (cols, rows) => `<div class="tablewrap"><table><thead><tr>${cols.map((c) => `<th>${h(c)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;

  // ---------- This week and Posts: the launch kit, rendered by the checklist builder and synced as documents ----------
  async function renderDocView(view, slug) {
    const d = await api("docs/" + slug);
    const back = slug === "posts" ? `<p class="crumbs"><button type="button" class="linkbtn" data-back="checklists">← Checklists</button><span class="muted"> · </span><button type="button" class="linkbtn" data-back="week">This week</button></p>` : "";
    view.innerHTML = `${back}${slug === "posts" ? head("Posts", "Every text here is ready to paste. Settings for LinkedIn and Work.ua are folded under each post.") : ""}<section class="kit ${slug}">${d.html || "<p class='muted'>Not synced yet.</p>"}</section>`;
    const strip = view.querySelector("[data-live-strip]");
    if (strip) {
      if (!state.candidates) await loadCandidates();
      if (!state.outreach) await loadOutreach();
      const t = today(), cands = state.candidates.filter((c) => !isClosedRole(roleOf(c.role_id)));
      const tiles = [[roles().filter((r) => ["live", "pool"].includes(r.state)).length, "roles on the jobs site"], [cands.length, "applications so far"],
        [cands.filter((c) => (c.applied || c.created_at || "").slice(0, 10) === t).length, "new applicants today, all sources"],
        [cands.filter((c) => c.your_call === "Shortlist").length, "shortlisted so far"],
        [state.outreach.filter((o) => (o.status || "queued").startsWith("queued")).length, "queued for LinkedIn outreach"]];
      strip.innerHTML = tiles.map(([v, l]) => `<div class="kpi"><b>${h(v)}</b><span>${h(l)}</span></div>`).join("");
    }
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
    const list = state.candidates.filter(inRole);
    const isClosed = (c) => CLOSED.includes(c.stage) || isClosedRole(roleOf(c.role_id));  // an earlier round is closed as a whole
    const active = list.filter((c) => !isClosed(c));
    const closed = list.filter(isClosed);
    const idx = (c) => { const i = FUNNEL.findIndex(([, st]) => st.includes(c.stage || "applied")); return i < 0 ? 0 : i; };
    const reached = FUNNEL.map((_, i) => active.filter((c) => idx(c) >= i));
    const applied = reached[0].length, top = applied || 1;
    const pct = (a, b) => (b ? Math.round(100 * a / b) + "%" : "–");
    // the bottleneck is the weakest step among stages with at least 5 people entering it
    let bottleneck = null;
    FUNNEL.forEach((_, i) => { if (i && reached[i - 1].length >= 5) { const r = reached[i].length / reached[i - 1].length; if (!bottleneck || r < bottleneck.r) bottleneck = { i, r }; } });
    // Interview rate: of the shortlisted candidates sent to the hiring lead, the share the lead agreed to interview (yes ÷ answered).
    const sent = list.filter((c) => c.sent_to_lead), yes = sent.filter((c) => c.lead_call === "Interview").length, no = sent.filter((c) => c.lead_call === "No").length;
    const waiting = sent.length - yes - no, rate = yes + no ? Math.round(100 * yes / (yes + no)) + "%" : "–";
    const leadRow = `<div class="stage leadrow"><div class="stagerow static"><span class="sname">Lead agreed to interview<small>${sent.length ? `${sent.length} of ${list.filter((c) => c.your_call === "Shortlist").length} shortlisted sent to the lead` : "nobody sent to the lead yet"}</small></span>
        <span class="sbar"><span style="width:${yes + no ? Math.round(100 * yes / (yes + no)) : 0}%"></span></span>
        <span class="snum">${yes}<small>${yes + no} answered</small></span>
        <span class="sconv"><b>${rate}</b><small>interview rate${waiting ? ` · ${waiting} waiting` : ""}</small></span></div></div>`;
    const rows = FUNNEL.map(([title], i) => {
      const n = reached[i].length, prev = i ? reached[i - 1].length : null, here = active.filter((c) => idx(c) === i);
      const open = !!state.open[title];
      return `<div class="stage ${open ? "open" : ""} ${bottleneck && bottleneck.i === i ? "weak" : ""}">
        <button type="button" class="stagerow" data-toggle="${h(title)}" aria-expanded="${open}">
          <span class="sname">${h(title)}<small>${here.length ? `${here.length} here now` : "nobody here now"}</small></span>
          <span class="sbar"><span style="width:${n ? Math.max(2, Math.round(100 * n / top)) : 0}%"></span></span>
          <span class="snum">${n}<small>${i > 1 ? `${pct(n, applied)} of applied` : i === 1 ? "" : "reached"}</small></span>
          <span class="sconv">${i ? `<b>${pct(n, prev)}</b><small>from ${h(FUNNEL[i - 1][0].toLowerCase())}</small>` : ""}${bottleneck && bottleneck.i === i ? pill("weakest step", "warn") : ""}</span>
        </button>
        ${open ? `<div class="stagelist">${here.length ? here.map((c) => `<button type="button" class="srow" data-id="${h(c.id)}"><span class="name">${h(c.name)}</span><span class="muted">${h(roleName(c.role_id))}${c.sources ? " · " + h(c.sources) : ""}</span>${callPill(c.your_call)}${c.due ? `<span class="muted">due ${h(fmt(c.due))}</span>` : ""}<span class="pill">${h(c.stage)}</span></button>`).join("") : `<p class="muted">Nobody at this stage right now.</p>`}</div>` : ""}
      </div>${title === "Shortlisted" ? leadRow : ""}`;
    }).join("");
    const strip = [[active.length, "active candidates"], [closed.length, "closed"], [pct(reached[FUNNEL.length - 1].length, applied), "applied to hired"],
      [rate, yes + no ? `interview rate (${yes} of ${yes + no} the lead answered)` : "interview rate (no answers yet)"],
      [bottleneck ? FUNNEL[bottleneck.i][0] : "–", bottleneck ? "weakest step" : "weakest step (needs 5+ per stage)"]];
    // Per role: the hiring lead's answers and where the first-three calibration stands
    const leadRoles = (state.roleFilter === "all" ? openRoles() : state.roleFilter === "closed" ? roles().filter(isClosedRole) : [roleOf(state.roleFilter)]);
    const leadTable = table(["Role", "Hiring lead", "Shortlisted", "Sent", "Interview", "No", "Waiting", "Interview rate", "First three"], leadRoles.map((r) => {
      const mine = list.filter((c) => c.role_id === r.id), cal = calibration(r.id), y = mine.filter((c) => c.lead_call === "Interview").length, nn = mine.filter((c) => c.lead_call === "No").length;
      const firstThree = cal.done ? pill("calibrated", "ok") : !cal.first.length ? '<span class="muted">none sent yet</span>'
        : pill(`${cal.answered} of 3 answered`, "warn") + (cal.first.length < 3 ? ` <span class="muted">${cal.first.length} sent</span>` : "");
      return `<tr><td>${h(r.short)}</td><td>${h(leadOf(r))}</td><td>${mine.filter((c) => c.your_call === "Shortlist").length}</td><td>${cal.sent.length}</td><td>${y}</td><td>${nn}</td><td>${cal.sent.length - y - nn}</td><td>${y + nn ? Math.round(100 * y / (y + nn)) + "%" : "–"}</td><td>${firstThree}</td></tr>`;
    }));
    // Source of hire: everyone by the furthest stage they reached, closed candidates included; a referral counts as Referral
    const bySource = {}; list.forEach((c) => { (bySource[sourceOf(c)] = bySource[sourceOf(c)] || []).push(c); });
    const atLeast = (cs, st) => cs.filter((c) => reachedIdx(c) >= stageIdx(st)).length;
    const hiredAll = atLeast(list, "hired");
    const sourceTable = table(["Source", "Candidates", "Shortlisted", "Lead said interview", "Interviewed", "Hired", "Share of hires"], Object.entries(bySource).sort((a, b) => atLeast(b[1], "hired") - atLeast(a[1], "hired") || b[1].length - a[1].length).map(([src, cs]) =>
      `<tr><td>${h(src)}</td><td>${cs.length}</td><td>${cs.filter(passedStage).length}</td><td>${cs.filter((c) => c.lead_call === "Interview").length}</td><td>${atLeast(cs, "interview booked")}</td><td>${atLeast(cs, "hired")}</td><td>${hiredAll ? Math.round(100 * atLeast(cs, "hired") / hiredAll) + "%" : "–"}</td></tr>`));
    const referred = list.filter((c) => (c.referred_by || "").trim());
    const bountyTable = referred.length ? table(["Candidate", "Role", "Referred by", "Stage", "Hired on", "Bounty", "Bounty due"], referred.map((c) =>
      `<tr class="clickable" data-id="${h(c.id)}"><td><span class="name">${h(c.name)}</span></td><td>${h(roleName(c.role_id))}</td><td>${h(c.referred_by)}</td><td>${pill(c.stage || "applied")}</td><td>${h(fmt(c.hired_at))}</td><td>${c.bounty ? h(c.bounty) : '<span class="muted">not set yet</span>'}</td><td>${c.bounty_due ? (c.bounty_due <= today() ? `<b>${h(fmt(c.bounty_due))} · due</b>` : h(fmt(c.bounty_due))) : '<span class="muted">at hire + 90 days</span>'}</td></tr>`)) : "";
    view.innerHTML = head("Pipeline", "Each stage counts everyone who reached it or went further. Closed candidates sit in their own row and don't count against the conversions. Click a stage to see who is there now.", roleSeg()) +
      `<div class="strip">${strip.map(([v, t]) => `<div class="kpi"><b>${h(v)}</b><span>${h(t)}</span></div>`).join("")}</div>
      <div class="funnel">${rows}
      <div class="stage closedrow"><button type="button" class="stagerow" data-toggle="Closed" aria-expanded="${!!state.open.Closed}"><span class="sname">Closed<small>declined, not now, pool, earlier rounds</small></span><span class="sbar"></span><span class="snum">${closed.length}</span><span class="sconv"></span></button>
        ${state.open.Closed ? `<div class="stagelist">${closed.length ? closed.map((c) => `<button type="button" class="srow" data-id="${h(c.id)}"><span class="name">${h(c.name)}</span><span class="muted">${h(roleName(c.role_id))}</span><span class="pill">${h(isClosedRole(roleOf(c.role_id)) && !CLOSED.includes(c.stage) ? "got to " + stageWord(c.stage) : c.stage)}</span></button>`).join("") : '<p class="muted">Nobody closed yet.</p>'}</div>` : ""}</div></div>
      ${list.length ? "" : `<p class="muted">No candidates yet. They arrive from the jobs site, LinkedIn and Work.ua through the daily check-in, or you add one under Candidates.</p>`}
      <div class="group"><span class="eyebrow">Hiring lead: interview rate and the first three</span>${leadTable}
        <p class="muted small">Interview rate is the lead's "Interview" answers divided by all their answers; candidates still waiting are left out until answered. Each role's first three sent to the lead wait for a yes or no with a reason before a fourth can go.</p></div>
      <div class="group"><span class="eyebrow">Source of hire</span>${sourceTable}
        <p class="muted small">Counts everyone by the furthest stage they reached, closed candidates included. Source is the first channel in Sources; anyone with "Referred by" filled counts as Referral.</p></div>
      ${bountyTable ? `<div class="group"><span class="eyebrow">Referrals and bounties</span>${bountyTable}<p class="muted small">The bounty is due 90 days after the hire. Kostya sets the amount on each referred candidate.</p></div>` : ""}`;
    bindSeg(view, "role", (v) => { state.roleFilter = v; renderPipeline(view); });
    view.querySelectorAll("tr.clickable").forEach((tr) => tr.addEventListener("click", () => openCandidate(tr.dataset.id)));
    view.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => { state.open[b.dataset.toggle] = !state.open[b.dataset.toggle]; renderPipeline(view); }));
    view.querySelectorAll(".srow").forEach((b) => b.addEventListener("click", () => openCandidate(b.dataset.id)));
  }

  // ---------- candidates ----------
  async function renderCandidates(view) {
    if (!state.candidates) await loadCandidates();
    const q = state.search.trim().toLowerCase();
    const list = state.candidates.filter((c) => inRole(c) &&
      (!q || [c.name, c.headline, c.location, c.sources, c.email, c.stage, c.your_call, c.agent_call].join(" ").toLowerCase().includes(q)));
    view.innerHTML = head("Candidates", `${list.length} of ${state.candidates.length}`, `<button type="button" class="btn" id="add">Add candidate</button>`) +
      `<div class="toolbar"><input type="search" id="q" placeholder="Search name, headline, source, stage" value="${h(state.search)}">${roleSeg()}</div>
      ${list.length ? table(["Name", "Role", "Source", "Applied", "Agent call", "Your call", "Stage", "Next step", "Due"],
        list.map((c) => `<tr class="clickable" data-id="${h(c.id)}"><td><span class="name">${h(c.name)}</span><br><span class="muted">${h(c.headline || c.location || "")}</span></td><td>${h(roleName(c.role_id))}</td><td>${h(c.sources)}${c.referred_by ? `<br><span class="muted">referred by ${h(c.referred_by)}</span>` : ""}</td><td>${h(fmt(c.applied))}</td><td>${h(c.agent_call)}</td><td>${callPill(c.your_call)}</td><td>${pill(c.stage || "applied")}</td><td>${h(c.next_step)}</td><td>${h(fmt(c.due))}</td></tr>`))
        : `<div class="card empty">No candidates yet. They arrive from the jobs site, LinkedIn and Work.ua through the daily check-in, or add one by hand.</div>`}`;
    const qel = $("#q", view);
    qel.addEventListener("input", (e) => { state.search = e.target.value; renderCandidates(view); qel.focus(); });
    if (q) { qel.focus(); qel.setSelectionRange(qel.value.length, qel.value.length); }
    bindSeg(view, "role", (v) => { state.roleFilter = v; renderCandidates(view); });
    view.querySelectorAll("tr.clickable").forEach((tr) => tr.addEventListener("click", () => openCandidate(tr.dataset.id)));
    $("#add", view).addEventListener("click", () => openCandidate(null));
  }
  // ---------- the candidate record: a pop-up with three blocks ----------
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return u; } };
  function linkChip(u, forcedLabel) {
    const host = hostOf(u);
    const label = forcedLabel || (/linkedin\.com/.test(host) ? "LinkedIn" : /drive\.google\.com|docs\.google\.com/.test(host) ? "CV · in hello@'s Drive" : /instagram\.com/.test(host) ? "Instagram · " + (u.match(/instagram\.com\/([^/?]+)/) || [])[1] : /behance|dribbble|framer|notion|figma|vimeo|youtube/.test(host) ? host : host);
    return `<a class="chip link" href="${h(u)}" target="_blank" rel="noopener" title="${h(u)}">${h(label)} ↗</a>`;
  }
  const urlsIn = (text) => (String(text || "").match(/https?:\/\/[^\s,;]+/g) || []);
  const kindOf = (d, r) => d.kind === "knockout" ? (r.result === "met" ? ["passes", "ok"] : r.result === "not met" ? ["fails", "bad"] : ["unclear", "warn"])
    : d.kind === "minus" ? (r.result === "met" ? ["red flag", "bad"] : r.result === "not met" ? ["no", ""] : ["unclear", "warn"])
    : (r.result === "met" ? ["yes", "ok"] : r.result === "not met" ? ["no", ""] : ["unclear", "warn"]);
  function readBlock(c) {
    const defs = criteriaFor(c.role_id), res = resultsFor(c.id);
    const row = (d) => { const r = res.find((x) => x.criterion_id === d.id); if (!r) return `<li class="crow"><span class="pill">not checked</span><div class="cbody"><span class="clabel">${h(d.label)}</span></div></li>`;
      const [word, kind] = kindOf(d, r); return `<li class="crow"><span class="pill ${kind}">${h(word)}</span><div class="cbody"><span class="clabel">${h(d.label)}</span>${r.evidence ? `<span class="ev">${h(r.evidence)}</span>` : ""}${r.field ? `<span class="cmeta">From ${h(r.field)}</span>` : ""}</div></li>`; };
    const ko = defs.filter((d) => d.kind === "knockout"), plus = defs.filter((d) => d.kind === "plus"), minus = defs.filter((d) => d.kind === "minus"), other = defs.filter((d) => !["knockout", "plus", "minus"].includes(d.kind));
    const count = (list, pred) => list.filter((d) => { const r = res.find((x) => x.criterion_id === d.id); return r && pred(r); }).length;
    const last = res.slice().sort((a, b) => (b.at || "").localeCompare(a.at || ""))[0];
    const head = c.agent_call ? `<div class="readhead"><div><span class="eyebrow">2 · Claude's read</span><h3>${h(c.agent_call)}${c.confidence ? ` <span class="muted">· ${h(c.confidence.toLowerCase())} confidence</span>` : ""}</h3></div><span class="cmeta">${h(c.rules_version || (last && last.rules_version) || "")}${last ? ` · ${h(fmt(last.at))}` : ""}</span></div>`
      : `<div class="readhead"><div><span class="eyebrow">2 · Claude's read</span><h3 class="muted">Not read yet</h3></div></div>`;
    if (!c.agent_call && !res.length) return `<section class="block">${head}<p class="muted">The next robot run reads the application against the ${h(roleName(c.role_id))} scorecard: completeness, knockouts, markers, then a proposal.</p></section>`;
    return `<section class="block read">${head}
      ${c.why ? `<p class="why">${h(c.why)}</p>` : ""}
      ${ko.length ? `<div class="critgroup"><span class="lbl">Knockouts · ${count(ko, (r) => r.result === "not met")} failed of ${ko.length}</span><ul class="critlist">${ko.map(row).join("")}</ul></div>` : ""}
      ${plus.length ? `<div class="critgroup"><span class="lbl">Markers for · ${count(plus, (r) => r.result === "met")} of ${plus.length}</span><ul class="critlist">${plus.map(row).join("")}</ul></div>` : ""}
      ${minus.length ? `<div class="critgroup"><span class="lbl">Red flags · ${count(minus, (r) => r.result === "met")} of ${minus.length}</span><ul class="critlist">${minus.map(row).join("")}</ul></div>` : ""}
      ${other.length ? `<div class="critgroup"><span class="lbl">Criteria</span><ul class="critlist">${other.map(row).join("")}</ul></div>` : ""}
      ${c.doubt ? `<div class="kvline"><span class="lbl">Doubt to probe</span><span>${h(c.doubt)}</span></div>` : ""}
      <p class="muted small">Claude's reading of what she or he sent, against the scorecard, with the words it rests on. It informs your call; nobody is declined on it.</p></section>`;
  }
  function openCandidate(id) {
    const c = id ? state.candidates.find((x) => x.id === id) : { stage: "applied", role_id: state.roleFilter !== "all" && state.roleFilter !== "closed" ? state.roleFilter : (openRoles()[0] || {}).id };
    const sel = (name, opts, val, labels) => `<select name="${name}">${opts.map((o, i) => `<option value="${h(o)}" ${o === (val || "") ? "selected" : ""}>${h(labels ? labels[i] : (o || "–"))}</option>`).join("")}</select>`;
    const kv = (k, v) => v ? `<dt>${h(k)}</dt><dd>${h(v)}</dd>` : "";
    const role = roleOf(c.role_id), lead = leadOf(role);
    const furthest = id && reachedIdx(c) > stageIdx(c.stage || "applied") ? stageWord(reachedOf(c)) : "";
    const links = [];
    if (c.linkedin) links.push(linkChip(c.linkedin, "LinkedIn"));
    urlsIn(c.cv).forEach((u) => links.push(linkChip(u)));
    const eyebrow = id ? [c.id, roleName(c.role_id) + (isClosedRole(role) ? " (earlier round)" : ""), c.sources, c.applied ? "applied " + fmt(c.applied) : ""].filter(Boolean).join(" · ") : roleName(c.role_id);
    const application = id ? `<section class="block"><span class="eyebrow">1 · From the application</span>
        <dl class="kv">${kv("Location", c.location)}${kv("Email", c.email)}${kv("English, self-rated", c.english)}${kv("Headline", c.headline)}${kv("Referred by", c.referred_by)}${kv("Screening answers", c.screening)}${kv("Furthest stage", furthest)}${kv("Scores", c.scores)}${kv("Latest reply", c.latest_reply)}${kv("Last contact", c.last_contact)}</dl>
        ${links.length ? `<div class="links"><span class="lbl">Links she or he gave</span><div class="chips">${links.join("")}</div>${/drive\.google\.com/.test(c.cv || "") ? `<span class="muted small">The CV sits in hello@'s Drive. If the link asks for access, hello@ needs to share the "Corner Careers — Applications" folder with you once.</span>` : ""}</div>` : ""}
        ${c.site_answer ? `<div class="answer"><span class="lbl">Written answer</span><p>${h(c.site_answer).replace(/\n+/g, "<br>")}</p></div>` : ""}</section>` : "";
    const callSeg = `${seg("yourcall", [["Shortlist", "Shortlist"], ["Hold", "Hold"], ["Decline", "Decline"]], c.your_call || "")}<input type="hidden" name="your_call" value="${h(c.your_call || "")}">`;
    const form = `<section class="block"><span class="eyebrow">${id ? "3 · Your call" : "New candidate"}</span>
      <form class="form" id="cform">
        ${id ? "" : `<label class="full"><span class="lbl">Name</span><input name="name" required></label><label><span class="lbl">Role</span>${sel("role_id", openRoles().map((r) => r.id), c.role_id, openRoles().map((r) => r.short))}</label><label><span class="lbl">Source</span><input name="sources" placeholder="LinkedIn UA, referral…"></label><label class="full"><span class="lbl">LinkedIn</span><input name="linkedin" type="url"></label><label><span class="lbl">Email</span><input name="email" type="email"></label><label><span class="lbl">Location</span><input name="location"></label>`}
        <div class="full callrow"><span class="lbl">Your call</span>${callSeg}${id && c.agent_call ? `<span class="hint">Claude suggests <b>${h(c.agent_call)}</b>. Set yours before reading the block above if you want a blind check.</span>` : ""}</div>
        <label class="full"><span class="lbl">Your reason</span><input name="your_reason" value="${h(c.your_reason)}" placeholder="Needed when you disagree with Claude"></label>
        <label><span class="lbl">Stage</span>${sel("stage", STAGES, c.stage || "applied")}</label>
        <label><span class="lbl">Due</span><input name="due" type="date" value="${h((c.due || "").slice(0, 10))}"></label>
        <label class="full"><span class="lbl">Next step</span><input name="next_step" value="${h(c.next_step)}"></label>
        <details class="fold plain more"><summary>Referral and hire fields</summary><div class="form inner">
          <label><span class="lbl">Referred by</span><input name="referred_by" value="${h(c.referred_by)}" placeholder="Who on the team or in our network"></label>
          <label><span class="lbl">Referral bounty</span><input name="bounty" value="${h(c.bounty)}" placeholder="Blank until Kostya sets it"></label>
          ${id ? `<label><span class="lbl">Hired on</span><input name="hired_at" type="date" value="${h((c.hired_at || "").slice(0, 10))}"></label>
          <div class="fieldnote"><span class="lbl">Bounty due</span><span>${c.bounty_due ? h(fmt(c.bounty_due)) + " · hire + 90 days" : (c.referred_by ? "90 days after the hire date" : "Only for referrals")}</span></div>` : ""}</div></details>
        <label class="full"><span class="lbl">Notes</span><textarea name="notes">${h(c.notes)}</textarea></label>
        <div class="formfoot full"><span class="saved" id="csaved"></span><button type="submit" class="btn">${id ? "Save" : "Add"}</button></div>
      </form>${id ? leadBlock(c, role, lead) : ""}</section>`;
    openRecord(id ? c.name : "New candidate", eyebrow, application + (id ? readBlock(c) : "") + form);
    const f = $("#cform");
    bindSeg(f, "yourcall", (v) => { const cur = $('input[name="your_call"]', f); cur.value = cur.value === v ? "" : v; f.querySelectorAll('[data-seg="yourcall"] button').forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === cur.value)); });
    const refresh = async () => { state.candidates = null; state.boot = null; await loadBoot(); await loadCandidates(); render(); if (id) openCandidate(id); };
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      // Your call moves the stage: a person decided. Decline closes; Shortlist confirms; Hold leaves it.
      if (id && data.your_call !== (c.your_call || "") && ["applied", "triaged", "confirmed", "declined"].includes(data.stage)) {
        if (data.your_call === "Decline") data.stage = "declined";
        else if (data.your_call === "Shortlist") data.stage = "confirmed";
        else if (!data.your_call || data.your_call === "Hold") data.stage = c.agent_call ? "triaged" : "applied";
      }
      if (id) await api("candidates/" + id, "PATCH", data); else await api("candidates", "POST", data);
      if (id) await refresh(); else { state.candidates = null; state.boot = null; await loadBoot(); await loadCandidates(); render(); closeRecord(); }
    });
    const send = $("#sendlead");
    if (send) send.addEventListener("click", async () => { send.disabled = true; try { await api("candidates/" + id, "PATCH", { sent_to_lead: new Date().toISOString() }); await refresh(); } catch (e) { send.disabled = false; } });
    const lf = $("#lform");
    if (lf) {
      bindSeg(lf, "leadcall", (v) => { $('input[name="lead_call"]', lf).value = v; lf.querySelectorAll("[data-seg] button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === v)); });
      lf.addEventListener("submit", async (e) => { e.preventDefault(); await api("candidates/" + id, "PATCH", Object.fromEntries(new FormData(lf).entries())); await refresh(); });
    }
  }
  function openRecord(title, eyebrow, html) {
    const d = $("#recdlg"); $("#rectitle").textContent = title; $("#receyebrow").textContent = eyebrow; $("#recbody").innerHTML = html; $("#recbody").scrollTop = 0;
    if (!d.open) (d.showModal ? d.showModal() : d.setAttribute("open", ""));
  }
  function closeRecord() { const d = $("#recdlg"); if (d.open) d.close(); }
  $("#recclose").addEventListener("click", closeRecord);
  $("#recdlg").addEventListener("click", (e) => { if (e.target === $("#recdlg")) closeRecord(); });
  
  // Criteria match with evidence: Claude's reading against the scorecard, per criterion. It informs "Your call" and never rejects.
  function criteriaBlock(c) {
    const defs = criteriaFor(c.role_id), res = resultsFor(c.id);
    const extra = res.filter((x) => !defs.some((d) => d.id === x.criterion_id)).map((x) => ({ id: x.criterion_id, label: x.criterion_id, kind: "" }));
    const items = defs.concat(extra);
    if (!items.length) return "";
    const kindWord = { knockout: "Knockout", plus: "Plus marker", minus: "Minus marker", scored: "Scored" };
    const counts = { met: 0, "not met": 0, unclear: 0, none: 0 };
    const rows = items.map((d) => {
      const r = res.find((x) => x.criterion_id === d.id);
      counts[r ? r.result : "none"]++;
      // green is good for the candidate: a minus marker that is met is a red flag
      const kind = !r ? "" : r.result === "unclear" ? "warn" : d.kind === "minus" ? (r.result === "met" ? "bad" : "ok")
        : r.result === "met" ? "ok" : d.kind === "knockout" ? "bad" : "";
      return `<li class="crow"><span class="pill ${kind}">${h(r ? r.result : "not checked")}</span><div class="cbody"><span class="clabel">${h(d.label)}${d.kind ? `<span class="ckind">${h(kindWord[d.kind] || d.kind)}</span>` : ""}</span>
        ${r && r.evidence ? `<span class="ev">${h(r.evidence)}</span>` : ""}${r ? `<span class="cmeta">${r.field ? "From " + h(r.field) + " · " : ""}${r.rules_version ? h(r.rules_version) + " · " : ""}${h(whoName(r.by))}, ${h(fmt(r.at))}</span>` : ""}</div></li>`;
    }).join("");
    const src = (defs[0] || {}).source;
    if (!res.length) return `<section class="crit"><details class="fold plain"><summary>Criteria${src ? " · " + h(src) : ""}: not checked yet (${items.length})</summary>
      <ul class="critnames">${items.map((d) => `<li>${h(d.label)}</li>`).join("")}</ul></details><p class="muted small">Claude checks each one against the application, with the words it rests on. It informs your call; nobody is rejected on it.</p></section>`;
    return `<section class="crit"><div class="crithead"><span class="eyebrow">Criteria${src ? " · " + h(src) : ""}</span><span class="muted small">${counts.met} met · ${counts["not met"]} not met · ${counts.unclear} unclear${counts.none ? ` · ${counts.none} not checked` : ""}</span></div>
      <ul class="critlist">${rows}</ul><p class="muted small">Claude's reading of the application against the scorecard, with the words it rests on. It informs your call; nobody is rejected on it.</p></section>`;
  }
  // The hiring lead's yes or no, and the first-three gate
  function leadBlock(c, role, lead) {
    if (c.your_call !== "Shortlist" && !c.sent_to_lead) return "";
    const cal = calibration(c.role_id), pos = cal.first.findIndex((x) => x.id === c.id);
    if (!c.sent_to_lead) {
      return `<section class="leadbox"><span class="eyebrow">Hiring lead · ${h(lead)}</span>
        ${cal.open ? `<p>Shortlisted. Send to ${h(lead)}, who answers yes or no to an interview, with a reason.${cal.first.length < 3 ? ` This would be number ${cal.first.length + 1} of the first three, which calibrate the search.` : ""}</p><div><button type="button" class="btn small" id="sendlead">Send to ${h(lead)}</button></div>`
          : `<p><b>Calibration first.</b> The first three sent for ${h(role.short)} need ${h(lead)}'s yes or no with a reason before more go: ${cal.answered} of 3 answered.</p><div class="chips">${cal.first.map((x) => `<span class="chip">${h(x.name)} · ${x.lead_call ? h(x.lead_call) : "waiting"}</span>`).join("")}</div>`}</section>`;
    }
    return `<section class="leadbox"><span class="eyebrow">Hiring lead · ${h(lead)}</span><p>Sent ${h(fmt(c.sent_to_lead))}${pos >= 0 ? ` · number ${pos + 1} of the first three for ${h(role.short)}` : ""}. ${c.lead_call ? "" : `Waiting for ${h(lead)}'s yes or no.`}</p>
      <form class="form" id="lform"><label><span class="lbl">Interview?</span>${seg("leadcall", [["Interview", "Yes, interview"], ["No", "No"]], c.lead_call || "")}<input type="hidden" name="lead_call" value="${h(c.lead_call)}"></label>
        <label class="full"><span class="lbl">Reason</span><input name="lead_reason" value="${h(c.lead_reason)}" required placeholder="What decided it, in one line"></label>
        <div class="formfoot full"><button type="submit" class="btn small">Save ${h(lead)}'s answer</button></div></form></section>`;
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

  // ---------- talent rediscovery: a search first lists earlier candidates who passed a stage ----------
  function families(r) {  // the job families of the other searches, each named after its open search when there is one
    const fams = {};
    roles().forEach((x) => { if (x.id === r.id) return; const f = familyOf(x); if (!fams[f] || !isClosedRole(x)) fams[f] = x.name; });
    const cur = r.id && familyOf(r) !== r.id ? familyOf(r) : "";
    return [["", r.id ? "Its own (no earlier rounds)" : "None: a new kind of role"]].concat(Object.entries(fams))
      .map(([v, l]) => `<option value="${h(v)}" ${v === cur ? "selected" : ""}>${h(l)}</option>`).join("");
  }
  function poolFor(role) {
    const fam = familyOf(role), mine = state.candidates.filter((c) => c.role_id === role.id);
    // someone declined for the same job stays out (the lead already decided); declined for another job, they can still fit this one
    const declined = (c) => c.your_call === "Decline" || c.stage === "declined";
    return state.candidates.filter((c) => c.role_id !== role.id && roles().some((r) => r.id === c.role_id) && passedStage(c) && c.stage !== "hired")
      .map((c) => ({ c, same: familyOf(roleOf(c.role_id)) === fam, added: mine.some((m) => samePerson(c, m)) }))
      .filter((p) => !(p.same && declined(p.c)))
      .sort((a, b) => (b.same - a.same) || (reachedIdx(b.c) - reachedIdx(a.c)) || a.c.name.localeCompare(b.c.name));
  }
  function poolPanel(role) {
    const pool = poolFor(role), same = pool.filter((p) => p.same).length;
    const fresh = state.justCreated === role.id || !state.candidates.some((c) => c.role_id === role.id && c.sources !== "pool");
    const row = ({ c, same: sameJob, added }) => {
      const from = roleOf(c.role_id), notes = [c.your_reason, c.notes].filter(Boolean).join(" · "), m = matchSummary(c);
      return `<li class="prow"><div class="ptop"><span class="name">${h(c.name)}</span>${sameJob ? pill("same job", "ok") : ""}${added ? pill("in this search", "") : ""}
          <span class="muted small">${h(from.short)} · got to ${h(stageWord(reachedOf(c)))}${c.stage && c.stage !== reachedOf(c) ? ", now " + h(stageWord(c.stage)) : ""}</span></div>
        ${c.scores ? `<p><span class="lbl">Scores</span> ${h(c.scores)}</p>` : ""}${c.why ? `<p><span class="lbl">Why</span> ${h(c.why)}</p>` : ""}${c.doubt ? `<p><span class="lbl">To probe</span> ${h(c.doubt)}</p>` : ""}
        ${notes ? `<p><span class="lbl">Notes</span> ${h(notes)}</p>` : ""}${m ? `<p><span class="lbl">Criteria</span> ${h(m)}</p>` : ""}
        <div class="pact">${added ? "" : `<button type="button" class="btn small" data-recontact="${h(c.id)}">Add to this search</button>`}<button type="button" class="btn ghost small" data-poolopen="${h(c.id)}">Open record</button>${c.linkedin ? `<a class="btn ghost small" href="${h(c.linkedin)}" target="_blank" rel="noopener">LinkedIn</a>` : ""}</div></li>`;
    };
    return `<details class="fold pool" ${fresh ? "open" : ""}><summary>Re-contact first<span class="count">${same ? `${same} for this job` : "none for this job"}${pool.length > same ? ` · ${pool.length - same} from other jobs` : ""}</span></summary>
      <p class="muted small">Everyone from another round or role who passed at least one stage (shortlisted or further), same job first, with their stage, scores and notes; anyone declined for this job stays out. Re-contact them before posting; "Add to this search" opens a record here with the source "pool".</p>
      ${same ? `<ul class="poollist">${pool.filter((p) => p.same).map(row).join("")}</ul>` : '<p class="muted small">Nobody from an earlier round of this job is left to re-contact.</p>'}
      ${pool.length > same ? `<details class="fold plain"><summary>From other jobs (${pool.length - same})</summary><ul class="poollist">${pool.filter((p) => !p.same).map(row).join("")}</ul></details>` : ""}</details>`;
  }

  // ---------- checklists ----------
  async function renderChecklists(view) {
    if (!state.candidates) await loadCandidates();
    const b = state.boot, steps = b.steps, total = steps.length;
    const doneSet = new Set(b.ticks.filter((t) => t.done).map((t) => t.role_id + "~" + t.step_id));
    const tickOf = (rid, sid) => b.ticks.find((t) => t.role_id === rid && t.step_id === sid);
    const count = (rid) => steps.filter((s) => doneSet.has(rid + "~" + s.id)).length;
    const shown = roles().filter((r) => state.showClosed || !isClosedRole(r)), closedCount = roles().filter(isClosedRole).length;
    if (!state.role || !shown.find((r) => r.id === state.role)) state.role = shown.find((r) => r.id === store.get("studio-role")) ? store.get("studio-role") : (shown[0] || {}).id;
    const role = shown.find((r) => r.id === state.role);
    const notes = {}; b.role_steps.forEach((rs) => { notes[rs.role_id + "~" + rs.step_id] = rs; });
    const phases = []; steps.forEach((s) => { let p = phases.find((x) => x.key === s.phase); if (!p) { p = { key: s.phase, title: s.phase_title, steps: [] }; phases.push(p); } p.steps.push(s); });
    const chipFor = (l) => l.target === "#posts" ? `<button type="button" class="chip link" data-posts>${h(l.label)}</button>`
      : l.target.startsWith("doc:") ? `<button type="button" class="chip link" data-doc="${h(l.target.slice(4))}">${h(l.label)}</button>`
      : `<a class="chip link" href="${h(l.target.startsWith("art:") ? "https://claude.ai/artifact/" + l.target.slice(4) : l.target)}" target="_blank" rel="noopener">${h(l.label)}</a>`;
    view.innerHTML = head("Checklists", `The ${total} steps every search follows, one list per role`, `<button type="button" class="btn" id="newsearch">New search</button>`) +
      `<div class="cards">${shown.map((r) => `<button type="button" class="rcard" data-role="${h(r.id)}" aria-pressed="${r.id === state.role}">${pill(r.state === "live" ? "Live" : r.state === "pool" ? "Quiet pool" : r.state || "planned", r.state === "live" ? "ok" : r.state === "pool" ? "warn" : "")}<span class="cname">${h(r.short)}</span><span class="muted small">Owner · ${h(r.owner || "–")}</span><span class="bar"><span style="width:${Math.round(100 * count(r.id) / total)}%"></span></span><span class="mono muted"><b>${count(r.id)}</b> / ${total}</span></button>`).join("")}</div>
      ${closedCount ? `<p class="small"><button type="button" class="linkbtn" id="toggleclosed">${state.showClosed ? "Hide" : "Show"} earlier rounds (${closedCount})</button></p>` : ""}
      ${role ? `<div class="rolebar"><div class="rtabs">${shown.map((r) => `<button type="button" class="rtab" data-role="${h(r.id)}" aria-pressed="${r.id === state.role}">${h(r.short)}<b>${count(r.id)}</b></button>`).join("")}</div>${seg("filter", [["all", "All"], ["open", "Open"], ["done", "Done"]], state.filter)}</div>
      <section class="role" data-filter="${h(state.filter)}"><div class="rolehead"><div><span class="eyebrow">Owner · ${h(role.owner || "–")}</span><h2>${h(role.name)}</h2><p class="muted">${h(role.status)}<button type="button" class="edit" id="editrole">edit</button></p></div><div class="rolestat"><span class="big">${count(role.id)}</span><span class="muted">of ${total} steps done</span></div></div><div class="bar"><span style="width:${Math.round(100 * count(role.id) / total)}%"></span></div>
      ${isClosedRole(role) ? "" : poolPanel(role)}
      ${phases.map((p) => `<div class="phase"><h3>${h(p.title)} <span>${p.steps.filter((s) => doneSet.has(role.id + "~" + s.id)).length} / ${p.steps.length}</span></h3><ul class="steps">
        ${p.steps.map((s) => { const key = role.id + "~" + s.id, done = doneSet.has(key), t = tickOf(role.id, s.id), rs = notes[key] || {}; let links = []; try { links = JSON.parse(rs.links || "[]"); } catch (e) {}
          return `<li class="step ${done ? "done" : ""}"><input type="checkbox" class="tick" id="t-${h(key)}" data-key="${h(key)}" ${done ? "checked" : ""}><div class="stepbody"><label for="t-${h(key)}" class="stitle">${h(s.title)}</label>
            <p class="snote" data-note="${h(key)}">${h(rs.note || "")}<button type="button" class="edit" data-editnote="${h(key)}">${rs.note ? "edit" : "add a note"}</button></p>
            ${links.length ? `<div class="chips">${links.map(chipFor).join("")}</div>` : ""}
            <details class="what"><summary>What this step means</summary><p>${h(s.what)}</p></details>
            <span class="smeta">${done && t ? "Done " + fmt(t.at) + " · by " + h(whoName(t.by)) : ""}</span></div></li>`; }).join("")}</ul></div>`).join("")}</section>` : '<div class="card empty">No searches yet. Start one with "New search".</div>'}`;
    view.querySelectorAll("[data-role]").forEach((el) => el.addEventListener("click", () => { state.role = el.dataset.role; store.set("studio-role", state.role); renderChecklists(view); }));
    const tc = $("#toggleclosed", view); if (tc) tc.addEventListener("click", () => { state.showClosed = !state.showClosed; renderChecklists(view); });
    view.querySelectorAll("[data-recontact]").forEach((btn) => btn.addEventListener("click", async () => {
      const c = state.candidates.find((x) => x.id === btn.dataset.recontact), from = roleOf(c.role_id);
      btn.disabled = true;
      await api("candidates", "POST", { role_id: role.id, name: c.name, linkedin: c.linkedin, email: c.email, location: c.location, headline: c.headline, english: c.english,
        sources: "pool", stage: "applied", next_step: `Re-contact first: ${stageWord(reachedOf(c))} in ${from.short} (${c.id})` });
      state.candidates = null; await loadCandidates(); renderChecklists(view);
    }));
    view.querySelectorAll("[data-poolopen]").forEach((btn) => btn.addEventListener("click", () => openCandidate(btn.dataset.poolopen)));
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
        <label><span class="lbl">State</span><select name="state">${[["planned", "Planned"], ["live", "Live"], ["pool", "Quiet pool"], ["closed", "Closed"]].map(([v, l]) => `<option value="${v}" ${v === (r.state || "planned") ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label><span class="lbl">Hiring lead</span><input name="lead" value="${h(r.lead || "")}" placeholder="Who says yes or no to interviews"></label>
        <label class="full"><span class="lbl">Earlier rounds of</span><select name="family">${families(r)}</select></label><label class="full"><span class="lbl">Status line</span><input name="status" value="${h(r.status || "")}" placeholder="Opens when the first TA Manager round is hired"></label>
        <div class="formfoot full"><button type="submit" class="btn">${r.id ? "Save" : "Create the checklist"}</button></div></form>`);
      $("#rform").addEventListener("submit", async (e) => { e.preventDefault(); await onSubmit(Object.fromEntries(new FormData(e.target).entries())); state.boot = null; closeDrawer(); await loadBoot(); renderChecklists(view); });
    };
    $("#newsearch", view).addEventListener("click", () => roleForm("New search", {}, async (d) => { const r = await api("roles", "POST", d); state.role = r.id; state.justCreated = r.id; store.set("studio-role", r.id); }));
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
