/* Corner Studio: the hiring CRM. Talks to /studio/api (a Worker on D1); Cloudflare Access has already signed the viewer in.
   One visual language throughout, taken from the Checklists view: greige cards, mono eyebrows, segmented controls, quiet buttons. */
(function () {
  "use strict";
  const API = "/studio/api/";
  const $ = (s, el) => (el || document).querySelector(s);
  const h = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const localDay = (d) => d.toLocaleDateString("en-CA");  // YYYY-MM-DD in the viewer's time zone (UTC is a day ahead in Brazil after 21:00)
  const today = () => localDay(new Date());
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
  const VIEWS = ["week", "checklists", "pipeline", "candidates", "screening", "calibration", "outreach", "templates", "activity", "onboarding", "posts"];
  const CALL_RANK = { Shortlist: 0, Hold: 1, Decline: 2 }, CONF_RANK = { High: 0, Medium: 1, Low: 2 };
  // A blind calibration batch (scorecard section 7): Claude's call on these records stays hidden everywhere until a person has made theirs.
  const blindNow = (c) => !!(c.calib_batch && !c.your_call);
  // Names come from one place: the Worker's people table (login email → the name shown), sent with bootstrap. A login that isn't in it
  // yet shows as the first part of its address.
  const people = () => (state.boot && state.boot.people) || [];
  const whoName = (by) => !by ? "" : by === "claude" || /\.access$/.test(by) || /^u_/.test(by) ? "Claude"
    : (people().find((x) => x.email === by) || {}).name || by.replace(/@.*/, "").replace(/^\w/, (c) => c.toUpperCase());
  const firstName = (by) => whoName(by).split(" ")[0];
  const state = { view: "week", boot: null, roleFilter: "all", role: null, filter: "all", candidates: null, results: null, outreach: null, templates: null, search: "", open: {},
    showClosed: false, justCreated: null, cards: null, cardStage: {}, cardEdit: null, srcFilter: "all", callFilter: "all", agentFilter: "all", confFilter: "all",
    sort: { key: "", dir: 1 }, screenFilter: "tosend", calGroup: "", cvFilter: "all", resBy: {}, wsBy: {}, decBy: {}, onb: null, onbPlan: "", onbOpen: {}, onbDraft: {}, onbAnswer: {}, onbScore: {}, onbErr: {}, onbVisit: null, onbRead: {} };
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };

  // missing: what to return on a 404 instead of an error (a route an older Worker doesn't have yet; the caller hides what it would show)
  async function api(path, method, body, missing) {
    const payload = body ? JSON.stringify(body) : undefined;
    // keepalive lets a save finish after the record (or the tab) is closed; browsers allow it for bodies under 64 KB
    return send(path, { method: method || "GET", keepalive: !!payload && payload.length < 60000, headers: body ? { "content-type": "application/json" } : {}, body: payload }, missing);
  }
  async function send(path, init, missing) {  // any body (a file upload sends its bytes), the same sign-in and error handling as api()
    const r = await fetch(API + path, { credentials: "same-origin", ...init });
    if (r.status === 401) { notice("Your sign-in expired. Reload the page to sign in again.", true); throw new Error("unauthorized"); }
    if (r.status === 404 && missing !== undefined) return missing;
    const j = await r.json().catch(() => ({}));
    if (r.status === 503) { notice(j.error === "login_not_configured" ? "Sign-in isn't switched on for the studio yet." : "The sign-in check didn't answer. Try again in a minute.", true); throw new Error(j.error || "unavailable"); }
    if (!r.ok || j.error) { notice(j.error || ("Request failed: " + r.status), true); throw new Error(j.error || r.status); }
    return j;
  }
  function notice(text, bad) { const n = $("#notice"); n.textContent = text || ""; n.hidden = !text; n.classList.toggle("bad", !!bad); }

  // ---------- data ----------
  async function loadBoot() {
    state.boot = await api("bootstrap");
    const who = $("#who"); who.textContent = whoName(state.boot.who); who.title = state.boot.who;
    // Onboarding shows only to the person a plan is for and to its managers: the Worker sends the plans this login may see
    const tab = document.querySelector('nav.views button[data-view="onboarding"]'), plans = state.boot.onboarding || [];
    if (tab) { tab.hidden = !plans.length;
      // first in the row for the person the plan is for (it is their week), last for its managers
      const nav = tab.parentNode, own = plans.some((p) => p.person_email === state.boot.who);
      if (own && nav.firstElementChild !== tab) nav.prepend(tab); else if (!own && nav.lastElementChild !== tab) nav.append(tab); }
  }
  const roles = () => state.boot.roles;
  const roleOf = (id) => roles().find((r) => r.id === id) || { id, short: id, name: id };
  const roleName = (id) => roleOf(id).short || id;
  // An archived role is a closed one that only its viewers get from the Worker (12 Nov): everything that asks "closed?" treats it the same.
  const isArchivedRole = (r) => (r || {}).state === "archived";
  const isClosedRole = (r) => ["closed", "archived"].includes((r || {}).state);
  const openRoles = () => roles().filter((r) => !isClosedRole(r));
  const familyOf = (r) => (r && (r.family || r.id)) || "";
  const leadOf = (r) => (r && (r.lead || r.owner)) || "the hiring manager";
  // The hiring manager as a login: roles.lead holds a name ("Yuliia") or an email
  const leadEmail = (r) => { const l = String((r && (r.lead || r.owner)) || "").trim().toLowerCase();
    return (people().find((x) => x.email === l || x.name.toLowerCase() === l || x.name.toLowerCase().split(" ")[0] === l) || {}).email || ""; };
  // A call reads with the name of the person who made it; with no call yet, the role's recruiter makes it; with neither, just "Call".
  const callBy = (c) => (c.your_call && c.call_by) || "";
  const callLabel = (c) => { const by = callBy(c) || roleOf(c.role_id).recruiter || ""; return by ? `${firstName(by)}'s call` : "Call"; };
  // Each view loads only what it shows; the caches are dropped when the data changes (see refresh) or after a save.
  async function need(...keys) {
    // Lists load light candidate rows and per-candidate criteria counts; a record fetches its full row and its own criteria when it
    // opens (27 Oct: the full tables, about 3 MB and 6 MB, went over the Worker's CPU limit and Cloudflare answered with an error page).
    const load = { candidates: "candidates?lite=1", summary: "criteria/results?summary=1", cards: "scorecards", outreach: "outreach", templates: "templates" };
    const missing = keys.filter((k) => !state[k]);
    (await Promise.all(missing.map((k) => api(load[k])))).forEach((v, i) => { state[missing[i]] = v; });
  }
  const forget = () => { state.boot = null; state.candidates = null; state.summary = null; state.resBy = {}; state.cards = null; state.outreach = null; state.templates = null; state.msgs = null; state.onb = null; };

  // ---------- shared candidate logic ----------
  const stageIdx = (s) => ORDER.indexOf(s || "");
  const reachedIdx = (c) => Math.max(stageIdx(c.stage || "applied"), stageIdx(c.reached));
  const reachedOf = (c) => ORDER[reachedIdx(c)] || "applied";
  const stageWord = (s) => STAGE_LABEL[s] || s || "applied";
  // Passed at least one stage: shortlisted (a person's call) or got as far as the shortlist or further, in any round.
  const passedStage = (c) => c.your_call === "Shortlist" || reachedIdx(c) >= stageIdx("confirmed");
  const sourceOf = (c) => (c.referred_by || "").trim() ? "Referral" : ((c.sources || "").split(/[,;·]/)[0].trim() || "Not recorded");
  const samePerson = (a, b) => (a.linkedin && b.linkedin && a.linkedin.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase() === b.linkedin.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase())
    || (a.email && b.email && a.email.trim().toLowerCase() === b.email.trim().toLowerCase()) || (!a.linkedin && !a.email && a.name && a.name.trim().toLowerCase() === (b.name || "").trim().toLowerCase());
  function criteriaFor(roleId) {
    const all = state.boot.criteria || [], own = all.filter((k) => k.role_id === roleId);
    return own.length ? own : all.filter((k) => k.role_id === familyOf(roleOf(roleId)));
  }
  const resultsFor = (cid) => (state.resBy && state.resBy[cid]) || [];
  function matchSummary(c) {
    const rows = (state.summary || []).filter((x) => x.candidate_id === c.id).sort((a, b) => (b.at || "").localeCompare(a.at || ""));
    const n = rows[0];  // the newest read
    return n ? `${n.met} met · ${n.not_met} not met · ${n.unclear} unclear` : "";
  }

  // ---------- shell ----------
  function setView(v) {
    state.view = v; store.set("studio-view", v);
    if (v !== "onboarding") state.onbVisit = null;  // leaving the Onboarding tab ends the visit: what was new then counts as seen
    document.querySelectorAll("nav.views button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.view === v));
    return render();
  }
  document.querySelectorAll("nav.views button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  async function render(quiet) {
    notice("");
    const view = $("#view"), y = window.scrollY;
    if (!quiet) view.innerHTML = '<p class="muted">Loading…</p>';
    try {
      if (!state.boot) await loadBoot();
      if (state.view === "week") await renderDocView(view, "this-week");
      else if (state.view === "checklists") await renderChecklists(view);
      else if (state.view === "pipeline") await renderPipeline(view);
      else if (state.view === "candidates") await renderCandidates(view);
      else if (state.view === "screening") await renderScreening(view);
      else if (state.view === "calibration") await renderCalibration(view);
      else if (state.view === "outreach") await renderOutreach(view);
      else if (state.view === "templates") await renderTemplates(view);
      else if (state.view === "activity") await renderActivity(view);
      else if (state.view === "onboarding") await renderOnboarding(view);
      else if (state.view === "posts") await renderDocView(view, "posts");
    } catch (e) { if (!$("#notice").textContent) notice(String(e.message || e), true); view.innerHTML = ""; }
    window.scrollTo(0, quiet ? y : 0);
  }

  // ---------- fresh data without a reload: the robots write every two hours and at each check-in, people write from their own tabs ----------
  // Every minute while the tab is visible, and the moment it comes back into view, the app asks the API for its change counter
  // (one small read). Only when it moved does the view re-read its data and redraw in place. It waits while a record or document
  // is open, while a field has focus, or while a form has edits not saved yet, so nothing is pulled from under a person's hands.
  let lastCheck = Date.now();
  document.addEventListener("input", (e) => { const f = e.target.closest && e.target.closest("form"); if (f) f.dataset.dirty = "1"; });
  const editing = () => document.querySelector("dialog[open], #view form[data-dirty], #drawer:not([hidden]) form[data-dirty], [data-note] textarea, .scrmsg[data-dirty=\"1\"]")
    || ["INPUT", "TEXTAREA", "SELECT"].includes((document.activeElement || {}).tagName);
  async function refresh(force) {
    if (document.hidden || editing() || (!force && Date.now() - lastCheck < 55000)) return;
    lastCheck = Date.now();
    let version;
    try { version = (await api("changes")).version; } catch (e) { return; }
    if (state.boot && version === state.boot.version) return;
    forget();
    await render(true);
  }
  setInterval(() => refresh(false), 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(true); });
  window.addEventListener("focus", () => refresh(true));

  // Shared pieces
  const head = (title, sub, right) => `<div class="viewhead"><div><h2>${h(title)}</h2>${sub ? `<div class="sub">${sub}</div>` : ""}</div>${right || ""}</div>`;
  const seg = (name, items, current) => `<div class="seg" data-seg="${h(name)}">${items.map(([v, l]) => `<button type="button" data-v="${h(v)}" aria-pressed="${v === current}">${h(l)}</button>`).join("")}</div>`;
  function bindSeg(el, name, onPick) {
    el.querySelectorAll(`[data-seg="${name}"] button`).forEach((b) => b.addEventListener("click", () => { const f = b.closest("form"); if (f) f.dataset.dirty = "1"; onPick(b.dataset.v); }));
  }
  const roleSeg = () => seg("role", [["all", "All roles"]].concat(openRoles().map((r) => [r.id, r.short]), roles().some(isClosedRole) ? [["closed", "Earlier rounds"]] : []), state.roleFilter);
  const inRole = (c) => state.roleFilter === "all" || c.role_id === state.roleFilter || (state.roleFilter === "closed" && isClosedRole(roleOf(c.role_id)));
  const pill = (text, kind) => text ? `<span class="pill ${kind || ""}" title="${h(text)}">${h(text)}</span>` : "";
  const callPill = (c) => pill(c, c === "Shortlist" ? "ok" : c === "Decline" ? "bad" : c ? "warn" : "");
  const confWord = (c) => c ? `<span class="conf conf-${h(c.toLowerCase())}">${h(c)}</span>` : "";
  const table = (cols, rows) => `<div class="tablewrap"><table><thead><tr>${cols.map((c) => `<th>${h(c)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;

  // ---------- This week and Posts: the launch kit, rendered by the checklist builder and synced as documents ----------
  async function renderDocView(view, slug) {
    const d = await api("docs/" + slug);
    const back = slug === "posts" ? `<p class="crumbs"><button type="button" class="linkbtn" data-back="checklists">← Checklists</button><span class="muted"> · </span><button type="button" class="linkbtn" data-back="week">This week</button></p>` : "";
    view.innerHTML = `${back}${slug === "posts" ? head("Posts", "Every text here is ready to paste. Settings for LinkedIn and Work.ua are folded under each post.") : ""}<section class="kit ${slug}">${d.html || "<p class='muted'>Not synced yet.</p>"}</section>`;
    const strip = view.querySelector("[data-live-strip]");
    if (strip) {
      await need("candidates", "outreach");
      const t = today(), cands = state.candidates.filter((c) => !isClosedRole(roleOf(c.role_id)));
      const tiles = [[roles().filter((r) => ["live", "pool"].includes(r.state)).length, "roles on the jobs site"], [cands.length, "applications so far"],
        // New today by the date they applied. A record without that date counts only while it still sits at "applied":
        // imports of earlier applicants (Yuliia's PM channels on 18 Oct) arrive with a stage already and are not today's news.
        [cands.filter((c) => c.applied ? c.applied.slice(0, 10) === t : (c.created_at && localDay(new Date(c.created_at)) === t && (c.stage || "applied") === "applied")).length, "new applicants today, all sources"],
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
    await need("candidates");
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
      </div>`;
    }).join("");
    const strip = [[active.length, "active candidates"], [closed.length, "closed"], [pct(reached[FUNNEL.length - 1].length, applied), "applied to hired"],
      [bottleneck ? FUNNEL[bottleneck.i][0] : "–", bottleneck ? "weakest step" : "weakest step (needs 5+ per stage)"]];
    // Source of hire: everyone by the furthest stage they reached, closed candidates included; a referral counts as Referral
    const bySource = {}; list.forEach((c) => { (bySource[sourceOf(c)] = bySource[sourceOf(c)] || []).push(c); });
    const atLeast = (cs, st) => cs.filter((c) => reachedIdx(c) >= stageIdx(st)).length;
    const hiredAll = atLeast(list, "hired");
    const sourceTable = table(["Source", "Candidates", "Shortlisted", "Interviewed", "Hired", "Share of hires"], Object.entries(bySource).sort((a, b) => atLeast(b[1], "hired") - atLeast(a[1], "hired") || b[1].length - a[1].length).map(([src, cs]) =>
      `<tr><td>${h(src)}</td><td>${cs.length}</td><td>${cs.filter(passedStage).length}</td><td>${atLeast(cs, "interview booked")}</td><td>${atLeast(cs, "hired")}</td><td>${hiredAll ? Math.round(100 * atLeast(cs, "hired") / hiredAll) + "%" : "–"}</td></tr>`));
    const referred = list.filter((c) => (c.referred_by || "").trim());
    const bountyTable = referred.length ? table(["Candidate", "Role", "Referred by", "Stage", "Hired on", "Bounty", "Bounty due"], referred.map((c) =>
      `<tr class="clickable" data-id="${h(c.id)}"><td><span class="name">${h(c.name)}</span></td><td>${h(roleName(c.role_id))}</td><td>${h(c.referred_by)}</td><td>${pill(c.stage || "applied")}</td><td>${h(fmt(c.hired_at))}</td><td>${c.bounty ? h(c.bounty) : '<span class="muted">not set yet</span>'}</td><td>${c.bounty_due ? (c.bounty_due <= today() ? `<b>${h(fmt(c.bounty_due))} · due</b>` : h(fmt(c.bounty_due))) : '<span class="muted">at hire + 90 days</span>'}</td></tr>`)) : "";
    view.innerHTML = head("Pipeline", "Each stage counts everyone who reached it or went further. Closed candidates sit in their own row and don't count against the conversions. Click a stage to see who is there now.", roleSeg()) +
      `<div class="strip four">${strip.map(([v, t]) => `<div class="kpi"><b>${h(v)}</b><span>${h(t)}</span></div>`).join("")}</div>
      <div class="funnel">${rows}
      <div class="stage closedrow"><button type="button" class="stagerow" data-toggle="Closed" aria-expanded="${!!state.open.Closed}"><span class="sname">Closed<small>declined, not now, pool, earlier rounds</small></span><span class="sbar"></span><span class="snum">${closed.length}</span><span class="sconv"></span></button>
        ${state.open.Closed ? `<div class="stagelist">${closed.length ? closed.map((c) => `<button type="button" class="srow" data-id="${h(c.id)}"><span class="name">${h(c.name)}</span><span class="muted">${h(roleName(c.role_id))}</span><span class="pill">${h(isClosedRole(roleOf(c.role_id)) && !CLOSED.includes(c.stage) ? "got to " + stageWord(c.stage) : c.stage)}</span></button>`).join("") : '<p class="muted">Nobody closed yet.</p>'}</div>` : ""}</div></div>
      ${list.length ? "" : `<p class="muted">No candidates yet. They arrive from the jobs site, LinkedIn and Work.ua through the daily check-in, or you add one under Candidates.</p>`}
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
    await need("candidates");
    const q = state.search.trim().toLowerCase();
    // Source and Call filters (Yuliia's request, 18 Oct); options count within the chosen role
    const base = state.candidates.filter(inRole);
    const callOf = (c) => c.your_call || "none", agentOf = (c) => blindNow(c) ? "blind" : c.agent_call || "none", confOf = (c) => blindNow(c) ? "blind" : c.confidence || "none", cvOf = (c) => c.cv_check || "none";
    const count = (f) => { const m = {}; base.forEach((c) => { m[f(c)] = (m[f(c)] || 0) + 1; }); return m; };
    const srcCounts = count(sourceOf), callCounts = count(callOf), agentCounts = count(agentOf), confCounts = count(confOf), cvCounts = count(cvOf);
    if (state.srcFilter !== "all" && !srcCounts[state.srcFilter]) state.srcFilter = "all";
    const list = base.filter((c) => (state.srcFilter === "all" || sourceOf(c) === state.srcFilter) && (state.callFilter === "all" || callOf(c) === state.callFilter) &&
      (state.agentFilter === "all" || agentOf(c) === state.agentFilter) && (state.confFilter === "all" || confOf(c) === state.confFilter) &&
      (state.cvFilter === "all" || cvOf(c) === state.cvFilter) &&
      (!q || [c.name, c.headline, c.location, c.sources, c.email, c.stage, c.your_call, c.agent_call].join(" ").toLowerCase().includes(q)));
    // Sorting: click a column header; click again to reverse. Calls sort Shortlist, Hold, Decline, then none; confidence High to Low.
    const SORTS = { name: (c) => (c.name || "").toLowerCase(), applied: (c) => c.applied || c.created_at || "", agent: (c) => blindNow(c) ? 4 : CALL_RANK[c.agent_call] ?? 3,
      conf: (c) => blindNow(c) ? 4 : CONF_RANK[c.confidence] ?? 3, your: (c) => CALL_RANK[c.your_call] ?? 3, stage: (c) => stageIdx(c.stage || "applied"), due: (c) => c.due || "~" };
    const sk = state.sort.key, sd = state.sort.dir;
    if (SORTS[sk]) list.sort((a, b) => { const x = SORTS[sk](a), y = SORTS[sk](b); return (x < y ? -1 : x > y ? 1 : 0) * sd || (a.name || "").localeCompare(b.name || ""); });
    const opt = (v, label, cur) => `<option value="${h(v)}" ${v === cur ? "selected" : ""}>${h(label)}</option>`;
    const srcSel = `<select id="fsrc" aria-label="Source">${opt("all", "All sources", state.srcFilter)}${Object.entries(srcCounts).sort((a, b) => b[1] - a[1]).map(([v, n]) => opt(v, `${v} (${n})`, state.srcFilter)).join("")}</select>`;
    const callSel = `<select id="fcall" aria-label="Call">${opt("all", "Call: any", state.callFilter)}${[["Shortlist", "Shortlist"], ["Hold", "Hold"], ["Decline", "Decline"], ["none", "No call yet"]].map(([v, l]) => opt(v, `Call: ${l} (${callCounts[v] || 0})`, state.callFilter)).join("")}</select>`;
    const agentSel = `<select id="fagent" aria-label="Agent call">${opt("all", "Agent call: any", state.agentFilter)}${[["Shortlist", "Shortlist"], ["Hold", "Hold"], ["Decline", "Decline"], ["none", "Not read yet"]].concat(agentCounts.blind ? [["blind", "Hidden, blind batch"]] : []).map(([v, l]) => opt(v, `Agent call: ${l} (${agentCounts[v] || 0})`, state.agentFilter)).join("")}</select>`;
    const confSel = `<select id="fconf" aria-label="Confidence">${opt("all", "Confidence: any", state.confFilter)}${[["High", "High"], ["Medium", "Medium"], ["Low", "Low"]].map(([v, l]) => opt(v, `Confidence: ${l} (${confCounts[v] || 0})`, state.confFilter)).join("")}</select>`;
    const cvSel = `<select id="fcv" aria-label="CV check">${opt("all", "CV check: any", state.cvFilter)}${[["Pass", "Pass"], ["Not pass", "Not pass"], ["none", "Not checked"]].map(([v, l]) => opt(v, `CV check: ${l} (${cvCounts[v] || 0})`, state.cvFilter)).join("")}</select>`;
    // Compact (Kostya, 27 Oct): role sits above the source, confidence under Claude's call, long text clamps to two lines,
    // so Next step and Due fit without scrolling sideways
    const cols = [["Name", "name"], ["Role · source", ""], ["Applied", "applied"], ["Claude", "agent"], ["Call", "your"], ["Stage", "stage"], ["Next step", ""], ["Due", "due"]];
    const th = ([label, key]) => key ? `<th><button type="button" class="sorth" data-sort="${key}" aria-sort="${sk === key ? (sd > 0 ? "ascending" : "descending") : "none"}">${h(label)}<span class="arrow">${sk === key ? (sd > 0 ? "↑" : "↓") : "↕"}</span></button></th>` : `<th>${h(label)}</th>`;
    view.innerHTML = head("Candidates", `${list.length} of ${state.candidates.length}`, `<button type="button" class="btn" id="add">Add candidate</button>`) +
      `<div class="toolbar"><input type="search" id="q" placeholder="Search name, headline, source, stage" value="${h(state.search)}">${srcSel}${agentSel}${confSel}${callSel}${cvSel}${roleSeg()}</div>
      ${list.length ? `<div class="tablewrap cands"><table><thead><tr>${cols.map(th).join("")}</tr></thead><tbody>${
        list.map((c) => `<tr class="clickable" data-id="${h(c.id)}"><td class="cname"><span class="name">${h(c.name)}</span><span class="muted clamp2">${h(c.headline || c.location || "")}</span></td><td class="csrc"><span class="muted small">${h(roleName(c.role_id))}</span><br>${h(sourceShort(c.sources))}${c.referred_by ? `<br><span class="muted">referred by ${h(c.referred_by)}</span>` : ""}</td><td class="nowrap">${h(fmt(c.applied))}</td><td>${blindNow(c) ? pill("blind") : callPill(c.agent_call)}${blindNow(c) || !c.confidence ? "" : `<br>${confWord(c.confidence)}`}</td><td>${callPill(c.your_call)}${callBy(c) ? `<br><span class="muted small">${h(firstName(callBy(c)))}</span>` : ""}</td><td>${pill(c.stage || "applied")}${c.ws_file ? `<br><span class="wsflag" title="${h(c.ws_file)}">Work sample</span>` : ""}</td><td class="cnext"><span class="clamp2" title="${h(c.next_step)}">${h(c.next_step)}</span></td><td class="nowrap">${h(fmt(c.due))}</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="card empty">No candidates match. They arrive from the jobs site, LinkedIn and Work.ua through the daily check-in, or add one by hand.</div>`}`;
    const qel = $("#q", view);
    qel.addEventListener("input", (e) => { state.search = e.target.value; renderCandidates(view); qel.focus(); });
    if (q) { qel.focus(); qel.setSelectionRange(qel.value.length, qel.value.length); }
    bindSeg(view, "role", (v) => { state.roleFilter = v; renderCandidates(view); });
    $("#fsrc", view).addEventListener("change", (e) => { state.srcFilter = e.target.value; renderCandidates(view); });
    $("#fcall", view).addEventListener("change", (e) => { state.callFilter = e.target.value; renderCandidates(view); });
    $("#fcv", view).addEventListener("change", (e) => { state.cvFilter = e.target.value; renderCandidates(view); });
    $("#fagent", view).addEventListener("change", (e) => { state.agentFilter = e.target.value; renderCandidates(view); });
    $("#fconf", view).addEventListener("change", (e) => { state.confFilter = e.target.value; renderCandidates(view); });
    view.querySelectorAll("[data-sort]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.sort; state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 }; renderCandidates(view); }));
    view.querySelectorAll("tr.clickable").forEach((tr) => tr.addEventListener("click", () => openCandidate(tr.dataset.id)));
    $("#add", view).addEventListener("click", () => openCandidate(null));
  }
  // ---------- the candidate record: a pop-up with three blocks ----------
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return u; } };
  function linkChip(u, forcedLabel) {
    const host = hostOf(u);
    const label = forcedLabel || (/linkedin\.com\/hiring\/applicants/.test(u) ? "CV on LinkedIn · application" : /linkedin\.com/.test(host) ? "LinkedIn" :/drive\.google\.com|docs\.google\.com/.test(host) ? "CV · in hello@'s Drive" : /instagram\.com/.test(host) ? "Instagram · " + (u.match(/instagram\.com\/([^/?]+)/) || [])[1] : /behance|dribbble|framer|notion|figma|vimeo|youtube/.test(host) ? host : host);
    return `<a class="chip link" href="${h(u)}" target="_blank" rel="noopener" title="${h(u)}">${h(label)} ↗</a>`;
  }
  const urlsIn = (text) => (String(text || "").match(/https?:\/\/[^\s,;]+/g) || []);
  // Platform and country only: "LinkedIn Denmark, LinkedIn message" reads "LinkedIn Denmark"; the channel detail stays in the record
  function sourceShort(src) {
    const out = [];
    for (let p of String(src || "").split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean)) {
      if (/^via\b/i.test(p)) continue;
      if (/^linkedin (message|application|inmail)$/i.test(p)) p = "LinkedIn";
      else if (/^email\b/i.test(p)) p = "Email";
      else if (/^jobs? site$/i.test(p)) p = "Jobs site";
      if (p === "LinkedIn" && out.some((o) => /^LinkedIn /.test(o))) continue;
      if (/^LinkedIn /.test(p)) { const i = out.indexOf("LinkedIn"); if (i >= 0) out.splice(i, 1); }
      if (!out.includes(p)) out.push(p);
    }
    return out.join(", ");
  }
  // First lines as rows: "Now: <title>, <employer> (<dates>): <first bullet>", "Before: …", "Also now: …" (scorecard v0.4, word for word).
  function parseLines(text) {
    return String(text || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.match(/^(Now|Before|Also now)\s*:\s*(.+?)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*:\s*([\s\S]*)$/i);
      if (!m) return { tag: "", head: l, dates: "", line: "" };
      const head = m[2], i = head.indexOf(", ");
      return { tag: m[1], title: i > 0 ? head.slice(0, i) : head, employer: i > 0 ? head.slice(i + 2) : "", dates: m[3], line: m[4].trim() };
    });
  }
  const tagPill = (t) => t ? `<span class="pill ${/^now|also/i.test(t) ? "ok" : ""}">${h(t.toLowerCase())}</span>` : `<span class="rtag-empty"></span>`;
  function firstLinesHtml(c) {
    const rows = parseLines(c.first_lines);
    if (!rows.length) return "";
    return `<div class="firstlines"><span class="lbl">First lines, word for word from the CV</span><ul class="roles">${rows.map((r) => r.tag
      ? `<li>${tagPill(r.tag)}<div class="rbody"><div class="rhead"><span class="etitle">${h(r.title)}</span>${r.employer ? ` <span class="muted">·</span> <span class="eorg">${h(r.employer)}</span>` : ""}${r.dates ? ` <span class="cmeta">${h(r.dates)}</span>` : ""}</div>${r.line && r.line !== "(no bullet)" ? `<q>${h(r.line)}</q>` : `<span class="muted small">No line under this role</span>`}</div></li>`
      : `<li>${tagPill("")}<div class="rbody">${h(r.head)}</div></li>`).join("")}</ul></div>`;
  }
  // The CV as data (cv_struct, 27 Oct): the file and its link, the roles newest first, then languages, education and portfolio.
  // The CV file Studio keeps (LinkedIn's own links expire after 24 hours): one click, opens inline under the candidate's name.
  const cvOpen = (c, cls) => c.cv_file ? `<a class="${cls || "chip link cvopen"}" href="${API}cv/${encodeURIComponent(c.id)}" target="_blank" rel="noopener" title="${h(c.cv_file)}">Open CV ↗</a>` : "";
  function cvBlock(c) {
    let d = null; try { d = c.cv_struct ? JSON.parse(c.cv_struct) : null; } catch (e) { d = null; }
    if (!d || typeof d !== "object" || Array.isArray(d)) d = null;
    const cvLinks = urlsIn(c.cv).filter((u) => /linkedin\.com\/hiring\/applicants|drive\.google\.com|docs\.google\.com/.test(u));
    // Kostya, 27 Oct: every Brand & Content and TA Shortlist and Hold (his, or Claude's he hasn't called) gets Open CV
    const owed = !c.cv_file && ["bc", "ta"].includes(familyOf(roleOf(c.role_id))) && (["Shortlist", "Hold"].includes(c.your_call) || (!c.your_call && ["Shortlist", "Hold"].includes(c.agent_call)));
    if (!d && !c.first_lines && !cvLinks.length && !c.cv_file && !owed) return "";
    // A robot once wrote a lone string where a list belongs (30 Oct: "portfolio" as text kept nine records from opening), so take either
    const list = (x) => (Array.isArray(x) ? x : x ? [x] : []);
    const roles = list(d && d.roles).filter((r) => r && typeof r === "object"), portfolio = list(d && d.portfolio).map(String);
    return `<div class="cvblock"><div class="cvhead"><span class="lbl">CV</span>${d && d.file ? `<span class="cmeta">${h(d.file)}</span>` : ""}<div class="chips">${cvOpen(c)}${cvLinks.map((u) => linkChip(u)).join("")}</div></div>
      ${owed ? `<p class="muted small">Open CV is added at the next robot run: 14:00 daily, and 17:00 and 20:00 on weekdays.</p>` : ""}
      ${roles.length ? `<ul class="roles">${roles.map((r) => `<li>${tagPill(r.when === "earlier" ? "" : r.when)}<div class="rbody"><div class="rhead"><span class="etitle">${h(r.title)}</span>${r.employer ? ` <span class="muted">·</span> <span class="eorg">${h(r.employer)}</span>` : ""}${r.dates ? ` <span class="cmeta">${h(r.dates)}</span>` : ""}</div>${r.what ? (r.when === "earlier" ? `<span class="small">${h(r.what)}</span>` : `<q>${h(r.what)}</q>`) : r.when !== "earlier" ? `<span class="muted small">No line under this role in the CV</span>` : ""}</div></li>`).join("")}</ul>`
        : firstLinesHtml(c)}
      ${d && (d.languages || d.education || portfolio.length || d.other) ? `<dl class="qa">${d.languages ? `<dt>Languages</dt><dd>${h(d.languages)}</dd>` : ""}${d.education ? `<dt>Education</dt><dd>${h(d.education)}</dd>` : ""}${portfolio.length ? `<dt>Portfolio</dt><dd>${portfolio.map((u) => /^https?:/.test(u) ? linkChip(u) : h(u)).join(" ")}</dd>` : ""}${d.other ? `<dt>Also</dt><dd class="long">${h(d.other)}</dd>` : ""}</dl>` : ""}</div>`;
  }
  // Screening answers as a structured block. LinkedIn imports join their parts with " · ": question-and-answer pairs, LinkedIn's own
  // match, the experience lines (title — company • years) and whether a resume is attached. Notes from the jobs site, Work.ua and the
  // robots' CV reads are "Label: text" segments. Anything else stays as written.
  // LinkedIn screening questions were stored cut at 60 characters until 26 Oct; show them whole.
  const QUESTIONS = { "Have you recruited for a furniture, kitchen, joinery or cons…": "Have you recruited for a furniture, kitchen, joinery or construction company?" };
  function parseScreening(text) {
    const t = String(text || "").trim();
    const out = { qa: [], exp: [], match: "", resume: false, notes: [] };
    if (!t) return out;
    if (/\s·\s/.test(t) || /^(LinkedIn's match:|Experience:)/.test(t)) {
      for (const p of t.split(/\s+·\s+/)) {
        if (/^LinkedIn's match:/i.test(p)) out.match = p.replace(/^LinkedIn's match:\s*/i, "");
        else if (/^Experience:/i.test(p)) out.exp = p.replace(/^Experience:\s*/i, "").split(/;\s+/).filter(Boolean);
        else if (/^Resume attached on LinkedIn$/i.test(p.trim())) out.resume = true;
        else { const m = p.match(/^(.{4,160}?[?…])\s+(.+)$/s), l = p.match(/^([A-Z][\w ./()'&-]{1,40}):\s+([\s\S]+)$/);
          if (l && (!m || l[1].length < m[1].length)) out.notes.push([l[1], l[2]]); else if (m) out.qa.push([QUESTIONS[m[1]] || m[1], m[2]]); else out.notes.push(["", p]); }
      }
      return out;
    }
    // "Label: text" segments, split where a new short label starts a sentence or clause
    t.split(/(?:(?<=[.;])\s+|^)(?=[A-Z][\w ./()'&-]{1,32}:\s)/).map((s) => s.trim()).filter(Boolean).forEach((s) => {
      const m = s.match(/^([A-Z][\w ./()'&-]{1,32}):\s+([\s\S]+)$/);
      out.notes.push(m ? [m[1], m[2]] : ["", s]);
    });
    return out;
  }
  function screeningBlock(c) {
    const s = parseScreening(c.screening);
    if (c.cv_struct || c.first_lines) s.notes = s.notes.filter(([l]) => !/^CV( \(LinkedIn resume\))?$/.test(l));
    if (!s.qa.length && !s.exp.length && !s.match && !s.resume && !s.notes.length) return "";
    const expRow = (e) => { const [title, rest] = e.split(/\s+—\s+/); const [org, years] = String(rest || "").split(/\s+•\s+/);
      return `<li><span class="etitle">${h(title)}</span>${org ? ` <span class="muted">·</span> <span class="eorg">${h(org)}</span>` : ""}${years ? ` <span class="cmeta">${h(years)}</span>` : ""}</li>`; };
    return `<div class="scr"><span class="lbl">Screening answers</span>
      ${s.qa.length ? `<dl class="qa">${s.qa.map(([q, a]) => `<dt>${h(q)}</dt><dd${a.length > 120 ? ' class="long"' : ""}>${h(a)}</dd>`).join("")}</dl>` : ""}
      ${s.notes.length ? `<dl class="qa">${s.notes.map(([l, v]) => l ? `<dt>${h(l)}</dt><dd${v.length > 120 ? ' class="long"' : ""}>${h(v)}</dd>` : `<dd class="plain">${h(v)}</dd>`).join("")}</dl>` : ""}
      ${s.exp.length ? `<div class="exp"><span class="lbl">Experience on the application</span><ul>${s.exp.map(expRow).join("")}</ul></div>` : ""}
      ${s.match || s.resume ? `<p class="cmeta">${s.resume ? "Resume attached on LinkedIn. " : ""}${s.match ? `LinkedIn's own match: ${h(s.match)} (LinkedIn's score against the post, not used for the call).` : ""}</p>` : ""}</div>`;
  }
  const kindOf = (d, r) => d.kind === "knockout" ? (r.result === "met" ? ["passes", "ok"] : r.result === "not met" ? ["fails", "bad"] : ["unclear", "warn"])
    : d.kind === "minus" ? (r.result === "met" ? ["red flag", "bad"] : r.result === "not met" ? ["no", ""] : ["unclear", "warn"])
    : (r.result === "met" ? ["yes", "ok"] : r.result === "not met" ? ["no", ""] : ["unclear", "warn"]);
  function readBlock(c) {
    if (blindNow(c)) return `<section class="block read"><div class="readhead"><div><span class="eyebrow">2 · Claude's read</span><h3 class="muted">Hidden until the call is saved</h3></div><span class="cmeta">${h(c.calib_batch)}</span></div>
      <p class="muted small">This record is in a blind calibration batch: open the CV, set the CV check and the call with a reason, and save. Claude's call shows after that and counts toward the agreement on the Calibration tab.</p></section>`;
    // A role can carry two scorecard versions (Brand & Content: v0.3 bc-*, v0.4 bc4-*): show the set this record was read with,
    // or the newest set when it hasn't been read yet.
    const all = criteriaFor(c.role_id), newest = all.length ? all[all.length - 1].source : "";
    const lastVer = (resultsFor(c.id).slice().sort((a, b) => (b.at || "").localeCompare(a.at || ""))[0] || {}).rules_version;
    const res = resultsFor(c.id).filter((x) => x.rules_version === lastVer);
    const defs = res.length ? all.filter((d) => res.some((x) => x.criterion_id === d.id)) : all.filter((d) => d.source === newest);
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
      <p class="muted small">Claude's reading of what she or he sent, against the scorecard, with the words it rests on. It informs the call; nobody is declined on it.</p></section>`;
  }
  async function openCandidate(id) {
    if (wsLive) await wsLive.flush();  // a call note still in its field is saved before any record is read (again)
    if (id) await need("candidates", "cards");
    const c = id ? state.candidates.find((x) => x.id === id) : { stage: "applied", role_id: state.roleFilter !== "all" && state.roleFilter !== "closed" ? state.roleFilter : (openRoles()[0] || {}).id };
    if (!c) { forget(); await render(true); notice(`There's no candidate ${id} in the studio.`, true); return; }
    if (id) {  // the full row (CV, screening answers, written answer, first lines) and this candidate's criteria
      const [full, res, msgs, ws, dec] = await Promise.all([api("candidates/" + encodeURIComponent(id)), api("criteria/results?candidate_id=" + encodeURIComponent(id)), api("messages?candidate_id=" + encodeURIComponent(id)),
        wsLoad(id), api("decisions?candidate_id=" + encodeURIComponent(id), "GET", null, [])]);
      Object.assign(c, full); state.resBy = state.resBy || {}; state.resBy[id] = res; state.msgsBy = state.msgsBy || {}; state.msgsBy[id] = msgs; state.wsBy[id] = ws; state.decBy[id] = dec;
    }
    const sel = (name, opts, val, labels) => `<select name="${name}">${opts.map((o, i) => `<option value="${h(o)}" ${o === (val || "") ? "selected" : ""}>${h(labels ? labels[i] : (o || "–"))}</option>`).join("")}</select>`;
    const kv = (k, v) => v ? `<dt>${h(k)}</dt><dd>${h(v)}</dd>` : "";
    const role = roleOf(c.role_id);
    const furthest = id && reachedIdx(c) > stageIdx(c.stage || "applied") ? stageWord(reachedOf(c)) : "";
    const links = [];
    if (c.linkedin) links.push(linkChip(c.linkedin, "LinkedIn"));
    urlsIn(c.cv).filter((u) => !/linkedin\.com\/hiring\/applicants|drive\.google\.com|docs\.google\.com/.test(u)).forEach((u) => links.push(linkChip(u)));
    const eyebrow = id ? [c.id, roleName(c.role_id) + (isArchivedRole(role) ? " (archived)" : isClosedRole(role) ? " (earlier round)" : ""), c.sources, c.applied ? "applied " + fmt(c.applied) : ""].filter(Boolean).join(" · ") : roleName(c.role_id);
    const application = id ? `<section class="block"><span class="eyebrow">1 · From the application</span>
        <dl class="kv">${kv("Location", c.location)}${kv("Email", c.email)}${kv("English, self-rated", c.english)}${kv("Headline", c.headline)}${kv("Referred by", c.referred_by)}${kv("Furthest stage", furthest)}${kv("Scores", c.scores)}${kv("Latest reply", c.latest_reply)}${kv("Last contact", c.last_contact)}</dl>
        ${screeningBlock(c)}
        ${cvBlock(c)}
        ${links.length ? `<div class="links"><span class="lbl">Links she or he gave</span><div class="chips">${links.join("")}</div>${/drive\.google\.com/.test(c.cv || "") ? `<span class="muted small">The CV sits in hello@'s Drive. If the link asks for access, hello@ needs to share the "Corner Careers — Applications" folder with you once.</span>` : ""}</div>` : ""}
        ${cvCheck(c)}
        ${c.site_answer ? `<div class="answer"><span class="lbl">Written answer</span><p>${h(c.site_answer).replace(/\n+/g, "<br>")}</p></div>` : ""}</section>` : "";
    const callSeg = `${seg("yourcall", [["Shortlist", "Shortlist"], ["Hold", "Hold"], ["Decline", "Decline"]], c.your_call || "")}<input type="hidden" name="your_call" value="${h(c.your_call || "")}">`;
    // 3 · Decisions (12 Nov): three steps, each with the name of the person who makes the call. Screening is the record's own call and
    // saves with the record (it moves the stage as before); the interview and second-interview decisions save one by one.
    const form = `<section class="block"><span class="eyebrow">${id ? "3 · Decisions" : "New candidate"}</span>
      <form class="form" id="cform">
        ${id ? "" : `<label class="full"><span class="lbl">Name</span><input name="name" required></label><label><span class="lbl">Role</span>${sel("role_id", openRoles().map((r) => r.id), c.role_id, openRoles().map((r) => r.short))}</label><label><span class="lbl">Source</span><input name="sources" placeholder="LinkedIn UA, referral…"></label><label class="full"><span class="lbl">LinkedIn</span><input name="linkedin" type="url"></label><label><span class="lbl">Email</span><input name="email" type="email"></label><label><span class="lbl">Location</span><input name="location"></label>`}
        <ul class="full dsteps">
          <li class="dstep"><span class="lbl">1 · Screening</span>
            <div class="drow"><span class="dwho" id="calllabel">${h(callLabel(c))}</span>${callSeg}
              <input name="your_reason" value="${h(c.your_reason)}" placeholder="Reason, needed when the call differs from Claude's" aria-label="Reason">
              <button type="submit" class="btn small">Save</button></div>
            ${id && c.agent_call && !blindNow(c) ? `<span class="hint">Claude suggests <b>${h(c.agent_call)}</b>. For a blind check, make the call before reading the block above.</span>` : ""}</li>
          ${id ? `<li class="dstep" id="dstep-interview">${decisionStep(c, "interview")}</li><li class="dstep" id="dstep-second">${decisionStep(c, "second")}</li>` : ""}
        </ul>
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
      </form></section>`;
    openRecord(id ? c.name : "New candidate", eyebrow, (id && scriptDue(c) ? scriptBlock(c) : "") + application + (id ? readBlock(c) + screenSection(c) : "") + form + (id ? (scriptDue(c) ? "" : scriptBlock(c)) + scoreBlock(c) + wsBlock(c) : ""), id);
    if (id) { bindDecisions(c); bindScoreBlock(c); bindWsBlock(c); bindScreen($("#recbody"), async () => { forget(); await render(true); await openCandidate(id); }); bindReply($("#recbody"), async () => { forget(); await render(true); await openCandidate(id); }); bindCvCheck($("#recbody"), () => render(true)); }
    const f = $("#cform");
    bindSeg(f, "yourcall", (v) => { const cur = $('input[name="your_call"]', f); cur.value = cur.value === v ? "" : v; f.querySelectorAll('[data-seg="yourcall"] button').forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === cur.value)); });
    // After a save: everything is re-read (the Worker moves the stage when the call changes, and keeps reached, hired_at and bounty_due),
    // the page behind redraws in place, and the record reopens with what was stored.
    const reopen = async () => { forget(); await render(true); if (id) await openCandidate(id); else closeRecord(); };
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      if (!id) { await api("candidates", "POST", data); await reopen(); return; }
      // An existing record saves in the background: the change shows at once (the record stays where it is and can be closed
      // straight away), the request runs on, and the list behind redraws from the server when it answers. The stage moves the way
      // the Worker moves it when the call changes, so a second Save doesn't send a stale stage back.
      const before = { ...c }, wasBlind = blindNow(c), saved = $("#csaved"), called = (data.your_call || "") !== (c.your_call || "");
      if (called && ["applied", "triaged", "confirmed", "declined"].includes(data.stage || "applied"))
        data.stage = data.your_call === "Decline" ? "declined" : data.your_call === "Shortlist" ? "confirmed" : c.agent_call ? "triaged" : "applied";
      Object.assign(c, data);
      if (called) c.call_by = data.your_call ? state.boot.who : "";  // the Worker records who made the call; the label shows it at once
      const lab = $("#calllabel"); if (lab) lab.textContent = callLabel(c);
      const stageSel = f.querySelector('select[name="stage"]'); if (stageSel) stageSel.value = c.stage || "applied";
      delete f.dataset.dirty;
      saved.textContent = "Saving…";
      render(true);
      api("candidates/" + id, "PATCH", data).then(async () => {
        if (saved.isConnected) saved.textContent = "Saved";
        const rb = $("#recbody .block.read");
        if (wasBlind && rb && $("#recdlg").open && $("#rectitle").textContent === c.name) rb.outerHTML = readBlock(c);  // a blind record shows Claude's read now
        forget(); await render(true);
      }).catch(async (err) => {
        Object.assign(c, before); if (saved.isConnected) saved.textContent = "Not saved";
        await render(true); notice(`${c.name}: not saved (${err && err.message || err}). Open the record and save again.`, true);
      });
    });
  }
  // Decisions after screening. Interview: Go or No with a reason (needed for a No); whoever saves it is recorded, and each person has one.
  // Second interview: one each from the role's hiring manager and from Kostya (one row when that is the same person). A person edits
  // only their own; everyone else's shows as it was saved. Robots never write these, and they don't move the stage.
  const DSTEPS = { interview: "2 · Interview", second: "3 · Second interview" };
  const decOf = (c, step) => (state.decBy[c.id] || []).filter((d) => d.step === step).sort((a, b) => (a.at || "").localeCompare(b.at || ""));
  function decisionStep(c, step) {
    const me = state.boot.who, role = roleOf(c.role_id), all = decOf(c, step), mine = all.find((d) => d.by === me);
    const shown = (label, d) => `<div class="drow ro"><span class="dwho">${h(label)}</span>${d ? pill(d.call, d.call === "Go" ? "ok" : "bad") : '<span class="muted small">No call yet</span>'}
      <span class="dreason">${d ? h(d.reason) : ""}</span><span class="cmeta">${d ? h(fmt(d.at)) : ""}</span></div>`;
    const edit = (label, d) => `<div class="drow" data-dstep="${step}"><span class="dwho">${h(label)}</span>${seg("dec-" + step, [["Go", "Go"], ["No", "No"]], d ? d.call : "")}
      <input class="dreason" value="${h(d ? d.reason : "")}" placeholder="Reason, needed for a No" aria-label="Reason">
      <span class="dact"><span class="saved" data-dsaved></span><button type="button" class="btn small" data-dsave>Save</button></span></div>`;
    let rows;
    if (step === "interview") {
      const others = all.filter((d) => d.by !== me);
      // nobody decided yet: the row carries the recruiter's name (or just "Call"); the person who saves it is the one recorded
      const label = mine || others.length ? `${firstName(me)}'s call` : role.recruiter ? `${firstName(role.recruiter)}'s call` : "Call";
      rows = others.map((d) => shown(`${firstName(d.by)}'s call`, d)).join("") + edit(label, mine);
    } else {
      const lead = leadEmail(role), deciders = [...new Set([lead, state.boot.final_call].filter(Boolean))];
      const extra = all.filter((d) => !deciders.includes(d.by));  // saved by someone who was the hiring manager then
      rows = deciders.map((by) => by === me ? edit(`${firstName(by)}'s call`, mine) : shown(`${firstName(by)}'s call`, all.find((d) => d.by === by))).join("")
        + extra.map((d) => shown(`${firstName(d.by)}'s call`, d)).join("");
    }
    return `<span class="lbl">${DSTEPS[step]}</span>${rows}`;
  }
  function bindDecisions(c) {
    document.querySelectorAll("#recbody .drow[data-dstep]").forEach((row) => {
      const step = row.dataset.dstep, input = $("input.dreason", row), mark = $("[data-dsaved]", row), btn = $("[data-dsave]", row);
      if (btn.dataset.bound) return;  // a re-render of one step binds its new rows only
      btn.dataset.bound = "1";
      const picked = () => (row.querySelector('[data-seg] button[aria-pressed="true"]') || { dataset: { v: "" } }).dataset.v;
      bindSeg(row, "dec-" + step, (v) => { const cur = picked(); row.querySelectorAll("[data-seg] button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === v && cur !== v)); mark.textContent = ""; });
      const save = async () => {
        const call = picked(), reason = input.value.trim();
        mark.classList.remove("bad");
        if (call === "No" && !reason) { mark.textContent = "Add the reason"; mark.classList.add("bad"); input.focus(); return; }
        btn.disabled = true; mark.textContent = "Saving…";
        try {
          await api(`decisions/${encodeURIComponent(c.id)}/${step}`, "PUT", { call, reason });
          state.decBy[c.id] = await api("decisions?candidate_id=" + encodeURIComponent(c.id));
          const li = $("#dstep-" + step); if (li) { li.innerHTML = decisionStep(c, step); bindDecisions(c); const m = $("#dstep-" + step + " [data-dsaved]"); if (m) m.textContent = call ? "Saved" : "Taken back"; }
        } catch (e) { btn.disabled = false; mark.textContent = "Not saved"; mark.classList.add("bad"); }
      };
      btn.addEventListener("click", save);
      // Enter in the reason saves this decision, not the whole record
      input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); if (!btn.disabled) save(); } });
    });
  }
  // ---------- the message screen: one concern per shortlisted candidate and the LinkedIn message that checks it ----------
  // Claude writes the concern and the message; Kostya edits if he wants, copies it into LinkedIn and marks it sent, which moves the
  // candidate to "messaged". The same panel shows on the Screening view and in the candidate record.
  const SENT = ["messaged", "replied", "screen booked", "screen done", "interview booked", "interview done", "work sample", "references", "offer", "hired"];
  const wasSent = (c) => SENT.includes(c.stage || "");
  // A person's call decides when there is one; otherwise Claude's Shortlist counts.
  const inScreening = (c) => (c.your_call ? c.your_call === "Shortlist" : c.agent_call === "Shortlist") && c.cv_check !== "Not pass" && !blindNow(c) && !CLOSED.includes(c.stage) && !isClosedRole(roleOf(c.role_id));
  // The hiring lead's own look at the CV or portfolio as a work sample (scorecard v0.4, 27 Oct): Pass or Not pass, saved on the click.
  // Only a person sets it; "Not pass" takes the candidate out of Screening.
  const cvCheck = (c) => familyOf(roleOf(c.role_id)) !== "bc" ? "" : `<div class="cvcheck" data-cvc="${h(c.id)}"><span class="lbl">CV / portfolio · your look</span>${seg("cvc", [["Pass", "Pass"], ["Not pass", "Not pass"]], c.cv_check || "")}</div>`;
  function bindCvCheck(root, after) {
    root.querySelectorAll("[data-cvc]").forEach((el) => bindSeg(el, "cvc", async (v) => {
      const id = el.dataset.cvc, c = (state.candidates || []).find((x) => x.id === id) || {}, next = c.cv_check === v ? "" : v;
      el.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      try { await api("candidates/" + id, "PATCH", { cv_check: next }); c.cv_check = next; } finally { el.querySelectorAll("button").forEach((b) => { b.disabled = false; b.setAttribute("aria-pressed", b.dataset.v === c.cv_check); }); }
      if (after) await after();
    }));
  }
  // Conversations (28 Oct): every message with the candidate on LinkedIn, email or Work.ua, both ways, as the robots read them from the inbox.
  const msgsOf = (c) => (state.msgsBy || {})[c.id] || [];
  const repliedAt = (c) => msgsOf(c).filter((m) => m.direction === "in").map((m) => m.at).sort().pop() || "";
  const hasReply = (c) => !!repliedAt(c) || c.stage === "replied";
  const atWord = (s) => { const d = new Date(s); return isNaN(d) ? s : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); };
  const linkify = (t) => h(t).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  const CHANNEL = { linkedin: "LinkedIn", email: "Email", "work.ua": "Work.ua" };
  function convoHtml(c) {
    const list = msgsOf(c);
    if (!list.length) return "";
    const first = (c.name || "").split(" ")[0], n = list.filter((m) => m.direction === "in").length;
    return `<div class="convo"><span class="lbl">Conversation · ${list.length} message${list.length > 1 ? "s" : ""}${n ? ` · ${n} from ${h(first)}` : " · no reply yet"}</span>
      ${list.map((m) => `<div class="msg ${m.direction === "in" ? "in" : "out"}"><div class="mmeta">${m.direction === "in" ? h(first) : "You"} · ${h(CHANNEL[m.channel] || m.channel)} · ${h(atWord(m.at))}</div><div class="mbody">${linkify(m.body)}</div></div>`).join("")}</div>`;
  }
  // The reply draft (28 Oct): Claude drafts the next message to someone who replied (reply_draft) with the step it suggests and why
  // (reply_note). Kostya edits it, sends it himself in the same channel and marks it sent: it joins the conversation and the draft clears.
  const replyChannel = (c) => (msgsOf(c).filter((m) => m.direction === "in").pop() || {}).channel || (c.linkedin ? "linkedin" : "email");
  const replyHtml = (c) => !c.reply_draft ? "" : `<div class="replydraft" data-rid="${h(c.id)}"><span class="lbl">Your reply · on ${h(CHANNEL[replyChannel(c)] || replyChannel(c))} · drafted by Claude, nothing is sent</span>
      ${c.reply_note ? `<p class="rnote">${linkify(c.reply_note)}</p>` : ""}
      <textarea class="scrmsg rmsg" rows="${Math.min(18, Math.max(5, c.reply_draft.split("\n").reduce((n, l) => n + 1 + Math.floor(l.length / 85), 0)))}" aria-label="Reply to ${h(c.name)}">${h(c.reply_draft)}</textarea>
      <div class="pact"><button type="button" class="btn small" data-rcopy>Copy</button><button type="button" class="btn ghost small" data-rsave hidden>Save the edit</button>
        <button type="button" class="btn ghost small" data-rsent>Mark reply sent</button></div></div>`;
  function bindReply(root, after) {
    root.querySelectorAll(".replydraft").forEach((p) => {
      const id = p.dataset.rid, ta = $(".rmsg", p), save = $("[data-rsave]", p), copy = $("[data-rcopy]", p), sent = $("[data-rsent]", p), orig = ta.value;
      ta.addEventListener("input", () => { save.hidden = ta.value === orig; ta.dataset.dirty = ta.value === orig ? "" : "1"; });
      copy.addEventListener("click", () => {
        const ok = () => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1600); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(ok, () => { ta.select(); copy.textContent = "Selected: press ⌘C"; });
        else { ta.select(); copy.textContent = "Selected: press ⌘C"; }
      });
      save.addEventListener("click", async () => { save.disabled = true; await api("candidates/" + id, "PATCH", { reply_draft: ta.value }); await after(); });
      sent.addEventListener("click", async () => {
        sent.disabled = true;
        const c = (state.candidates || []).find((x) => x.id === id) || { id }, at = new Date().toISOString();
        await api("messages/upsert", "POST", [{ candidate_id: id, channel: replyChannel(c), direction: "out", author: "Kostya", at, body: ta.value, ext_id: "studio|" + at }]);
        await api("candidates/" + id, "PATCH", { reply_draft: "", reply_note: "", last_contact: today() });
        state.msgs = null; await after();
      });
    });
  }
  async function loadMsgs() {
    if (!state.msgs) { state.msgs = await api("messages"); state.msgsBy = {}; for (const m of state.msgs) (state.msgsBy[m.candidate_id] = state.msgsBy[m.candidate_id] || []).push(m); }
  }
  function screenPanel(c) {
    if (!c.screen_concern && !c.screen_message) return `<p class="muted small">No concern written yet. Claude writes one for every shortlisted candidate.</p>${convoHtml(c)}${replyHtml(c)}`;
    return `<div class="scrpanel" data-sid="${h(c.id)}">
      <div class="scrcol"><span class="lbl">Concern to verify</span><p class="concern">${h(c.screen_concern)}</p></div>
      <div class="scrcol"><span class="lbl">Message to send on LinkedIn</span><textarea class="scrmsg" rows="7" aria-label="Message to ${h(c.name)}">${h(c.screen_message)}</textarea>
        <div class="pact"><button type="button" class="btn small" data-copy>Copy</button><button type="button" class="btn ghost small" data-savemsg hidden>Save the edit</button>
          ${wasSent(c) ? `<span class="pill ok">sent${c.last_contact ? " " + h(fmt(c.last_contact)) : ""}</span>` : `<button type="button" class="btn ghost small" data-sent>Mark as sent</button>`}
          ${cvOpen(c, "btn small")}
          ${c.linkedin ? `<a class="btn ghost small" href="${h(c.linkedin)}" target="_blank" rel="noopener">LinkedIn ↗</a>` : ""}
          ${urlsIn(c.cv).filter((u) => /linkedin\.com\/hiring\/applicants/.test(u)).map((u) => `<a class="btn ghost small" href="${h(u)}" target="_blank" rel="noopener">Application ↗</a>`).join("")}</div>
        ${c.latest_reply && !repliedAt(c) ? `<div class="answer"><span class="lbl">Latest reply</span><p>${h(c.latest_reply)}</p></div>` : ""}</div>${convoHtml(c)}${replyHtml(c)}</div>`;
  }
  const screenSection = (c) => blindNow(c) ? "" : inScreening(c) || c.screen_concern ? `<section class="block"><span class="eyebrow">Message screen</span>${screenPanel(c)}</section>` : "";
  // The interview script (27 Oct): the candidate's prep sheet in Markdown, written before the call and filled with the answers after it.
  // Rendered safely: everything is escaped first, then a small subset is turned on (headings, tables, lists, bold, code, http links).
  const mdInline = (t) => h(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  function mdToHtml(md) {
    const lines = String(md || "").replace(/\r/g, "").split("\n"), out = [];
    const isRow = (l) => /^\s*\|.*\|\s*$/.test(l), isItem = (l) => /^\s*([-*]|\d+\.)\s+/.test(l), isHead = (l) => /^#{1,6}\s/.test(l);
    const cells = (l) => l.trim().replace(/\\\|/g, "\u0001").replace(/^\||\|$/g, "").split("|").map((x) => x.trim().replace(/\u0001/g, "|"));
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      const m = l.match(/^(#{1,6})\s+(.*)$/);
      if (m) { const n = Math.min(m[1].length + 2, 6); out.push(`<h${n}>${mdInline(m[2])}</h${n}>`); i++; continue; }
      if (isRow(l)) {
        const rows = []; while (i < lines.length && isRow(lines[i])) rows.push(lines[i++]);
        const [head, ...rest] = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
        out.push(`<div class="tablewrap"><table><thead><tr>${cells(head).map((x) => `<th>${mdInline(x)}</th>`).join("")}</tr></thead><tbody>${rest.map((r) => `<tr>${cells(r).map((x) => `<td>${mdInline(x)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }
      if (isItem(l)) {
        const ordered = /^\s*\d+\./.test(l), items = [];
        while (i < lines.length && isItem(lines[i])) { items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, "")); while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !isItem(lines[i])) items[items.length - 1] += " " + lines[i++].trim(); }
        out.push(`<${ordered ? "ol" : "ul"}>${items.map((t) => `<li>${mdInline(t)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
        continue;
      }
      const para = []; while (i < lines.length && lines[i].trim() && !isHead(lines[i]) && !isRow(lines[i]) && !isItem(lines[i])) para.push(lines[i++].trim());
      out.push(`<p>${mdInline(para.join(" "))}</p>`);
    }
    return out.join("");
  }
  const scriptDue = (c) => /^(interview|screen) booked$/.test(c.stage || "");
  function scriptBlock(c) {
    if (!c.interview_sheet) return "";
    const md = c.interview_sheet.replace(/^\s*#\s+([^\n]+)\n/, ""), title = (c.interview_sheet.match(/^\s*#\s+([^\n]+)/) || [0, "Interview script"])[1];
    return `<section class="block" id="scriptblock"><span class="eyebrow">Interview script</span>
      <details class="fold plain mdoc"${scriptDue(c) ? " open" : ""}><summary>${h(title)}</summary>${mdToHtml(md)}</details></section>`;
  }
  function bindScreen(root, after) {
    root.querySelectorAll(".scrpanel").forEach((p) => {
      const id = p.dataset.sid, ta = $(".scrmsg", p), save = $("[data-savemsg]", p), copy = $("[data-copy]", p), sent = $("[data-sent]", p);
      const orig = ta.value;
      ta.addEventListener("input", () => { save.hidden = ta.value === orig; ta.dataset.dirty = ta.value === orig ? "" : "1"; });
      copy.addEventListener("click", () => {
        const ok = () => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1600); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(ok, () => { ta.select(); copy.textContent = "Selected: press ⌘C"; });
        else { ta.select(); copy.textContent = "Selected: press ⌘C"; }
      });
      save.addEventListener("click", async () => { save.disabled = true; await api("candidates/" + id, "PATCH", { screen_message: ta.value }); await after(); });
      if (sent) sent.addEventListener("click", async () => {
        sent.disabled = true;
        const patch = { stage: "messaged", last_contact: today(), next_step: "Wait for the reply; nudge after 5 working days" };
        if (ta.value !== orig) patch.screen_message = ta.value;
        await api("candidates/" + id, "PATCH", patch); await after();
      });
    });
  }
  async function renderScreening(view) {
    await need("candidates"); await loadMsgs();
    const all = state.candidates.filter(inScreening).filter(inRole);
    const pick = { tosend: (c) => !wasSent(c), sent: wasSent, replied: hasReply, all: () => true }[state.screenFilter] || (() => true);
    const list = all.filter(pick).sort((a, b) => (state.screenFilter === "replied" ? repliedAt(b).localeCompare(repliedAt(a)) : 0) || (wasSent(a) - wasSent(b)) || a.role_id.localeCompare(b.role_id) || (CONF_RANK[a.confidence] ?? 3) - (CONF_RANK[b.confidence] ?? 3) || a.name.localeCompare(b.name));
    const toSend = all.filter((c) => !wasSent(c)).length, noConcern = all.filter((c) => !c.screen_concern).length, replied = all.filter(hasReply).length, drafts = all.filter((c) => c.reply_draft).length;
    view.innerHTML = head("Screening", `One message per shortlisted candidate, asking the one thing we need to verify. ${toSend} to send · ${all.length - toSend} sent · ${replied} replied${drafts ? ` · ${drafts} repl${drafts > 1 ? "ies" : "y"} drafted` : ""}${noConcern ? ` · ${noConcern} without a concern yet` : ""}`,
      seg("scrf", [["tosend", "To send"], ["sent", "Sent"], ["replied", `Replied · ${replied}`], ["all", "All"]], state.screenFilter)) +
      `<div class="toolbar">${roleSeg()}</div>
      <p class="muted small">Everyone with a Shortlist call, and everyone Claude shortlisted who has no call yet. Edit the message if you want, copy it into LinkedIn (the Application button opens their application, where messaging is free), then mark it sent: the candidate moves to "messaged".</p>
      ${list.length ? list.map((c) => `<article class="card scrcard"><div class="scrwho"><button type="button" class="linkbtn name" data-open="${h(c.id)}">${h(c.name)}</button>
          <span class="muted small">${h(c.id)} · ${h(roleName(c.role_id))}${c.location ? " · " + h(c.location) : ""}</span>
          <div class="chips">${callPill(c.agent_call)}${confWord(c.confidence)}${c.your_call ? `<span class="muted small">${h(callBy(c) ? firstName(callBy(c)) : "call")}:</span>${callPill(c.your_call)}` : ""}</div>
          ${c.why ? `<p class="small">${h(c.why)}</p>` : ""}${cvCheck(c)}</div>${screenPanel(c)}</article>`).join("")
        : `<div class="card empty">${state.screenFilter === "tosend" ? "Nothing left to send." : "Nobody here yet."}</div>`}`;
    bindSeg(view, "scrf", (v) => { state.screenFilter = v; renderScreening(view); });
    bindSeg(view, "role", (v) => { state.roleFilter = v; renderScreening(view); });
    view.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openCandidate(b.dataset.open)));
    bindScreen(view, async () => { state.candidates = null; await renderScreening(view); });
    bindReply(view, async () => { state.candidates = null; await renderScreening(view); });
    bindCvCheck(view, async () => { await renderScreening(view); });
  }

  // ---------- interview scorecards: the AI recruiter drafts, people confirm or edit, Studio puts the scorers side by side ----------
  const scorerName = (s) => s === "ai" ? "AI recruiter" : whoName(s);
  const scorerRank = (s) => { if (s === "ai") return 0; const i = people().findIndex((x) => x.email === s); return i < 0 ? 99 : i + 1; };  // the AI's card first, then people in the order they got a login
  function rubricOf(roleId) {
    const fam = familyOf(roleOf(roleId)), rule = (state.boot.rubric_rules || []).find((r) => r.role_id === fam);
    if (!rule) return null;
    const rows = (state.boot.rubrics || []).filter((r) => r.role_id === fam);
    return { fam, rule, stages: JSON.parse(rule.stages || "[]"), scored: rows.filter((r) => r.kind !== "must_pass"), must: rows.find((r) => r.kind === "must_pass") || null };
  }
  const cardsFor = (cid) => (state.cards || []).filter((k) => k.candidate_id === cid);
  const itemOf = (card, cid) => (card.items || []).find((i) => i.criterion_id === cid) || {};
  const mustPill = (m) => m ? pill(m, m === "pass" ? "ok" : m === "fail" ? "bad" : "warn") : '<span class="muted">–</span>';
  const decisionPill = (d) => pill(d || "–", d === "meets" ? "ok" : d === "partial" ? "" : d ? "bad" : "");
  const quotesHtml = (qs) => qs && qs.length ? `<details class="q"><summary>${qs.length} quote${qs.length > 1 ? "s" : ""}</summary><ul>${qs.map((q) => `<li>“${h(q.text)}”${q.at ? ` <span class="cmeta">${h(q.at)}</span>` : ""}</li>`).join("")}</ul></details>` : "";
  function scoreBlock(c) {
    const rub = rubricOf(c.role_id);
    if (!rub) return "";
    const cards = cardsFor(c.id), me = state.boot.who;
    const firstWith = rub.stages.find(([st]) => cards.some((k) => k.stage === st));
    const cur = state.cardStage[c.id] || (firstWith || rub.stages[0])[0];
    const curLabel = (rub.stages.find(([st]) => st === cur) || [cur, cur])[1];
    const here = cards.filter((k) => k.stage === cur).sort((a, b) => scorerRank(a.scorer) - scorerRank(b.scorer));
    const ai = here.find((k) => k.scorer === "ai"), mine = here.find((k) => k.scorer === me);
    const edit = state.cardEdit && state.cardEdit.cid === c.id && state.cardEdit.stage === cur ? state.cardEdit : null;
    const tabs = seg("cardstage", rub.stages.map(([st, l]) => [st, l + (cards.some((k) => k.stage === st) ? ` · ${cards.filter((k) => k.stage === st).length}` : "")]), cur);
    const tested = (r) => (r.stages || "").split(",").includes(cur);
    const rowsFor = rub.scored.filter((r) => tested(r) || here.some((k) => itemOf(k, r.id).score != null));
    const untested = rub.scored.filter((r) => !rowsFor.includes(r));
    let gaps = 0;
    const head = `<tr><th>Criterion</th>${here.map((k) => `<th>${h(scorerName(k.scorer))}<small>${k.kind === "ai" ? "draft from the transcript" : k.entered_by ? "entered for them" : k.started_from === "draft" ? "started from the draft" : "scored blind"}${k.hindsight ? " · after the outcome" : ""}</small></th>`).join("")}</tr>`;
    const body = rowsFor.map((r) => {
      const vals = here.map((k) => itemOf(k, r.id).score).filter((v) => v != null);
      const gap = vals.length > 1 ? Math.max(...vals) - Math.min(...vals) : 0;
      if (gap > 1) gaps++;
      return `<tr class="${gap > 1 ? "gap" : ""}"><td><span class="clabel">${h(r.label)}</span><small>${r.weight}%${r.min_score ? ` · at least ${r.min_score}` : ""}${tested(r) ? "" : " · not usually tested here"}</small>${gap > 1 ? pill("gap " + gap, "warn") : ""}</td>
        ${here.map((k) => { const it = itemOf(k, r.id); return `<td>${it.score != null ? `<b class="sc">${it.score}</b>` : '<span class="muted">–</span>'}${it.note ? `<span class="scnote">${h(it.note)}</span>` : ""}${quotesHtml(it.quotes)}</td>`; }).join("")}</tr>`;
    }).join("");
    const mustRow = rub.must && (rub.must.stages.split(",").includes(cur) || here.some((k) => k.must_pass)) ? (() => {
      const set = here.map((k) => k.must_pass).filter((m) => m === "pass" || m === "fail");
      const split = set.includes("pass") && set.includes("fail");
      if (split) gaps++;
      return `<tr class="mustrow ${split ? "gap" : ""}"><td><span class="clabel">Must-pass: ${h(rub.must.label)}</span>${split ? pill("scorers disagree", "warn") : ""}</td>${here.map((k) => `<td>${mustPill(k.must_pass)}${k.must_pass_note ? `<span class="scnote">${h(k.must_pass_note)}</span>` : ""}</td>`).join("")}</tr>`;
    })() : "";
    const foot = `<tr class="totrow"><td><span class="clabel">Weighted so far</span><small>over the criteria each card scored</small></td>${here.map((k) => `<td><b class="sc">${k.weighted != null ? Number(k.weighted).toFixed(2) : "–"}</b><small>${k.scored} of ${rub.scored.length}</small></td>`).join("")}</tr>
      <tr class="totrow"><td><span class="clabel">Decision rule</span></td>${here.map((k) => `<td>${decisionPill(k.decision)}</td>`).join("")}</tr>`;
    const tableHtml = here.length ? `<div class="tablewrap sctable"><table><thead>${head}</thead><tbody>${body}${mustRow}${foot}</tbody></table></div>
      ${untested.length ? `<p class="muted small">Tested at other stages: ${untested.map((r) => h(r.label)).join(", ")}.</p>` : ""}
      ${here.map((k) => k.summary ? `<p class="small scsum"><b>${h(scorerName(k.scorer))}:</b> ${h(k.summary)}</p>` : "").join("")}
      ${here.filter((k) => k.source).map((k) => `<p class="muted small">${h(scorerName(k.scorer))} · ${k.entered_by ? "entered by Claude from " : "from "}${h(k.source)}</p>`).join("")}` : "";
    let actions = "";
    if (!edit) actions = mine ? `<button type="button" class="btn ghost small" data-scstart="edit">Edit my card</button>`
      : `${ai ? `<button type="button" class="btn small" data-scstart="draft">Confirm or edit the AI draft</button>` : ""}<button type="button" class="btn ${ai ? "ghost " : ""}small" data-scstart="blank">Score ${ai ? "blind" : "this stage"}</button>`;
    const known = ["hired", "declined", "not now"].includes(c.stage) || isClosedRole(roleOf(c.role_id));
    const hideForBlind = !mine && here.length && !known && (!edit || edit.mode === "blank");
    const shown = edit && edit.mode === "blank" ? `<p class="muted small">The other cards stay hidden until you save yours, so they don't steer your scores.</p>`
      : hideForBlind ? `<details class="fold plain"><summary>Show the ${here.length} card${here.length > 1 ? "s" : ""} for this stage${gaps ? ` · ${gaps} gap${gaps > 1 ? "s" : ""} over one point` : ""}</summary>${tableHtml}</details>
        <p class="muted small">You haven't scored this stage yet. Score blind first if you want your card to count as an independent check.</p>` : tableHtml;
    return `<section class="block" id="scoreblock"><div class="readhead"><div><span class="eyebrow">4 · Interview scorecards</span><h3>${h(curLabel)}${gaps && !hideForBlind ? ` <span class="muted">· ${gaps} gap${gaps > 1 ? "s" : ""} over one point</span>` : ""}</h3></div><span class="cmeta">${h(rub.rule.version || "")}</span></div>
      ${tabs}
      ${here.length ? "" : `<p class="muted">No cards for this stage yet. The AI recruiter drafts one from the recording's transcript; you confirm or edit it.</p>`}
      ${shown}
      ${known ? `<p class="muted small">This candidate's outcome is already known, so cards saved here can't be blind. They show the rubric at work but don't count in Calibration.</p>` : ""}
      ${actions ? `<div class="pact">${actions}</div>` : ""}
      ${edit ? cardEditor(c, rub, cur, edit, ai, mine) : ""}
      <p class="muted small">${h(rub.rule.decision)} The AI recruiter's card is advice; the people who interview decide.</p></section>`;
  }
  function cardEditor(c, rub, stage, edit, ai, mine) {
    const base = edit.mode === "edit" ? mine : edit.mode === "draft" ? ai : null;
    const val = (r) => base ? itemOf(base, r.id) : {};
    const scoreSeg = (r) => { const v = val(r).score; return `${seg("sc-" + r.id, [["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"], ["", "–"]], v == null ? "" : String(v))}<input type="hidden" name="score:${h(r.id)}" value="${v == null ? "" : v}">`; };
    const tested = (r) => (r.stages || "").split(",").includes(stage);
    const row = (r) => { const a = edit.mode !== "blank" && ai ? itemOf(ai, r.id) : null;
      return `<div class="scedit"><div class="schead"><span class="clabel">${h(r.label)}</span><small>${r.weight}%${r.min_score ? ` · at least ${r.min_score}` : ""}</small></div>
        <div class="anchors"><span><b>1</b> ${h(r.anchor_1)}</span><span><b>4</b> ${h(r.anchor_4)}</span></div>
        ${a && a.score != null ? `<div class="aibox"><span class="lbl">AI recruiter: ${a.score}</span>${a.note ? `<span class="scnote">${h(a.note)}</span>` : ""}${quotesHtml(a.quotes)}</div>` : ""}
        <div class="scctl">${scoreSeg(r)}<input name="note:${h(r.id)}" value="${h(val(r).note || "")}" placeholder="Why, in one line"></div></div>`; };
    const main = rub.scored.filter(tested), rest = rub.scored.filter((r) => !tested(r));
    const m = base ? base.must_pass || "" : "";
    return `<form id="scform" class="scform"><span class="lbl">${edit.mode === "edit" ? "Your card" : edit.mode === "draft" ? "Your card, starting from the AI draft" : "Your card, scored blind"} · ${h(scorerName(state.boot.who))}</span>
      ${main.map(row).join("")}
      ${rest.length ? `<details class="fold plain"><summary>Criteria usually tested at other stages (${rest.length})</summary>${rest.map(row).join("")}</details>` : ""}
      ${rub.must ? `<div class="scedit"><div class="schead"><span class="clabel">Must-pass: ${h(rub.must.label)}</span></div><div class="anchors"><span><b>Pass</b> ${h(rub.must.anchor_4)}</span><span><b>Fail</b> ${h(rub.must.anchor_1)}</span></div>
        <div class="scctl">${seg("scmust", [["pass", "Pass"], ["fail", "Fail"], ["unclear", "Unclear"], ["", "–"]], m)}<input type="hidden" name="must_pass" value="${h(m)}"><input name="must_pass_note" value="${h(base ? base.must_pass_note || "" : "")}" placeholder="What decided it"></div></div>` : ""}
      <label><span class="lbl">Summary</span><textarea name="summary" rows="3">${h(edit.mode === "edit" && mine ? mine.summary || "" : "")}</textarea></label>
      <div class="formfoot"><button type="button" class="btn ghost small" data-sccancel>Cancel</button><button type="submit" class="btn">Save my card</button></div></form>`;
  }
  function bindScoreBlock(c) {
    const el = $("#scoreblock");
    if (!el) return;
    const again = () => { const cur = $("#scoreblock"); if (cur) { cur.outerHTML = scoreBlock(c); bindScoreBlock(c); } };
    bindSeg(el, "cardstage", (v) => { state.cardStage[c.id] = v; state.cardEdit = null; again(); });
    el.querySelectorAll("[data-scstart]").forEach((b) => b.addEventListener("click", () => {
      state.cardEdit = { cid: c.id, stage: state.cardStage[c.id] || (el.querySelector('[data-seg="cardstage"] [aria-pressed="true"]') || {}).dataset.v, mode: b.dataset.scstart };
      again(); const f = $("#scform"); if (f) f.scrollIntoView({ block: "start", behavior: "smooth" });
    }));
    const f = $("#scform");
    if (!f) return;
    f.querySelectorAll("[data-seg]").forEach((g) => { const name = g.dataset.seg; bindSeg(f, name, (v) => {
      const input = name === "scmust" ? $('input[name="must_pass"]', f) : $(`input[name="score:${CSS.escape(name.slice(3))}"]`, f);
      input.value = v; g.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === v)); }); });
    $("[data-sccancel]", f).addEventListener("click", () => { state.cardEdit = null; again(); });
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f).entries()), edit = state.cardEdit;
      const items = Object.keys(d).filter((k) => k.startsWith("score:")).map((k) => { const id = k.slice(6); return { criterion_id: id, score: d[k] === "" ? null : Number(d[k]), note: d["note:" + id] || "" }; });
      const mine = cardsFor(c.id).find((k) => k.stage === edit.stage && k.scorer === state.boot.who);
      await api("scorecards", "POST", { candidate_id: c.id, stage: edit.stage, items, must_pass: d.must_pass, must_pass_note: d.must_pass_note, summary: d.summary,
        started_from: edit.mode === "edit" ? (mine && mine.started_from) || "blank" : edit.mode });
      state.cards = await api("scorecards"); state.cardEdit = null; again(); wsScoreRefresh(c);
    });
  }

  // ---------- the work sample (5 Nov): the test assignment the candidate sent back, what doesn't hold in it, and the questions for the call ----------
  // A person or a robot stores the file (or the link to a Google Doc); the Worker then moves an earlier stage to "work sample". The AI
  // recruiter scores it on a worksample card (block 4) and writes the flaws and the questions. People tick a question as asked and note
  // what they heard: ticks and notes are people's only, and a robot's new list keeps them.
  const WS_FLAWS = [["not delivered", "Asked in the brief, not delivered"], ["evidence", "Evidence that doesn't hold"], ["judgement", "Judgement calls to probe"],
    ["against earlier interview", "Against the earlier interview"], ["ours", "Ours, not the candidate's"]];
  const WS_MAX = 20_000_000;
  const WS_TYPES = { pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    odt: "application/vnd.oasis.opendocument.text", rtf: "application/rtf", txt: "text/plain", md: "text/markdown", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  // { meta, flaws, questions }; null when the Worker doesn't have the route yet (the block stays hidden); a failed read shows in the block
  const wsLoad = (id) => api("worksample/" + encodeURIComponent(id), "GET", null, null).catch((e) => ({ failed: String((e && e.message) || e) }));
  const wsOf = (c) => state.wsBy[c.id];
  const wsHas = (w) => !!(w && !w.failed && (w.meta || (w.flaws || []).length || (w.questions || []).length));
  const wsInRubric = (c) => { const rub = rubricOf(c.role_id); return !!(rub && rub.stages.some(([st]) => st === "worksample")); };
  const wsShown = (c) => wsHas(wsOf(c)) || reachedIdx(c) >= stageIdx("work sample") || wsInRubric(c);
  const wsWhen = (s) => !s ? "" : /T\d{2}:\d{2}/.test(s) ? fmtTime(s) : fmt(s);
  // The type comes from the file's extension through this list, never from the browser's own guess: an .html or .svg sent as itself would
  // open as a page on Studio's address (5 Nov review). The Worker keeps the same list and serves anything else as a plain download.
  const wsType = (f) => WS_TYPES[((f.name.match(/\.([a-z0-9]+)$/i) || [])[1] || "").toLowerCase()] || "application/octet-stream";
  // Header values must be Latin-1, and file names are often Ukrainian ("МЕБЕЛЬ.pdf"): sent percent-encoded as UTF-8, the Worker decodes them
  const headerSafe = (s) => encodeURIComponent(s);
  // A flaw named in a question's "probes": its first sentence, or its first 60 characters
  const wsShort = (t) => { const first = String(t || "").trim().split(/(?<=[.?!])\s/)[0].replace(/\.$/, "");
    return first.length <= 70 ? first : first.slice(0, 60).replace(/\s+\S*$/, "") + "…"; };
  // The score in one line, from the worksample cards block 4 already loaded. Like block 4, the cards stay folded for someone who
  // hasn't scored this stage yet, so they can score blind first.
  function wsScoreHtml(c) {
    const cards = cardsFor(c.id).filter((k) => k.stage === "worksample").sort((a, b) => scorerRank(a.scorer) - scorerRank(b.scorer));
    const go = rubricOf(c.role_id) ? `<button type="button" class="linkbtn small" data-wsgo>Work sample tab in block 4</button>` : "";
    const one = (k) => `<span class="wsscorer">${h(scorerName(k.scorer))} <b>${k.weighted != null ? Number(k.weighted).toFixed(2) : "–"}</b>${decisionPill(k.decision)}${k.must_pass === "fail" ? pill("must-pass fail", "bad") : ""}</span>`;
    const ai = cards.filter((k) => k.scorer === "ai"), people = cards.filter((k) => k.scorer !== "ai");
    const known = ["hired", "declined", "not now"].includes(c.stage) || isClosedRole(roleOf(c.role_id));
    const line = `<div class="wsscores">${ai.map(one).join("")}${people.length ? people.map(one).join("") : '<span class="muted small">no person\'s card yet</span>'}</div>`;
    const body = !cards.length ? `<span class="muted">No card yet.</span>`
      : !known && !cards.some((k) => k.scorer === state.boot.who) ? `<details class="fold plain"><summary>${cards.length} card${cards.length > 1 ? "s" : ""}, folded until you score this stage</summary>${line}</details>` : line;
    return `<div class="wsscore" id="wsscore"><span class="lbl">Score</span>${body}${go}</div>`;
  }
  function wsFlawsHtml(flaws) {
    if (!flaws.length) return "";
    const fixed = WS_FLAWS.map(([g]) => g), groups = WS_FLAWS.concat(flaws.some((f) => !fixed.includes(f.grp)) ? [["", "Other"]] : []);
    return `<div class="wsgroup"><h4 class="wsh">What's missing or doesn't hold <span class="muted">· ${flaws.length}</span></h4>${groups.map(([g, label]) => {
      const list = flaws.filter((f) => g ? f.grp === g : !fixed.includes(f.grp));
      return list.length ? `<div class="wsgrp"><span class="lbl">${h(label)} · ${list.length}</span><ul class="wslist">${list.map((f) =>
        `<li class="wsflaw"><span class="wstext">${h(f.text)}</span>${f.evidence ? `<q class="wsev">${h(f.evidence)}</q>` : ""}</li>`).join("")}</ul></div>` : "";
    }).join("")}</div>`;
  }
  function wsQuestionsHtml(qs, flaws) {
    if (!qs.length) return "";
    const blocks = []; qs.forEach((q) => { if (!blocks.includes(q.grp || "")) blocks.push(q.grp || ""); });  // the call's blocks, in the list's order
    const probe = (key) => { const f = flaws.find((x) => x.key === key); return f ? wsShort(f.text) : key; };
    let n = 0;
    return `<form class="wsgroup" data-wsq><h4 class="wsh">Questions for the call <span class="muted" data-wscount>· ${qs.filter((q) => q.asked).length} of ${qs.length} asked</span></h4>${blocks.map((g) =>
      `<div class="wsgrp">${g ? `<span class="lbl">${h(g)}</span>` : ""}<ul class="wsqs">${qs.filter((q) => (q.grp || "") === g).map((q) => {
        n++; const refs = String(q.ref || "").split(",").map((s) => s.trim()).filter(Boolean);
        return `<li class="wsq${q.asked ? " asked" : ""}" data-key="${h(q.key)}"><div class="wsqhead"><span class="wsn">${n}</span><span class="wstext">${h(q.text)}</span></div>
          ${refs.length ? `<span class="wsprobe">probes: ${refs.map((r) => h(probe(r))).join("; ")}</span>` : ""}
          <div class="wsqctl"><label class="wsask"><input type="checkbox" class="tick"${q.asked ? " checked" : ""} aria-label="Question ${n} asked"><span>asked</span></label>
            <textarea class="wsnote" rows="${q.call_note ? 3 : 1}" placeholder="What she or he said" aria-label="Note on question ${n}">${h(q.call_note)}</textarea></div>
          <span class="saved" data-wssaved hidden></span></li>`; }).join("")}</ul></div>`).join("")}</form>`;
  }
  function wsBlock(c) {
    const w = wsOf(c);
    if (w == null || !wsShown(c)) return "";
    if (w.failed) return `<section class="block" id="wsblock"><span class="eyebrow">5 · Work sample</span><p class="muted small">The work sample didn't load (${h(w.failed)}). Close the record and open it again.</p></section>`;
    const m = w.meta || {}, flaws = w.flaws || [], qs = w.questions || [], items = flaws.concat(qs);
    const hasFile = Number(m.size) > 0, link = /^https?:\/\/\S+$/i.test(m.link || "") ? m.link : "";
    // the host exactly: "docs.google.com.evil.example" is not a Google Doc (5 Nov review)
    const linkLabel = (u) => { const host = hostOf(u); return host === "docs.google.com" ? "Google Doc" : host === "drive.google.com" ? "Google Drive" : host; };
    const latest = items.slice().sort((a, b) => (b.updated_at || b.created_at || "").localeCompare(a.updated_at || a.created_at || ""))[0];
    const facts = [m.filename, m.stored_at ? `stored ${fmt(m.stored_at)}${m.by ? " by " + whoName(m.by) : ""}` : ""].filter(Boolean);
    const head = `<div class="readhead"><div><span class="eyebrow">5 · Work sample</span><h3>${w.meta ? (m.received_at ? "Received " + h(wsWhen(m.received_at)) : "Received") : '<span class="muted">Nothing received yet</span>'}${m.source ? ` <span class="muted">· ${h(m.source)}</span>` : ""}</h3></div>
      ${latest ? `<span class="cmeta">Flaws and questions · ${h(whoName(latest.by) || "–")}${latest.updated_at || latest.created_at ? " · " + h(fmt(latest.updated_at || latest.created_at)) : ""}</span>` : ""}</div>`;
    const file = w.meta ? `<div class="wsfile"><div class="chips">${hasFile ? `<a class="chip link cvopen" href="${API}worksample/${encodeURIComponent(c.id)}/file" target="_blank" rel="noopener" title="${h(m.filename || c.ws_file)}">Open work sample ↗</a>` : ""}${link ? linkChip(link, linkLabel(link)) : ""}</div>
        ${c.ws_file ? `<span class="cmeta">${h(c.ws_file)}</span>` : ""}${facts.length ? `<span class="cmeta">${h(facts.join(" · "))}</span>` : ""}</div>`
      : `<p class="muted small">When the candidate sends the completed test assignment, upload the file here or add the link to their Google Doc. The robots do the same when it arrives on LinkedIn or by email.</p>`;
    const upload = `<details class="fold plain wsup"${w.meta ? "" : " open"}><summary>${w.meta ? "Replace the file or the link" : "Upload the file or add a link"}</summary>
      <form class="wsform" data-wsup>
        <label><span class="lbl">Received</span><input type="date" name="received" value="${h(today())}"></label>
        <label><span class="lbl">Channel</span><input name="source" value="${h(m.source || "")}" placeholder="LinkedIn, email…" list="wschannels"></label>
        <datalist id="wschannels"><option value="LinkedIn"><option value="Email"><option value="Work.ua"><option value="Telegram"></datalist>
        <div class="wsrow"><input type="file" name="file" accept=".pdf,.doc,.docx,.odt,.rtf,.txt,.md,.pptx,.xlsx,.png,.jpg,.jpeg" aria-label="Work sample file"><button type="button" class="btn small" data-wsact="file">Upload</button></div>
        <div class="wsrow"><input type="url" name="link" placeholder="https://docs.google.com/…" aria-label="Link to the work sample"><button type="button" class="btn ghost small" data-wsact="link">Add link</button></div>
        <span class="saved" data-wsupsaved></span>
        <p class="muted small">PDF, Word or a Google Doc link, up to 20 MB. Storing one moves an earlier stage to "work sample"; it never moves a stage back.${hasFile ? ' <button type="button" class="linkbtn" data-wsdel>Remove the stored file</button> (the link stays).' : ""}</p>
      </form></details>`;
    return `<section class="block" id="wsblock">${head}${file}
      ${wsScoreHtml(c)}
      ${wsFlawsHtml(flaws)}
      ${wsQuestionsHtml(qs, flaws)}
      ${w.meta && !items.length ? `<p class="muted small">No flaws or questions yet. The AI recruiter writes them when it scores the document.</p>` : ""}
      ${upload}
      <p class="muted small">The AI recruiter reads the document against the brief the candidate got and the role's review guide. The flaws and questions prepare the call; nobody is declined on them. Ticks and notes are yours: a robot's new list keeps them.</p></section>`;
  }
  // The open record's call notes (5 Nov review). A note saves when it loses focus, and whatever is still unsaved goes before any record is
  // read (again) and when the record closes: an upload or a link used to redraw the record from a read made before the note went, so the
  // field came back with the old note and without focus. Typing that lands while the record is being read again is carried over the redraw.
  let wsLive = null, wsCarry = null;  // wsLive: { cid, flush() → Promise, unsaved() → { key: text }, focused() → { key, start, end } | null }
  $("#recdlg").addEventListener("close", () => { if (wsLive) wsLive.flush(); });
  function bindWsGo(c) {
    const b = $("#wsblock [data-wsgo]");
    if (b) b.addEventListener("click", () => {
      const sb = $("#scoreblock"); if (!sb) return;
      state.cardStage[c.id] = "worksample"; state.cardEdit = null;
      sb.outerHTML = scoreBlock(c); bindScoreBlock(c);
      $("#scoreblock").scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }
  function wsScoreRefresh(c) { const el = $("#wsscore"); if (el) { el.outerHTML = wsScoreHtml(c); bindWsGo(c); } }
  function bindWsBlock(c) {
    const el = $("#wsblock"), carry = wsCarry && wsCarry.cid === c.id ? wsCarry : null;
    wsLive = null; wsCarry = null;
    if (!el) return;
    const id = c.id, w = wsOf(c) || {}, path = "worksample/" + encodeURIComponent(id);
    // After a file or a link: everything is re-read (the Worker may have moved the stage, and the record's form must not send the old one
    // back), and the record reopens at this block, or at the note being typed.
    const reopen = async () => {
      forget(); await render(true); await openCandidate(id);
      requestAnimationFrame(() => { const t = document.activeElement, b = $("#wsblock");
        if (t && t.matches && t.matches("textarea.wsnote")) t.scrollIntoView({ block: "center" }); else if (b) b.scrollIntoView({ block: "start" }); });
    };
    bindWsGo(c);
    // Questions: a tick saves on the click, a note when it loses focus; each sends only what changed and the record stays where it is.
    const form = $("form[data-wsq]", el), sent = {};
    const qName = (li) => "question " + (($(".wsn", li) || {}).textContent || li.dataset.key);
    const patch = async (li, body) => {
      const mark = $("[data-wssaved]", li);
      mark.hidden = false; mark.classList.remove("bad"); mark.textContent = "Saving…";
      try {
        await api(`${path}/questions/${encodeURIComponent(li.dataset.key)}`, "PATCH", body);
        const q = (w.questions || []).find((x) => x.key === li.dataset.key); if (q) Object.assign(q, body);
        mark.textContent = "Saved"; setTimeout(() => { if (mark.textContent === "Saved") mark.hidden = true; }, 1600);
        return true;
      } catch (e) {
        const msg = (e && e.message) || String(e);
        mark.textContent = `Not saved (${msg}). Try again.`; mark.classList.add("bad");
        // With the record closed (or another one open) the mark can't be seen, and api() names HTTP errors only, not a dropped network:
        // say it at the top of the page, with the note's words (5 Nov review)
        if (!li.isConnected || !$("#recdlg").open || e instanceof TypeError) {
          const t = String(body.call_note || "");
          notice("call_note" in body ? `${c.name}: the call note on ${qName(li)} wasn't saved (${msg}). Opening a record sends it again; reloading the page loses it. The note: "${t.length > 300 ? t.slice(0, 300) + "…" : t}"`
            : `${c.name}: the tick on ${qName(li)} wasn't saved (${msg}). Open the record and tick it again.`, true);
        }
        return false;
      }
    };
    const clean = () => { if (form && [...form.querySelectorAll("li.wsq")].every((li) => $("textarea.wsnote", li).value === sent[li.dataset.key])) delete form.dataset.dirty; };
    const saveNote = async (li) => {
      const key = li.dataset.key, v = $("textarea.wsnote", li).value, before = sent[key];
      if (v === before) return;
      sent[key] = v;
      if (!(await patch(li, { call_note: v }))) sent[key] = before;
      clean();
    };
    if (form) {
      form.addEventListener("submit", (e) => e.preventDefault());
      const count = () => { const k = $("[data-wscount]", form); if (k) k.textContent = `· ${form.querySelectorAll("input.tick:checked").length} of ${form.querySelectorAll("input.tick").length} asked`; };
      const fit = (ta) => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; };
      const items = [...form.querySelectorAll("li.wsq")];
      items.forEach((li) => {
        const cb = $("input.tick", li), ta = $("textarea.wsnote", li), key = li.dataset.key;
        sent[key] = ta.value;
        cb.addEventListener("change", async () => {
          const v = cb.checked ? 1 : 0;
          cb.disabled = true;
          if (!(await patch(li, { asked: v }))) cb.checked = !v;
          cb.disabled = false; li.classList.toggle("asked", cb.checked); count(); clean();
        });
        ta.addEventListener("input", () => fit(ta));
        ta.addEventListener("change", () => saveNote(li));
        ta.addEventListener("blur", () => saveNote(li));  // also a note carried over a redraw and left without more typing
        // typing that landed while the record was being read again: back in its field, still to be saved
        if (carry && carry.values[key] != null && carry.values[key] !== ta.value) { ta.value = carry.values[key]; fit(ta); form.dataset.dirty = "1"; }
      });
      const back = carry && carry.focus && items.find((li) => li.dataset.key === carry.focus.key);
      if (back) { const ta = $("textarea.wsnote", back); ta.focus({ preventScroll: true }); try { ta.setSelectionRange(carry.focus.start, carry.focus.end); } catch (e) {} }
      wsLive = { cid: id,
        flush: () => form.isConnected ? Promise.all(items.map(saveNote)) : Promise.resolve(),
        unsaved: () => Object.fromEntries(items.map((li) => [li.dataset.key, $("textarea.wsnote", li).value]).filter(([k, v]) => v !== sent[k])),
        focused: () => { const t = document.activeElement, li = t && t.matches && t.matches("textarea.wsnote") && form.contains(t) ? t.closest("li.wsq") : null;
          return li ? { key: li.dataset.key, start: t.selectionStart, end: t.selectionEnd } : null; } };
    }
    // The file or the link
    const up = $("form[data-wsup]", el);
    if (!up) return;
    const mark = $("[data-wsupsaved]", up), fileIn = $('input[name="file"]', up), linkIn = $('input[name="link"]', up);
    const say = (t, bad) => { mark.textContent = t; mark.classList.toggle("bad", !!bad); };
    const busy = (on) => up.querySelectorAll("button").forEach((b) => { b.disabled = on; });
    const got = () => ({ received: $('input[name="received"]', up).value || today(), source: $('input[name="source"]', up).value.trim() });
    const upload = async () => {
      const f = fileIn.files[0];
      if (!f) return say("Choose the file first.", true);
      if (!f.size) return say("That file is empty.", true);
      if (f.size > WS_MAX) return say("The file is over 20 MB.", true);
      const { received, source } = got(), headers = { "content-type": wsType(f), "x-filename": headerSafe(f.name), "x-received-at": received };
      if (source) headers["x-source"] = headerSafe(source);
      busy(true); say("Uploading…");
      try { await send(path + "/file", { method: "PUT", headers, body: f }); delete up.dataset.dirty; await reopen(); }
      catch (e) { busy(false); say(`Not stored (${(e && e.message) || e}).`, true); }
    };
    const addLink = async () => {
      const link = linkIn.value.trim();
      if (!/^https?:\/\/\S+$/i.test(link)) return say("The link has to start with https://", true);
      const { received, source } = got(), body = { link, received_at: received };
      if (source) body.source = source;
      busy(true); say("Saving…");
      try { await api(path + "/meta", "PUT", body); delete up.dataset.dirty; await reopen(); }
      catch (e) { busy(false); say(`Not saved (${(e && e.message) || e}).`, true); }
    };
    const linkBtn = $('[data-wsact="link"]', up);
    $('[data-wsact="file"]', up).addEventListener("click", upload);
    linkBtn.addEventListener("click", addLink);
    // Enter in the link field adds the link: the form has no submit button, so the browser wouldn't submit it (5 Nov review)
    linkIn.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); if (!linkBtn.disabled) addLink(); } });
    up.addEventListener("submit", (e) => { e.preventDefault(); (linkIn.value.trim() || !fileIn.files[0] ? addLink : upload)(); });
    const del = $("[data-wsdel]", up);
    if (del) del.addEventListener("click", async () => {
      if (!confirm(`Remove the stored work sample file for ${c.name}? The link, if there is one, stays.`)) return;
      busy(true);
      try { await api(path + "/file", "DELETE"); await reopen(); } catch (e) { busy(false); say(`Not removed (${(e && e.message) || e}).`, true); }
    });
  }

  // ---------- calibration, part 1: Claude's triage call against the person's call on the same record ----------
  // One measurement per role and scorecard version (the rules Claude read the record with). Rows are Claude's call, columns the person's.
  // A miss is a person's Shortlist that Claude held or declined; noise is a Claude Shortlist a person declined. Misses only show where Claude's
  // Holds and Declines get a person's call too, so the block offers a fixed random sample of them.
  const rulesOf = (c) => { const m = /v\d+(\.\d+)*/.exec((c.rules_version || "").split(" · ")[0]); return m ? m[0] : "no version"; };
  const pickOrder = (id) => [...String(id)].reduce((s, ch) => (s * 31 + ch.charCodeAt(0)) >>> 0, 7);
  // Claude never judges CV design; your "Not pass" on the CV check makes the effective call a Decline (scorecard v0.4, K1).
  const claudeCall = (c) => c.cv_check === "Not pass" && c.agent_call ? "Decline" : c.agent_call;
  function triageBlock() {
    const groups = {}, C = ["Shortlist", "Hold", "Decline"];
    (state.candidates || []).filter((c) => C.includes(c.agent_call) && !/DUPLICATE/.test(c.name || "")).forEach((c) => {
      const k = c.role_id + "|" + rulesOf(c), g = groups[k] = groups[k] || { key: k, role: c.role_id, ver: rulesOf(c), all: [], done: [] };
      g.all.push(c); if (C.includes(c.your_call)) g.done.push(c);
    });
    // newest decision first, so the block opens on the role being decided now
    const last = (x) => x.done.reduce((m, c) => (c.updated_at || "") > m ? c.updated_at : m, "");
    const list = Object.values(groups).filter((g) => g.done.length).sort((a, b) => last(b).localeCompare(last(a)) || b.done.length - a.done.length);
    const eyebrow = `<span class="eyebrow">Triage · Claude's call vs the person's call</span>`;
    if (!list.length) return `<div class="group">${eyebrow}<div class="card empty">Nobody has made a call on a record Claude read yet.</div></div>`;
    const g = list.find((x) => x.key === state.calGroup) || list[0];
    const n = (arr, a, y) => arr.filter((c) => (!a || claudeCall(c) === a) && (!y || c.your_call === y)).length;
    const pct = (x, d) => d ? Math.round(100 * x / d) + "%" : "–";
    const label = (x) => `${roleName(x.role)} · ${x.ver}`;
    const rows = list.map((x) => { const d = x.done, agree = d.filter((c) => claudeCall(c) === c.your_call).length, sl = n(d, "Shortlist");
      const miss = d.filter((c) => c.your_call === "Shortlist" && claudeCall(c) !== "Shortlist").length;
      return `<tr${x === g ? ' class="here"' : ""}><td><span class="name">${h(label(x))}</span></td><td>${d.length} <span class="muted">${d.length >= 50 ? "· complete" : "of 50"}</span></td><td>${pct(agree, d.length)} <span class="muted">${agree}</span></td>
        <td>${sl ? `${n(d, "Shortlist", "Shortlist")} of ${sl}` : "–"}</td><td>${miss}</td><td>${n(d, "Shortlist", "Decline")}</td><td>${C.map((a) => `${n(d, a)}/${n(x.all, a)}`).join(" · ")}</td></tr>`; });
    const mx = C.map((a) => `<tr><th>${callPill(a)}</th>${C.map((y) => `<td class="${a === y ? "diag" : ""}">${n(g.done, a, y) || ""}</td>`).join("")}<td>${n(g.done, a)}</td><td class="muted">${n(g.all, a) - n(g.done, a)}</td></tr>`).join("");
    const off = g.done.filter((c) => c.agent_call !== c.your_call).sort((a, b) => CALL_RANK[a.your_call] - CALL_RANK[b.your_call] || (a.name || "").localeCompare(b.name || ""));
    const same = g.done.filter((c) => claudeCall(c) === c.your_call);
    const open = g.all.filter((c) => !c.your_call && !c.calib_batch && claudeCall(c) !== "Shortlist" && !CLOSED.includes(c.stage)).sort((a, b) => pickOrder(a.id) - pickOrder(b.id));
    const batches = {};
    (state.candidates || []).filter((c) => c.calib_batch).forEach((c) => { (batches[c.calib_batch] = batches[c.calib_batch] || []).push(c); });
    const sample = Object.keys(batches).length ? [] : [...open.filter((c) => c.agent_call === "Hold").slice(0, 10), ...open.filter((c) => c.agent_call === "Decline").slice(0, 5)];
    const batchHtml = Object.entries(batches).map(([name, m]) => { const d = m.filter((c) => C.includes(c.your_call)), agree = d.filter((c) => claudeCall(c) === c.your_call).length;
      const miss = d.filter((c) => c.your_call === "Shortlist" && claudeCall(c) !== "Shortlist").length, left = m.filter((c) => !c.your_call).sort((a, b) => pickOrder(a.id) - pickOrder(b.id));
      return `<div class="group"><span class="eyebrow">Blind batch · ${h(name)} · ${d.length} of ${m.length} decided${d.length ? ` · same call ${agree} of ${d.length} (${pct(agree, d.length)}) · misses ${miss} · noise ${n(d, "Shortlist", "Decline")}` : ""}</span>
        ${left.length ? `<p class="muted small">Claude's call stays hidden on these until the call is saved. Open one, look at the CV, set the CV check and the call with a reason.</p><div class="chips">${left.map((c) => `<button type="button" class="chip linkbtn" data-bopen="${h(c.id)}">${h(c.name)}</button>`).join("")}</div>` : `<p class="muted small">All decided.</p>`}</div>`; }).join("");
    const row = (c) => `<tr class="clickable" data-id="${h(c.id)}"><td><span class="name">${h(c.name)}</span><br><span class="muted">${h(c.id)}</span></td>
      <td>${callPill(claudeCall(c))}${c.cv_check === "Not pass" ? ' <span class="muted small">the CV check</span>' : ""} ${confWord(c.confidence)}<br><span class="muted small">${h(c.why)}</span></td><td>${callPill(c.your_call)}${callBy(c) ? `<br><span class="muted small">${h(firstName(callBy(c)))}</span>` : ""}</td><td>${h(c.your_reason) || '<span class="muted">no reason</span>'}</td></tr>`;
    return `${batchHtml}<div class="group">${eyebrow}${list.length > 1 ? seg("calgroup", list.map((x) => [x.key, label(x)]), g.key) : ""}
      ${table(["Role · rules", "Decided", "Same call", "Claude's Shortlists kept", "Misses", "Noise", "Decided of Claude's Shortlist · Hold · Decline"], rows)}
      <p class="muted small">One measurement per scorecard version: a new version starts a new row, so the current one stays the baseline. A CV check of "Not pass" counts as Claude\'s Decline, since only a person judges the CV\'s design. A measurement closes at 50 decided records. Misses can only appear where Claude's Holds and Declines also get a person's call: ${n(g.done, "Hold") + n(g.done, "Decline")} of ${n(g.all, "Hold") + n(g.all, "Decline")} so far for ${h(label(g))}.</p></div>
      <div class="group"><span class="eyebrow">${h(label(g))} · rows are Claude's call, columns the person's call</span><div class="tablewrap"><table class="mx"><thead><tr><th></th>${C.map((y) => `<th>${h(y)}</th>`).join("")}<th>Decided</th><th>Not decided</th></tr></thead><tbody>${mx}</tbody></table></div></div>
      <div class="group"><span class="eyebrow">Different calls · ${off.length}</span>${off.length ? table(["Candidate", "Claude", "Call", "Reason"], off.map(row)) : '<p class="muted">None.</p>'}</div>
      ${same.length ? `<details class="group"><summary class="eyebrow">Same call · ${same.length}</summary>${table(["Candidate", "Claude", "Call", "Reason"], same.map(row))}</details>` : ""}
      ${sample.length ? `<div class="group"><span class="eyebrow">Check for misses · ${sample.length} of Claude's Holds and Declines, picked at random</span>
        <p class="muted small">Make the call on these as you go. They stay the same picks until decided, then the next ones in line come up.</p>${table(["Candidate", "Claude", "Call", "Reason"], sample.map(row))}</div>` : ""}`;
  }

  // ---------- calibration, part 2: how close the scorers are, per pair, across candidates ----------
  async function renderCalibration(view) {
    await need("candidates", "cards");
    const all = state.cards || [], groups = {};
    const practice = all.filter((k) => k.hindsight), cards = all.filter((k) => !k.hindsight);  // after-the-outcome cards can't be blind
    cards.forEach((k) => { (groups[k.candidate_id + "|" + k.stage] = groups[k.candidate_id + "|" + k.stage] || []).push(k); });
    const pairs = {}, gapsList = [], waiting = [];
    const critLabel = (fam, id) => ((state.boot.rubrics || []).find((r) => r.role_id === fam && r.id === id) || {}).label || id;
    Object.values(groups).forEach((g) => {
      g.sort((a, b) => scorerRank(a.scorer) - scorerRank(b.scorer));
      if (g.length === 1 && g[0].scorer === "ai") waiting.push(g[0]);
      for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
        const a = g[i], b = g[j], key = a.scorer + "|" + b.scorer;
        const p = pairs[key] = pairs[key] || { a: a.scorer, b: b.scorer, cards: 0, fromDraft: 0, n: 0, within: 0, exact: 0, abs: 0, mustN: 0, mustAgree: 0, decN: 0, decAgree: 0, byCrit: {} };
        p.cards++;
        if (a.scorer === "ai" && b.started_from === "draft") p.fromDraft++;
        (a.items || []).forEach((ia) => { const ib = itemOf(b, ia.criterion_id); if (ia.score == null || ib.score == null) return;
          const diff = ib.score - ia.score, ad = Math.abs(diff); p.n++; p.abs += ad; if (ad <= 1) p.within++; if (!ad) p.exact++;
          const bc = p.byCrit[ia.criterion_id] = p.byCrit[ia.criterion_id] || { fam: a.rubric_role, n: 0, sum: 0, gaps: 0 }; bc.n++; bc.sum += diff; if (ad > 1) bc.gaps++;
          if (ad > 1) gapsList.push({ cid: a.candidate_id, stage: a.stage, crit: critLabel(a.rubric_role, ia.criterion_id), a: a.scorer, sa: ia.score, b: b.scorer, sb: ib.score }); });
        if (["pass", "fail"].includes(a.must_pass) && ["pass", "fail"].includes(b.must_pass)) { p.mustN++; if (a.must_pass === b.must_pass) p.mustAgree++; }
        if (a.decision && b.decision && a.decision !== "partial" && b.decision !== "partial") { p.decN++; if (a.decision === b.decision) p.decAgree++; }
      }
    });
    const pct = (x, n) => n ? Math.round(100 * x / n) + "%" : "–";
    const list = Object.values(pairs).sort((x, y) => (y.a === "ai" && y.b === "kostya@cornerrenovation.com") - (x.a === "ai" && x.b === "kostya@cornerrenovation.com") || y.n - x.n);
    const cname = (id) => (state.candidates.find((x) => x.id === id) || {}).name || id;
    const stageName = (cid, st) => { const r = rubricOf((state.candidates.find((x) => x.id === cid) || {}).role_id); return r ? ((r.stages.find(([x]) => x === st) || [st, st])[1]) : st; };
    const focus = list[0];
    view.innerHTML = head("Calibration", "Two checks. Triage: Claude's call against the person's call on the same record, per role and scorecard version. Interviews: how close the scorers are on the same interview, criterion by criterion; a gap over one point is flagged, and only cards saved before the outcome was known count. Together they are the evidence for handing a step over to the AI recruiter.") +
      triageBlock() + `<h3 class="parthead">Interview scorecards</h3><div class="strip four">${[[cards.length, "scorecards"], [cards.filter((k) => k.scorer === "ai").length, "AI recruiter drafts"], [cards.filter((k) => k.kind === "human").length, "people's cards"], [gapsList.length, "gaps over one point"]].map(([v, t]) => `<div class="kpi"><b>${h(v)}</b><span>${h(t)}</span></div>`).join("")}</div>
      <div class="group"><span class="eyebrow">Scorer pairs</span>${list.length ? table(["Pair", "Shared cards", "Criteria compared", "Within 1 point", "Exact", "Mean difference", "Must-pass agree", "Decision agree"], list.map((p) =>
        `<tr><td><span class="name">${h(scorerName(p.b))} vs ${h(scorerName(p.a))}</span>${p.fromDraft ? `<br><span class="muted small">${p.fromDraft} of ${p.cards} started from the AI draft</span>` : ""}</td><td>${p.cards}</td><td>${p.n}</td><td>${pct(p.within, p.n)}</td><td>${pct(p.exact, p.n)}</td><td>${p.n ? (p.abs / p.n).toFixed(2) : "–"}</td><td>${p.mustN ? `${p.mustAgree} of ${p.mustN}` : "–"}</td><td>${p.decN ? `${p.decAgree} of ${p.decN}` : "–"}</td></tr>`))
        : `<div class="card empty">No two scorers have scored the same interview yet. The first pair appears when someone saves a card next to an AI draft.</div>`}
        <p class="muted small">Within 1 point and Exact count criteria both scorers scored. Mean difference is the average absolute gap in points. Cards started from the AI draft agree more by construction; blind cards are the honest test. The triage handover rule in screening-logic.md is 90%+ agreement over two batches of 30 with no misses; no handover rule is set yet for interview scorecards.</p></div>
      ${focus && Object.keys(focus.byCrit).length ? `<div class="group"><span class="eyebrow">By criterion · ${h(scorerName(focus.b))} vs ${h(scorerName(focus.a))}</span>${table(["Criterion", "Compared", "Average difference", "Gaps over one point"], Object.entries(focus.byCrit).map(([id, bc]) =>
        `<tr><td>${h(critLabel(bc.fam, id))}</td><td>${bc.n}</td><td>${(bc.sum / bc.n > 0 ? "+" : "") + (bc.sum / bc.n).toFixed(2)}</td><td>${bc.gaps}</td></tr>`))}<p class="muted small">Average difference is ${h(scorerName(focus.b))}'s score minus ${h(scorerName(focus.a))}'s: plus means ${h(scorerName(focus.b))} scores higher.</p></div>` : ""}
      ${gapsList.length ? `<div class="group"><span class="eyebrow">Gaps to talk through</span>${table(["Candidate", "Stage", "Criterion", "Scores"], gapsList.map((g) => `<tr class="clickable" data-id="${h(g.cid)}"><td><span class="name">${h(cname(g.cid))}</span></td><td>${h(stageName(g.cid, g.stage))}</td><td>${h(g.crit)}</td><td>${h(scorerName(g.a))} ${g.sa} · ${h(scorerName(g.b))} ${g.sb}</td></tr>`))}</div>` : ""}
      ${practice.length ? `<p class="muted small">Not counted: ${practice.length} card${practice.length > 1 ? "s" : ""} saved after the outcome was known (${[...new Set(practice.map((k) => cname(k.candidate_id)))].map(h).join(", ")}). They test the rubric, not the scorers.</p>` : ""}
      <div class="group"><span class="eyebrow">AI drafts waiting for a person's card</span>${waiting.length ? table(["Candidate", "Stage", "AI weighted", "Decision rule"], waiting.map((k) => `<tr class="clickable" data-id="${h(k.candidate_id)}" data-stage="${h(k.stage)}"><td><span class="name">${h(cname(k.candidate_id))}</span><br><span class="muted">${h(roleName((state.candidates.find((x) => x.id === k.candidate_id) || {}).role_id))}</span></td><td>${h(stageName(k.candidate_id, k.stage))}</td><td>${k.weighted != null ? Number(k.weighted).toFixed(2) : "–"} <span class="muted">· ${k.scored} criteria</span></td><td>${decisionPill(k.decision)}</td></tr>`)) : '<p class="muted">None.</p>'}</div>`;
    view.querySelectorAll("tr.clickable").forEach((tr) => tr.addEventListener("click", () => { if (tr.dataset.stage) state.cardStage[tr.dataset.id] = tr.dataset.stage; openCandidate(tr.dataset.id); }));
    bindSeg(view, "calgroup", (v) => { state.calGroup = v; renderCalibration(view); });
    view.querySelectorAll("[data-bopen]").forEach((b) => b.addEventListener("click", () => openCandidate(b.dataset.bopen)));
  }

  function openRecord(title, eyebrow, html, cid) {
    // Typing in a call note since openCandidate saved the notes: the same record's new form takes it over (bindWsBlock); for another record it is sent.
    if (wsLive) { if (cid && wsLive.cid === cid) wsCarry = { cid, values: wsLive.unsaved(), focus: wsLive.focused() }; else wsLive.flush(); }
    wsLive = null;
    const d = $("#recdlg"), body = $("#recbody"); $("#rectitle").textContent = title; $("#receyebrow").textContent = eyebrow; body.innerHTML = html;
    if (!d.open) (d.showModal ? d.showModal() : d.setAttribute("open", ""));
    // Back to the top once the dialog is shown: a closed dialog ignores scrollTop, so the next record used to open where the last one was left
    body.scrollTop = 0; requestAnimationFrame(() => { body.scrollTop = 0; });
  }
  // Closing a record opened from a link leaves the address at the list, so a reload doesn't open it again.
  const leaveLink = () => { if (/^#candidates\//.test(location.hash)) history.replaceState(null, "", "#candidates"); };
  function closeRecord() { const d = $("#recdlg"); if (d.open) d.close(); leaveLink(); }
  $("#recdlg").addEventListener("cancel", leaveLink);  // Escape
  $("#recclose").addEventListener("click", closeRecord);
  $("#recdlg").addEventListener("click", (e) => { if (e.target === $("#recdlg")) closeRecord(); });

  // ---------- outreach ----------
  const addWorkDays = (from, n) => { const d = new Date(from + "T12:00:00"); let k = 0; while (k < n) { d.setDate(d.getDate() + 1); if (d.getDay() % 6) k++; } return d.toISOString().slice(0, 10); };
  // A prospect counts as accepted once anything after the invite happened (or they were connected before), and as answered once they
  // replied or booked a call: the booking link in message 1 lets them book without writing back.
  const connectedOut = (o) => !!(o.accepted || o.status === "already connected" || o.message1_sent || o.replied || o.call_booked);
  const answeredOut = (o) => !!(o.replied || o.call_booked);
  // The outreach run stops a person who applied by writing Next action "applied: …"; changing that text in the drawer resumes them
  const appliedOut = (o) => /^applied:/i.test(o.next_action || "");
  const doneOut = (o) => !!o.call_booked || appliedOut(o) || ["withdrawn", "closed"].includes(o.status);
  // The status, next step and due date the dates say, for when a booked call is taken off again
  const statusOut = (o) => o.replied ? "replied" : o.followup2_sent ? "closed" : o.followup1_sent ? "followed up" : o.message1_sent ? "messaged"
    : o.accepted ? "accepted" : o.invite_sent ? "invited" : o.status === "already connected" ? "already connected" : "queued";
  const nextOut = (o) => o.replied ? "Kostya replies" : o.followup2_sent ? "sequence ended, no answer" : o.followup1_sent ? "follow-up-2" : o.message1_sent ? "follow-up-1"
    : o.accepted || o.status === "already connected" ? "message-1" : o.invite_sent ? "wait for acceptance" : "invite";
  const dueOut = (o) => o.replied ? today() : o.followup2_sent ? o.followup2_sent : o.followup1_sent ? addWorkDays(o.followup1_sent, 5) : o.message1_sent ? addWorkDays(o.message1_sent, 3)
    : o.accepted || o.status === "already connected" ? today() : o.invite_sent ? addWorkDays(o.invite_sent, 10) : "";
  function nextActions(o) {  // [label, patch, confirm question]
    const t = today(), acts = [];
    if (o.call_booked || appliedOut(o)) return acts;  // the drawer takes a booking (or an application) off again
    const connected = connectedOut(o);
    if (!o.invite_sent && !connected) acts.push(["Invite sent", { invite_sent: t, step: "1", status: "invited", next_action: "wait for acceptance", due: addWorkDays(t, 10) }]);
    else if (!connected) {
      acts.push(["Accepted", { accepted: t, step: "2", status: "accepted", next_action: "message-1", due: addWorkDays(t, 1) }]);
      if (o.status !== "withdrawn") acts.push(["Withdrawn", { status: "withdrawn", next_action: "", due: "" }, `Mark the invite to ${o.name} as withdrawn?`]);
    }
    else if (!o.replied && !o.message1_sent) acts.push(["Message 1 sent", { message1_sent: t, step: "3", status: "messaged", next_action: "follow-up-1", due: addWorkDays(t, 3) }]);
    else if (!o.replied && !o.followup1_sent) acts.push(["Follow-up 1 sent", { followup1_sent: t, step: "4", status: "followed up", next_action: "follow-up-2", due: addWorkDays(t, 5) }]);
    else if (!o.replied && !o.followup2_sent) acts.push(["Follow-up 2 sent", { followup2_sent: t, status: "closed", next_action: "sequence ended, no answer", due: t }]);
    if ((o.invite_sent || connected) && !o.replied) acts.push(["Replied", { replied: t, status: "replied", next_action: "Kostya replies", due: t }, `Record a reply from ${o.name}? It stops the sequence; Open takes it off again.`]);
    if (connected) acts.push(["Call booked", { call_booked: t, status: "call booked", next_action: "the call", due: "" }, `Record a booked call for ${o.name}? It stops the sequence. Add the time in Open.`]);
    return acts;
  }
  // call_at is the event's start with its offset; the drawer edits it as local time
  const localInput = (iso) => { const d = new Date(iso || ""); if (!iso || isNaN(d)) return ""; const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  const stepCell = (date, title) => date ? `<td class="step done"${title ? ` title="${h(title)}"` : ""}>${h(fmt(date))}</td>` : '<td class="step none">–</td>';
  async function renderOutreach(view) {
    await need("outreach", "templates");
    if (!state.outreach || !state.templates) return;  // a refresh cleared the data while it loaded; that refresh renders again
    const list = state.outreach, t = today();
    const due = list.filter((o) => o.due && o.due <= t && !doneOut(o) && !answeredOut(o)).length;
    const unapproved = state.templates.filter((x) => x.approved !== "Yes").length;
    // The tracker: everyone invited, then how many accepted, answered and booked a call. Each step counts everyone who got that far.
    const invited = list.filter((o) => o.invite_sent), acc = invited.filter(connectedOut), ans = invited.filter(answeredOut), calls = invited.filter((o) => o.call_booked);
    const before = list.filter((o) => !o.invite_sent && connectedOut(o)).length, queued = list.filter((o) => !o.invite_sent && !connectedOut(o)).length;
    const pct = (a, b) => (b ? Math.round(100 * a / b) + "%" : "–");
    const steps = [
      ["Invited", invited.length, [queued && `${queued} queued`, before && `${before} connected before, not counted`].filter(Boolean).join(" · ") || "connection requests sent", "", ""],
      ["Accepted", acc.length, `${invited.filter((o) => !connectedOut(o) && o.status !== "withdrawn").length} waiting`, pct(acc.length, invited.length), "of invited"],
      ["Replied", ans.length, `${acc.filter((o) => !answeredOut(o) && o.message1_sent && !doneOut(o)).length} messaged, no answer yet`, pct(ans.length, acc.length), "of accepted"],
      ["Call booked", calls.length, `${calls.filter((o) => o.call_at && new Date(o.call_at) >= new Date()).length} coming up`, pct(calls.length, ans.length), "of replied"]];
    const top = invited.length || 1;
    const funnel = steps.map(([title, n, note, conv, of], i) => `<div class="stage"><div class="stagerow static"><span class="sname">${h(title)}<small>${h(note)}</small></span>
      <span class="sbar"><span style="width:${n ? Math.max(2, Math.round(100 * n / top)) : 0}%"></span></span>
      <span class="snum">${n}<small>${i ? `${pct(n, invited.length)} of invited` : "sent"}</small></span>
      <span class="sconv">${i ? `<b>${conv}</b><small>${of}</small>` : ""}</span></div></div>`).join("");
    const rank = (o) => o.call_booked ? 0 : answeredOut(o) ? 1 : connectedOut(o) ? 2 : o.invite_sent ? 3 : 4;
    const groups = {}; list.forEach((o) => { const g = o.campaign || "No campaign"; (groups[g] = groups[g] || []).push(o); });
    const nextCell = (o) => {
      if (o.call_booked) return '<span class="muted">the call</span>';
      if (doneOut(o)) return `<span class="muted">${h(o.status)}</span>`;
      const late = o.due && o.due <= t && !answeredOut(o);
      return `${h(o.next_action)}${o.due ? `<br><span class="muted">${late ? `<b>due ${h(fmt(o.due))}</b>` : `due ${h(fmt(o.due))}`}</span>` : ""}`;
    };
    const callCell = (o) => !o.call_booked ? '<td class="step none">–</td>'
      : `<td class="step done">${h(o.call_at ? fmtTime(o.call_at) : fmt(o.call_booked))}${o.candidate_id ? `<small><button type="button" class="linkbtn" data-cand="${h(o.candidate_id)}">${h(o.candidate_id)}</button></small>` : ""}</td>`;
    view.innerHTML = head("Outreach", `${list.length} prospects · ${due} due today or earlier`) +
      (unapproved ? `<div class="card note"><b>${unapproved} of ${state.templates.length} templates aren't approved yet.</b> Nothing is sent until they are. <button type="button" class="linkbtn" data-go="templates">Review templates</button></div>` : "") +
      `<div class="funnel">${funnel}</div>
      <p class="muted">Sequence: connection request (with a note while the month's free notes last) → message 1 with the booking link within a working day of acceptance → follow-ups at +3 and +5 working days. A reply or a booked call stops it. The outreach run sends these on weekdays at 11:00 and fills in the dates; the buttons are for corrections.</p>
      ${Object.entries(groups).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([g, rows]) => `<div class="group"><span class="eyebrow">${h(g)}</span>${table(["Prospect", "Invited", "Accepted", "Message 1", "Follow-ups", "Replied", "Call booked", "Next", ""],
        rows.slice().sort((a, b) => rank(a) - rank(b) || String(a.id).localeCompare(String(b.id))).map((o) => `<tr class="trk"><td><span class="name">${o.linkedin ? `<a href="${h(o.linkedin)}" target="_blank" rel="noopener">${h(o.name)}</a>` : h(o.name)}</span><br><span class="muted">${h(o.company || o.location || "")}</span></td>
          ${o.invite_sent ? stepCell(o.invite_sent) : `<td class="step none">${connectedOut(o) ? "connected before" : "queued"}</td>`}${stepCell(o.accepted)}${stepCell(o.message1_sent)}
          ${o.followup1_sent ? `<td class="step done">${[o.followup1_sent, o.followup2_sent].filter(Boolean).map((d) => h(fmt(d))).join(" · ")}</td>` : '<td class="step none">–</td>'}
          ${stepCell(o.replied, o.latest_reply)}${callCell(o)}<td>${nextCell(o)}</td>
          <td class="actions">${nextActions(o).map(([label, patch, ask]) => `<button type="button" class="btn ghost small" data-id="${h(o.id)}" data-patch='${h(JSON.stringify(patch))}'${ask ? ` data-confirm="${h(ask)}"` : ""}>${h(label)}</button>`).join("")}<button type="button" class="btn ghost small" data-open="${h(o.id)}">Open</button></td></tr>`))}</div>`).join("") || '<div class="card empty">No prospects queued.</div>'}`;
    view.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.go)));
    view.querySelectorAll("[data-cand]").forEach((b) => b.addEventListener("click", () => openCandidate(b.dataset.cand)));
    view.querySelectorAll("button[data-patch]").forEach((b) => b.addEventListener("click", async () => {
      if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
      b.disabled = true; await api("outreach/" + b.dataset.id, "PATCH", JSON.parse(b.dataset.patch)); state.outreach = null; renderOutreach(view);
    }));
    view.querySelectorAll("button[data-open]").forEach((b) => b.addEventListener("click", () => {
      const o = list.find((x) => x.id === b.dataset.open);
      openDrawer(o.name, `<dl class="kv"><dt>Company</dt><dd>${h(o.company)}</dd><dt>LinkedIn</dt><dd><a href="${h(o.linkedin)}" target="_blank" rel="noopener">${h((o.linkedin || "").replace(/^https?:\/\/(www\.)?/, ""))}</a></dd><dt>Hook</dt><dd>${h(o.hook)}</dd><dt>Dates</dt><dd>${["invite_sent", "accepted", "message1_sent", "followup1_sent", "followup2_sent", "replied"].filter((k) => o[k]).map((k) => `${k.replace(/_/g, " ")}: ${h(fmt(o[k]))}`).join(" · ") || "–"}</dd>${o.candidate_id ? `<dt>Record</dt><dd><button type="button" class="linkbtn" data-cand="${h(o.candidate_id)}">${h(o.candidate_id)}</button></dd>` : ""}</dl>
        <form class="form" id="oform"><label class="full"><span class="lbl">Latest reply</span><textarea name="latest_reply">${h(o.latest_reply)}</textarea></label>
          <label class="full"><span class="lbl">Replied on</span><input type="date" name="replied" value="${h(o.replied)}"></label>
          <label><span class="lbl">Call booked on</span><input type="date" name="call_booked" value="${h(o.call_booked)}"></label><label><span class="lbl">Call at</span><input type="datetime-local" name="call_at" value="${h(localInput(o.call_at))}"></label>
          <label class="full"><span class="lbl">Next action</span><input name="next_action" value="${h(o.next_action)}"></label>
          <label class="full"><span class="lbl">Notes</span><textarea name="notes">${h(o.notes)}</textarea></label><p class="muted small full">Clear "Call booked on" when a call is cancelled, or "Replied on" when a reply was recorded by mistake: the row goes back to where its dates say.</p><div class="formfoot full"><button type="submit" class="btn">Save</button></div></form>`);
      document.querySelectorAll(".drawer [data-cand]").forEach((x) => x.addEventListener("click", () => { closeDrawer(); openCandidate(x.dataset.cand); }));
      const init = Object.fromEntries(new FormData($("#oform")).entries());
      $("#oform").addEventListener("submit", async (e) => {
        e.preventDefault();
        // Send only what the person changed, so a save never rewrites a field (or what a robot wrote while the drawer was open)
        const f = Object.fromEntries(Object.entries(Object.fromEntries(new FormData(e.target).entries())).filter(([k, v]) => v !== init[k]));
        if (f.call_at) f.call_at = new Date(f.call_at).toISOString();
        const booked = "call_booked" in f ? f.call_booked : o.call_booked;
        if (f.call_at && !booked) f.call_booked = today();  // a time on a row with no booking is a new booking
        const nowBooked = "call_booked" in f ? f.call_booked : o.call_booked, nowReplied = "replied" in f ? f.replied : o.replied, said = "next_action" in f;
        // a row with no invite was connected before: going back keeps that
        const back = (x) => ({ ...o, ...f, ...x, status: o.invite_sent ? o.status : "already connected" });
        if (nowBooked && !o.call_booked) {
          const at = f.call_at || o.call_at;
          Object.assign(f, { status: "call booked", due: at ? localDay(new Date(at)) : "", next_action: said ? f.next_action : "the call" });
        } else if (!nowBooked && o.call_booked) {  // a cancelled call: the row goes back to where its dates say
          const b2 = back({ call_booked: "" });
          Object.assign(f, { call_at: "", status: statusOut(b2), next_action: said ? f.next_action : nextOut(b2), due: dueOut(b2) });
        } else if (!nowBooked && nowReplied && !o.replied) Object.assign(f, { status: "replied", next_action: said ? f.next_action : "Kostya replies", due: today() });
        else if (!nowBooked && !nowReplied && o.replied) {  // a reply recorded by mistake
          const b2 = back({ replied: "" });
          Object.assign(f, { status: statusOut(b2), next_action: said ? f.next_action : nextOut(b2), due: dueOut(b2) });
        }
        if (!Object.keys(f).length) { closeDrawer(); return; }
        await api("outreach/" + o.id, "PATCH", f); state.outreach = null; closeDrawer(); renderOutreach(view);
      });
    }));
  }

  // ---------- templates ----------
  async function renderTemplates(view) {
    await need("templates");
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
    // Earlier rounds of the same job only (Kostya, 18 Oct: a sales designer has no place under TA Manager).
    // Someone declined for the job stays out: the lead already decided.
    const fam = familyOf(role), mine = state.candidates.filter((c) => c.role_id === role.id);
    const declined = (c) => c.your_call === "Decline" || c.stage === "declined";
    return state.candidates.filter((c) => c.role_id !== role.id && roles().some((r) => r.id === c.role_id) && familyOf(roleOf(c.role_id)) === fam && passedStage(c) && c.stage !== "hired" && !declined(c))
      .map((c) => ({ c, added: mine.some((m) => samePerson(c, m)) }))
      .sort((a, b) => (reachedIdx(b.c) - reachedIdx(a.c)) || a.c.name.localeCompare(b.c.name));
  }
  function poolPanel(role) {
    const pool = poolFor(role), same = pool.length;
    const fresh = state.justCreated === role.id || !state.candidates.some((c) => c.role_id === role.id && c.sources !== "pool");
    const row = ({ c, added }) => {
      const from = roleOf(c.role_id), notes = [c.your_reason, c.notes].filter(Boolean).join(" · "), m = matchSummary(c);
      return `<li class="prow"><div class="ptop"><span class="name">${h(c.name)}</span>${pill("same job", "ok")}${added ? pill("in this search", "") : ""}
          <span class="muted small">${h(from.short)} · got to ${h(stageWord(reachedOf(c)))}${c.stage && c.stage !== reachedOf(c) ? ", now " + h(stageWord(c.stage)) : ""}</span></div>
        ${c.scores ? `<p><span class="lbl">Scores</span> ${h(c.scores)}</p>` : ""}${c.why ? `<p><span class="lbl">Why</span> ${h(c.why)}</p>` : ""}${c.doubt ? `<p><span class="lbl">To probe</span> ${h(c.doubt)}</p>` : ""}
        ${notes ? `<p><span class="lbl">Notes</span> ${h(notes)}</p>` : ""}${m ? `<p><span class="lbl">Criteria</span> ${h(m)}</p>` : ""}
        <div class="pact">${added ? "" : `<button type="button" class="btn small" data-recontact="${h(c.id)}">Add to this search</button>`}<button type="button" class="btn ghost small" data-poolopen="${h(c.id)}">Open record</button>${c.linkedin ? `<a class="btn ghost small" href="${h(c.linkedin)}" target="_blank" rel="noopener">LinkedIn</a>` : ""}</div></li>`;
    };
    return `<details class="fold pool" ${fresh ? "open" : ""}><summary>Re-contact first<span class="count">${same ? `${same} for this job` : "none for this job"}</span></summary>
      <p class="muted small">Everyone from an earlier round of this job who passed at least one stage (shortlisted or further), with their stage, scores and notes; anyone declined stays out. Re-contact them before posting; "Add to this search" opens a record here with the source "pool".</p>
      ${same ? `<ul class="poollist">${pool.map(row).join("")}</ul>` : '<p class="muted small">Nobody from an earlier round of this job is left to re-contact.</p>'}</details>`;
  }

  // ---------- checklists ----------
  async function renderChecklists(view) {
    await need("candidates", "summary");
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
      state.candidates = null; renderChecklists(view);
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
        <label><span class="lbl">State</span><select name="state">${[["planned", "Planned"], ["live", "Live"], ["pool", "Quiet pool"], ["closed", "Closed"]].concat(isArchivedRole(r) ? [["archived", "Archived"]] : []).map(([v, l]) => `<option value="${v}" ${v === (r.state || "planned") ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label><span class="lbl">Hiring manager</span><input name="lead" value="${h(r.lead || "")}" placeholder="Decides at the second interview"></label>
        <label><span class="lbl">Recruiter</span><select name="recruiter">${[["", "Not set"]].concat(people().map((x) => [x.email, x.name]), r.recruiter && !people().some((x) => x.email === r.recruiter) ? [[r.recruiter, r.recruiter]] : []).map(([v, l]) => `<option value="${h(v)}" ${v === (r.recruiter || "") ? "selected" : ""}>${h(l)}</option>`).join("")}</select></label>
        <label class="full"><span class="lbl">Earlier rounds of</span><select name="family">${families(r)}</select></label><label class="full"><span class="lbl">Status line</span><input name="status" value="${h(r.status || "")}" placeholder="Opens when the first TA Manager round is hired"></label>
        <div class="formfoot full"><button type="submit" class="btn">${r.id ? "Save" : "Create the checklist"}</button></div></form>`);
      $("#rform").addEventListener("submit", async (e) => { e.preventDefault(); await onSubmit(Object.fromEntries(new FormData(e.target).entries())); state.boot = null; closeDrawer(); await loadBoot(); renderChecklists(view); });
    };
    $("#newsearch", view).addEventListener("click", () => roleForm("New search", {}, async (d) => { const r = await api("roles", "POST", d); state.role = r.id; state.justCreated = r.id; store.set("studio-role", r.id); }));
    const er = $("#editrole", view); if (er) er.addEventListener("click", () => roleForm("Edit search", role, (d) => api("roles/" + role.id, "PATCH", d)));
  }

  // ---------- onboarding (12 Nov): a plan per person, shown to that person and to the plan's managers ----------
  // The plan and its tasks come from a file in git (studio.py onboarding-sync). Each task is one line: the status, the title (its link
  // opens in a new tab, a Studio document over this page), what kind of task it is, who a call is with, and on the right what opens the
  // task: its brief or its answer, and the comments. Everything else lives inside the opened task: the brief, the answer, the thread,
  // and for a manager the right answer and the assessment. A status saves on the click, a comment on Send, an answer on Submit.
  // The person never gets a right answer: the Worker sends keys and drafts to the plan's managers only.
  const ONB_STATUS = [["todo", "To do"], ["doing", "Doing"], ["done", "Done"]];
  const ONB_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 3h11a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H8l-3.2 2.6V11.5H2.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  const ONB_RESULT = { met: "ok", partly: "warn", not: "bad" };
  const onbPath = (plan) => "onboarding/" + encodeURIComponent(plan);
  const onbKey = (plan, task) => `studio-onb-answer-${plan}-${task}`;  // an answer being written also survives a reload
  const firstWords = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n).trimEnd() + "…" : t; };
  async function renderOnboarding(view) {
    const plans = state.boot.onboarding || [];
    if (!plans.length) { view.innerHTML = head("Onboarding") + '<div class="card empty">There is no onboarding plan for this login.</div>'; return; }
    if (!plans.some((p) => p.id === state.onbPlan)) state.onbPlan = (plans.find((p) => p.person_email === state.boot.who) || plans[0]).id;
    // A visit starts when the tab is opened, not on a background refresh. The Worker answers when this login opened it the time before:
    // what came after that is new for as long as the tab stays open.
    if (!state.onbVisit || state.onbVisit.plan !== state.onbPlan) {
      const r = await api(onbPath(state.onbPlan) + "/seen", "POST", {}, null).catch(() => null);
      state.onbVisit = { plan: state.onbPlan, since: r ? r.since || "" : null }; state.onbRead = {};
    }
    if (!state.onb || state.onb.plan.id !== state.onbPlan) state.onb = await api(onbPath(state.onbPlan));
    drawOnboarding(view);
  }
  function drawOnboarding(view) {
    const { plan, tasks, comments, can } = state.onb, plans = state.boot.onboarding || [], me = state.boot.who;
    const manager = state.onb.role === "manager", person = state.onb.role === "person", pass = plan.pass || 90, name = plan.person_name || plan.id;
    const answers = {}, keys = {}, drafts = {}, by = {};
    (state.onb.answers || []).forEach((a) => { answers[a.task_id] = a; });
    (state.onb.keys || []).forEach((k) => { keys[k.task_id] = k.points || []; });
    (state.onb.drafts || []).forEach((d) => { drafts[d.task_id] = d; });
    comments.forEach((c) => { (by[c.task_id] = by[c.task_id] || []).push(c); });
    const since = state.onbVisit && state.onbVisit.plan === plan.id ? state.onbVisit.since : null;
    const isNew = (x) => since != null && x.by !== me && (x.at || "") > since;
    // what is being typed survives the redraw: the drafts are kept as they are written, and the field that had focus gets it back
    const act = document.activeElement, actLi = act && act.closest && act.closest("li.onbtask");
    const focus = actLi && act.name ? { task: actLi.dataset.task, name: act.name, a: act.selectionStart, b: act.selectionEnd } : null;
    const done = tasks.filter((t) => t.status === "done").length;
    const sections = []; tasks.forEach((t) => { let g = sections.find((x) => x.name === (t.section || "")); if (!g) { g = { name: t.section || "", tasks: [] }; sections.push(g); } g.tasks.push(t); });
    const typed = (t) => { if (state.onbAnswer[t.id] != null) return state.onbAnswer[t.id]; const kept = store.get(onbKey(plan.id, t.id)); return kept != null && kept !== "" ? kept : null; };
    // where an answer stands: nothing yet, in review (no confirmed score), passed, or not yet
    const stand = (t) => { const a = answers[t.id];
      if (!a) return { k: "none", label: person ? "Answer" : "No answer" };
      if (a.score == null) return { k: "review", label: "In review" };
      return a.score >= pass ? { k: "passed", label: `Passed ${a.score}%` } : { k: "notyet", label: `Not yet ${a.score}%` }; };
    const link = (t) => !t.link ? `<span class="stitle">${h(t.title)}</span>`
      : `<a class="stitle" href="${h(t.link)}" target="_blank" rel="noopener"${/^#doc\//.test(t.link) ? ` data-doc="${h(t.link.slice(5))}"` : ""}>${h(t.title)}</a>`;
    const thread = (t) => `<div class="onbthread">${(by[t.id] || []).map((c) => `<div class="onbmsg"><span class="cmeta">${h(whoName(c.by))} · ${h(fmtTime(c.at))}</span><p>${linkify(c.body)}</p></div>`).join("")}
      ${can ? `<form class="onbform"><input name="body" maxlength="4000" autocomplete="off" placeholder="Write a comment" aria-label="Comment on ${h(t.title)}" value="${h(state.onbDraft[t.id] || "")}"><button type="submit" class="btn small">Send</button></form>` : ""}</div>`;
    const failed = (t) => state.onbErr[t.id] ? `<span class="saved bad onberr">${h(state.onbErr[t.id])}</span>` : "";
    // the person's side of an answer: one text box and Submit; once passed it stays as it is
    const mine = (t) => { const a = answers[t.id], s = stand(t), text = typed(t);
      const verdict = a && a.score != null ? `<p class="onbverdict">${pill(s.label, s.k === "passed" ? "ok" : "warn")}${a.note ? `<span>${linkify(a.note)}</span>` : ""}</p>` : "";
      if (s.k === "passed") return `<div class="onbans">${verdict}<p class="onbtext">${linkify(a.body)}</p></div>`;
      return `<form class="onbans" data-answer>${verdict}<textarea name="answer" rows="6" maxlength="8000" placeholder="Write your answer, or paste a link to it" aria-label="Your answer to ${h(t.title)}">${h(text != null ? text : a ? a.body : "")}</textarea>
        <div class="formfoot">${failed(t)}${a ? `<span class="cmeta">${s.k === "review" ? "In review" : "Sent"} · ${h(fmt(a.at))}</span>` : ""}<button type="submit" class="btn small">${a ? "Submit again" : "Submit"}</button></div></form>`; };
    // a manager's side: her answer, the right answer folded, the robots' draft point by point, and the score to confirm
    const theirs = (t) => { const a = answers[t.id], key = keys[t.id] || [], d = drafts[t.id], s = stand(t), typedScore = state.onbScore[t.id];
      const kept = typedScore && a && typedScore.at === a.at ? typedScore : null;  // a score typed for an earlier answer never shows over a new one
      const right = key.length ? `<details class="fold plain onbkey"><summary>Right answer<span class="count">${key.length} points</span></summary><ol>${key.map((k) => `<li>${h(k.text)}${k.weight !== 1 ? ` <span class="cmeta">counts ${h(k.weight)}×</span>` : ""}</li>`).join("")}</ol></details>` : "";
      if (!a) return `<div class="onbans"><p class="muted small">No answer from ${h(name)} yet.</p>${right}</div>`;
      const draft = d ? `<details class="fold plain onbdraft"${a.score == null ? " open" : ""}><summary>Draft by the AI recruiter: ${h(d.score)}%</summary><ul class="onbpoints">${(d.points || []).map((x) => `<li>${pill(x.result, ONB_RESULT[x.result])}<div><span>${h(x.text)}</span>${x.quote ? `<q>${h(x.quote)}</q>` : ""}${x.found === false ? '<span class="cmeta flag">These words aren\'t in her answer</span>' : ""}${x.note ? `<span class="muted">${h(x.note)}</span>` : ""}</div></li>`).join("")}</ul></details>` : "";
      const score = kept ? kept.score : a.score != null ? a.score : d ? d.score : "", note = kept ? kept.note : a.score != null ? a.note || "" : d ? d.note || "" : "";
      return `<div class="onbans"><span class="cmeta">${h(name)}'s answer · ${h(fmtTime(a.at))}</span><p class="onbtext">${linkify(a.body)}</p>${right}${draft}
        <form class="onbscore" data-score><label><span class="lbl">Score, %</span><input name="score" type="number" inputmode="numeric" min="0" max="100" step="1" required value="${h(score)}" aria-label="Score for ${h(t.title)}, in percent"></label>
          <label><span class="lbl">Note to ${h(name)}</span><textarea name="note" rows="2" maxlength="2000" placeholder="Needed under ${pass}%: what to look at again">${h(note)}</textarea></label>
          <div class="formfoot">${failed(t)}<span class="cmeta">${a.score != null ? `${h(s.label)} · ${h(whoName(a.score_by))}, ${h(fmtTime(a.score_at))}` : `${pass}% or more passes`}</span>${a.score != null ? '<button type="button" class="linkbtn" data-unscore>Take it back</button>' : ""}<button type="submit" class="btn small">${a.score != null ? "Change" : "Confirm"}</button></div></form></div>`; };
    const row = (t) => { const list = by[t.id] || [], n = list.length, open = !!state.onbOpen[t.id], when = [t.time, t.with_whom].filter(Boolean).join(" · ");
      const fresh = !state.onbRead[t.id] && list.some(isNew), s = t.takes_answer ? stand(t) : null;
      const opener = s ? `<button type="button" class="btn ghost small onba ${s.k}" data-open aria-expanded="${open}">${h(s.label)}</button>`
        : t.note ? `<button type="button" class="btn ghost small onba" data-open aria-expanded="${open}">Brief</button>` : "";
      return `<li class="step onbtask ${t.status === "done" ? "done" : ""}" data-task="${h(t.id)}"><div class="onbrow">
          ${seg("onbst", ONB_STATUS, t.status)}
          <div class="onbmain">${link(t)}<span class="pill kind-${h(t.kind)}">${h(t.kind)}</span>${when ? `<span class="cmeta">${h(when)}</span>` : ""}</div>
          ${opener}<button type="button" class="btn ghost small onbc" data-thread aria-expanded="${open}" aria-label="${n} comment${n === 1 ? "" : "s"} on ${h(t.title)}${fresh ? ", new" : ""}">${ONB_ICON}<span>${n}</span>${fresh ? '<i class="onbdot"></i>' : ""}</button></div>
        ${open ? `<div class="onbopen">${t.note ? `<p class="onbbrief">${linkify(t.note)}</p>` : ""}${t.takes_answer ? (person ? mine(t) : theirs(t)) : ""}${thread(t)}</div>` : ""}</li>`; };
    // for a manager: what the person wrote since he last opened the tab, newest first, one line each
    let strip = "";
    if (manager) {
      const title = (id) => (tasks.find((t) => t.id === id) || {}).title || id;
      const news = comments.filter((c) => c.by === plan.person_email && isNew(c)).map((c) => ({ task: c.task_id, at: c.at, what: "", text: c.body }))
        .concat((state.onb.answers || []).filter(isNew).map((a) => ({ task: a.task_id, at: a.at, what: "Answer: ", text: a.body }))).sort((a, b) => (b.at || "").localeCompare(a.at || ""));
      const line = (x) => `<li><button type="button" class="onbnewrow ${state.onbRead[x.task] ? "seen" : ""}" data-jump="${h(x.task)}"><b>${h(title(x.task))}</b><span>${h(x.what)}${h(firstWords(x.text, 90))}</span><span class="cmeta">${h(fmtTime(x.at))}</span></button></li>`;
      if (news.length) strip = `<div class="card onbnew"><span class="eyebrow">New from ${h(name)}</span><ul>${news.slice(0, 5).map(line).join("")}</ul>
        ${news.length > 5 ? `<details class="fold plain"><summary>${news.length - 5} more</summary><ul>${news.slice(5).map(line).join("")}</ul></details>` : ""}</div>`;
    }
    const who = (plan.people || []).length ? `<details class="fold"><summary>Who is who<span class="count">${plan.people.length}</span></summary><dl class="kv">${plan.people.map((x) => `<dt>${h(x.name)}</dt><dd>${h(x.role)}${x.ask ? `<br><span class="muted">Ask about: ${h(x.ask.replace(/^\w/, (c) => c.toLowerCase()))}</span>` : ""}</dd>`).join("")}</dl></details>` : "";
    const days = plan.days || {};
    view.innerHTML = `${plans.length > 1 ? `<div class="toolbar">${seg("onbplan", plans.map((p) => [p.id, p.person_name || p.id]), plan.id)}</div>` : ""}
      <section class="role onb"><div class="rolehead"><div><span class="eyebrow">${h(name)}${plan.person_email ? "" : " · no login yet"}</span><h2>${h(plan.title || "Onboarding")}</h2>${plan.aim ? `<p class="muted">${h(plan.aim)}</p>` : ""}</div>
        <div class="rolestat"><span class="big">${done}</span><span class="muted">of ${tasks.length} done</span></div></div>
      <div class="bar"><span style="width:${tasks.length ? Math.round(100 * done / tasks.length) : 0}%"></span></div>
      ${plan.note ? `<p class="muted small">${h(plan.note)}</p>` : ""}${strip}
      ${sections.map((g) => `<div class="phase"><h3>${h(g.name)}${days[g.name] ? `<b>${h(days[g.name])}</b>` : ""}<span>${g.tasks.filter((t) => t.status === "done").length} / ${g.tasks.length}</span></h3><ul class="steps onbtasks">${g.tasks.map(row).join("")}</ul></div>`).join("")}
      ${who}</section>`;
    const again = () => drawOnboarding(view), path = onbPath(plan.id) + "/tasks/", inTask = (id, sel) => view.querySelector(`li[data-task="${CSS.escape(id)}"] ${sel}`);
    // after an answer or a score: the task's status and the rest follow, and the task stays in view
    const reload = async (id) => { state.onb = await api(onbPath(plan.id)); again(); const li = id && view.querySelector(`li[data-task="${CSS.escape(id)}"]`); if (li) li.scrollIntoView({ block: "nearest" }); };
    // a save that fails says so next to its button (the page's notice is at the top, out of sight from a task further down), and keeps
    // saying so through a redraw until the next try
    const tell = (id, err) => { state.onbErr[id] = String((err && err.message) || err || ""); };
    bindSeg(view, "onbplan", (v) => { state.onbPlan = v; state.onb = null; state.onbOpen = {}; state.onbDraft = {}; state.onbAnswer = {}; state.onbScore = {}; renderOnboarding(view); });
    view.querySelectorAll("a[data-doc]").forEach((a) => a.addEventListener("click", (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); openDoc(a.dataset.doc); }));
    view.querySelectorAll("[data-jump]").forEach((b) => b.addEventListener("click", () => openOnbTask(view, b.dataset.jump)));
    view.querySelectorAll("li.onbtask").forEach((li) => {
      const t = tasks.find((x) => x.id === li.dataset.task), a = answers[t.id], passed = !!(t.takes_answer && a && a.score != null && a.score >= pass);
      // a task that takes an answer is done when the answer passes: Done isn't set by hand, and a passed task stays done
      if (t.takes_answer) li.querySelectorAll('[data-seg="onbst"] button').forEach((b) => { if (passed || b.dataset.v === "done") { b.disabled = true; b.title = passed ? "Done: the answer passed" : "Done when the answer passes"; } });
      bindSeg(li, "onbst", async (v) => {
        if (v === t.status || !can) return;
        const was = t.status; t.status = v; again();  // shown at once; put back if the save fails
        try { Object.assign(t, await api(path + encodeURIComponent(t.id), "PATCH", { status: v })); } catch (e) { t.status = was; again(); }
      });
      const toggle = (sel) => { state.onbOpen[t.id] = !state.onbOpen[t.id]; if (state.onbOpen[t.id]) state.onbRead[t.id] = true; again(); if (state.onbOpen[t.id]) { const i = inTask(t.id, sel); if (i) i.focus({ preventScroll: true }); } };
      $("[data-thread]", li).addEventListener("click", () => toggle(".onbform input"));
      const opener = $("[data-open]", li); if (opener) opener.addEventListener("click", () => toggle('textarea[name="answer"]'));
      const f = $(".onbform", li);
      if (f) {
        const input = $("input", f);
        if (input.value) f.dataset.dirty = "1";  // a draft carried over a redraw still holds the live refresh back
        // the page marks a form as edited on every keystroke (see refresh); an emptied draft is no edit
        input.addEventListener("input", () => { state.onbDraft[t.id] = input.value; if (!input.value) setTimeout(() => { delete f.dataset.dirty; }, 0); });
        f.addEventListener("submit", async (e) => {
          e.preventDefault();
          const body = input.value.trim(), btn = $("button", f);
          if (!body) return;
          btn.disabled = true;
          try { const r = await api(path + encodeURIComponent(t.id) + "/comments", "POST", { body }); comments.push(r.comment); state.onbDraft[t.id] = ""; again();
            const i = inTask(t.id, ".onbform input"); if (i) i.focus(); }
          catch (err) { btn.disabled = false; }
        });
      }
      const af = $("form[data-answer]", li);
      if (af) {
        const box = $("textarea", af), sent = a ? a.body : "";
        const mark = () => { const edited = box.value.trim() !== sent.trim(); if (edited) af.dataset.dirty = "1"; else setTimeout(() => { delete af.dataset.dirty; }, 0); return edited; };
        mark();
        box.addEventListener("input", () => { const edited = mark(); state.onbAnswer[t.id] = edited ? box.value : null; store.set(onbKey(plan.id, t.id), edited ? box.value : ""); });
        af.addEventListener("submit", async (e) => {
          e.preventDefault();
          const body = box.value.trim(), btn = $("button", af);
          if (!body) { box.focus(); return; }
          btn.disabled = true;
          delete state.onbErr[t.id];
          try { await api(path + encodeURIComponent(t.id) + "/answer", "PUT", { body }); state.onbAnswer[t.id] = null; store.set(onbKey(plan.id, t.id), ""); delete af.dataset.dirty; await reload(t.id); }
          catch (err) { tell(t.id, err); try { await reload(t.id); } catch (e) { again(); } }  // refused (it passed meanwhile): the task as it is now, with the reason
        });
      }
      const sf = $("form[data-score]", li);
      if (sf) {
        const keep = () => { state.onbScore[t.id] = { score: sf.elements.score.value, note: sf.elements.note.value, at: a.at }; };
        if (state.onbScore[t.id] && state.onbScore[t.id].at === a.at) sf.dataset.dirty = "1"; else delete state.onbScore[t.id];
        sf.addEventListener("input", keep);
        const save = async (body, btn) => {
          btn.disabled = true; delete state.onbErr[t.id];
          try { await api(path + encodeURIComponent(t.id) + "/score", "PUT", { ...body, answer_at: a.at }); delete state.onbScore[t.id]; delete sf.dataset.dirty; await reload(t.id); }
          catch (err) { tell(t.id, err); try { await reload(t.id); } catch (e) { again(); } }  // refused (she changed the answer meanwhile): the task as it is now, with the reason
        };
        sf.elements.note.addEventListener("input", () => sf.elements.note.setCustomValidity(""));
        // the field itself takes only a whole number from 0 to 100; under the pass mark the note is needed, and the form says so in place
        sf.addEventListener("submit", (e) => { e.preventDefault(); const n = Number(sf.elements.score.value), note = sf.elements.note;
          if (n < pass && !note.value.trim()) { note.setCustomValidity(`Under ${pass}% ${name} needs a note: what to look at again.`); note.reportValidity(); return; }
          save({ score: n, note: note.value.trim() }, $('button[type="submit"]', sf)); });
        const undo = $("[data-unscore]", sf); if (undo) undo.addEventListener("click", () => save({ score: null }, undo));
      }
    });
    if (focus) { const i = inTask(focus.task, `[name="${focus.name}"]`); if (i) { i.focus({ preventScroll: true }); try { i.setSelectionRange(focus.a, focus.b); } catch (e) {} } }
  }
  // Open one task and bring it into view: from the "New from" strip, or from a link (#onboarding/<plan>/<task>, the Slack messages use it).
  function openOnbTask(view, id) {
    if (!state.onb || !state.onb.tasks.some((t) => t.id === id)) return false;
    state.onbOpen[id] = true; state.onbRead[id] = true;
    drawOnboarding(view);
    const li = view.querySelector(`li[data-task="${CSS.escape(id)}"]`);
    if (li) li.scrollIntoView({ block: "center" });
    return true;
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
    const d = await api("docs/" + encodeURIComponent(slug), "GET", null, null);
    const dlg = $("#docview");
    if (!d) { if (dlg.open) dlg.close(); notice(`The document "${slug}" isn't in Studio yet.`, true); return; }
    $("#doctitle").textContent = d.title || slug; $("#docpath").textContent = d.path || ""; $("#docbody").innerHTML = d.html || "<p>Not found.</p>"; $("#docbody").scrollTop = 0;
    dlg.showModal ? dlg.showModal() : dlg.setAttribute("open", "");
  }
  $("#docclose").addEventListener("click", () => $("#docview").close());
  $("#docview").addEventListener("click", (e) => { if (e.target === $("#docview")) $("#docview").close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer(); });

  // Links: #<view> opens a view, #candidates/<ID> opens that candidate's record on the Candidates view (the #talent posts link there),
  // #doc/<slug> opens a document over the view the person was on (the onboarding tasks link there), and #onboarding/<plan>/<task> opens
  // that task in the Onboarding tab (the Slack message about a comment or an answer links there).
  // A first visit opens This week, or the person's own onboarding plan while they have one.
  async function follow() {
    const [v, id, sub] = decodeURIComponent((location.hash || "").slice(1)).split("/");
    const saved = store.get("studio-view");
    let view = VIEWS.includes(v) ? v : VIEWS.includes(saved) ? saved : "";
    if (!view || view === "onboarding") {
      try { if (!state.boot) await loadBoot(); } catch (e) {}
      const plans = (state.boot && state.boot.onboarding) || [];
      if (!view) view = plans.some((p) => p.person_email === state.boot.who) ? "onboarding" : "week";
      else if (!plans.length) view = "week";  // a link to a tab this login doesn't have
    }
    if (view === "onboarding" && v === "onboarding" && id) state.onbPlan = id;  // a plan this login doesn't have falls back to its own
    await setView(view);
    if (v === "onboarding" && id) {  // the link has done its work (or this login has no such tab): the address goes back to the view's own
      if (view === "onboarding" && sub && state.onb && state.onb.plan.id === id && !openOnbTask($("#view"), sub)) notice(`There's no task ${sub} in this plan.`, true);
      history.replaceState(null, "", "#" + view);
    }
    if (v === "candidates" && id && state.boot) await openCandidate(id);
    if (v === "doc" && id && state.boot) { await openDoc(id); history.replaceState(null, "", "#" + state.view); }
  }
  window.addEventListener("hashchange", follow);
  follow();
})();
