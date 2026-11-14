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
  // Stage model v2 (5 Nov), the same in the Worker: each stored stage has a status label and a stage group. The funnel order is the one
  // the Worker keeps "reached" in (the furthest stage a candidate got to, even after they were closed).
  const ORDER = ["applied", "triaged", "confirmed", "messaged", "replied", "screen booked", "screen done", "interview booked", "interview done",
    "work sample", "2nd interview booked", "2nd interview done", "references", "offer", "hired"];
  // Closed: a person's call only (robots can't set these or move anyone out of them). A closed candidate's stage group is the group of the
  // furthest stage they reached.
  const CLOSED = ["declined", "withdrawn", "not now", "pool R1"];
  // An outcome is known: cards saved now can't be blind (the Worker marks them "after the outcome").
  const OUTCOME = ["hired", "declined", "withdrawn", "not now"];
  const STATUS = { applied: "New", triaged: "In screening", confirmed: "Shortlisted", messaged: "Messaged", replied: "Replied",
    "screen booked": "Invited to screen call", "screen done": "Screen call done", "interview booked": "Invited to 1st interview", "interview done": "1st interview done",
    "work sample": "Test assignment sent", "2nd interview booked": "Invited to 2nd interview", "2nd interview done": "2nd interview done",
    references: "References", offer: "Offer", hired: "Hired", declined: "Rejected", withdrawn: "Withdrawn", "not now": "Not now", "pool R1": "Pool (next round)" };
  const WS_RECEIVED = "Test assignment received";  // "work sample" once the candidate's file or link is stored
  const GROUPS = [["Screening", ["applied", "triaged", "confirmed", "messaged", "replied", "screen booked", "screen done"]], ["First interview", ["interview booked", "interview done"]],
    ["Test assignment", ["work sample"]], ["Second interview", ["2nd interview booked", "2nd interview done"]], ["References", ["references"]], ["Offer", ["offer"]], ["Hired", ["hired"]]];
  // Stages only a Worker with "stages-v2" knows: the stage pickers offer them only then (an older Worker would store them off the funnel)
  const V2_STAGES = ["2nd interview booked", "2nd interview done", "withdrawn"];
  // Every status label, in funnel order and closed ones last: the Status filter's options
  const STATUS_LIST = ORDER.flatMap((s) => s === "work sample" ? [STATUS[s], WS_RECEIVED] : [STATUS[s]]).concat(CLOSED.map((s) => STATUS[s]));
  const FUNNEL = [["Applied", ["applied"]], ["Triaged", ["triaged"]], ["Shortlisted", ["confirmed"]], ["Messaged", ["messaged"]], ["Replied", ["replied"]],
    ["Screen call", ["screen booked", "screen done"]], ["First interview", ["interview booked", "interview done"]], ["Test assignment", ["work sample"]],
    ["Second interview", ["2nd interview booked", "2nd interview done"]], ["References", ["references"]], ["Offer", ["offer"]], ["Hired", ["hired"]]];
  const CALLS = ["", "Shortlist", "Hold", "Decline"];
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
    sort: { key: "", dir: 1 }, screenFilter: "tosend", calGroup: "", cvFilter: "all", stageFilter: "all", statusFilter: "all", resBy: {}, wsBy: {}, decBy: {},
    decisions: null, secAsk: {}, dOpen: {}, carry: null,
    subOpen: {}, focusSec: "", onb: null, onbPlan: "", onbOpen: {}, onbDraft: {}, onbAnswer: {}, onbScore: {}, onbErr: {}, onbVisit: null, onbRead: {} };
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
    if (!r.ok || j.error) { notice(j.error || ("Request failed: " + r.status), true); throw Object.assign(new Error(j.error || r.status), { status: r.status, data: j }); }
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
  // A call reads with the name of the person who made it ("Kostya's call"); the row that makes one carries the viewer's own name, and the
  // role's recruiter, who is meant to make it, is a note there (14 Nov review).
  const callBy = (c) => (c.your_call && c.call_by) || "";
  // The decisions after screening (12 Nov): 1 · Screening is the record's own call (your_call, made by call_by), 2 · Interview and
  // 3 · Second interview are rows of their own, read with the record (decBy) and for the lists (need "decisions").
  const STEPN = { screening: "Screening", interview: "Interview", second: "2nd interview" };
  const decsOf = (c) => state.decBy[c.id] || (state.decisions || {})[c.id] || [];
  // The latest call (14 Nov review: outside the Decision panel a call only ever meant the screening one, so an interview's No showed nowhere
  // else and no filter found it): the furthest step anyone decided, with every decision made there, newest first; else the screening call.
  function latestCall(c) {
    for (const step of ["second", "interview"]) {
      const here = decsOf(c).filter((d) => d.step === step && d.call).sort((a, b) => (b.at || "").localeCompare(a.at || ""));
      if (here.length) return { step, call: here[0].call, by: here[0].by, all: here };
    }
    return c.your_call ? { step: "screening", call: c.your_call, by: callBy(c), all: [{ call: c.your_call, by: callBy(c) }] } : null;
  }
  // The Call filter's values and the Call sort: the furthest step first, a Go before a No
  const CALL_KEYS = [["second|Go", "2nd interview: Go"], ["second|No", "2nd interview: No"], ["interview|Go", "Interview: Go"], ["interview|No", "Interview: No"],
    ["screening|Shortlist", "Screening: Shortlist"], ["screening|Hold", "Screening: Hold"], ["screening|Decline", "Screening: Decline"]];
  const callKey = (c) => { const l = latestCall(c); return l ? `${l.step}|${l.call}` : "none"; };
  const callRank = (c) => { const i = CALL_KEYS.findIndex(([k]) => k === callKey(c)); return i < 0 ? CALL_KEYS.length : i; };
  // Each view loads only what it shows; the caches are dropped when the data changes (see refresh) or after a save.
  async function need(...keys) {
    // Lists load light candidate rows and per-candidate criteria counts; a record fetches its full row and its own criteria when it
    // opens (27 Oct: the full tables, about 3 MB and 6 MB, went over the Worker's CPU limit and Cloudflare answered with an error page).
    const load = { candidates: "candidates?lite=1", summary: "criteria/results?summary=1", cards: "scorecards", outreach: "outreach", templates: "templates",
      // the decisions after screening, by candidate (an older Worker has no such route: none). Read now, they replace what records opened
      // earlier read, except the open record's own.
      decisions: () => api("decisions", "GET", null, []).then((rows) => {
        Object.keys(state.decBy).forEach((k) => { if (!isOpen(k)) delete state.decBy[k]; });
        return rows.reduce((m, d) => ((m[d.candidate_id] = m[d.candidate_id] || []).push(d), m), {}); }) };
    const missing = keys.filter((k) => !state[k]);
    (await Promise.all(missing.map((k) => typeof load[k] === "function" ? load[k]() : api(load[k])))).forEach((v, i) => { state[missing[i]] = v; });
  }
  const forget = () => { state.boot = null; state.candidates = null; state.summary = null; state.resBy = {}; state.cards = null; state.outreach = null; state.templates = null; state.msgs = null; state.onb = null; state.decisions = null; };

  // ---------- shared candidate logic ----------
  const stageIdx = (s) => ORDER.indexOf(s || "");
  const reachedIdx = (c) => Math.max(stageIdx(c.stage || "applied"), stageIdx(c.reached));
  const reachedOf = (c) => ORDER[reachedIdx(c)] || "applied";
  const stageLabel = (s) => STATUS[s || "applied"] || s;
  const stageWord = (s) => stageLabel(s).toLowerCase();
  // What the Worker says it knows (bootstrap "features"; an older Worker sends none, and its routes and stages stay out of the app)
  const has = (f) => ((state.boot || {}).features || []).includes(f);
  // The status label ("Invited to 1st interview") and the stage group ("First interview") of a candidate
  const statusOf = (c) => { const s = c.stage || "applied"; return s === "work sample" && c.ws_file ? WS_RECEIVED : stageLabel(s); };
  const groupOfStage = (s) => (GROUPS.find(([, st]) => st.includes(s)) || [""])[0];
  const groupOf = (c) => groupOfStage(ORDER.includes(c.stage || "applied") ? c.stage || "applied" : reachedOf(c)) || "Screening";
  const isClosedStage = (c) => CLOSED.includes(c.stage);
  // Funnel order with closed stages after the open ones (a received test assignment just after a sent one)
  const stageRank = (c) => { const s = c.stage || "applied", i = ORDER.indexOf(s), k = CLOSED.indexOf(s);
    return i >= 0 ? i * 2 + (s === "work sample" && c.ws_file ? 1 : 0) : k >= 0 ? 1000 + k * 100 + reachedIdx(c) : 500; };
  // The Stage picker: one group per stage group, status labels as the options' text. The stage stored now is always offered, so a save
  // never changes it by accident.
  function stageSelect(c) {
    const cur = c.stage || "applied", offered = (s) => s === cur || has("stages-v2") || !V2_STAGES.includes(s);
    const opt = (s) => `<option value="${h(s)}"${s === cur ? " selected" : ""}>${h(s === "work sample" ? statusOf({ stage: s, ws_file: c.ws_file }) : stageLabel(s))}</option>`;
    const groups = GROUPS.concat([["Closed", CLOSED]]).map(([g, st]) => [g, st.filter(offered)]).filter(([, st]) => st.length);
    return `<select name="stage">${ORDER.includes(cur) || CLOSED.includes(cur) ? "" : `<option value="${h(cur)}" selected>${h(cur)}</option>`}${
      groups.map(([g, st]) => `<optgroup label="${h(g)}">${st.map(opt).join("")}</optgroup>`).join("")}</select>`;
  }
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
  const callPill = (c) => pill(c, c === "Shortlist" || c === "Go" ? "ok" : c === "Decline" || c === "No" ? "bad" : c ? "warn" : "");
  // The list's Call cell: the latest call and where it was made ("No" over "Interview · Kostya"), others at that step counted
  const latestCell = (c) => { const l = latestCall(c); if (!l) return "";
    return `${callPill(l.call)}<br><span class="muted small">${h(STEPN[l.step])}${l.by ? " · " + h(firstName(l.by)) : ""}${l.all.length > 1 ? ` +${l.all.length - 1}` : ""}</span>`; };
  const confWord = (c) => c ? `<span class="conf conf-${h(c.toLowerCase())}">${h(c)}</span>` : "";
  const table = (cols, rows) => `<div class="tablewrap"><table><thead><tr>${cols.map((c) => `<th>${h(c)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  // A text box that grows with its text, up to its data-max height (px, about four lines when not set)
  const fitArea = (ta) => { if (!ta.getClientRects().length) return;  // hidden (a step's edit row before Edit): fitted when it shows
    ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight + 2, Number(ta.dataset.max) || 108) + "px"; };
  // A field that holds one line (a reason, a next step) shown in a box that wraps: a line break pasted into it becomes a space
  const oneLine = (s) => String(s).replace(/\s*[\r\n]+\s*/g, " ");

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
    await need("candidates", "decisions");
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
        ${open ? `<div class="stagelist">${here.length ? here.map((c) => `<button type="button" class="srow" data-id="${h(c.id)}"><span class="name">${h(c.name)}</span><span class="muted">${h(roleName(c.role_id))}${c.sources ? " · " + h(c.sources) : ""}</span>${latestCall(c) ? callPill(latestCall(c).call) : ""}${c.due ? `<span class="muted">due ${h(fmt(c.due))}</span>` : ""}${pill(statusOf(c))}</button>`).join("") : `<p class="muted">Nobody at this stage right now.</p>`}</div>` : ""}
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
      `<tr class="clickable" data-id="${h(c.id)}"><td><span class="name">${h(c.name)}</span></td><td>${h(roleName(c.role_id))}</td><td>${h(c.referred_by)}</td><td>${pill(statusOf(c))}</td><td>${h(fmt(c.hired_at))}</td><td>${c.bounty ? h(c.bounty) : '<span class="muted">not set yet</span>'}</td><td>${c.bounty_due ? (c.bounty_due <= today() ? `<b>${h(fmt(c.bounty_due))} · due</b>` : h(fmt(c.bounty_due))) : '<span class="muted">at hire + 90 days</span>'}</td></tr>`)) : "";
    view.innerHTML = head("Pipeline", "Each stage counts everyone who reached it or went further. Closed candidates sit in their own row and don't count against the conversions. Click a stage to see who is there now.", roleSeg()) +
      `<div class="strip four">${strip.map(([v, t]) => `<div class="kpi"><b>${h(v)}</b><span>${h(t)}</span></div>`).join("")}</div>
      <div class="funnel">${rows}
      <div class="stage closedrow"><button type="button" class="stagerow" data-toggle="Closed" aria-expanded="${!!state.open.Closed}"><span class="sname">Closed<small>rejected, withdrawn, not now, pool, earlier rounds</small></span><span class="sbar"></span><span class="snum">${closed.length}</span><span class="sconv"></span></button>
        ${state.open.Closed ? `<div class="stagelist">${closed.length ? closed.map((c) => `<button type="button" class="srow" data-id="${h(c.id)}"><span class="name">${h(c.name)}</span><span class="muted">${h(roleName(c.role_id))}</span>${pill(isClosedRole(roleOf(c.role_id)) && !CLOSED.includes(c.stage) ? "got to " + stageWord(c.stage) : statusOf(c) + " · " + groupOf(c))}</button>`).join("") : '<p class="muted">Nobody closed yet.</p>'}</div>` : ""}</div></div>
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
    await need("candidates", "decisions");
    const q = state.search.trim().toLowerCase();
    // Source and Call filters (Yuliia's request, 18 Oct); options count within the chosen role. Call is the latest call (14 Nov review):
    // the furthest step decided, so an interview's No is found as one, not as the Shortlist that came before it.
    const base = state.candidates.filter(inRole);
    const callOf = callKey, agentOf = (c) => blindNow(c) ? "blind" : c.agent_call || "none", confOf = (c) => blindNow(c) ? "blind" : c.confidence || "none", cvOf = (c) => c.cv_check || "none";
    const count = (f, rows) => { const m = {}; (rows || base).forEach((c) => { m[f(c)] = (m[f(c)] || 0) + 1; }); return m; };
    const srcCounts = count(sourceOf), callCounts = count(callOf), agentCounts = count(agentOf), confCounts = count(confOf), cvCounts = count(cvOf);
    if (state.srcFilter !== "all" && !srcCounts[state.srcFilter]) state.srcFilter = "all";
    // Stage and Status (Kostya, 5 Nov): the stage group ("First interview", a closed candidate's furthest one) and the status label
    // ("Invited to 1st interview", "Rejected"); they combine with every other filter and the search. With a stage chosen, Status offers that
    // stage's statuses and the closed ones, counted within the stage, and a status the stage can't hold goes back to any, so the two never
    // contradict each other (14 Nov review: "Test assignment" with "Invited to 1st interview" gave 0 of 1407 and no way back).
    const inStage = (c) => state.stageFilter === "all" || groupOf(c) === state.stageFilter;
    const groupCounts = count(groupOf), statusCounts = count(statusOf, base.filter(inStage));
    const stGroups = GROUPS.filter(([g]) => state.stageFilter === "all" || g === state.stageFilter).map(([g, st]) => [g, st.flatMap((x) => x === "work sample" ? [STATUS[x], WS_RECEIVED] : [STATUS[x]])]);
    const closedSt = CLOSED.map((x) => STATUS[x]);
    const odd = Object.keys(statusCounts).filter((l) => !STATUS_LIST.includes(l));  // a stage the app doesn't know, so nobody is unfindable
    if (state.statusFilter !== "all" && !stGroups.flatMap(([, l]) => l).concat(closedSt, odd).includes(state.statusFilter)) state.statusFilter = "all";
    const list = base.filter((c) => inStage(c) && (state.statusFilter === "all" || statusOf(c) === state.statusFilter) &&
      (state.srcFilter === "all" || sourceOf(c) === state.srcFilter) && (state.callFilter === "all" || callOf(c) === state.callFilter) &&
      (state.agentFilter === "all" || agentOf(c) === state.agentFilter) && (state.confFilter === "all" || confOf(c) === state.confFilter) &&
      (state.cvFilter === "all" || cvOf(c) === state.cvFilter) &&
      (!q || [c.name, c.headline, c.location, c.sources, c.email, c.stage, statusOf(c), groupOf(c), c.your_call, c.agent_call].join(" ").toLowerCase().includes(q)));
    // Sorting: click a column header; click again to reverse. Calls sort Shortlist, Hold, Decline, then none; confidence High to Low.
    const SORTS = { name: (c) => (c.name || "").toLowerCase(), applied: (c) => c.applied || c.created_at || "", agent: (c) => blindNow(c) ? 4 : CALL_RANK[c.agent_call] ?? 3,
      conf: (c) => blindNow(c) ? 4 : CONF_RANK[c.confidence] ?? 3, your: callRank, stage: stageRank, due: (c) => c.due || "~" };
    const sk = state.sort.key, sd = state.sort.dir;
    if (SORTS[sk]) list.sort((a, b) => { const x = SORTS[sk](a), y = SORTS[sk](b); return (x < y ? -1 : x > y ? 1 : 0) * sd || (a.name || "").localeCompare(b.name || ""); });
    const opt = (v, label, cur) => `<option value="${h(v)}" ${v === cur ? "selected" : ""}>${h(label)}</option>`;
    // Labelled like the other filters, so a chosen value says what it filters ("Stage: Hired (2)" next to "Status: Hired (2)")
    const stageSel = `<select id="fstage" aria-label="Stage">${opt("all", "Stage: any", state.stageFilter)}${GROUPS.map(([g]) => opt(g, `Stage: ${g} (${groupCounts[g] || 0})`, state.stageFilter)).join("")}</select>`;
    // Status: the labels in funnel order under their stage group, closed ones last
    const stOpt = (l) => opt(l, `Status: ${l} (${statusCounts[l] || 0})`, state.statusFilter);
    const statusSel = `<select id="fstatus" aria-label="Status">${opt("all", "Status: any", state.statusFilter)}${stGroups.map(([g, l]) =>
      `<optgroup label="${h(g)}">${l.map(stOpt).join("")}</optgroup>`).join("")}<optgroup label="Closed">${closedSt.map(stOpt).join("")}</optgroup>${
      odd.length ? `<optgroup label="Other">${odd.map(stOpt).join("")}</optgroup>` : ""}</select>`;
    const srcSel = `<select id="fsrc" aria-label="Source">${opt("all", "All sources", state.srcFilter)}${Object.entries(srcCounts).sort((a, b) => b[1] - a[1]).map(([v, n]) => opt(v, `${v} (${n})`, state.srcFilter)).join("")}</select>`;
    const callSel = `<select id="fcall" aria-label="Call">${opt("all", "Call: any", state.callFilter)}${CALL_KEYS.concat([["none", "No call yet"]]).map(([v, l]) => opt(v, `Call: ${l} (${callCounts[v] || 0})`, state.callFilter)).join("")}</select>`;
    const agentSel = `<select id="fagent" aria-label="Agent call">${opt("all", "Agent call: any", state.agentFilter)}${[["Shortlist", "Shortlist"], ["Hold", "Hold"], ["Decline", "Decline"], ["none", "Not read yet"]].concat(agentCounts.blind ? [["blind", "Hidden, blind batch"]] : []).map(([v, l]) => opt(v, `Agent call: ${l} (${agentCounts[v] || 0})`, state.agentFilter)).join("")}</select>`;
    const confSel = `<select id="fconf" aria-label="Confidence">${opt("all", "Confidence: any", state.confFilter)}${[["High", "High"], ["Medium", "Medium"], ["Low", "Low"]].map(([v, l]) => opt(v, `Confidence: ${l} (${confCounts[v] || 0})`, state.confFilter)).join("")}</select>`;
    const cvSel = `<select id="fcv" aria-label="CV check">${opt("all", "CV check: any", state.cvFilter)}${[["Pass", "Pass"], ["Not pass", "Not pass"], ["none", "Not checked"]].map(([v, l]) => opt(v, `CV check: ${l} (${cvCounts[v] || 0})`, state.cvFilter)).join("")}</select>`;
    // Compact (Kostya, 27 Oct): role sits above the source, confidence under Claude's call, long text clamps to two lines,
    // so Next step and Due fit without scrolling sideways
    const cols = [["Name", "name"], ["Role · source", ""], ["Applied", "applied"], ["Claude", "agent"], ["Call", "your"], ["Stage", "stage"], ["Next step", ""], ["Due", "due"]];
    const th = ([label, key]) => key ? `<th><button type="button" class="sorth" data-sort="${key}" aria-sort="${sk === key ? (sd > 0 ? "ascending" : "descending") : "none"}">${h(label)}<span class="arrow">${sk === key ? (sd > 0 ? "↑" : "↓") : "↕"}</span></button></th>` : `<th>${h(label)}</th>`;
    // On a phone the column headers give way to cards, so the sort is a select inside the filters
    const SORT_OPTS = [["", 1, "Sort: latest change"], ["applied", -1, "Sort: applied, newest"], ["name", 1, "Sort: name"], ["stage", 1, "Sort: stage"], ["due", 1, "Sort: due"],
      ["agent", 1, "Sort: Claude's call"], ["conf", 1, "Sort: confidence"], ["your", 1, "Sort: call"]];
    const sortSel = `<select id="fsort" class="fsort" aria-label="Sort">${SORT_OPTS.map(([k, d, l]) => `<option value="${k}|${d}"${(SORTS[sk] ? sk : "") === k ? " selected" : ""}>${h(l)}</option>`).join("")}</select>`;
    // What is filtering the list: the search and every filter not at "any" (the role's buttons stay in sight). Clear filters puts them back.
    const picked = [state.stageFilter, state.statusFilter, state.srcFilter, state.agentFilter, state.confFilter, state.callFilter, state.cvFilter].filter((v) => v !== "all").length;
    const on = picked + (q ? 1 : 0), clear = `<button type="button" class="linkbtn" data-fclear>Clear filters</button>`;
    // Each row as a table row; on a phone as a card (studio.css): the name and the status with its group, the calls, the next step and due.
    // On a phone the Applied column gives way to the card's second line, which carries the date (14 Nov review: "· applied 18 Oct").
    const row = (c) => `<tr class="clickable" data-id="${h(c.id)}"><td class="cname"><span class="name">${h(c.name)}</span><span class="muted clamp2">${h(c.headline || c.location || "")}</span></td><td class="csrc"><span class="muted small">${h(roleName(c.role_id))}</span><span class="sep"> · </span><br>${h(sourceShort(c.sources))}${c.applied ? `<span class="cappm"> · applied ${h(fmt(c.applied))}</span>` : ""}${c.referred_by ? `<br><span class="muted">referred by ${h(c.referred_by)}</span>` : ""}</td><td class="nowrap capplied">${h(fmt(c.applied))}</td><td class="cclaude">${blindNow(c) ? pill("blind") : callPill(c.agent_call)}${blindNow(c) || !c.confidence ? "" : `<br>${confWord(c.confidence)}`}</td><td class="ccall">${latestCell(c)}</td><td class="cstage"><span class="stl${isClosedStage(c) ? " closed" : ""}">${h(statusOf(c))}</span><span class="muted small cgrp">${h(groupOf(c))}</span>${c.ws_file && statusOf(c) !== WS_RECEIVED ? `<span class="wsflag" title="${h(c.ws_file)}">Work sample</span>` : ""}</td><td class="cnext"><span class="clamp2" title="${h(c.next_step)}">${h(c.next_step)}</span></td><td class="nowrap cdue">${c.due ? `<span class="duew">due </span>${h(fmt(c.due))}` : ""}</td></tr>`;
    view.innerHTML = head("Candidates", `${list.length} of ${state.candidates.length}${on ? ` · ${on} filter${on > 1 ? "s" : ""} on · ${clear}` : ""}`, `<button type="button" class="btn" id="add">Add candidate</button>`) +
      `<div class="toolbar ctools${state.filtersOpen ? " open" : ""}"><input type="search" id="q" placeholder="Search name, headline, source, stage" value="${h(state.search)}">
        <button type="button" class="btn ghost ftoggle" id="ftoggle" aria-expanded="${state.filtersOpen ? "true" : "false"}" aria-controls="fsel">Filters${picked ? ` · ${picked}` : ""}</button>
        <div class="fsel" id="fsel">${stageSel}${statusSel}${srcSel}${agentSel}${confSel}${callSel}${cvSel}${sortSel}${roleSeg()}</div></div>
      ${list.length ? `<div class="tablewrap cands"><table><thead><tr>${cols.map(th).join("")}</tr></thead><tbody>${list.map(row).join("")}</tbody></table></div>`
        : on ? `<div class="card empty">No candidates match these filters. ${clear}</div>`
        : `<div class="card empty">No candidates match. They arrive from the jobs site, LinkedIn and Work.ua through the daily check-in, or add one by hand.</div>`}`;
    const qel = $("#q", view);
    qel.addEventListener("input", (e) => { state.search = e.target.value; renderCandidates(view); qel.focus(); });
    if (q) { qel.focus(); qel.setSelectionRange(qel.value.length, qel.value.length); }
    view.querySelectorAll("[data-fclear]").forEach((b) => b.addEventListener("click", () => {
      Object.assign(state, { search: "", stageFilter: "all", statusFilter: "all", srcFilter: "all", agentFilter: "all", confFilter: "all", callFilter: "all", cvFilter: "all" });
      renderCandidates(view); }));
    $("#ftoggle", view).addEventListener("click", () => { state.filtersOpen = !state.filtersOpen; renderCandidates(view); });
    $("#fsort", view).addEventListener("change", (e) => { const [k, d] = e.target.value.split("|"); state.sort = { key: k, dir: Number(d) || 1 }; renderCandidates(view); });
    bindSeg(view, "role", (v) => { state.roleFilter = v; renderCandidates(view); });
    $("#fstage", view).addEventListener("change", (e) => { state.stageFilter = e.target.value; renderCandidates(view); });
    $("#fstatus", view).addEventListener("change", (e) => { state.statusFilter = e.target.value; renderCandidates(view); });
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
  // ---------- the candidate record's parts: links, the CV, the screening answers, Claude's read ----------
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return u; } };
  function linkChip(u, forcedLabel) {
    if (!/^https?:\/\//i.test(String(u || "").trim())) return u ? `<span class="chip link off" title="${h(u)}">${h(forcedLabel || u)}</span>` : "";
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
  // Claude's read: the criteria set this record was read with (a role can carry two scorecard versions, Brand & Content v0.3 bc-* and
  // v0.4 bc4-*), or the newest set when it hasn't been read yet, and each result.
  function readModel(c) {
    const all = criteriaFor(c.role_id), newest = all.length ? all[all.length - 1].source : "", byAt = (a, b) => (b.at || "").localeCompare(a.at || "");
    const lastVer = (resultsFor(c.id).slice().sort(byAt)[0] || {}).rules_version;
    const res = resultsFor(c.id).filter((x) => x.rules_version === lastVer);
    const defs = res.length ? all.filter((d) => res.some((x) => x.criterion_id === d.id)) : all.filter((d) => d.source === newest);
    return { res, defs, last: res.slice().sort(byAt)[0], resultOf: (d) => res.find((x) => x.criterion_id === d.id) };
  }
  // "Shortlist · high · knockouts 0 failed of 3, 2 unclear · markers 3 of 5 · 1 red flag": the open section's own counts, each group on its
  // own (14 Nov review: one ratio of knockouts and markers together, with unclear counted as not met, read like a failing profile)
  function readSummary(c) {
    if (blindNow(c)) return "Hidden until the call is saved";
    const { res, defs, resultOf } = readModel(c);
    if (!c.agent_call && !res.length) return "Not read yet";
    const of = (kind) => defs.filter((d) => d.kind === kind), n = (list, result) => list.filter((d) => (resultOf(d) || {}).result === result).length;
    const ko = of("knockout"), plus = of("plus"), flags = n(of("minus"), "met");
    const unclear = ko.filter((d) => { const r = resultOf(d); return r && r.result !== "met" && r.result !== "not met"; }).length;  // the section's "unclear" pills
    return [c.agent_call || "No call yet", c.confidence ? c.confidence.toLowerCase() : "",
      ko.length ? `knockouts ${n(ko, "not met")} failed of ${ko.length}${unclear ? `, ${unclear} unclear` : ""}` : "",
      plus.length ? `markers ${n(plus, "met")} of ${plus.length}` : "", flags ? `${flags} red flag${flags > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
  }
  function readBlock(c) {
    if (blindNow(c)) return `<div class="readhead"><h3 class="muted">Hidden until the call is saved</h3><span class="cmeta">${h(c.calib_batch)}</span></div>
      <p class="muted small">This record is in a blind calibration batch: open the CV, set the CV check and the call with a reason, and save. Claude's call shows after that and counts toward the agreement on the Calibration tab.</p>`;
    const { res, defs, last, resultOf } = readModel(c);
    const row = (d) => { const r = resultOf(d); if (!r) return `<li class="crow"><span class="pill">not checked</span><div class="cbody"><span class="clabel">${h(d.label)}</span></div></li>`;
      const [word, kind] = kindOf(d, r); return `<li class="crow"><span class="pill ${kind}">${h(word)}</span><div class="cbody"><span class="clabel">${h(d.label)}</span>${r.evidence ? `<span class="ev">${h(r.evidence)}</span>` : ""}${r.field ? `<span class="cmeta">From ${h(r.field)}</span>` : ""}</div></li>`; };
    const ko = defs.filter((d) => d.kind === "knockout"), plus = defs.filter((d) => d.kind === "plus"), minus = defs.filter((d) => d.kind === "minus"), other = defs.filter((d) => !["knockout", "plus", "minus"].includes(d.kind));
    const count = (list, pred) => list.filter((d) => { const r = resultOf(d); return r && pred(r); }).length;
    if (!c.agent_call && !res.length) return `<p class="muted">The next robot run reads the application against the ${h(roleName(c.role_id))} scorecard: completeness, knockouts, markers, then a proposal.</p>`;
    return `<div class="readhead"><h3>${c.agent_call ? `${h(c.agent_call)}${c.confidence ? ` <span class="muted">· ${h(c.confidence.toLowerCase())} confidence</span>` : ""}` : '<span class="muted">No call yet</span>'}</h3>
        <span class="cmeta">${h(c.rules_version || (last && last.rules_version) || "")}${last ? ` · ${h(fmt(last.at))}` : ""}</span></div>
      ${c.why ? `<p class="why">${h(c.why)}</p>` : ""}
      ${ko.length ? `<div class="critgroup"><span class="lbl">Knockouts · ${count(ko, (r) => r.result === "not met")} failed of ${ko.length}</span><ul class="critlist">${ko.map(row).join("")}</ul></div>` : ""}
      ${plus.length ? `<div class="critgroup"><span class="lbl">Markers for · ${count(plus, (r) => r.result === "met")} of ${plus.length}</span><ul class="critlist">${plus.map(row).join("")}</ul></div>` : ""}
      ${minus.length ? `<div class="critgroup"><span class="lbl">Red flags · ${count(minus, (r) => r.result === "met")} of ${minus.length}</span><ul class="critlist">${minus.map(row).join("")}</ul></div>` : ""}
      ${other.length ? `<div class="critgroup"><span class="lbl">Criteria</span><ul class="critlist">${other.map(row).join("")}</ul></div>` : ""}
      ${c.doubt ? `<div class="kvline"><span class="lbl">Doubt to probe</span><span>${h(c.doubt)}</span></div>` : ""}
      <p class="muted small">Claude's reading of what she or he sent, against the scorecard, with the words it rests on. It informs the call; nobody is declined on it.</p>`;
  }

  // ---------- the candidate record (redesigned 5 Nov): a header that stays, the Next call panel and collapsible sections in the main column,
  // and the Decision panel on the right (under the Next call panel on a narrow screen) ----------
  // A section's open or closed state is remembered per section, across records (localStorage); a call sheet's groups stay as they were
  // while the same record is redrawn.
  const secOpen = (name, dflt) => { const v = store.get("studio-sec-" + name); return v === "1" ? true : v === "0" ? false : dflt; };
  const section = (name, title, summary, body, dflt) => { const open = secOpen(name, dflt);
    return `<details class="rsec" id="sec-${name}" data-sec="${name}" data-state="${open ? 1 : 0}"${open ? " open" : ""}><summary><span class="rsec-t">${h(title)}</span><span class="rsec-s" data-secsum>${h(summary)}</span></summary><div class="rsec-b">${body}</div></details>`; };
  const setSum = (name, text) => { const el = $(`#sec-${name} [data-secsum]`); if (el) el.textContent = text; };
  // Opened by the app (a link from the Calibration view, the Work sample's "tab" button), not by the person: not remembered
  function openSec(name, scroll) {
    const d = $("#sec-" + name); if (!d) return;
    if (!d.open) { d.dataset.state = "1"; d.open = true; }
    if (scroll) requestAnimationFrame(() => d.scrollIntoView({ block: "start" }));
  }
  const isOpen = (id) => $("#recdlg").open && $("#recdlg").dataset.cid === id;
  const callKind = (x) => x === "Shortlist" || x === "Go" ? "ok" : x === "Decline" || x === "No" ? "bad" : x ? "warn" : "";
  // The latest call, with its step and the name of each person who decided there: "Interview · Kostya: No", "2nd interview · Julieta: Go ·
  // Kostya: No", "Screening · Kostya: Shortlist"; with no call yet the one the role's recruiter makes (14 Nov review: the header named the
  // screening call while the panel held an interview No)
  function callChip(c) {
    const l = latestCall(c), rec = roleOf(c.role_id).recruiter;
    if (!l) return pill(`Screening · ${rec ? `${firstName(rec)}'s call, ` : ""}not made yet`, "");
    const kinds = [...new Set(l.all.map((d) => callKind(d.call)))];
    return pill(`${STEPN[l.step]} · ${l.all.map((d) => (d.by ? firstName(d.by) + ": " : "") + d.call).join(" · ")}`, kinds.length === 1 ? kinds[0] : "warn");
  }
  // The header: status and stage group, the latest call with the name of whoever made it, Claude's (not in a blind batch), one line of facts,
  // and the links used most
  function headHtml(c, hideClaude) {
    const kind = ["declined", "withdrawn"].includes(c.stage) ? "bad" : ["offer", "hired"].includes(c.stage) ? "ok" : "";
    const w = wsOf(c), m = w && !w.failed ? w.meta : null, wsLink = m && /^https?:\/\/\S+$/i.test(m.link || "") ? m.link : "";
    const role = roleOf(c.role_id);
    const facts = [c.id, roleName(c.role_id) + (isArchivedRole(role) ? " (archived)" : isClosedRole(role) ? " (earlier round)" : ""), c.sources, c.applied ? "applied " + fmt(c.applied) : "", c.location, c.english ? "English: " + c.english : ""].filter(Boolean);
    const links = [c.linkedin ? linkChip(c.linkedin, "LinkedIn") : "", cvOpen(c, "chip link"),
      m && Number(m.size) > 0 ? `<a class="chip link" href="${API}worksample/${encodeURIComponent(c.id)}/file" target="_blank" rel="noopener" title="${h(m.filename || c.ws_file || "")}">Open work sample ↗</a>` : wsLink ? linkChip(wsLink, "Work sample") : "",
      c.email ? `<a class="chip link mail" href="mailto:${h(c.email.trim())}" title="${h(c.email)}">${h(c.email.trim())}</a>` : ""].filter(Boolean);
    // the stage group only when it says something the status doesn't ("Hired" "Hired", "Offer" "Offer" read twice: 14 Nov review)
    const grp = groupOf(c), sameWord = grp.toLowerCase() === statusOf(c).toLowerCase();
    return `<div class="rchips"><span class="pill st ${kind}" title="Status">${h(statusOf(c))}</span>${sameWord ? "" : `<span class="pill grp" title="Stage">${h(grp)}</span>`}${callChip(c)}${
      !hideClaude && !blindNow(c) && c.agent_call ? pill("Claude · " + c.agent_call, callKind(c.agent_call)) : ""}</div>
      <p class="rmeta">${facts.map(h).join(" · ")}</p>${links.length ? `<div class="rlinks">${links.join("")}</div>` : ""}`;
  }
  const setHead = (c, hideClaude) => { if (isOpen(c.id)) $("#recsub").innerHTML = headHtml(c, hideClaude); };
  // the Next call panel's "Now" line follows a saved Next step at once, like the header
  const setNow = (c) => { const el = isOpen(c.id) && $("#callnow"); if (el) { el.innerHTML = callNowHtml(c); el.hidden = !c.next_step; el.title = nowText(c); } };
  // Section summaries, one line each
  function cardsSummary(c) {
    const cards = cardsFor(c.id), rub = rubricOf(c.role_id);
    if (!cards.length) return "No cards yet";
    const latest = cards.slice().sort((a, b) => (b.updated_at || b.created_at || "").localeCompare(a.updated_at || a.created_at || ""))[0];
    const label = ((rub && rub.stages.find(([x]) => x === latest.stage)) || [latest.stage, latest.stage])[1];
    // like the cards themselves, the score stays out of sight for someone who hasn't scored that stage, so they can score blind
    const shown = OUTCOME.includes(c.stage) || isClosedRole(roleOf(c.role_id)) || cards.some((k) => k.stage === latest.stage && k.scorer === state.boot.who);
    return `${cards.length} card${cards.length > 1 ? "s" : ""} · ${label}${shown ? `: ${latest.weighted != null ? Number(latest.weighted).toFixed(2) : "–"}${latest.decision ? " · " + latest.decision : ""}` : ", folded until you score it"}`;
  }
  function wsSummary(c) {
    const w = wsOf(c);
    if (!w) return "";
    if (w.failed) return "Didn't load";
    const m = w.meta, qs = w.questions || [], n = (w.flaws || []).length;
    return [m ? `${Number(m.size) > 0 ? "File" : "Link"} received${m.received_at ? " " + fmt(m.received_at) : ""}` : "Nothing received yet", n ? `${n} flaw${n > 1 ? "s" : ""}` : "",
      qs.length ? `${qs.filter((q) => q.asked).length} of ${qs.length} questions asked` : ""].filter(Boolean).join(" · ");
  }
  function msgsSummary(c) {
    const list = msgsOf(c), last = list[list.length - 1], first = (c.name || "").split(" ")[0];
    return [list.length ? `${list.length} message${list.length > 1 ? "s" : ""} · last ${last.direction === "in" ? "from " + first : "sent"} ${fmt(last.at)}` : "",
      c.reply_draft ? "reply drafted" : "", !list.length && (inScreening(c) || c.screen_concern) ? (wasSent(c) ? "screen message sent" : c.screen_message ? "screen message to send" : "no concern written yet") : ""].filter(Boolean).join(" · ");
  }
  const appSummary = (c) => [sourceShort(c.sources) || "Source not recorded", c.applied ? "applied " + fmt(c.applied) : "", c.cv_file ? "CV stored" : ""].filter(Boolean).join(" · ");
  // Blind scoring (18 Oct): an interview's outcome stays out of sight until the viewer has a card of their own for this candidate, unless
  // the outcome is known or the round is closed, as the cards themselves do (cardsSummary). A call sheet's results are the AI recruiter's
  // card in words, so its Weighted, Must-pass and Verdict fold the same way (14 Nov review: they showed on the first screen).
  const callsShown = (c) => OUTCOME.includes(c.stage) || isClosedRole(roleOf(c.role_id)) || cardsFor(c.id).some((k) => k.scorer === state.boot.who);
  const FOLDED = "folded until you score";
  const earlierSummary = (c, sheets) => sheets.map((x) => { const v = Object.fromEntries(x.chips);
    if (!callsShown(c)) return mdPlain(stepName(c, x.title)) + (x.chips.length ? `: results ${FOLDED}` : "");
    return mdPlain(stepName(c, x.title)) + (v.Verdict ? `: ${v.Verdict}` : "") + (v.Weighted ? `, ${v.Weighted}` : ""); }).join(" · ");
  // Empty when the record has none of it (an earlier round's hire imported with a name and a source only), so the section is hidden
  function applicationHtml(c) {
    const kv = (k, v) => v ? `<dt>${h(k)}</dt><dd>${h(v)}</dd>` : "";
    const furthest = reachedIdx(c) > stageIdx(c.stage || "applied") ? stageLabel(reachedOf(c)) : "";
    const links = (c.linkedin ? [linkChip(c.linkedin, "LinkedIn")] : []).concat(urlsIn(c.cv).filter((u) => !/linkedin\.com\/hiring\/applicants|drive\.google\.com|docs\.google\.com/.test(u)).map((u) => linkChip(u)));
    const facts = kv("Location", c.location) + kv("Email", c.email) + kv("English, self-rated", c.english) + kv("Headline", c.headline) + kv("Referred by", c.referred_by) + kv("Furthest stage", furthest) + kv("Scores", c.scores) + kv("Latest reply", c.latest_reply) + kv("Last contact", c.last_contact);
    return [facts ? `<dl class="kv">${facts}</dl>` : "", screeningBlock(c), cvBlock(c),
      links.length ? `<div class="links"><span class="lbl">Links she or he gave</span><div class="chips">${links.join("")}</div>${/drive\.google\.com/.test(c.cv || "") ? `<span class="muted small">The CV sits in hello@'s Drive. If the link asks for access, hello@ needs to share the "Corner Careers — Applications" folder with you once.</span>` : ""}</div>` : "",
      cvCheck(c),
      c.site_answer ? `<div class="answer"><span class="lbl">Written answer</span><p>${h(c.site_answer).replace(/\n+/g, "<br>")}</p></div>` : ""].filter(Boolean).join("\n      ");
  }
  // A date field holds only a whole day. A value stored another way ("2026-04", the March round's hires) can't show in it, so the field
  // names it, and a save that leaves the field empty keeps it (it used to come back empty, and the Worker then set hired_at to today).
  const dayOf = (v) => /^\d{4}-\d{2}-\d{2}/.test(v || "") ? v.slice(0, 10) : "";
  const dateField = (name, v) => `<input name="${name}" type="date" value="${h(dayOf(v))}">${v && !dayOf(v) ? `<span class="muted small">Stored as “${h(v)}”: pick a day to replace it.</span>` : ""}`;
  // The Decision panel (5 Nov, with the Decisions of 12 Nov; one Save since the second 14 Nov review). The three steps, then the record's
  // fields, then Save at the panel's foot, which saves everything changed in it: the record's fields that changed (only those) and each
  // step's decision that changed. 1 · Screening is the record's own call and moves the stage as before; 2 · Interview and 3 · Second
  // interview are rows of their own and leave the stage alone. A step before its stage is one quiet line; a call made shows as one line
  // with the name of whoever made it, and Edit (or Change, for someone else's screening call). The row that edits a call always carries the
  // viewer's own name, the person the Worker records; who is meant to decide is a note above it.
  function decisionHtml(c, id) {
    const sel = (name, opts, val, labels) => `<select name="${name}">${opts.map((o, i) => `<option value="${h(o)}" ${o === (val || "") ? "selected" : ""}>${h(labels ? labels[i] : (o || "–"))}</option>`).join("")}</select>`;
    const title = id ? "Decisions and next step" : "New candidate";
    return `<section class="decision" aria-label="${title}"><span class="eyebrow">${title}</span>
      <form class="form" id="cform">
        ${id ? "" : `<label class="full"><span class="lbl">Name</span><input name="name" required></label><label><span class="lbl">Role</span>${sel("role_id", openRoles().map((r) => r.id), c.role_id, openRoles().map((r) => r.short))}</label><label><span class="lbl">Source</span><input name="sources" placeholder="LinkedIn UA, referral…"></label><label class="full"><span class="lbl">LinkedIn</span><input name="linkedin" type="url"></label><label><span class="lbl">Email</span><input name="email" type="email"></label><label><span class="lbl">Location</span><input name="location"></label>`}
        <ul class="full dsteps">
          <li class="dstep" id="dstep-screening">${screenStep(c, id)}</li>
          ${id ? `<li class="dstep" id="dstep-interview">${decisionStep(c, "interview")}</li><li class="dstep" id="dstep-second">${decisionStep(c, "second")}</li>` : ""}
        </ul>
        <label><span class="lbl">Stage</span>${stageSelect(c)}</label>
        <label><span class="lbl">Due</span>${dateField("due", c.due)}</label>
        <label class="full"><span class="lbl">Next step</span><textarea name="next_step" class="fit oneline" rows="2" data-max="168">${h(c.next_step)}</textarea></label>
        <label class="full"><span class="lbl">Notes</span><textarea name="notes">${h(c.notes)}</textarea></label>
        <details class="fold plain more full"><summary>Referral and hire fields</summary><div class="form inner">
          <label><span class="lbl">Referred by</span><input name="referred_by" value="${h(c.referred_by)}" placeholder="Who on the team or in our network"></label>
          <label><span class="lbl">Referral bounty</span><input name="bounty" value="${h(c.bounty)}" placeholder="Blank until Kostya sets it"></label>
          ${id ? `<label><span class="lbl">Hired on</span>${dateField("hired_at", c.hired_at)}</label>
          <div class="fieldnote"><span class="lbl">Bounty due</span><span>${c.bounty_due ? h(fmt(c.bounty_due)) + " · hire + 90 days" : (c.referred_by ? "90 days after the hire date" : "Only for referrals")}</span></div>` : ""}</div></details>
        <div class="formfoot full"><span class="saved" id="csaved"></span><button type="submit" class="btn">${id ? "Save" : "Add"}</button></div>
      </form></section>`;
  }
  async function openCandidate(id) {
    if (wsLive) await wsLive.flush();  // a call note still in its field is saved before any record is read (again)
    // What was typed in the Decision panel and not saved yet stays when the same record is drawn again (a link or a file added, a message
    // marked sent, a save refused because the stage changed meanwhile)
    const f0 = id && isOpen(id) && $("#cform"), carry = (state.carry && state.carry.cid === id ? state.carry : null) || (f0 && f0._edits ? f0._edits() : null);
    state.carry = null;
    if (id) await need("candidates", "cards");
    let c = id ? state.candidates.find((x) => x.id === id) : { stage: "applied", role_id: state.roleFilter !== "all" && state.roleFilter !== "closed" ? state.roleFilter : (openRoles()[0] || {}).id };
    // a record added since the list was read (the robots' new applicant, linked from #talent): the list is read again once
    if (!c) { forget(); await render(true); await need("candidates", "cards"); c = state.candidates.find((x) => x.id === id); }
    if (!c) { notice(`There's no candidate ${id} in the studio.`, true); return; }
    if (id) {  // the full row (CV, screening answers, written answer, first lines, the call sheets), this candidate's criteria and decisions
      // the work sample only from a Worker that has its routes (an older one would answer 404 into the console)
      const [full, res, msgs, ws, dec] = await Promise.all([api("candidates/" + encodeURIComponent(id)), api("criteria/results?candidate_id=" + encodeURIComponent(id)), api("messages?candidate_id=" + encodeURIComponent(id)),
        has("worksample") ? wsLoad(id) : null, api("decisions?candidate_id=" + encodeURIComponent(id), "GET", null, [])]);
      Object.assign(c, full); state.resBy = state.resBy || {}; state.resBy[id] = res; state.msgsBy = state.msgsBy || {}; state.msgsBy[id] = msgs; state.wsBy[id] = ws; state.decBy[id] = dec;
      if (state.decisions) state.decisions[id] = dec;
    }
    if (!id) openRecord("New candidate", roleName(c.role_id), `<div class="reclayout solo">${decisionHtml(c, id)}</div>`, null, "");
    else {
      const sheets = parseSheets(c.interview_sheet), focus = state.focusSec;
      state.focusSec = "";
      // Claude's read starts open when there is no call sheet
      const read = section("read", "Claude's read", readSummary(c), readBlock(c), !sheets.length);
      // The main column opens on the Next call panel; a card without a call sheet opens on Claude's read instead, so on a narrow screen,
      // where the Decision panel comes right after this first part, the evidence comes before the form (14 Nov review: a phone opened a
      // screening card on an empty form, with Claude's read 900px down)
      openRecord(c.name, "", `<div class="reclayout"><div class="recnext">${sheets.length ? nextCallHtml(c, sheets[0]) : read}</div>
        <div class="recside">${decisionHtml(c, id)}</div>
        <div class="recrest">${(sheets.length ? read : "") + sectionList(c, sheets).filter((x) => x[3]).map(([k, t, sm, b]) => section(k, t, sm, b, asked(c, k))).join("") + laterHtml(c)}</div></div>`, id, headHtml(c));
      if (focus) openSec(focus, true);
      bindLater(c); bindScoreBlock(c); bindWsBlock(c); bindScreen($("#recbody"), async () => { forget(); await render(true); await openCandidate(id); }); bindReply($("#recbody"), async () => { forget(); await render(true); await openCandidate(id); }); bindCvCheck($("#recbody"), () => render(true));
    }
    bindRecordForm(c, id, carry);
  }
  // The main column's sections after the Next call panel (or Claude's read): [key, title, summary, body]. A section with nothing in it isn't
  // shown, nor Scorecards and Work sample before their step (cardsShown, wsShown), unless asked for from the line at the card's end
  // (state.secAsk; 14 Nov review: the gates took away the upload and "Score this stage" where the stage lagged behind what happened).
  const asked = (c, k) => !!(state.secAsk[c.id] || {})[k];
  const cardsOn = (c) => !!rubricOf(c.role_id) && (cardsShown(c) || asked(c, "cards"));
  const wsOn = (c) => wsShown(c) || asked(c, "ws");
  const sectionList = (c, sheets) => [["cards", "Scorecards", cardsSummary(c), cardsOn(c) ? scoreBlock(c) : ""], ["ws", "Work sample", wsSummary(c), wsBlock(c)],
    ["msgs", "Messages", msgsSummary(c), messagesHtml(c)], ["app", "Application", appSummary(c), applicationHtml(c)],
    ["earlier", "Earlier calls", earlierSummary(c, sheets.slice(1)), sheets.length > 1 ? earlierHtml(c, sheets.slice(1)) : ""]];
  // The sections someone may need before their step, as one quiet line at the card's end (not on a closed record: its steps are over)
  function laterHtml(c) {
    if (isClosedStage(c)) return "";
    const w = wsOf(c), can = [rubricOf(c.role_id) && !cardsOn(c) ? ["cards", "Scorecards"] : null,
      w && !w.failed && !wsOn(c) && wsInRubric(c) && !isClosedRole(roleOf(c.role_id)) ? ["ws", "Work sample"] : null].filter(Boolean);
    return can.length ? `<p class="reclater" id="reclater"><span class="muted">Before their step:</span> ${can.map(([k, t]) => `<button type="button" class="linkbtn" data-secask="${k}">${t}</button>`).join('<span class="muted"> · </span>')}</p>` : "";
  }
  function bindLater(c) {
    document.querySelectorAll("#reclater [data-secask]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.secask; state.secAsk[c.id] = { ...(state.secAsk[c.id] || {}), [k]: true };
      syncSections(c); openSec(k, true);
    }));
  }
  // The sections that apply now and aren't on the card yet (a stage saved in the panel, one asked for) join it in their place, bound
  // (14 Nov review: a later stage saved in the panel brought them back only once the record was opened again)
  function syncSections(c) {
    const rest = isOpen(c.id) && $("#recbody .recrest");
    if (!rest) return;
    const order = ["read", "cards", "ws", "msgs", "app", "earlier"], at = (k) => rest.querySelector(`:scope > #sec-${k}`);
    for (const [k, t, sm, b] of sectionList(c, parseSheets(c.interview_sheet))) {
      if (!b || $("#sec-" + k)) continue;
      const next = order.slice(order.indexOf(k) + 1).map(at).find(Boolean) || rest.querySelector(":scope > #reclater");
      const html = section(k, t, sm, b, asked(c, k));
      if (next) next.insertAdjacentHTML("beforebegin", html); else rest.insertAdjacentHTML("beforeend", html);
      if (k === "cards") bindScoreBlock(c);
      if (k === "ws") bindWsBlock(c);
    }
    const old = rest.querySelector(":scope > #reclater"), later = laterHtml(c);
    if (old) old.remove();
    if (later) { rest.insertAdjacentHTML("beforeend", later); bindLater(c); }
  }
  // The Decision panel's form: one Save for everything in it (14 Nov review: four Saves, and the biggest one, pinned at the panel's foot, left
  // the interview decisions picked above it unsaved while it said "Saved"). Only what changed since the form was drawn is sent, so an
  // untouched Stage, Next step or Due never goes back over what a robot or a colleague saved while the card was open; the stage goes with the
  // one the card showed (stage_was), and the Worker refuses it (409) when the stored one changed meanwhile.
  function bindRecordForm(c, id, carry) {
    const f = $("#cform"), saved = $("#csaved");
    const snap = () => Object.fromEntries(new FormData(f).entries());
    const init = snap();  // the fields as drawn; a save sends what differs
    const changed = () => Object.fromEntries(Object.entries(snap()).filter(([k, v]) => (init[k] ?? "") !== v));
    const decRows = () => [...f.querySelectorAll(".drow[data-dstep]")];
    const rowVal = (row) => ({ call: (row.querySelector('[data-seg] button[aria-pressed="true"]') || { dataset: { v: "" } }).dataset.v || "", reason: oneLine($("textarea", row).value).trim() });
    const rowInit = (row) => { try { return JSON.parse(row.dataset.init || "{}"); } catch (e) { return {}; } };
    const rowDirty = (row) => { const a = rowVal(row), b = rowInit(row); return a.call !== (b.call || "") || a.reason !== (b.reason || ""); };
    const screenDirty = () => { const d = changed(); return "your_call" in d || "your_reason" in d; };
    const say = (t, bad) => { saved.textContent = t; saved.classList.toggle("bad", !!bad); saved.classList.toggle("warn", t === "Not saved yet"); };
    let saving = 0;
    // "Not saved yet" on each step changed and at the foot, and no "Saved" while anything is
    const marks = () => {
      decRows().forEach((row) => { const m = $("[data-dmark]", row); if (!rowDirty(row)) { m.textContent = ""; m.classList.remove("bad", "warn"); } else if (!m.classList.contains("bad")) { m.textContent = "Not saved yet"; m.classList.add("warn"); } });
      const sm = f.querySelector("[data-dscreen] [data-dmark]");
      if (sm) { sm.textContent = screenDirty() ? "Not saved yet" : ""; sm.classList.toggle("warn", screenDirty()); }
      const any = Object.keys(changed()).length || decRows().some(rowDirty);
      if (any && !saving && !saved.classList.contains("bad")) say("Not saved yet");
      else if (!any && saved.textContent === "Not saved yet") say("");
    };
    // a step's edit row shown (Edit, Change, Add, Decide now) or put back (Cancel), and its values back to what is stored
    const show = (step, on) => { const row = f.querySelector(`[data-dedit-row="${step}"]`), ro = f.querySelector(`[data-dro="${step}"]`), add = f.querySelector(`[data-dadd="${step}"]`), note = f.querySelector(`#dstep-${step} [data-dnote]`);
      if (row) row.hidden = !on; if (ro) ro.hidden = !!on; if (add) add.hidden = !!on; if (note) note.hidden = !on;
      if (on && row) row.querySelectorAll("textarea").forEach(fitArea); };
    const press = (root, name, v) => root.querySelectorAll(`[data-seg="${name}"] button`).forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === v && !!v));
    const reset = (step) => {
      if (step === "screening") { f.elements.your_call.value = init.your_call || ""; press(f, "yourcall", init.your_call || ""); f.elements.your_reason.value = init.your_reason || ""; return; }
      const row = f.querySelector(`.drow[data-dstep="${step}"]`); if (!row) return;
      const b = rowInit(row); press(row, "dec-" + step, b.call || ""); $("textarea", row).value = b.reason || ""; $("[data-dmark]", row).classList.remove("bad");
    };
    // a step drawn again from what is stored (after its save, or when someone else's call arrived), focus kept in the step
    const redraw = (step) => {
      const li = $("#dstep-" + step); if (!li) return;
      const had = li.contains(document.activeElement);
      li.innerHTML = step === "screening" ? screenStep(c, id) : decisionStep(c, step);
      if (step === "screening") { init.your_call = f.elements.your_call.value; init.your_reason = f.elements.your_reason.value; }
      bindDecisions(c);
      if (had) { const b = li.querySelector("button:not([hidden])"); if (b) b.focus(); }
    };
    // fields nobody touched since the form was drawn show what is stored now
    const sync = () => {
      for (const el of f.elements) {
        const k = el.name;
        if (!k || k === "your_call" || k === "your_reason" || !(k in init) || el.value !== init[k] || !(k in c)) continue;
        const v = k === "due" || k === "hired_at" ? dayOf(c[k]) : k === "stage" ? c.stage || "applied" : String(c[k] ?? "");
        if (v === el.value) continue;
        if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === v)) el.add(new Option(v, v), 0);
        el.value = v; init[k] = el.value;
        if (el.tagName === "TEXTAREA") fitArea(el);
      }
      if (!screenDirty()) redraw("screening");
    };
    const LABELS = { your_call: "1 · Screening", your_reason: "1 · Screening", stage: "Stage", due: "Due", next_step: "Next step", notes: "Notes", referred_by: "Referred by", bounty: "Referral bounty", hired_at: "Hired on" };
    Object.assign(f, { _marks: marks, _show: show, _reset: reset,
      _what: () => id ? [...new Set(Object.keys(changed()).map((k) => LABELS[k] || k).concat(decRows().filter(rowDirty).map((r) => DSTEPS[r.dataset.dstep])))] : Object.values(changed()).some(Boolean) ? ["the new candidate"] : [],
      _edits: () => ({ cid: id, fields: changed(), decs: Object.fromEntries(decRows().filter(rowDirty).map((r) => [r.dataset.dstep, rowVal(r)])) }) });
    bindDecisions(c);
    f.addEventListener("input", marks);
    // edits put back in their fields and steps, still to be saved: carried over a redraw, or a save that failed
    const apply = (edits) => {
      for (const [k, v] of Object.entries(edits.fields || {})) { const el = f.elements[k]; if (!el || el instanceof RadioNodeList) continue; el.value = v; if (el.tagName === "TEXTAREA") fitArea(el); }
      if (edits.fields && ("your_call" in edits.fields || "your_reason" in edits.fields)) { press(f, "yourcall", f.elements.your_call.value); show("screening", true); }
      for (const [step, v] of Object.entries(edits.decs || {})) {
        if (!f.querySelector(`.drow[data-dstep="${step}"]`)) { state.dOpen[`${c.id}|${step}`] = true; redraw(step); }
        const row = f.querySelector(`.drow[data-dstep="${step}"]`); if (!row) continue;
        show(step, true); press(row, "dec-" + step, v.call); $("textarea", row).value = v.reason; fitArea($("textarea", row));
      }
      marks();
    };
    if (carry) { apply(carry); if (carry.msg) say(carry.msg, true); }
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const raw = changed(), data = { ...raw };
      ["due", "hired_at"].forEach((k) => { if (k in data && !data[k] && c[k] && !dayOf(c[k])) delete data[k]; });  // see dateField
      ["next_step", "your_reason"].forEach((k) => { if (typeof data[k] === "string") data[k] = oneLine(data[k]); });  // one line, as the fields always held
      if (!id) {  // a new record: everything filled in
        const all = snap(); ["next_step", "your_reason"].forEach((k) => { if (typeof all[k] === "string") all[k] = oneLine(all[k]); });
        await api("candidates", "POST", all); Object.assign(init, snap()); forget(); await render(true); closeRecord(true); return;
      }
      const decs = decRows().filter(rowDirty).map((row) => ({ row, step: row.dataset.dstep, ...rowVal(row) }));
      // a No needs its reason: nothing goes until it has one
      const noReason = decs.find((d) => d.call === "No" && !d.reason);
      if (noReason) { const m = $("[data-dmark]", noReason.row); m.textContent = "Add the reason for the No"; m.classList.remove("warn"); m.classList.add("bad"); $("textarea", noReason.row).focus(); say("Not saved: a No needs its reason", true); return; }
      if (!Object.keys(data).length && !decs.length) { say(saved.textContent === "Saved" ? "Saved" : "Nothing changed"); return; }
      // An existing record saves in the background: the change shows at once (the record stays where it is and can be closed straight
      // away), the requests run on, and the card and the list behind follow what was stored when they answer. The stage shows the way the
      // Worker moves it when the call changes (its EARLY stages); the Worker decides it from the stage it holds.
      const before = { ...c }, wasBlind = blindNow(c), called = "your_call" in data, initBefore = { ...init };
      const local = { ...data }, stageNow = "stage" in data ? data.stage : c.stage || "applied";
      if (called && ["applied", "triaged", "confirmed", "declined"].includes(stageNow))
        local.stage = data.your_call === "Decline" ? "declined" : data.your_call === "Shortlist" ? "confirmed" : c.agent_call ? "triaged" : "applied";
      if ("stage" in data) data.stage_was = init.stage || "applied";
      Object.assign(c, local);
      if (called) c.call_by = data.your_call ? state.boot.who : "";  // the Worker records who made the call; the step shows it at once
      Object.assign(init, raw);
      if (local.stage && f.elements.stage) { const s = f.elements.stage; if (![...s.options].some((o) => o.value === local.stage)) s.add(new Option(local.stage, local.stage), 0); s.value = local.stage; init.stage = s.value; }
      const decBefore = decs.map((d) => d.row.dataset.init);
      decs.forEach((d) => { d.row.dataset.init = JSON.stringify({ call: d.call, reason: d.reason }); const m = $("[data-dmark]", d.row); m.textContent = "Saving…"; m.classList.remove("warn", "bad"); });
      delete f.dataset.dirty;
      saving++; say("Saving…");
      if (Object.keys(data).length) { setHead(c, wasBlind); setNow(c); if (called) redraw("screening"); }  // Claude's call stays hidden until a blind record is saved
      render(true);
      const quietly = (p) => p.then(() => ({ ok: true }), (err) => ({ ok: false, err }));
      const [rec, ...dres] = await Promise.all([Object.keys(data).length ? quietly(api("candidates/" + id, "PATCH", data)) : null,
        ...decs.map((d) => quietly(api(`decisions/${encodeURIComponent(c.id)}/${d.step}`, "PUT", { call: d.call, reason: d.reason })))]);
      saving--;
      const failed = [];
      if (rec && !rec.ok) {
        Object.assign(c, before);
        const err = rec.err, moved = err && err.status === 409 && err.data && err.data.stage;
        if (moved) {  // the stage changed while the card was open: nothing of the record was written; the card is drawn again from what is stored, with the rest still typed in it
          const { stage, ...rest } = raw, msg = `Not saved: the stage changed while the card was open (it is ${stageLabel(moved)} now). Your other changes are still here: check the stage and save again.`;
          dres.forEach((r, i) => { if (!r.ok) decs[i].row.dataset.init = decBefore[i]; });
          if (isOpen(id) && f.isConnected) {
            const later = f._edits(); delete later.fields.stage;  // and whatever was typed while the save was under way
            notice(""); state.carry = { cid: id, fields: { ...rest, ...later.fields }, decs: { ...Object.fromEntries(decs.filter((d, i) => !dres[i].ok).map((d) => [d.step, { call: d.call, reason: d.reason }])), ...later.decs }, msg };
            forget(); await render(true); await openCandidate(id);
          } else notice(`${c.name}: not saved. The stage changed while the record was open (it is ${stageLabel(moved)} now). Open the record and save again.`, true);
          return;
        }
        for (const k of Object.keys(raw)) init[k] = initBefore[k];  // still to be saved
        if (local.stage) init.stage = initBefore.stage;
        failed.push(`the record (${(err && err.message) || err})`);
        if (isOpen(id) && f.isConnected) {  // the card back to what is stored, with what didn't go still in its fields
          setHead(c); setNow(c);
          if (called) redraw("screening");
          if (local.stage && f.elements.stage) f.elements.stage.value = "stage" in raw ? raw.stage : initBefore.stage;
          apply({ fields: raw });
        }
      }
      dres.forEach((r, i) => { if (r.ok) return; decs[i].row.dataset.init = decBefore[i]; const m = $("[data-dmark]", decs[i].row); m.textContent = `Not saved (${(r.err && r.err.message) || r.err})`; m.classList.add("bad"); failed.push(DSTEPS[decs[i].step]); });
      // what is stored now: the record (the Worker moves the stage, keeps reached, hired_at and bounty_due) and the decisions
      if (decs.length) { try { state.decBy[c.id] = await api("decisions?candidate_id=" + encodeURIComponent(c.id)); if (state.decisions) state.decisions[c.id] = state.decBy[c.id]; } catch (e2) {} }
      if (rec && rec.ok) { try { Object.assign(c, await api("candidates/" + encodeURIComponent(id))); } catch (e2) {} }
      if (isOpen(id) && f.isConnected) {
        dres.forEach((r, i) => { if (r.ok && !rowDirty(decs[i].row)) redraw(decs[i].step); });
        if (rec && rec.ok) {
          sync(); setNow(c); syncSections(c);
          // a stage saved can bring a step's turn (2 · Interview from the first interview's booking on): the steps nobody is typing in follow
          ["interview", "second"].forEach((s) => { const row = f.querySelector(`.drow[data-dstep="${s}"]`); if (!row || !rowDirty(row)) redraw(s); });
          if (wasBlind) { const rb = $("#sec-read .rsec-b"); if (rb) rb.innerHTML = readBlock(c); setSum("read", readSummary(c)); }  // a blind record shows Claude's read now
        }
        setHead(c);
        say(failed.length ? `Not saved: ${failed.join(", ")}` : "Saved", !!failed.length);
        marks();
        if (failed.length) notice("");
      } else if (failed.length) notice(`${c.name}: not saved (${failed.join(", ")}). Open the record and save again.`, true);
      forget(); await render(true);
    });
  }
  // Decisions after screening. Interview: Go or No with a reason (needed for a No); whoever saves it is recorded, and each person has one.
  // Second interview: one each from the role's hiring manager and from Kostya (one row when that is the same person). A person edits
  // only their own; everyone else's shows as it was saved. Robots never write these, and they don't move the stage.
  // Since the second 14 Nov review a call made shows as one line (pill, reason, day, as everyone else's), the panel's Save saves every step,
  // and a step before its stage is one quiet line.
  const DSTEPS = { interview: "2 · Interview", second: "3 · Second interview" };
  const decOf = (c, step) => decsOf(c).filter((d) => d.step === step).sort((a, b) => (a.at || "").localeCompare(b.at || ""));
  const myCall = () => `${firstName(state.boot.who)}'s call`;
  // A call made, as one line: whose, the call, the reason, the day; on one's own, Edit (Change on someone else's screening call, which the
  // record holds once)
  const roLine = (step, label, call, reason, at, act) => `<div class="drow ro"${act ? ` data-dro="${step}"` : ""}><span class="dwho">${h(label)}</span>${pill(call, callKind(call))}${act ? `<button type="button" class="linkbtn small dedit-btn" data-dedit="${step}">${h(act)}</button>` : ""}
      <span class="dreason">${h(reason)}${at ? `${reason ? " " : ""}<span class="cmeta">${h(fmt(at))}</span>` : ""}</span></div>`;
  // 1 · Screening: the record's own call. The row that edits it carries the viewer's name; the recruiter who is meant to make it is a note.
  function screenStep(c, id) {
    const me = state.boot.who, by = callBy(c), made = !!(id && c.your_call), rec = roleOf(c.role_id).recruiter;
    // Claude's call on the step's own line, and the rule it carries in the reason's placeholder (one line, not two, in the 320px panel)
    const claude = id && c.agent_call && !blindNow(c) ? c.agent_call : "";
    const note = made ? (by && by !== me ? `<span class="dnote" data-dnote hidden>Saving replaces ${h(firstName(by))}'s call.</span>` : "")
      : rec && rec !== me ? `<span class="dnote">${h(firstName(rec))} makes this call.</span>` : "";
    return `<span class="lbl">1 · Screening${claude ? `<span class="dclaude" title="Claude suggests ${h(claude)}. A call that differs needs its reason."> · Claude: ${h(claude)}</span>` : ""}</span>${made ? roLine("screening", by ? `${firstName(by)}'s call` : "Call", c.your_call, c.your_reason, "", by && by !== me ? "Change" : "Edit") : ""}${note}
      <div class="dedit" data-dedit-row="screening"${made ? " hidden" : ""}><div class="drow" data-dscreen><span class="dwho">${h(myCall())}</span>${seg("yourcall", [["Shortlist", "Shortlist"], ["Hold", "Hold"], ["Decline", "Decline"]], c.your_call || "")}<input type="hidden" name="your_call" value="${h(c.your_call || "")}">
        <textarea name="your_reason" class="fit oneline" rows="1" placeholder="${claude ? `Reason, needed if not ${h(claude)}` : "Reason"}" aria-label="Reason for the screening call${claude ? `, needed when it differs from Claude's ${h(claude)}` : ""}">${h(c.your_reason)}</textarea>
        <span class="dact"><span class="saved" data-dmark></span>${made ? `<button type="button" class="linkbtn small" data-dcancel="screening">Cancel</button>` : ""}</span></div></div>`;
  }
  // 2 · Interview from the first interview's booking on, 3 · Second interview from the test assignment on; before that one quiet line, with
  // "Decide now" on an open record for when the stage lags behind what happened (14 Nov review: the two steps took 500px of the panel on
  // every card, a screening one or a rejected one too). Whoever saves an interview decision is recorded, one per person; the second
  // interview's are the role's hiring manager's and Kostya's. Robots never write these, and they don't move the stage.
  const DFROM = { interview: "interview booked", second: "work sample" }, DLATER = { interview: "from the first interview", second: "after the test" };
  function decisionStep(c, step) {
    const me = state.boot.who, role = roleOf(c.role_id), all = decOf(c, step), mine = all.find((d) => d.by === me);
    const label = `<span class="lbl">${DSTEPS[step]}</span>`;
    if (!all.length && reachedIdx(c) < stageIdx(DFROM[step]) && !state.dOpen[`${c.id}|${step}`])
      return isClosedStage(c) || isClosedRole(role) ? `<div class="dlater">${label}<span class="muted small">${h(DLATER[step])}</span></div>`
        : `<button type="button" class="dlater" data-dnow="${step}" title="Decide now" aria-label="${h(DSTEPS[step])}, ${h(DLATER[step])}: decide now">${label}<span class="muted small">${h(DLATER[step])}</span></button>`;
    const deciders = step === "second" ? [...new Set([leadEmail(role), state.boot.final_call].filter(Boolean))] : [];
    const mayDecide = step === "interview" || deciders.includes(me);
    const line = (d) => roLine(step, `${firstName(d.by)}'s call`, d.call, d.reason, d.at, d.by === me ? "Edit" : "");
    let rows, note = "";
    if (step === "interview") {
      rows = all.filter((d) => d.by !== me).map(line).join("") + (mine ? line(mine) : "");
      if (!all.length && role.recruiter && role.recruiter !== me) note = `${firstName(role.recruiter)} makes this call.`;
    } else {
      rows = deciders.map((by) => { const d = all.find((x) => x.by === by); return d ? line(d) : by === me ? "" : `<div class="drow ro"><span class="dwho">${h(firstName(by))}'s call</span><span class="muted small">not made yet</span></div>`; }).join("")
        + all.filter((d) => !deciders.includes(d.by)).map(line).join("");  // saved by someone who was the hiring manager then
      if (!mayDecide) note = `${deciders.map((x) => firstName(x)).join(" and ")} make${deciders.length > 1 ? "" : "s"} this call.`;
    }
    // the viewer's own row: open while it is theirs to take (nobody decided the interview yet; their second-interview call), behind Edit once
    // they decided, behind "Add" while others have and they haven't
    const open = mayDecide && !mine && (step === "second" || !all.length);
    const init = JSON.stringify({ call: mine ? mine.call : "", reason: mine ? mine.reason || "" : "" });
    const edit = !mayDecide ? "" : `<div class="dedit" data-dedit-row="${step}"${open ? "" : " hidden"}><div class="drow" data-dstep="${step}" data-init="${h(init)}"><span class="dwho">${h(myCall())}</span>${seg("dec-" + step, [["Go", "Go"], ["No", "No"]], mine ? mine.call : "")}
        <textarea class="dreason fit oneline" rows="1" placeholder="Reason, needed for a No" aria-label="Reason for the ${step === "second" ? "second-interview" : "interview"} decision">${h(mine ? mine.reason : "")}</textarea>
        <span class="dact"><span class="saved" data-dmark></span>${open ? "" : `<button type="button" class="linkbtn small" data-dcancel="${step}">Cancel</button>`}</span></div></div>`;
    const add = mayDecide && !mine && !open ? `<button type="button" class="linkbtn small dadd" data-dadd="${step}">Add ${h(myCall())}</button>` : "";
    return `${label}${note ? `<span class="dnote">${h(note)}</span>` : ""}${rows}${edit}${add}`;
  }
  // The steps' controls: Edit, Change, Add and Decide now open a row, Cancel puts it back as stored, Go and No press and unpress (unpressed and
  // saved, one's own decision is taken back), and Enter in a reason saves the panel. New rows after a redraw are bound once.
  function bindDecisions(c) {
    const f = $("#cform"); if (!f) return;
    const marks = () => f._marks && f._marks(), show = (step, on) => f._show && f._show(step, on);
    // the screening call: a click picks, a click on the picked one takes it back (the hidden field is what the form sends)
    f.querySelectorAll('[data-seg="yourcall"] button:not([data-bound])').forEach((b) => { b.dataset.bound = "1"; b.addEventListener("click", () => {
      const cur = f.elements.your_call; cur.value = cur.value === b.dataset.v ? "" : b.dataset.v;
      f.querySelectorAll('[data-seg="yourcall"] button').forEach((x) => x.setAttribute("aria-pressed", x.dataset.v === cur.value)); marks(); }); });
    f.querySelectorAll(".drow[data-dstep]:not([data-bound])").forEach((row) => {
      row.dataset.bound = "1";
      const step = row.dataset.dstep;
      bindSeg(row, "dec-" + step, (v) => { const cur = (row.querySelector('[data-seg] button[aria-pressed="true"]') || { dataset: {} }).dataset.v;
        row.querySelectorAll("[data-seg] button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === v && cur !== v)); $("[data-dmark]", row).classList.remove("bad"); marks(); });
    });
    f.querySelectorAll("textarea.oneline:not([data-ol])").forEach((ta) => {
      ta.dataset.ol = "1";
      ta.addEventListener("input", () => fitArea(ta));
      // one line of text, as the fields always held: Enter saves the panel, and a line break becomes a space on save
      ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); f.requestSubmit(); } });
      fitArea(ta); requestAnimationFrame(() => fitArea(ta));
    });
    const once = (sel, fn) => f.querySelectorAll(`${sel}:not([data-bound])`).forEach((b) => { b.dataset.bound = "1"; b.addEventListener("click", () => fn(b)); });
    once("[data-dedit], [data-dadd]", (b) => { const step = b.dataset.dedit || b.dataset.dadd; show(step, true);
      const row = f.querySelector(`[data-dedit-row="${step}"]`), t = row && (row.querySelector('[data-seg] button[aria-pressed="true"]') || row.querySelector("[data-seg] button")); if (t) t.focus(); });
    once("[data-dcancel]", (b) => { const step = b.dataset.dcancel; if (f._reset) f._reset(step); show(step, false); marks();
      const back = f.querySelector(`[data-dro="${step}"] [data-dedit], [data-dadd="${step}"]`); if (back) back.focus(); });
    once("[data-dnow]", (b) => { const step = b.dataset.dnow; state.dOpen[`${c.id}|${step}`] = true; const li = $("#dstep-" + step); li.innerHTML = decisionStep(c, step); bindDecisions(c);
      const t = li.querySelector("[data-seg] button"); if (t) t.focus(); });
  }
  // ---------- the message screen: one concern per shortlisted candidate and the LinkedIn message that checks it ----------
  // Claude writes the concern and the message; Kostya edits if he wants, copies it into LinkedIn and marks it sent, which moves the
  // candidate to "messaged". The same panel shows on the Screening view and in the candidate record.
  const SENT = ORDER.slice(ORDER.indexOf("messaged"));  // messaged and every funnel stage after it
  // Sent once the candidate got as far as messaged, closed since or not, or once the conversation has a message to them (second 14 Nov
  // review: the current stage alone showed a withdrawn or declined candidate's sent message as unsent, with Mark as sent)
  const wasSent = (c) => SENT.includes(c.stage || "") || reachedIdx(c) >= stageIdx("messaged") || msgsOf(c).some((m) => m.direction === "out");
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
  // keep: on the card, only the last few messages show, the earlier ones behind one fold above them (14 Nov review: a five-message thread
  // ran about 2,000px before the reply draft)
  function convoHtml(c, keep) {
    const list = msgsOf(c);
    if (!list.length) return "";
    const first = (c.name || "").split(" ")[0], n = list.filter((m) => m.direction === "in").length;
    const one = (m) => `<div class="msg ${m.direction === "in" ? "in" : "out"}"><div class="mmeta">${m.direction === "in" ? h(first) : "You"} · ${h(CHANNEL[m.channel] || m.channel)} · ${h(atWord(m.at))}</div><div class="mbody">${linkify(m.body)}</div></div>`;
    const cut = keep && list.length > keep + 1 ? list.length - keep : 0;
    return `<div class="convo"><span class="lbl">Conversation · ${list.length} message${list.length > 1 ? "s" : ""}${n ? ` · ${n} from ${h(first)}` : " · no reply yet"}</span>
      ${cut ? `<details class="fold plain convomore"><summary>${cut} earlier message${cut > 1 ? "s" : ""}</summary><div class="convolist">${list.slice(0, cut).map(one).join("")}</div></details>` : ""}${list.slice(cut).map(one).join("")}</div>`;
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
  // rec: the panel inside a candidate's record, where the header already has Open CV and LinkedIn and the Messages section lays out the
  // conversation and the reply itself (see messagesHtml). A concern not written yet leaves no empty label.
  function screenPanel(c, rec) {
    if (!c.screen_concern && !c.screen_message) return `<p class="muted small">No concern written yet. Claude writes one for every shortlisted candidate.</p>${rec ? "" : convoHtml(c) + replyHtml(c)}`;
    const application = urlsIn(c.cv).filter((u) => /linkedin\.com\/hiring\/applicants/.test(u)).map((u) => `<a class="btn ghost small" href="${h(u)}" target="_blank" rel="noopener">Application ↗</a>`).join("");
    return `<div class="scrpanel${c.screen_concern ? "" : " noconcern"}" data-sid="${h(c.id)}" data-stage="${h(c.stage || "applied")}">
      ${c.screen_concern ? `<div class="scrcol"><span class="lbl">Concern to verify</span><p class="concern">${h(c.screen_concern)}</p></div>` : ""}
      <div class="scrcol"><span class="lbl">Message to send on LinkedIn</span><textarea class="scrmsg" rows="7" aria-label="Message to ${h(c.name)}">${h(c.screen_message)}</textarea>
        <div class="pact"><button type="button" class="btn small" data-copy>Copy</button><button type="button" class="btn ghost small" data-savemsg hidden>Save the edit</button>
          ${wasSent(c) ? `<span class="pill ok">sent${c.last_contact ? " " + h(fmt(c.last_contact)) : ""}</span>`
            : isClosedStage(c) || isClosedRole(roleOf(c.role_id)) ? `<span class="muted small">Not sent · the record is closed</span>` : `<button type="button" class="btn ghost small" data-sent>Mark as sent</button>`}
          ${rec ? "" : cvOpen(c, "btn small")}
          ${!rec && c.linkedin ? `<a class="btn ghost small" href="${h(c.linkedin)}" target="_blank" rel="noopener">LinkedIn ↗</a>` : ""}
          ${application}</div>
        ${c.latest_reply && !repliedAt(c) ? `<div class="answer"><span class="lbl">Latest reply</span><p>${h(c.latest_reply)}</p></div>` : ""}</div>${rec ? "" : convoHtml(c) + replyHtml(c)}</div>`;
  }
  // Once the screening message is sent (or the candidate is past it): the concern it checks, the message as one line that opens to its text
  // (the conversation holds it too), and a reply recorded outside the conversation. Empty when there is none of it.
  function sentScreenHtml(c) {
    const norm = (t) => String(t || "").replace(/\s+/g, " ").trim(), out = msgsOf(c).filter((m) => m.direction !== "in");
    const at = (out.find((m) => norm(m.body) === norm(c.screen_message)) || {}).at || c.last_contact || "";
    return [c.screen_concern ? `<div class="kvline scrsentc"><span class="lbl">Concern to verify</span><span>${h(c.screen_concern)}</span></div>` : "",
      c.screen_message ? `<details class="fold plain scrsent"><summary>Screening message · sent${at ? " " + h(fmt(at)) : ""}</summary><p class="scrtext">${linkify(c.screen_message)}</p></details>` : "",
      c.latest_reply && !repliedAt(c) ? `<div class="answer"><span class="lbl">Latest reply</span><p>${h(c.latest_reply)}</p></div>` : ""].filter(Boolean).join("");
  }
  // The record's Messages section, the thing to act on first (14 Nov review: the reply draft came last, 2,000px down): Claude's reply draft,
  // then for someone in screening or with a concern written the message screen (the message to send; once sent, one line), then the
  // conversation with its last two messages open. Hidden in a blind batch, as the message screen always was.
  const messagesHtml = (c) => blindNow(c) ? "" : [replyHtml(c),
    inScreening(c) || c.screen_concern ? (wasSent(c) ? sentScreenHtml(c) : screenPanel(c, true)) : "",
    convoHtml(c, 2)].filter(Boolean).join("");

  // ---------- the call sheets on the card (5 Nov) ----------
  // candidates.interview_sheet holds one Markdown sheet per call, newest first, each starting "# <step> · <date, time (-03)>"; text
  // before the first "# " is a sheet called "Interview script" (the format of 27 Oct). Under its title a sheet has one meta paragraph,
  // then "## " sections, which the card groups as Context, Script, Next steps and Results (talent-checkin README).
  // Rendered safely: every piece of text goes through h(), and only this small subset of Markdown becomes HTML: ### headings, **bold**,
  // *italic*, `code`, [text](http link), bare http(s) addresses, lists and tables. Nothing from a sheet is ever inserted as HTML.
  const INLINE_MD = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*(?=\S)(.*?\S)\*\*|(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])|(https?:\/\/[^\s<>"'`]+)/g;
  // a bare address ends before trailing punctuation, and before a closing bracket it didn't open
  function trimUrl(u) {
    let tail = "";
    const extra = (o, c) => u.split(c).length > u.split(o).length;
    while (u.length > 10) {
      const ch = u.slice(-1);
      if (/[.,;:!?'"*_]/.test(ch) || (ch === ")" && extra("(", ")")) || (ch === "]" && extra("[", "]"))) { tail = ch + tail; u = u.slice(0, -1); } else break;
    }
    return [u, tail];
  }
  // plain: the same text without markers or link targets (for summary lines, which must not hold links, and for lengths). Only mdPlain
  // passes it: mdInline(t) on its own always escapes, also when handed to Array.map (whose index would otherwise read as the flag).
  const mdInline = (t) => inlineMd(t, false);
  function inlineMd(t, plain) {
    const s = String(t == null ? "" : t); let out = "", at = 0;
    for (const m of s.matchAll(INLINE_MD)) {
      out += plain ? s.slice(at, m.index) : h(s.slice(at, m.index)); at = m.index + m[0].length;
      const [, code, text, href, bold, it1, it2, url] = m;
      if (plain) { out += code != null ? code : text != null ? inlineMd(text, true) : bold != null ? inlineMd(bold, true) : it1 != null || it2 != null ? inlineMd(it1 != null ? it1 : it2, true) : url; continue; }
      if (code != null) out += `<code>${h(code)}</code>`;
      else if (text != null) out += /^https?:\/\//i.test(href) ? `<a href="${h(href)}" target="_blank" rel="noopener">${mdInline(text)}</a>` : mdInline(text);
      else if (bold != null) out += `<b>${mdInline(bold)}</b>`;
      else if (it1 != null || it2 != null) out += `<i>${mdInline(it1 != null ? it1 : it2)}</i>`;
      else { const [u, tail] = trimUrl(url); out += `<a href="${h(u)}" target="_blank" rel="noopener">${h(u)}</a>${h(tail)}`; }
    }
    return out + (plain ? s.slice(at) : h(s.slice(at)));
  }
  const mdPlain = (t) => inlineMd(t, true);
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l), isSep = (l) => /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(l);
  const cellsOf = (l) => l.trim().replace(/\\\|/g, "\u0001").replace(/^\||\|$/g, "").split("|").map((x) => x.trim().replace(/\u0001/g, "|"));
  const ITEM = /^(\s*)([-*+]|\d+[.)])\s+/;
  // "Show more" under a paragraph or a meta line that is clamped (one click handler on the record, see below)
  const clampHtml = (inner) => `<div class="clampbox">${inner}<button type="button" class="linkbtn small" data-more aria-expanded="false">Show more</button></div>`;
  // One paragraph per line: the robots write one statement per line and never wrap. A leading "Label:" reads in bold, and a paragraph over
  // about 700 characters shows four lines and "Show more".
  function mdPara(t) {
    const m = !/^\*\*/.test(t) && t.match(/^([A-Z][\w ’'()/&+.-]{0,46}?):\s/);
    const html = m ? `<b>${h(m[1])}:</b> ${mdInline(t.slice(m[0].length))}` : mdInline(t);
    return mdPlain(t).length > 700 ? clampHtml(`<p class="clamp4">${html}</p>`) : `<p>${html}</p>`;
  }
  function mdList(lines, i) {  // → [html, the next line]; deeper lines belong to the item above them
    const ind = (l) => l.match(/^\s*/)[0].length, base = ind(lines[i]), first = lines[i].match(ITEM)[2], items = [];
    while (i < lines.length && lines[i].trim()) {
      const l = lines[i];
      if (ind(l) === base && ITEM.test(l)) { items.push({ text: l.replace(ITEM, ""), sub: [] }); i++; }
      else if (ind(l) > base && items.length) { items[items.length - 1].sub.push(l); i++; }
      else break;
    }
    const li = (it) => {
      if (!it.sub.some((x) => ITEM.test(x) || isRow(x))) return `<li>${mdInline([it.text].concat(it.sub.map((x) => x.trim())).join(" "))}</li>`;
      const cut = Math.min(...it.sub.map(ind));
      return `<li>${mdInline(it.text)}${mdBlocks(it.sub.map((x) => x.slice(cut)).join("\n"))}</li>`;
    };
    const ordered = /\d/.test(first), start = ordered ? parseInt(first, 10) : 1;
    return [`<${ordered ? "ol" : "ul"}${start > 1 ? ` start="${start}"` : ""}>${items.map(li).join("")}</${ordered ? "ol" : "ul"}>`, i];
  }
  // A table whose cells are short stays a compact table (scrolling inside its own frame on a phone). When any cell runs past ~140
  // characters, its rows become an accordion: the first cell and the short cells (a score, "Not asked") on the row, the long cells
  // under it when opened, each with its column's name.
  function mdTable(rows) {
    const all = rows.filter((r) => !isSep(r)).map(cellsOf);
    if (!all.length) return "";
    const [head, ...body] = all, n = head.length, len = (x) => mdPlain(x).length;
    const full = body.map((r) => Array.from({ length: Math.max(n, r.length) }, (_, k) => r[k] || ""));
    if (!full.some((r) => r.some((x) => len(x) > 140)))
      return `<div class="tablewrap mdt"><table class="${full.every((r) => len(r[0]) <= 24) ? "idcol" : ""}" style="min-width:${Math.min(720, n * 110)}px"><thead><tr>${head.map((x) => `<th>${mdInline(x)}</th>`).join("")}</tr></thead><tbody>${
        full.map((r) => `<tr>${r.map((x) => `<td>${mdInline(x)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    const empty = (x) => !x.replace(/[_\s–-]/g, "");
    return `<div class="tacc"><div class="tacchead">${head.map((x) => h(mdPlain(x))).filter(Boolean).join(" · ")}</div>${full.map((r) => {
      const cells = r.slice(1).map((x, k) => [head[k + 1] || "", x]).filter(([, x]) => !empty(x));
      const short = cells.filter(([, x]) => len(x) <= 40), long = cells.filter(([, x]) => len(x) > 40);
      // a bare index ("1", "#") says nothing on its own: the row also shows the start of its first long cell
      const peek = len(r[0]) <= 4 && long.length ? `<span class="trp">${h(mdPlain(long[0][1]))}</span>` : "";
      // on the row a column goes by its short name ("Proof", not "Proof (what she showed, time)"); opened, by its full one
      const sum = `<span class="tr1">${h(mdPlain(r[0])) || "–"}</span>${short.map(([k, x]) => `<span class="tcs"><small>${h(mdPlain(k).replace(/\s*\([^)]*\)\s*/g, " ").trim())}</small> ${h(mdPlain(x))}</span>`).join("")}${peek}`;
      return long.length ? `<details class="trow"><summary>${sum}</summary><dl class="trd">${long.map(([k, x]) => `<dt>${mdInline(k)}</dt><dd>${mdInline(x)}</dd>`).join("")}</dl></details>`
        : `<div class="trow flat">${sum}</div>`;
    }).join("")}</div>`;
  }
  function mdBlocks(md) {
    const lines = String(md || "").replace(/\r/g, "").split("\n"), out = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      if (/^\s*```/.test(l)) { const code = []; i++; while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]); i++; out.push(`<pre><code>${h(code.join("\n"))}</code></pre>`); continue; }
      const m = l.match(/^(#{1,6})\s+(.*)$/);
      if (m) { const n = Math.min(m[1].length + 2, 6); out.push(`<h${n}>${mdInline(m[2])}</h${n}>`); i++; continue; }
      if (isRow(l)) { const rows = []; while (i < lines.length && isRow(lines[i])) rows.push(lines[i++]); out.push(mdTable(rows)); continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
      if (ITEM.test(l)) { const [html, next] = mdList(lines, i); out.push(html); i = next; continue; }
      if (/^\s*>/.test(l)) { const q = []; while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, "")); out.push(`<blockquote>${mdBlocks(q.join("\n"))}</blockquote>`); continue; }
      out.push(mdPara(l.trim())); i++;
    }
    return out.join("");
  }

  // The sheets, newest first: { title, meta, sections: [{ heading, body, group }], filled, chips }
  const SHEET_GROUPS = [["context", "Context"], ["script", "Script"], ["next", "Next steps"], ["results", "Results"]];
  const bareHead = (t) => String(t || "").replace(/^\s*\d+[.)]\s*/, "").trim();
  const sameAs = (heading, label) => bareHead(heading).toLowerCase().replace(/\s+/g, " ") === label.toLowerCase();
  const afterCall = (heading) => /^(after the call|results?\b)/i.test(bareHead(heading));
  // An "After the call" section is filled once it has a weighted score, a verdict, or a value in an "AI score" column
  function callFilled(body) {
    if (/\bWeighted\b[^\n]*?[:=]\s*\d/i.test(body) || /\bVerdict\s*:\s*(?![_\s])\S/i.test(body)) return true;
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!isRow(lines[i]) || (i && isRow(lines[i - 1]))) continue;  // a table's first row is its header
      const k = cellsOf(lines[i]).findIndex((x) => /^ai score$/i.test(mdPlain(x).trim()));
      if (k >= 0) for (let j = i + 1; j < lines.length && isRow(lines[j]); j++) if (!isSep(lines[j]) && (cellsOf(lines[j])[k] || "").replace(/[_\s–-]/g, "")) return true;
    }
    return false;
  }
  // An "After the call" not filled yet is the robots' empty template: it is no group of its own and no Next step ("pending", shown as one
  // muted line, 14 Nov review: the six-part sheets' Next steps held only that template)
  function sheetGroup(heading, body) {
    const t = bareHead(heading).toLowerCase();
    if (afterCall(heading)) return callFilled(body) ? "results" : "pending";
    if (/^next steps?\b/.test(t)) return "next";
    if (/script|run sheet|questions|logistics|quick marks|agenda|role.?play/.test(t)) return "script";
    return "context";
  }
  // The call's outcome in a few words, from the status line the robots write: "Weighted: 1.6 · Must-pass: fail · Verdict: No · Confidence: medium"
  function resultChips(text) {
    const pick = (re) => { const m = text.match(re); return m ? m[1].trim().replace(/\s+/g, " ").slice(0, 40) : ""; };
    return [["Weighted", pick(/\bWeighted\s*:\s*(\d+(?:[.,]\d+)?)/i) || pick(/\bWeighted\b[^\n]*?=\s*(\d+(?:[.,]\d+)?)\b/i)], ["Must-pass", pick(/\bMust-pass\s*:\s*([A-Za-z][\w-]*)/i)],
      ["Verdict", pick(/\bVerdict\s*:\s*([A-Za-z][^(·|\n.;,]*)/i)], ["Confidence", pick(/\bConfidence\s*:\s*([A-Za-z][\w-]*)/i)]].filter(([, v]) => v);
  }
  const chipKind = (k, v) => { const x = v.toLowerCase();
    return k === "Must-pass" ? (/^(pass|met)/.test(x) ? "ok" : /^fail/.test(x) ? "bad" : "warn")
      : k === "Verdict" ? (/^(no\b|below|fail|reject|decline)/.test(x) ? "bad" : /^(yes|meets|pass|strong|hire|move)/.test(x) ? "ok" : "warn") : ""; };
  // a long verdict ("not decidable from this call") is cut to the pill's width; the title keeps it whole
  const chipsHtml = (chips) => chips.map(([k, v]) => `<span class="pill ${chipKind(k, v)}" title="${h(k)} ${h(v)}">${h(k)} ${h(v)}</span>`).join("");
  function parseSheets(text) {
    const sheets = []; let cur = null, fence = false;
    for (const l of String(text || "").replace(/\r/g, "").split("\n")) {
      if (/^\s*```/.test(l)) fence = !fence;
      const m = !fence && l.match(/^#\s+(.+?)\s*#*\s*$/);
      if (m) { cur = { title: m[1], lines: [] }; sheets.push(cur); continue; }
      if (!cur) { if (!l.trim()) continue; cur = { title: "Interview script", lines: [] }; sheets.push(cur); }
      cur.lines.push(l);
    }
    return sheets.map(({ title, lines }) => {
      let i = 0; while (i < lines.length && !lines[i].trim()) i++;
      const meta = [];  // the first paragraph under the title, unless it is a heading, a list or a table
      const plainLine = (l) => l.trim() && !/^\s*(#|\||```|>|([-*+]|\d+[.)])\s)/.test(l);
      while (i < lines.length && plainLine(lines[i])) meta.push(lines[i++].trim());
      const sections = []; let sec = { heading: "", lines: [] };
      const push = () => { const body = sec.lines.join("\n").trim(); if (sec.heading || body) sections.push({ heading: sec.heading, body, group: sheetGroup(sec.heading, body) }); };
      for (; i < lines.length; i++) { const m = lines[i].match(/^##\s+(.+?)\s*#*\s*$/); if (m) { push(); sec = { heading: m[1], lines: [] }; } else sec.lines.push(lines[i]); }
      push();
      const res = sections.filter((x) => x.group === "results");
      return { title, meta, sections, filled: res.length > 0, chips: resultChips(res.map((x) => x.body).join("\n")) };
    });
  }
  // A group's one-line hint: Script counts its questions (Q1., Q2. … or a numbered list under a "questions" heading) or its parts,
  // Results shows the outcome chips, Next steps counts the steps, Context names what it covers.
  function groupHint(g, secs, sheet, shown) {
    const text = secs.map((x) => x.body).join("\n"), plural = (n, w) => `${n} ${w}${n > 1 ? "s" : ""}`;
    if (g === "results") return shown ? chipsHtml(sheet.chips) : h(FOLDED);
    if (g === "script") {
      const qs = new Set();
      secs.map((x) => bareHead(x.heading)).concat(text.split("\n")).forEach((l) => { const m = l.match(/^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\*\*|__)?\s*(?:\d{1,2}:\d{2}\s+)?Q(\d{1,3})\b/); if (m) qs.add(m[1]); });
      const n = qs.size || secs.filter((x) => /question/i.test(x.heading)).reduce((k, x) => k + (x.body.match(/^\s*\d+[.)]\s+/gm) || []).length, 0);
      if (n) return h(plural(n, "question"));
      const parts = secs.length > 1 ? secs.length : (text.match(/^\s*(?:[-*+]\s+)?\*\*\d{1,2}:\d{2}\b/gm) || []).length;
      return parts > 1 ? h(`${parts} parts`) : "";
    }
    if (g === "next") {
      const steps = secs.reduce((k, x) => k + (x.body.match(/^\s*([-*+]|\d+[.)])\s+/gm) || []).length, 0);
      return h(steps ? plural(steps, "step") : "");
    }
    const heads = [];
    secs.forEach((x) => { if (x.heading && !sameAs(x.heading, "Context")) heads.push(bareHead(x.heading)); (x.body.match(/^#{3,6}\s+.+$/gm) || []).forEach((y) => heads.push(y.replace(/^#+\s+/, ""))); });
    return h(heads.map(mdPlain).join(" · "));
  }
  // Context, Script, Next steps and Results, each closed until opened (its state is kept while the record is redrawn). When several of the
  // sheet's sections land in one group, each keeps its heading.
  function sheetGroupsHtml(c, sheet, si) {
    const shown = callsShown(c);
    const groups = SHEET_GROUPS.map(([g, label]) => {
      const secs = sheet.sections.filter((x) => x.group === g && x.body);
      if (!secs.length) return "";
      const key = `${c.id}|${si}|${g}`, open = !!state.subOpen[key], many = secs.length > 1;
      const sub = (x) => x.heading && (many || (g !== "results" && !sameAs(x.heading, label))) ? `<h4 class="sh">${mdInline(bareHead(x.heading))}</h4>` : "";
      return `<details class="subp" data-sub="${h(key)}" data-state="${open ? 1 : 0}"${open ? " open" : ""}><summary><span class="subt">${h(label)}</span><span class="subh">${groupHint(g, secs, sheet, shown)}</span></summary>
        <div class="subb sheet">${g === "results" && sheet.chips.length ? `<div class="chips rchiprow">${chipsHtml(sheet.chips)}</div>` : ""}${secs.map((x) => sub(x) + mdBlocks(x.body)).join("")}</div></details>`;
    }).join("");
    // the robots' empty "After the call": one line, nothing to open
    const waiting = !sheet.filled && sheet.sections.some((x) => x.group === "pending") ? `<div class="subp subwait"><span class="subt">Results</span><span class="subh">${si ? "none recorded" : "after the call"}</span></div>` : "";
    return groups + waiting;
  }
  // The step's name: the sheet's title without the candidate's name in front ("Yana H., first interview, 29 Oct" → "First interview, 29 Oct")
  function stepName(c, title) {
    const n = (c.name || "").trim(), t = n && title.toLowerCase().startsWith(n.toLowerCase()) ? title.slice(n.length).replace(/^\s*[,·:–—-]\s*/, "") : title;
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : title;
  }
  const metaHtml = (meta) => { const html = meta.map((l) => mdInline(l)).join("<br>");
    return !meta.length ? "" : mdPlain(meta.join(" ")).length > 240 ? clampHtml(`<p class="callmeta clamp2">${html}</p>`) : `<p class="callmeta">${html}</p>`; };
  // The day a sheet's title names ("First interview, 4 Nov 2026 12:00 (-03)", "Work sample call (2nd interview) · Thu 5 Nov, 12:30–13:30
  // (-03)") as YYYY-MM-DD; a title without a year is read in the year that puts the day nearest to today. "" when it names none.
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  function sheetDay(title) {
    const m = String(title || "").match(/\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?(?:,?\s+(\d{4})\b)?/i);
    if (!m) return "";
    const mon = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()), now = new Date(today() + "T12:00:00");
    let y = m[3] ? +m[3] : now.getFullYear();
    if (!m[3]) { const away = (new Date(y, mon, +m[1], 12) - now) / 864e5; if (away > 182) y--; else if (away < -182) y++; }
    const d = new Date(y, mon, +m[1], 12);
    return d.getMonth() === mon ? localDay(d) : "";
  }
  // What stands now, from the record's Next step (the robots keep it with what actually happened: a call moved, cancelled, held), under
  // the call's name, with the due day. 14 Nov review: a booking whose day had passed still read as the next call.
  // For someone yet to score (callsShown), a sentence of it that carries the AI card's result leaves the line, which says so (second 14 Nov
  // review: Next steps stored before the robots' prompts changed put "AI card: weighted 2.47, partial" right above "folded until you score").
  const AI_RESULT = /\bweighted\b|\bverdict\b|\bmust-pass\b|\bAI card\b\s*:?\s*\d/i;
  const nowText = (c) => { const t = c.next_step || "";
    if (!AI_RESULT.test(t) || callsShown(c)) return t;
    const kept = t.split(/(?<=[.;!?])\s+/).filter((s) => !AI_RESULT.test(s)).join(" ").replace(/[\s;,:]+$/, "");
    return `${kept ? kept.replace(/([^.!?])$/, "$1.") + " " : ""}The AI card's result is folded until you score.`; };
  const callNowHtml = (c) => c.next_step ? `<span class="lbl">Now${c.due ? ` · due ${h(fmt(c.due))}` : ""}</span> ${h(nowText(c))}` : "";
  // The Next call panel: the newest sheet's name, what stands now, its meta line, and its four groups. "Latest call" once its results are
  // filled; "Booked call · date passed" once its day is behind us without results. The panel itself doesn't fold, its groups do (second
  // 14 Nov review: a click on the Now line, to select a time, folded the panel on every card, and the fold was remembered).
  function nextCallHtml(c, sheet) {
    const groups = sheetGroupsHtml(c, sheet, 0), day = sheetDay(sheet.title);
    const eyebrow = sheet.filled ? "Latest call" : day && day < today() ? "Booked call · date passed" : "Next call";
    return `<section class="callp" id="sec-next" aria-labelledby="callt"><div class="callhd"><span class="eyebrow${sheet.filled || eyebrow === "Next call" ? "" : " late"}">${eyebrow}</span>
      <h3 class="callt" id="callt">${h(mdPlain(stepName(c, sheet.title)))}</h3></div>
      <div class="callb"><p class="callnow" id="callnow"${c.next_step ? "" : " hidden"} title="${h(nowText(c))}">${callNowHtml(c)}</p>${metaHtml(sheet.meta)}${groups ? `<div class="subps">${groups}</div>` : ""}</div></section>`;
  }
  // After the viewer saves a card of their own, the call sheets' results unfold in place (callsShown), the panel's open parts kept
  function refreshCalls(c) {
    if (!isOpen(c.id)) return;
    const sheets = parseSheets(c.interview_sheet), nx = $("#sec-next"), eb = $("#sec-earlier .rsec-b");
    if (nx && sheets.length) nx.outerHTML = nextCallHtml(c, sheets[0]);
    if (eb && sheets.length > 1) { eb.innerHTML = earlierHtml(c, sheets.slice(1)); setSum("earlier", earlierSummary(c, sheets.slice(1))); }
  }
  // Earlier calls: one fold per earlier sheet, its name and outcome on the fold (folded for someone yet to score), the same four groups inside
  const earlierHtml = (c, sheets) => `<div class="subps">${sheets.map((x, k) => { const si = k + 1, key = `${c.id}|${si}|sheet`, open = !!state.subOpen[key];
    return `<details class="subp sheetp" data-sub="${h(key)}" data-state="${open ? 1 : 0}"${open ? " open" : ""}><summary><span class="subt">${h(mdPlain(stepName(c, x.title)))}</span><span class="subh">${callsShown(c) ? chipsHtml(x.chips) : x.chips.length ? h("results " + FOLDED) : ""}</span></summary>
      <div class="subb">${metaHtml(x.meta)}<div class="subps">${sheetGroupsHtml(c, x, si)}</div></div></details>`; }).join("")}</div>`;
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
        // the stage moves to messaged only from an earlier one: a later or a closed stage is never sent from here (second 14 Nov review:
        // one click reopened a declined candidate and replaced their next step)
        const at = stageIdx(p.dataset.stage || ""), early = at >= 0 && at < stageIdx("messaged");
        const patch = early ? { stage: "messaged", last_contact: today(), next_step: "Wait for the reply; nudge after 5 working days" } : { last_contact: today() };
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
  // The Scorecards section once there is a card, or once the first scored call is near: a call booked (a screen call is the PM and sales
  // designer intro), or for PM's message screen the message sent (14 Nov review: "No cards yet" on every card, a screening decline's too)
  // Also whenever the Work sample section is there in a role whose scorecard scores it (14 Nov review: its "Work sample tab in Scorecards" did
  // nothing on a declined record with a link stored, where Scorecards was hidden).
  const cardsShown = (c) => { const rub = rubricOf(c.role_id); if (!rub) return false; if (cardsFor(c.id).length) return true;
    return reachedIdx(c) >= stageIdx(rub.stages.some(([st]) => st === "message") ? "messaged" : "screen booked") || (wsInRubric(c) && wsShown(c)); };
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
    const known = OUTCOME.includes(c.stage) || isClosedRole(roleOf(c.role_id));
    const hideForBlind = !mine && here.length && !known && (!edit || edit.mode === "blank");
    const shown = edit && edit.mode === "blank" ? `<p class="muted small">The other cards stay hidden until you save yours, so they don't steer your scores.</p>`
      : hideForBlind ? `<details class="fold plain"><summary>Show the ${here.length} card${here.length > 1 ? "s" : ""} for this stage${gaps ? ` · ${gaps} gap${gaps > 1 ? "s" : ""} over one point` : ""}</summary>${tableHtml}</details>
        <p class="muted small">You haven't scored this stage yet. Score blind first if you want your card to count as an independent check.</p>` : tableHtml;
    return `<div class="secin" id="scoreblock"><div class="readhead"><div><h3>${h(curLabel)}${gaps && !hideForBlind ? ` <span class="muted">· ${gaps} gap${gaps > 1 ? "s" : ""} over one point</span>` : ""}</h3></div><span class="cmeta">${h(rub.rule.version || "")}</span></div>
      ${tabs}
      ${here.length ? "" : `<p class="muted">No cards for this stage yet. The AI recruiter drafts one from the recording's transcript; you confirm or edit it.</p>`}
      ${shown}
      ${known ? `<p class="muted small">This candidate's outcome is already known, so cards saved here can't be blind. They show the rubric at work but don't count in Calibration.</p>` : ""}
      ${actions ? `<div class="pact">${actions}</div>` : ""}
      ${edit ? cardEditor(c, rub, cur, edit, ai, mine) : ""}
      <p class="muted small">${h(rub.rule.decision)} The AI recruiter's card is advice; the people who interview decide.</p></div>`;
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
      state.cards = await api("scorecards"); state.cardEdit = null; again(); wsScoreRefresh(c); setSum("cards", cardsSummary(c)); refreshCalls(c);
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
  // The Work sample section once there is something in it, or once the step is near: the test sent (or later), or the first interview booked
  // in a role whose scorecard has the step (the test often goes out right after that call, before the stage says so: second 14 Nov review).
  // An earlier round's people never get one now (14 Nov review: every TA and Brand & Content card, a screening decline and a March hire
  // included, showed "Nothing received yet" with an upload form for a test never sent). Before that, "Before their step" at the card's end
  // brings it, and Scorecards, to a card that needs them early.
  const wsShown = (c) => wsHas(wsOf(c)) || (!isClosedRole(roleOf(c.role_id)) && (reachedIdx(c) >= stageIdx("work sample") || (wsInRubric(c) && !isClosedStage(c) && reachedIdx(c) >= stageIdx("interview booked"))));
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
    const go = rubricOf(c.role_id) ? `<button type="button" class="linkbtn small" data-wsgo>Work sample tab in Scorecards</button>` : "";
    const one = (k) => `<span class="wsscorer">${h(scorerName(k.scorer))} <b>${k.weighted != null ? Number(k.weighted).toFixed(2) : "–"}</b>${decisionPill(k.decision)}${k.must_pass === "fail" ? pill("must-pass fail", "bad") : ""}</span>`;
    const ai = cards.filter((k) => k.scorer === "ai"), people = cards.filter((k) => k.scorer !== "ai");
    const known = OUTCOME.includes(c.stage) || isClosedRole(roleOf(c.role_id));
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
    if (w == null || !wsOn(c)) return "";
    if (w.failed) return `<div class="secin" id="wsblock"><p class="muted small">The work sample didn't load (${h(w.failed)}). Close the record and open it again.</p></div>`;
    const m = w.meta || {}, flaws = w.flaws || [], qs = w.questions || [], items = flaws.concat(qs);
    const hasFile = Number(m.size) > 0, link = /^https?:\/\/\S+$/i.test(m.link || "") ? m.link : "";
    // the host exactly: "docs.google.com.evil.example" is not a Google Doc (5 Nov review)
    const linkLabel = (u) => { const host = hostOf(u); return host === "docs.google.com" ? "Google Doc" : host === "drive.google.com" ? "Google Drive" : host; };
    const latest = items.slice().sort((a, b) => (b.updated_at || b.created_at || "").localeCompare(a.updated_at || a.created_at || ""))[0];
    const facts = [m.filename, m.stored_at ? `stored ${fmt(m.stored_at)}${m.by ? " by " + whoName(m.by) : ""}` : ""].filter(Boolean);
    const head = `<div class="readhead"><div><h3>${w.meta ? (m.received_at ? "Received " + h(wsWhen(m.received_at)) : "Received") : '<span class="muted">Nothing received yet</span>'}${m.source ? ` <span class="muted">· ${h(m.source)}</span>` : ""}</h3></div>
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
    return `<div class="secin" id="wsblock">${head}${file}
      ${wsScoreHtml(c)}
      ${wsFlawsHtml(flaws)}
      ${wsQuestionsHtml(qs, flaws)}
      ${w.meta && !items.length ? `<p class="muted small">No flaws or questions yet. The AI recruiter writes them when it scores the document.</p>` : ""}
      ${upload}
      <p class="muted small">The AI recruiter reads the document against the brief the candidate got and the role's review guide. The flaws and questions prepare the call; nobody is declined on them. Ticks and notes are yours: a robot's new list keeps them.</p></div>`;
  }
  // The open record's call notes (5 Nov review). A note saves when it loses focus, and whatever is still unsaved goes before any record is
  // read (again) and when the record closes: an upload or a link used to redraw the record from a read made before the note went, so the
  // field came back with the old note and without focus. Typing that lands while the record is being read again is carried over the redraw.
  let wsLive = null, wsCarry = null;  // wsLive: { cid, flush() → Promise, unsaved() → { key: text }, focused() → { key, start, end } | null }
  $("#recdlg").addEventListener("close", () => { if (wsLive) wsLive.flush(); });
  function bindWsGo(c) {
    const b = $("#wsblock [data-wsgo]");
    if (b) b.addEventListener("click", () => {
      // Scorecards isn't on the card yet (before its step): it joins it here, so the button always leads somewhere (14 Nov review)
      if (!$("#scoreblock")) { state.secAsk[c.id] = { ...(state.secAsk[c.id] || {}), cards: true }; syncSections(c); }
      const sb = $("#scoreblock"); if (!sb) return;
      state.cardStage[c.id] = "worksample"; state.cardEdit = null;
      sb.outerHTML = scoreBlock(c); bindScoreBlock(c);
      openSec("cards");
      $("#sec-cards").scrollIntoView({ block: "start", behavior: "smooth" });  // the section's title and fold in sight, not only its body
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
      requestAnimationFrame(() => { const t = document.activeElement, b = $("#sec-ws") || $("#wsblock");
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
          cb.disabled = false; li.classList.toggle("asked", cb.checked); count(); clean(); setSum("ws", wsSummary(c));
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
      ${gapsList.length ? `<div class="group"><span class="eyebrow">Gaps to talk through</span>${table(["Candidate", "Stage", "Criterion", "Scores"], gapsList.map((g) => `<tr class="clickable" data-id="${h(g.cid)}" data-stage="${h(g.stage)}"><td><span class="name">${h(cname(g.cid))}</span></td><td>${h(stageName(g.cid, g.stage))}</td><td>${h(g.crit)}</td><td>${h(scorerName(g.a))} ${g.sa} · ${h(scorerName(g.b))} ${g.sb}</td></tr>`))}</div>` : ""}
      ${practice.length ? `<p class="muted small">Not counted: ${practice.length} card${practice.length > 1 ? "s" : ""} saved after the outcome was known (${[...new Set(practice.map((k) => cname(k.candidate_id)))].map(h).join(", ")}). They test the rubric, not the scorers.</p>` : ""}
      <div class="group"><span class="eyebrow">AI drafts waiting for a person's card</span>${waiting.length ? table(["Candidate", "Stage", "AI weighted", "Decision rule"], waiting.map((k) => `<tr class="clickable" data-id="${h(k.candidate_id)}" data-stage="${h(k.stage)}"><td><span class="name">${h(cname(k.candidate_id))}</span><br><span class="muted">${h(roleName((state.candidates.find((x) => x.id === k.candidate_id) || {}).role_id))}</span></td><td>${h(stageName(k.candidate_id, k.stage))}</td><td>${k.weighted != null ? Number(k.weighted).toFixed(2) : "–"} <span class="muted">· ${k.scored} criteria</span></td><td>${decisionPill(k.decision)}</td></tr>`)) : '<p class="muted">None.</p>'}</div>`;
    view.querySelectorAll("tr.clickable").forEach((tr) => tr.addEventListener("click", () => { if (tr.dataset.stage) { state.cardStage[tr.dataset.id] = tr.dataset.stage; state.focusSec = "cards"; } openCandidate(tr.dataset.id); }));
    bindSeg(view, "calgroup", (v) => { state.calGroup = v; renderCalibration(view); });
    view.querySelectorAll("[data-bopen]").forEach((b) => b.addEventListener("click", () => openCandidate(b.dataset.bopen)));
  }

  function openRecord(title, eyebrow, html, cid, sub) {
    // Typing in a call note since openCandidate saved the notes: the same record's new form takes it over (bindWsBlock); for another record it is sent.
    if (wsLive) { if (cid && wsLive.cid === cid) wsCarry = { cid, values: wsLive.unsaved(), focus: wsLive.focused() }; else wsLive.flush(); }
    wsLive = null;
    const d = $("#recdlg"), body = $("#recbody");
    d.dataset.cid = cid || ""; d.classList.toggle("hassub", !!sub);
    $("#rectitle").textContent = title; $("#receyebrow").textContent = eyebrow || ""; $("#recsub").innerHTML = sub || ""; body.innerHTML = html;
    if (!d.open) (d.showModal ? d.showModal() : d.setAttribute("open", ""));
    // Back to the top once the dialog is shown: a closed dialog ignores scrollTop, so the next record used to open where the last one was left.
    // On a phone the dialog itself scrolls (its header's first row stays), elsewhere the body does.
    const top = () => { body.scrollTop = 0; d.scrollTop = 0; d.classList.remove("scrolled"); };
    top(); requestAnimationFrame(top);
  }
  // The record's collapsible parts, for every record: a section's open state is remembered when the person opens or closes it (the
  // toggle event doesn't bubble, hence the capture), and "Show more" opens a clamped paragraph.
  $("#recbody").addEventListener("toggle", (e) => {
    const d = e.target;
    if (!d.matches || !d.matches("details[data-sec], details[data-sub]")) return;
    const now = d.open ? "1" : "0";
    if (d.dataset.state === now) return;  // drawn that way, or opened by the app
    d.dataset.state = now;
    if (d.dataset.sec) store.set("studio-sec-" + d.dataset.sec, now); else state.subOpen[d.dataset.sub] = d.open;
  }, true);
  $("#recbody").addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-more]");
    if (!b) return;
    const box = b.closest(".clampbox"), open = !box.classList.contains("open");
    box.classList.toggle("open", open); b.textContent = open ? "Show less" : "Show more"; b.setAttribute("aria-expanded", open);
  });
  // The Decision panel stays in view beside the main column and scrolls itself when it is taller than the record's body. The body's height is
  // the space the dialog has (studio.css gives a record the window's height), and a closed dialog's 0 is no reading (14 Nov review).
  if (window.ResizeObserver) new ResizeObserver(() => { const hgt = $("#recbody").clientHeight; if (hgt > 0) $("#recdlg").style.setProperty("--rbh", hgt + "px"); }).observe($("#recbody"));
  // A field focused in the panel (Tab, a click, a step opened) is kept clear of the sticky Save bar at its foot (second 14 Nov review, WCAG 2.2
  // 2.4.11: Due, Notes and a step's controls landed under it; the bar's scroll-padding in studio.css alone left Notes 27px under it)
  $("#recbody").addEventListener("focusin", (e) => requestAnimationFrame(() => {
    const t = e.target, d = t.closest && t.closest(".recside .decision"), foot = d && d.querySelector(".formfoot");
    if (!foot || t.closest(".formfoot") || getComputedStyle(foot).position !== "sticky") return;
    const over = t.getBoundingClientRect().bottom + 8 - foot.getBoundingClientRect().top;
    if (over > 0) d.scrollTop += over;
  }));
  $("#recdlg").addEventListener("scroll", () => { const d = $("#recdlg"); d.classList.toggle("scrolled", d.scrollTop > 4); });
  // Closing a record opened from a link leaves the address at the list, so a reload doesn't open it again.
  const leaveLink = () => { if (/^#candidates\//.test(location.hash)) history.replaceState(null, "", "#candidates"); };
  // Closing a record with changes not saved asks first (14 Nov review: a Go and its reason picked in a step went with no word): the Decision
  // panel's fields and steps, a scorecard being written, an edited message, a work sample link or file not added yet
  const unsavedParts = () => {
    if (!$("#recdlg").open) return [];
    const f = $("#cform"), parts = f && f._what ? f._what() : [];
    if ($("#recbody #scform[data-dirty]")) parts.push("your scorecard");
    if ($('#recbody .scrmsg[data-dirty="1"], #recbody .rmsg[data-dirty="1"]')) parts.push("an edited message");
    if ($("#recbody form[data-wsup][data-dirty]")) parts.push("the work sample file or link");
    return parts;
  };
  const closeOk = () => { const p = unsavedParts(); return !p.length || confirm(`${p.join(", ")}: not saved. Close the record anyway?`); };
  function closeRecord(force) { const d = $("#recdlg"); if (d.open && !force && !closeOk()) return; if (d.open) d.close(); leaveLink(); }
  $("#recdlg").addEventListener("cancel", (e) => { if (!closeOk()) { e.preventDefault(); return; } leaveLink(); });  // Escape
  window.addEventListener("beforeunload", (e) => { if (unsavedParts().length) { e.preventDefault(); e.returnValue = ""; } });
  $("#recclose").addEventListener("click", () => closeRecord());
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
    // Someone declined for the job stays out: the lead already decided. Withdrawn counts the same way (stages v2, as in studio.py rediscover).
    const fam = familyOf(role), mine = state.candidates.filter((c) => c.role_id === role.id);
    const declined = (c) => c.your_call === "Decline" || c.stage === "declined" || c.stage === "withdrawn";
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
