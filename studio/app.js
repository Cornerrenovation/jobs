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
  const VIEWS = ["week", "checklists", "pipeline", "candidates", "screening", "calibration", "outreach", "templates", "activity", "posts"];
  const CALL_RANK = { Shortlist: 0, Hold: 1, Decline: 2 }, CONF_RANK = { High: 0, Medium: 1, Low: 2 };
  // A blind calibration batch (scorecard section 7): Claude's call on these records stays hidden everywhere until a person has made theirs.
  const blindNow = (c) => !!(c.calib_batch && !c.your_call);
  const whoName = (by) => !by ? "" : by === "claude" || /\.access$/.test(by) || /^u_/.test(by) ? "Claude" : by.replace(/@.*/, "").replace(/^\w/, (c) => c.toUpperCase());
  const state = { view: "week", boot: null, roleFilter: "all", role: null, filter: "all", candidates: null, results: null, outreach: null, templates: null, search: "", open: {},
    showClosed: false, justCreated: null, cards: null, cardStage: {}, cardEdit: null, srcFilter: "all", callFilter: "all", agentFilter: "all", confFilter: "all",
    sort: { key: "", dir: 1 }, screenFilter: "tosend", calGroup: "", cvFilter: "all", resBy: {} };
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };

  async function api(path, method, body) {
    const payload = body ? JSON.stringify(body) : undefined;
    // keepalive lets a save finish after the record (or the tab) is closed; browsers allow it for bodies under 64 KB
    const r = await fetch(API + path, { method: method || "GET", credentials: "same-origin", keepalive: !!payload && payload.length < 60000,
      headers: body ? { "content-type": "application/json" } : {}, body: payload });
    if (r.status === 401) { notice("Your sign-in expired. Reload the page to sign in again.", true); throw new Error("unauthorized"); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 503) { notice(j.error === "login_not_configured" ? "Sign-in isn't switched on for the studio yet." : "The sign-in check didn't answer. Try again in a minute.", true); throw new Error(j.error || "unavailable"); }
    if (!r.ok || j.error) { notice(j.error || ("Request failed: " + r.status), true); throw new Error(j.error || r.status); }
    return j;
  }
  function notice(text, bad) { const n = $("#notice"); n.textContent = text || ""; n.hidden = !text; n.classList.toggle("bad", !!bad); }

  // ---------- data ----------
  async function loadBoot() { state.boot = await api("bootstrap"); $("#who").textContent = state.boot.who; }
  const roles = () => state.boot.roles;
  const roleOf = (id) => roles().find((r) => r.id === id) || { id, short: id, name: id };
  const roleName = (id) => roleOf(id).short || id;
  const isClosedRole = (r) => (r || {}).state === "closed";
  const openRoles = () => roles().filter((r) => !isClosedRole(r));
  const familyOf = (r) => (r && (r.family || r.id)) || "";
  const leadOf = (r) => (r && (r.lead || r.owner)) || "the hiring lead";
  // Each view loads only what it shows; the caches are dropped when the data changes (see refresh) or after a save.
  async function need(...keys) {
    // Lists load light candidate rows and per-candidate criteria counts; a record fetches its full row and its own criteria when it
    // opens (27 Oct: the full tables, about 3 MB and 6 MB, went over the Worker's CPU limit and Cloudflare answered with an error page).
    const load = { candidates: "candidates?lite=1", summary: "criteria/results?summary=1", cards: "scorecards", outreach: "outreach", templates: "templates" };
    const missing = keys.filter((k) => !state[k]);
    (await Promise.all(missing.map((k) => api(load[k])))).forEach((v, i) => { state[missing[i]] = v; });
  }
  const forget = () => { state.boot = null; state.candidates = null; state.summary = null; state.resBy = {}; state.cards = null; state.outreach = null; state.templates = null; };

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
  const resultsFor = (cid) => (state.resBy && state.resBy[cid]) || [];
  function matchSummary(c) {
    const rows = (state.summary || []).filter((x) => x.candidate_id === c.id).sort((a, b) => (b.at || "").localeCompare(a.at || ""));
    const n = rows[0];  // the newest read
    return n ? `${n.met} met · ${n.not_met} not met · ${n.unclear} unclear` : "";
  }
  // First-three calibration: the first three a role sends to its hiring lead wait for a yes or no with a reason before more go.
  function calibration(roleId) {
    const sent = (state.candidates || []).filter((c) => c.role_id === roleId && c.sent_to_lead).sort((a, b) => (a.sent_to_lead + a.id).localeCompare(b.sent_to_lead + b.id));
    const first = sent.slice(0, 3), answered = first.filter((c) => c.lead_call && (c.lead_reason || "").trim()).length;
    return { sent, first, answered, open: first.length < 3 || answered === 3, done: first.length === 3 && answered === 3 };
  }

  // ---------- shell ----------
  function setView(v) {
    state.view = v; store.set("studio-view", v);
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
    await need("candidates");
    const q = state.search.trim().toLowerCase();
    // Source and Your call filters (Yuliia's request, 18 Oct); options count within the chosen role
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
    const callSel = `<select id="fcall" aria-label="Your call">${opt("all", "Your call: any", state.callFilter)}${[["Shortlist", "Shortlist"], ["Hold", "Hold"], ["Decline", "Decline"], ["none", "No call yet"]].map(([v, l]) => opt(v, `Your call: ${l} (${callCounts[v] || 0})`, state.callFilter)).join("")}</select>`;
    const agentSel = `<select id="fagent" aria-label="Agent call">${opt("all", "Agent call: any", state.agentFilter)}${[["Shortlist", "Shortlist"], ["Hold", "Hold"], ["Decline", "Decline"], ["none", "Not read yet"]].concat(agentCounts.blind ? [["blind", "Hidden, blind batch"]] : []).map(([v, l]) => opt(v, `Agent call: ${l} (${agentCounts[v] || 0})`, state.agentFilter)).join("")}</select>`;
    const confSel = `<select id="fconf" aria-label="Confidence">${opt("all", "Confidence: any", state.confFilter)}${[["High", "High"], ["Medium", "Medium"], ["Low", "Low"]].map(([v, l]) => opt(v, `Confidence: ${l} (${confCounts[v] || 0})`, state.confFilter)).join("")}</select>`;
    const cvSel = `<select id="fcv" aria-label="CV check">${opt("all", "CV check: any", state.cvFilter)}${[["Pass", "Pass"], ["Not pass", "Not pass"], ["none", "Not checked"]].map(([v, l]) => opt(v, `CV check: ${l} (${cvCounts[v] || 0})`, state.cvFilter)).join("")}</select>`;
    // Compact (Kostya, 27 Oct): role sits above the source, confidence under Claude's call, long text clamps to two lines,
    // so Next step and Due fit without scrolling sideways
    const cols = [["Name", "name"], ["Role · source", ""], ["Applied", "applied"], ["Claude", "agent"], ["Your call", "your"], ["Stage", "stage"], ["Next step", ""], ["Due", "due"]];
    const th = ([label, key]) => key ? `<th><button type="button" class="sorth" data-sort="${key}" aria-sort="${sk === key ? (sd > 0 ? "ascending" : "descending") : "none"}">${h(label)}<span class="arrow">${sk === key ? (sd > 0 ? "↑" : "↓") : "↕"}</span></button></th>` : `<th>${h(label)}</th>`;
    view.innerHTML = head("Candidates", `${list.length} of ${state.candidates.length}`, `<button type="button" class="btn" id="add">Add candidate</button>`) +
      `<div class="toolbar"><input type="search" id="q" placeholder="Search name, headline, source, stage" value="${h(state.search)}">${srcSel}${agentSel}${confSel}${callSel}${cvSel}${roleSeg()}</div>
      ${list.length ? `<div class="tablewrap cands"><table><thead><tr>${cols.map(th).join("")}</tr></thead><tbody>${
        list.map((c) => `<tr class="clickable" data-id="${h(c.id)}"><td class="cname"><span class="name">${h(c.name)}</span><span class="muted clamp2">${h(c.headline || c.location || "")}</span></td><td class="csrc"><span class="muted small">${h(roleName(c.role_id))}</span><br>${h(sourceShort(c.sources))}${c.referred_by ? `<br><span class="muted">referred by ${h(c.referred_by)}</span>` : ""}</td><td class="nowrap">${h(fmt(c.applied))}</td><td>${blindNow(c) ? pill("blind") : callPill(c.agent_call)}${blindNow(c) || !c.confidence ? "" : `<br>${confWord(c.confidence)}`}</td><td>${callPill(c.your_call)}</td><td>${pill(c.stage || "applied")}</td><td class="cnext"><span class="clamp2" title="${h(c.next_step)}">${h(c.next_step)}</span></td><td class="nowrap">${h(fmt(c.due))}</td></tr>`).join("")}</tbody></table></div>`
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
    const cvLinks = urlsIn(c.cv).filter((u) => /linkedin\.com\/hiring\/applicants|drive\.google\.com|docs\.google\.com/.test(u));
    // Kostya, 27 Oct: every Brand & Content and TA Shortlist and Hold (his, or Claude's he hasn't called) gets Open CV
    const owed = !c.cv_file && ["bc", "ta"].includes(familyOf(roleOf(c.role_id))) && (["Shortlist", "Hold"].includes(c.your_call) || (!c.your_call && ["Shortlist", "Hold"].includes(c.agent_call)));
    if (!d && !c.first_lines && !cvLinks.length && !c.cv_file && !owed) return "";
    const roles = (d && d.roles) || [];
    return `<div class="cvblock"><div class="cvhead"><span class="lbl">CV</span>${d && d.file ? `<span class="cmeta">${h(d.file)}</span>` : ""}<div class="chips">${cvOpen(c)}${cvLinks.map((u) => linkChip(u)).join("")}</div></div>
      ${owed ? `<p class="muted small">Open CV is added at the next robot run: 14:00 daily, and 17:00 and 20:00 on weekdays.</p>` : ""}
      ${roles.length ? `<ul class="roles">${roles.map((r) => `<li>${tagPill(r.when === "earlier" ? "" : r.when)}<div class="rbody"><div class="rhead"><span class="etitle">${h(r.title)}</span>${r.employer ? ` <span class="muted">·</span> <span class="eorg">${h(r.employer)}</span>` : ""}${r.dates ? ` <span class="cmeta">${h(r.dates)}</span>` : ""}</div>${r.what ? (r.when === "earlier" ? `<span class="small">${h(r.what)}</span>` : `<q>${h(r.what)}</q>`) : r.when !== "earlier" ? `<span class="muted small">No line under this role in the CV</span>` : ""}</div></li>`).join("")}</ul>`
        : firstLinesHtml(c)}
      ${d && (d.languages || d.education || (d.portfolio || []).length || d.other) ? `<dl class="qa">${d.languages ? `<dt>Languages</dt><dd>${h(d.languages)}</dd>` : ""}${d.education ? `<dt>Education</dt><dd>${h(d.education)}</dd>` : ""}${(d.portfolio || []).length ? `<dt>Portfolio</dt><dd>${d.portfolio.map((u) => /^https?:/.test(u) ? linkChip(u) : h(u)).join(" ")}</dd>` : ""}${d.other ? `<dt>Also</dt><dd class="long">${h(d.other)}</dd>` : ""}</dl>` : ""}</div>`;
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
    if (blindNow(c)) return `<section class="block read"><div class="readhead"><div><span class="eyebrow">2 · Claude's read</span><h3 class="muted">Hidden until you save Your call</h3></div><span class="cmeta">${h(c.calib_batch)}</span></div>
      <p class="muted small">This record is in a blind calibration batch: open the CV, set the CV check and Your call with a reason, and save. Claude's call shows after that and counts toward the agreement on the Calibration tab.</p></section>`;
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
      <p class="muted small">Claude's reading of what she or he sent, against the scorecard, with the words it rests on. It informs your call; nobody is declined on it.</p></section>`;
  }
  async function openCandidate(id) {
    if (id) await need("candidates", "cards");
    const c = id ? state.candidates.find((x) => x.id === id) : { stage: "applied", role_id: state.roleFilter !== "all" && state.roleFilter !== "closed" ? state.roleFilter : (openRoles()[0] || {}).id };
    if (!c) { forget(); await render(true); notice(`There's no candidate ${id} in the studio.`, true); return; }
    if (id) {  // the full row (CV, screening answers, written answer, first lines) and this candidate's criteria
      const [full, res] = await Promise.all([api("candidates/" + encodeURIComponent(id)), api("criteria/results?candidate_id=" + encodeURIComponent(id))]);
      Object.assign(c, full); state.resBy = state.resBy || {}; state.resBy[id] = res;
    }
    const sel = (name, opts, val, labels) => `<select name="${name}">${opts.map((o, i) => `<option value="${h(o)}" ${o === (val || "") ? "selected" : ""}>${h(labels ? labels[i] : (o || "–"))}</option>`).join("")}</select>`;
    const kv = (k, v) => v ? `<dt>${h(k)}</dt><dd>${h(v)}</dd>` : "";
    const role = roleOf(c.role_id), lead = leadOf(role);
    const furthest = id && reachedIdx(c) > stageIdx(c.stage || "applied") ? stageWord(reachedOf(c)) : "";
    const links = [];
    if (c.linkedin) links.push(linkChip(c.linkedin, "LinkedIn"));
    urlsIn(c.cv).filter((u) => !/linkedin\.com\/hiring\/applicants|drive\.google\.com|docs\.google\.com/.test(u)).forEach((u) => links.push(linkChip(u)));
    const eyebrow = id ? [c.id, roleName(c.role_id) + (isClosedRole(role) ? " (earlier round)" : ""), c.sources, c.applied ? "applied " + fmt(c.applied) : ""].filter(Boolean).join(" · ") : roleName(c.role_id);
    const application = id ? `<section class="block"><span class="eyebrow">1 · From the application</span>
        <dl class="kv">${kv("Location", c.location)}${kv("Email", c.email)}${kv("English, self-rated", c.english)}${kv("Headline", c.headline)}${kv("Referred by", c.referred_by)}${kv("Furthest stage", furthest)}${kv("Scores", c.scores)}${kv("Latest reply", c.latest_reply)}${kv("Last contact", c.last_contact)}</dl>
        ${screeningBlock(c)}
        ${cvBlock(c)}
        ${links.length ? `<div class="links"><span class="lbl">Links she or he gave</span><div class="chips">${links.join("")}</div>${/drive\.google\.com/.test(c.cv || "") ? `<span class="muted small">The CV sits in hello@'s Drive. If the link asks for access, hello@ needs to share the "Corner Careers — Applications" folder with you once.</span>` : ""}</div>` : ""}
        ${cvCheck(c)}
        ${c.site_answer ? `<div class="answer"><span class="lbl">Written answer</span><p>${h(c.site_answer).replace(/\n+/g, "<br>")}</p></div>` : ""}</section>` : "";
    const callSeg = `${seg("yourcall", [["Shortlist", "Shortlist"], ["Hold", "Hold"], ["Decline", "Decline"]], c.your_call || "")}<input type="hidden" name="your_call" value="${h(c.your_call || "")}">`;
    const form = `<section class="block"><span class="eyebrow">${id ? "3 · Your call" : "New candidate"}</span>
      <form class="form" id="cform">
        ${id ? "" : `<label class="full"><span class="lbl">Name</span><input name="name" required></label><label><span class="lbl">Role</span>${sel("role_id", openRoles().map((r) => r.id), c.role_id, openRoles().map((r) => r.short))}</label><label><span class="lbl">Source</span><input name="sources" placeholder="LinkedIn UA, referral…"></label><label class="full"><span class="lbl">LinkedIn</span><input name="linkedin" type="url"></label><label><span class="lbl">Email</span><input name="email" type="email"></label><label><span class="lbl">Location</span><input name="location"></label>`}
        <div class="full callrow"><span class="lbl">Your call</span>${callSeg}${id && c.agent_call && !blindNow(c) ? `<span class="hint">Claude suggests <b>${h(c.agent_call)}</b>. Set yours before reading the block above if you want a blind check.</span>` : ""}</div>
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
    openRecord(id ? c.name : "New candidate", eyebrow, (id && scriptDue(c) ? scriptBlock(c) : "") + application + (id ? readBlock(c) + screenSection(c) : "") + form + (id ? (scriptDue(c) ? "" : scriptBlock(c)) + scoreBlock(c) : ""));
    if (id) { bindScoreBlock(c); bindScreen($("#recbody"), async () => { forget(); await render(true); await openCandidate(id); }); bindCvCheck($("#recbody"), () => render(true)); }
    const f = $("#cform");
    bindSeg(f, "yourcall", (v) => { const cur = $('input[name="your_call"]', f); cur.value = cur.value === v ? "" : v; f.querySelectorAll('[data-seg="yourcall"] button').forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === cur.value)); });
    // After a save: everything is re-read (the Worker moves the stage when Your call changes, and keeps reached, hired_at and bounty_due),
    // the page behind redraws in place, and the record reopens with what was stored.
    const reopen = async () => { forget(); await render(true); if (id) await openCandidate(id); else closeRecord(); };
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      if (!id) { await api("candidates", "POST", data); await reopen(); return; }
      // An existing record saves in the background: the change shows at once (the record stays where it is and can be closed
      // straight away), the request runs on, and the list behind redraws from the server when it answers. The stage moves the way
      // the Worker moves it when Your call changes, so a second Save doesn't send a stale stage back.
      const before = { ...c }, wasBlind = blindNow(c), saved = $("#csaved");
      if ((data.your_call || "") !== (c.your_call || "") && ["applied", "triaged", "confirmed", "declined"].includes(data.stage || "applied"))
        data.stage = data.your_call === "Decline" ? "declined" : data.your_call === "Shortlist" ? "confirmed" : c.agent_call ? "triaged" : "applied";
      Object.assign(c, data);
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
    const send = $("#sendlead");
    if (send) send.addEventListener("click", async () => { send.disabled = true; try { await api("candidates/" + id, "PATCH", { sent_to_lead: new Date().toISOString() }); await reopen(); } catch (e) { send.disabled = false; } });
    const lf = $("#lform");
    if (lf) {
      bindSeg(lf, "leadcall", (v) => { $('input[name="lead_call"]', lf).value = v; lf.querySelectorAll("[data-seg] button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === v)); });
      lf.addEventListener("submit", async (e) => { e.preventDefault(); await api("candidates/" + id, "PATCH", Object.fromEntries(new FormData(lf).entries())); await reopen(); });
    }
  }
  // ---------- the message screen: one concern per shortlisted candidate and the LinkedIn message that checks it ----------
  // Claude writes the concern and the message; Kostya edits if he wants, copies it into LinkedIn and marks it sent, which moves the
  // candidate to "messaged". The same panel shows on the Screening view and in the candidate record.
  const SENT = ["messaged", "replied", "screen booked", "screen done", "interview booked", "interview done", "work sample", "references", "offer", "hired"];
  const wasSent = (c) => SENT.includes(c.stage || "");
  // Your call decides when there is one; otherwise Claude's Shortlist counts.
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
  function screenPanel(c) {
    if (!c.screen_concern && !c.screen_message) return `<p class="muted small">No concern written yet. Claude writes one for every shortlisted candidate.</p>`;
    return `<div class="scrpanel" data-sid="${h(c.id)}">
      <div class="scrcol"><span class="lbl">Concern to verify</span><p class="concern">${h(c.screen_concern)}</p></div>
      <div class="scrcol"><span class="lbl">Message to send on LinkedIn</span><textarea class="scrmsg" rows="7" aria-label="Message to ${h(c.name)}">${h(c.screen_message)}</textarea>
        <div class="pact"><button type="button" class="btn small" data-copy>Copy</button><button type="button" class="btn ghost small" data-savemsg hidden>Save the edit</button>
          ${wasSent(c) ? `<span class="pill ok">sent${c.last_contact ? " " + h(fmt(c.last_contact)) : ""}</span>` : `<button type="button" class="btn ghost small" data-sent>Mark as sent</button>`}
          ${cvOpen(c, "btn small")}
          ${c.linkedin ? `<a class="btn ghost small" href="${h(c.linkedin)}" target="_blank" rel="noopener">LinkedIn ↗</a>` : ""}
          ${urlsIn(c.cv).filter((u) => /linkedin\.com\/hiring\/applicants/.test(u)).map((u) => `<a class="btn ghost small" href="${h(u)}" target="_blank" rel="noopener">Application ↗</a>`).join("")}</div>
        ${c.latest_reply ? `<div class="answer"><span class="lbl">Latest reply</span><p>${h(c.latest_reply)}</p></div>` : ""}</div></div>`;
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
    await need("candidates");
    const all = state.candidates.filter(inScreening).filter(inRole);
    const pick = { tosend: (c) => !wasSent(c), sent: wasSent, all: () => true }[state.screenFilter] || (() => true);
    const list = all.filter(pick).sort((a, b) => (wasSent(a) - wasSent(b)) || a.role_id.localeCompare(b.role_id) || (CONF_RANK[a.confidence] ?? 3) - (CONF_RANK[b.confidence] ?? 3) || a.name.localeCompare(b.name));
    const toSend = all.filter((c) => !wasSent(c)).length, noConcern = all.filter((c) => !c.screen_concern).length;
    view.innerHTML = head("Screening", `One message per shortlisted candidate, asking the one thing we need to verify. ${toSend} to send · ${all.length - toSend} sent${noConcern ? ` · ${noConcern} without a concern yet` : ""}`,
      seg("scrf", [["tosend", "To send"], ["sent", "Sent"], ["all", "All"]], state.screenFilter)) +
      `<div class="toolbar">${roleSeg()}</div>
      <p class="muted small">Everyone you shortlisted, and everyone Claude shortlisted that you haven't called yet. Edit the message if you want, copy it into LinkedIn (the Application button opens their application, where messaging is free), then mark it sent: the candidate moves to "messaged".</p>
      ${list.length ? list.map((c) => `<article class="card scrcard"><div class="scrwho"><button type="button" class="linkbtn name" data-open="${h(c.id)}">${h(c.name)}</button>
          <span class="muted small">${h(c.id)} · ${h(roleName(c.role_id))}${c.location ? " · " + h(c.location) : ""}</span>
          <div class="chips">${callPill(c.agent_call)}${confWord(c.confidence)}${c.your_call ? `<span class="muted small">you:</span>${callPill(c.your_call)}` : ""}</div>
          ${c.why ? `<p class="small">${h(c.why)}</p>` : ""}${cvCheck(c)}</div>${screenPanel(c)}</article>`).join("")
        : `<div class="card empty">${state.screenFilter === "tosend" ? "Nothing left to send." : "Nobody here yet."}</div>`}`;
    bindSeg(view, "scrf", (v) => { state.screenFilter = v; renderScreening(view); });
    bindSeg(view, "role", (v) => { state.roleFilter = v; renderScreening(view); });
    view.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openCandidate(b.dataset.open)));
    bindScreen(view, async () => { state.candidates = null; await renderScreening(view); });
    bindCvCheck(view, async () => { await renderScreening(view); });
  }

  // ---------- interview scorecards: the AI recruiter drafts, people confirm or edit, Studio puts the scorers side by side ----------
  const SCORERS = [["ai", "AI recruiter"], ["kostya@cornerrenovation.com", "Kostya"], ["julia@cornerrenovation.com", "Yuliia"], ["julieta@cornerrenovation.com", "Julieta"]];
  const scorerName = (s) => (SCORERS.find(([k]) => k === s) || [s, String(s).replace(/@.*/, "").replace(/^\w/, (x) => x.toUpperCase())])[1];
  const scorerRank = (s) => { const i = SCORERS.findIndex(([k]) => k === s); return i < 0 ? 9 : i; };
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
      state.cards = await api("scorecards"); state.cardEdit = null; again();
    });
  }

  // ---------- calibration, part 1: Claude's triage call against Your call on the same record ----------
  // One measurement per role and scorecard version (the rules Claude read the record with). Rows are Claude's call, columns Your call.
  // A miss is your Shortlist that Claude held or declined; noise is a Claude Shortlist you declined. Misses only show where Claude's
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
    const eyebrow = `<span class="eyebrow">Triage · Claude's call vs Your call</span>`;
    if (!list.length) return `<div class="group">${eyebrow}<div class="card empty">Nobody has set Your call on a record Claude read yet.</div></div>`;
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
        ${left.length ? `<p class="muted small">Claude's call stays hidden on these until you save yours. Open one, look at the CV, set the CV check and Your call with a reason.</p><div class="chips">${left.map((c) => `<button type="button" class="chip linkbtn" data-bopen="${h(c.id)}">${h(c.name)}</button>`).join("")}</div>` : `<p class="muted small">All decided.</p>`}</div>`; }).join("");
    const row = (c) => `<tr class="clickable" data-id="${h(c.id)}"><td><span class="name">${h(c.name)}</span><br><span class="muted">${h(c.id)}</span></td>
      <td>${callPill(claudeCall(c))}${c.cv_check === "Not pass" ? ' <span class="muted small">your CV check</span>' : ""} ${confWord(c.confidence)}<br><span class="muted small">${h(c.why)}</span></td><td>${callPill(c.your_call)}</td><td>${h(c.your_reason) || '<span class="muted">no reason</span>'}</td></tr>`;
    return `${batchHtml}<div class="group">${eyebrow}${list.length > 1 ? seg("calgroup", list.map((x) => [x.key, label(x)]), g.key) : ""}
      ${table(["Role · rules", "Decided", "Same call", "Claude's Shortlists kept", "Misses", "Noise", "Decided of Claude's Shortlist · Hold · Decline"], rows)}
      <p class="muted small">One measurement per scorecard version: a new version starts a new row, so the current one stays the baseline. Your CV check "Not pass" counts as Claude\'s Decline, since only you judge the CV\'s design. A measurement closes at 50 decided records. Misses can only appear where Claude's Holds and Declines also get Your call: ${n(g.done, "Hold") + n(g.done, "Decline")} of ${n(g.all, "Hold") + n(g.all, "Decline")} so far for ${h(label(g))}.</p></div>
      <div class="group"><span class="eyebrow">${h(label(g))} · rows are Claude's call, columns Your call</span><div class="tablewrap"><table class="mx"><thead><tr><th></th>${C.map((y) => `<th>${h(y)}</th>`).join("")}<th>Decided</th><th>Not decided</th></tr></thead><tbody>${mx}</tbody></table></div></div>
      <div class="group"><span class="eyebrow">Different calls · ${off.length}</span>${off.length ? table(["Candidate", "Claude", "Your call", "Your reason"], off.map(row)) : '<p class="muted">None.</p>'}</div>
      ${same.length ? `<details class="group"><summary class="eyebrow">Same call · ${same.length}</summary>${table(["Candidate", "Claude", "Your call", "Your reason"], same.map(row))}</details>` : ""}
      ${sample.length ? `<div class="group"><span class="eyebrow">Check for misses · ${sample.length} of Claude's Holds and Declines, picked at random</span>
        <p class="muted small">Set Your call on these as you go. They stay the same picks until decided, then the next ones in line come up.</p>${table(["Candidate", "Claude", "Your call", "Your reason"], sample.map(row))}</div>` : ""}`;
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
    view.innerHTML = head("Calibration", "Two checks. Triage: Claude's call against Your call on the same record, per role and scorecard version. Interviews: how close the scorers are on the same interview, criterion by criterion; a gap over one point is flagged, and only cards saved before the outcome was known count. Together they are the evidence for handing a step over to the AI recruiter.") +
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

  function openRecord(title, eyebrow, html) {
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
    await need("outreach", "templates");
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
      b.disabled = true; await api("outreach/" + b.dataset.id, "PATCH", JSON.parse(b.dataset.patch)); state.outreach = null; renderOutreach(view);
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

  // Links: #<view> opens a view, #candidates/<ID> opens that candidate's record on the Candidates view (the #talent posts link there).
  async function follow() {
    const [v, id] = decodeURIComponent((location.hash || "").slice(1)).split("/");
    const saved = store.get("studio-view");
    await setView(VIEWS.includes(v) ? v : VIEWS.includes(saved) ? saved : "week");
    if (v === "candidates" && id && state.boot) await openCandidate(id);
  }
  window.addEventListener("hashchange", follow);
  follow();
})();
