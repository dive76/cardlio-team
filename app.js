// team.cardlio.app — the cardlio team library in the browser.
//
// Reads, through Apple's CloudKit JS, the teams this Apple ID OWNS
// (private database) and has JOINED (shared database): a team is a
// "team-…" zone holding a TeamInfo record (its name) and TeamCard records.
//
// ⚠️ The same private database also holds the person's own card library
// (SwiftData's zone). This page only ever opens "team-…" zones, and its
// one write is Claim: `claimedBy` on a single TeamCard, as a conflict-
// checked UPDATE (only that field changes; if someone else changed the
// card first, CloudKit refuses and nothing is overwritten). JOIN accepts
// an invite for the signed-in Apple ID — only possible when the team's
// owner added that Apple ID (invite-only share).
//
// ⚠️ Card text is untrusted input: always textContent, never innerHTML.

(function () {
  "use strict";

  const cfg = window.CARDLIO_TEAM_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const TEAM_PREFIX = "team-";
  const NAME_KEY = "cardlio.team.claimName";
  const PENDING_KEY = "cardlio.team.pendingInvite";

  const state = {
    teams: [],          // { id, zoneID, db, owned, name, records: [...] }
    team: null,
    filter: "all",
    sort: "new",
    query: "",
    event: "",
    open: null,         // record shown in the detail dialog
    pendingNew: 0,      // cards the background poll saw that are not shown yet
    view: storageGet("cardlio.team.view") || "grid"
  };
  // A stable colour per person, for the avatars.
  function personHue(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  const myName = () => storageGet(NAME_KEY);
  const isMine = (r) => { const n = myName(); return !!n && str(r, "claimedBy").localeCompare(n, undefined, { sensitivity: "base" }) === 0; };

  // ---------------------------------------------------------------- utils

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  const ICONS = {
    note: '<path d="M6 4h9l4 4v12H6z"/><path d="M15 4v4h4"/><path d="M9 12h6M9 16h6"/>',
    mail: '<path d="M4 6.5h16v11H4z"/><path d="M4.5 7l7.5 6 7.5-6"/>',
    phone: '<path d="M6.5 4h3l1.5 4-2 1.3a10 10 0 0 0 5.7 5.7L16 13l4 1.5v3a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4z"/>',
    mobile: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 17.5h2"/>',
    web: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.4 2.5 3.5 5.3 3.5 8.5s-1.1 6-3.5 8.5c-2.4-2.5-3.5-5.3-3.5-8.5s1.1-6 3.5-8.5z"/>',
    pin: '<path d="M12 21s-6.5-5.4-6.5-10a6.5 6.5 0 0 1 13 0c0 4.6-6.5 10-6.5 10z"/><circle cx="12" cy="10.6" r="2.3"/>',
    tag: '<path d="M3.5 12.5V4.5h8l9 9-8 8z"/><circle cx="8" cy="9" r="1.4"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    download: '<path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19h14"/>',
    hand: '<path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11"/><path d="M11 10.5V5a1.5 1.5 0 0 1 3 0v6"/><path d="M14 10.5V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.6a6 6 0 0 1-4.6-2.2L3.6 15a1.5 1.5 0 0 1 2.3-2L8 15V12"/>'
  };
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = ICONS[name]; // static, ours — never card data
    return svg;
  }

  function f(record, name) {
    const x = record.fields && record.fields[name];
    return x ? x.value : undefined;
  }
  function str(record, name) {
    const v = f(record, name);
    return typeof v === "string" ? v.trim() : "";
  }
  function emails(record) {
    const v = f(record, "emails");
    return Array.isArray(v) ? v.filter(Boolean) : [];
  }
  function fullName(r) {
    return [str(r, "firstName"), str(r, "lastName")].filter(Boolean).join(" ");
  }
  function displayName(r) {
    return fullName(r) || str(r, "company") || "No name";
  }
  function initials(text) {
    const parts = text.split(/\s+/).filter(Boolean);
    return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  }
  // A person: first and last name. A card with only a company: its first
  // two words ("Harbourline Freight Pte. Ltd." is HF, not HL).
  function cardInitials(r) {
    if (fullName(r)) return initials(fullName(r));
    const words = displayName(r).split(/\s+/).filter(Boolean);
    return initials(words.slice(0, 2).join(" "));
  }
  function photoURL(r) {
    const p = f(r, "photo");
    return p && p.downloadURL ? p.downloadURL.replace("${f}", "card.jpg") : "";
  }
  function addressLines(r) {
    const line1 = [str(r, "street"), str(r, "unit")].filter(Boolean).join(", ");
    const line2 = [str(r, "postalCode"), str(r, "city")].filter(Boolean).join(" ");
    return [line1, line2, str(r, "country")].filter(Boolean);
  }
  function fold(s) {
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }
  function scannedAt(r) {
    const v = f(r, "scannedAt");
    return typeof v === "number" ? v : 0;
  }
  const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
  function when(ms) { return ms ? dateFmt.format(new Date(ms)) : ""; }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

  function errorText(e) {
    if (!e) return "Something went wrong.";
    return [e.ckErrorCode || e.serverErrorCode, e.reason || e.message].filter(Boolean).join(": ") || String(e);
  }

  let toastTimer;
  function toast(text, isError) {
    const t = $("toast");
    t.textContent = text;
    t.classList.toggle("error", !!isError);
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), isError ? 5200 : 2600);
  }

  function showAlert(text) {
    $("alert").textContent = text;
    $("alert").hidden = !text;
  }

  function storageGet(key) { try { return localStorage.getItem(key) || ""; } catch (e) { return ""; } }
  function storageSet(key, v) { try { localStorage.setItem(key, v); } catch (e) { /* private mode */ } }
  function sessionGet(key) { try { return sessionStorage.getItem(key) || ""; } catch (e) { return ""; } }
  function sessionSet(key, v) { try { if (v) sessionStorage.setItem(key, v); else sessionStorage.removeItem(key); } catch (e) { /* private mode */ } }

  // An iCloud invite link: https://www.icloud.com/share/<shortGUID>#Title.
  // The short GUID is what CloudKit accepts; a bare GUID is taken too.
  function inviteGUID(text) {
    const s = (text || "").trim();
    const m = s.match(/icloud\.com\/share\/([A-Za-z0-9_-]{6,})/i) || s.match(/^([A-Za-z0-9_-]{10,})$/);
    return m ? m[1] : "";
  }

  // team.cardlio.app/#join=<invite link or GUID>: remembered for this tab,
  // so it survives Apple's sign-in, then offered once signed in.
  (function takeInviteFromURL() {
    const raw = new URLSearchParams(location.hash.slice(1)).get("join");
    if (!raw) return;
    const guid = inviteGUID(raw);
    if (guid) sessionSet(PENDING_KEY, guid);
    history.replaceState(null, "", location.pathname + location.search);
  })();

  function safeWebURL(raw) {
    let s = (raw || "").trim();
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    try {
      const u = new URL(s);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
    } catch (e) { return ""; }
  }

  // ------------------------------------------------------------- CloudKit

  if (!window.CloudKit || !cfg.apiToken) {
    $("welcome").hidden = false;
    $("apple-sign-in-button").replaceWith(el("p", "fine", "The team library can't reach iCloud right now. Please try again later."));
    return;
  }

  CloudKit.configure({
    containers: [{
      containerIdentifier: cfg.containerIdentifier,
      environment: cfg.environment,
      apiTokenAuth: {
        apiToken: cfg.apiToken,
        persist: true,
        signInButton: { id: "apple-sign-in-button", theme: "white-with-outline" },
        signOutButton: { id: "apple-sign-out-button", theme: "black" }
      }
    }]
  });
  const container = CloudKit.getDefaultContainer();
  const sources = [
    { db: container.privateCloudDatabase, owned: true },
    { db: container.sharedCloudDatabase, owned: false }
  ];

  async function zoneRecords(db, zoneID) {
    const records = [];
    let syncToken;
    for (let page = 0; page < 100; page++) {
      const response = await db.fetchRecordZoneChanges([{ zoneID, syncToken }]);
      if (response.hasErrors) throw response.errors[0];
      const zone = response.zones && response.zones[0];
      if (!zone) break;
      for (const r of zone.records || []) if (!r.deleted) records.push(r);
      syncToken = zone.syncToken;
      if (!zone.moreComing) break;
    }
    return records;
  }

  // A team = a team-… zone with a TeamInfo record (its name; the web API
  // cannot see the zone-wide share the apps take the name from). A zone
  // without TeamInfo but with cards is a team from before TeamInfo; one
  // with neither is what a deleted team leaves behind.
  async function discoverTeams() {
    const teams = [];
    const failures = [];
    for (const { db, owned } of sources) {
      let response;
      try {
        response = await db.fetchAllRecordZones();
        if (response.hasErrors) throw response.errors[0];
      } catch (e) {
        failures.push(errorText(e));
        continue;
      }
      const zones = (response.zones || []).filter((z) => z.zoneID.zoneName.startsWith(TEAM_PREFIX));
      const loaded = await Promise.all(zones.map(async (zone) => {
        try {
          const records = await zoneRecords(db, zone.zoneID);
          const info = records.find((r) => r.recordType === "TeamInfo");
          const cards = records.filter((r) => r.recordType === "TeamCard");
          if (!info && !cards.length) return null;
          return {
            id: zone.zoneID.zoneName, zoneID: zone.zoneID, db, owned,
            name: (info && str(info, "name")) || "Unnamed team",
            named: !!info,
            createdAt: (info && f(info, "createdAt")) || 0,
            records: cards
          };
        } catch (e) {
          failures.push(errorText(e));
          return null;
        }
      }));
      teams.push(...loaded.filter(Boolean));
    }
    teams.sort((a, b) => a.name.localeCompare(b.name));
    return { teams, failures };
  }

  // ------------------------------------------------------------- auth flow

  function signedOut() {
    document.title = "cardlio Team";
    document.body.classList.add("signed-out");
    document.body.classList.remove("signed-in-view");
    $("mobile-bar").hidden = true;
    $("welcome").hidden = false;
    $("invite-banner").hidden = !sessionGet(PENDING_KEY);
    $("app").hidden = true;
    $("refresh").hidden = true;
    state.teams = [];
    state.team = null;
    container.whenUserSignsIn().then(signedIn).catch((e) => toast(errorText(e), true));
  }

  function signedIn() {
    document.body.classList.remove("signed-out");
    document.body.classList.add("signed-in-view");
    $("welcome").hidden = true;
    $("app").hidden = false;
    $("refresh").hidden = false;
    $("mobile-bar").hidden = false;
    container.whenUserSignsOut().then(signedOut);
    load();
  }

  async function load() {
    showAlert("");
    $("refresh").classList.add("spinning");
    const firstLoad = !state.teams.length;
    if (firstLoad) {
      $("loading-teams").hidden = false;
      $("team-view").hidden = true;
      $("no-teams").hidden = true;
      renderSkeletons();
    }
    try {
      const { teams, failures } = await discoverTeams();
      state.teams = teams;
      if (failures.length && !teams.length) showAlert("Could not read your teams from iCloud: " + failures[0]);
      else if (failures.length) showAlert("Some teams could not be read: " + failures[0]);
    } finally {
      $("refresh").classList.remove("spinning");
      $("loading-teams").hidden = true;
    }
    renderTeamNav();
    const pending = sessionGet(PENDING_KEY);
    if (pending) { sessionSet(PENDING_KEY, ""); openJoin(pending); }
    if (!state.teams.length) {
      $("no-teams").hidden = false;
      $("team-view").hidden = true;
      return;
    }
    $("no-teams").hidden = true;
    const params = new URLSearchParams(location.hash.slice(1));
    // Read the deep link BEFORE selectTeam rewrites the hash.
    const wantedCard = params.get("card");
    const wanted = params.get("team") ||
                   (state.team && state.team.id) || storageGet("cardlio.team.last");
    // Otherwise the team with the most recent card: that is the fair in progress.
    const latest = (t) => t.records.reduce((m, r) => Math.max(m, scannedAt(r)), t.createdAt || 0);
    const busiest = [...state.teams].sort((a, b) => latest(b) - latest(a))[0];
    selectTeam(state.teams.find((t) => t.id === wanted) || busiest);
    if (wantedCard) openDeepLinkedCard(wantedCard);
    startPolling();
  }

  function renderSkeletons() {
    const grid = $("skeletons");
    grid.replaceChildren();
    for (let i = 0; i < 6; i++) {
      const li = el("li", "tile skeleton");
      li.append(el("div", "ph"));
      const tb = el("div", "tb");
      const a = el("div", "bar"); a.style.width = "70%";
      const b = el("div", "bar"); b.style.width = "45%";
      tb.append(a, b);
      li.append(tb);
      grid.append(li);
    }
  }

  // ----------------------------------------------------------------- teams

  function renderTeamNav() {
    const nav = $("team-nav");
    const select = $("team-select");
    nav.replaceChildren();
    select.replaceChildren();
    for (const team of state.teams) {
      const li = el("li");
      const b = el("button");
      b.type = "button";
      b.dataset.team = team.id;
      const av = el("span", "avatar", initials(team.name));
      const mid = el("span");
      mid.append(el("div", "t-name", team.name));
      mid.append(el("div", "t-sub", team.owned ? "Yours" : "Joined"));
      b.append(av, mid, el("span", "t-count", String(team.records.length)));
      b.addEventListener("click", () => selectTeam(team));
      li.append(b);
      nav.append(li);

      const opt = el("option", null, team.name + " (" + team.records.length + ")");
      opt.value = team.id;
      select.append(opt);
    }
  }

  function selectTeam(team) {
    state.team = team;
    state.event = "";
    $("new-pill").hidden = !(team.pendingRecords && team.pendingRecords.length);
    storageSet("cardlio.team.last", team.id);
    setHash({ team: team.id });
    document.title = team.name + " · cardlio Team";
    for (const b of $("team-nav").querySelectorAll("button")) {
      b.setAttribute("aria-current", b.dataset.team === team.id ? "true" : "false");
    }
    $("team-select").value = team.id;
    $("team-view").hidden = false;
    renderTeam();
  }

  // #team=<id>&card=<recordName> — a card can be sent to a colleague in
  // chat and opens directly (2026-09-19).
  function setHash(params) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
    history.replaceState(null, "", "#" + p.toString());
  }
  function openDeepLinkedCard(want) {
    if (!want || !state.team) return;
    const r = state.team.records.find((x) => x.recordName === want);
    if (r) openDetail(r);
  }

  function renderTeam() {
    const team = state.team;
    const records = team.records;
    $("team-name").textContent = team.name + " ";
    $("team-name").append(el("span", team.owned ? "badge" : "badge plain", team.owned ? "Yours" : "Joined"));
    const sub = [];
    const stamps = records.map(scannedAt).filter(Boolean);
    if (stamps.length) {
      const a = when(Math.min(...stamps)), b = when(Math.max(...stamps));
      sub.push(a === b ? "Cards from " + a : "Cards from " + a + " to " + b);
    } else if (team.createdAt) sub.push("Started " + when(team.createdAt));
    if (!team.named) sub.push("Open the team library in the cardlio app once to show this team's name here");
    $("team-sub").textContent = sub.join(" · ");
    // The people on the team, as the cards show them (the web API cannot
    // read the zone-wide share's participant list — the apps can).
    const peopleEl = $("team-people");
    peopleEl.replaceChildren();
    const names = [...new Set(records.flatMap((r) => [str(r, "scannedBy"), str(r, "claimedBy")]).filter(Boolean))];
    names.slice(0, 8).forEach((n) => {
      const a = el("span", "avatar", initials(n));
      a.style.background = `hsl(${personHue(n)} 62% 46%)`;
      a.title = n;
      peopleEl.append(a);
    });
    if (names.length > 8) peopleEl.append(el("span", "more", "+" + (names.length - 8)));
    if (!names.length) peopleEl.append(el("span", "none", "Nobody has shared a card yet"));

    state.dupes = duplicateMap(records);
    const claimed = records.filter((r) => str(r, "claimedBy")).length;
    const stats = $("stats");
    stats.replaceChildren();
    // The dashboard: how much is in, how much is open and who holds it,
    // who contributed how much, and the last seven days as bars.
    const count = (get) => {
      const m = new Map();
      for (const r of records) { const k = get(r); if (k) m.set(k, (m.get(k) || 0) + 1); }
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const peopleCell = (pairs) => {
      const v = el("div", "v people");
      if (!pairs.length) v.textContent = "—";
      for (const [name, n] of pairs) { const s = el("span"); s.append(el("b", null, String(n)), " " + name); v.append(s); }
      return v;
    };
    const s1 = el("div", "stat"); s1.append(el("div", "k", "Cards"), el("div", "v", String(records.length))); stats.append(s1);
    const s2 = el("div", "stat");
    s2.append(el("div", "k", claimed ? "Unclaimed · claimed by" : "Unclaimed"), el("div", "v", String(records.length - claimed)));
    if (claimed) s2.append(peopleCell(count((r) => str(r, "claimedBy"))));
    stats.append(s2);
    const s3 = el("div", "stat"); s3.append(el("div", "k", "Shared by"), peopleCell(count((r) => str(r, "scannedBy")))); stats.append(s3);
    const s4 = el("div", "stat");
    const dayMs = 86400000, today = Math.floor(Date.now() / dayMs);
    const perDay = new Array(7).fill(0);
    for (const r of records) { const d = today - Math.floor(scannedAt(r) / dayMs); if (d >= 0 && d < 7) perDay[6 - d]++; }
    const week = perDay.reduce((a, b) => a + b, 0), peak = Math.max(...perDay, 1);
    s4.append(el("div", "k", "Last 7 days"), el("div", "v", String(week)));
    const bars = el("div", "bars");
    for (const n of perDay) { const i = el("i", n ? null : "zero"); i.style.height = (n ? Math.max(12, Math.round(100 * n / peak)) : 6) + "%"; i.title = plural(n, "card"); bars.append(i); }
    s4.append(bars);
    const days = el("div", "days");
    days.append(el("span", null, dateFmt.format(new Date((today - 6) * dayMs))), el("span", null, "today"));
    s4.append(days);
    stats.append(s4);

    const events = [...new Set(records.map((r) => str(r, "eventTag")).filter(Boolean))].sort();
    const chips = $("event-chips");
    chips.replaceChildren();
    chips.hidden = events.length < 1;
    if (events.length) {
      for (const ev of ["", ...events]) {
        const c = el("button", "chip", ev || "All events");
        c.type = "button";
        c.setAttribute("aria-pressed", String(state.event === ev));
        c.addEventListener("click", () => { state.event = ev; renderTeam(); });
        chips.append(c);
      }
    }
    renderGrid();
  }

  function visibleRecords() {
    const q = fold(state.query.trim());
    let list = state.team.records.filter((r) => {
      const taken = !!str(r, "claimedBy");
      if (state.filter === "open" && taken) return false;
      if (state.filter === "taken" && !taken) return false;
      if (state.event && str(r, "eventTag") !== state.event) return false;
      if (!q) return true;
      const hay = fold([fullName(r), str(r, "title"), str(r, "company"), emails(r).join(" "),
        str(r, "phone"), str(r, "mobile"), str(r, "website"), str(r, "city"), str(r, "country"),
        str(r, "eventTag"), str(r, "scannedBy"), str(r, "claimedBy"), str(r, "notes"), str(r, "teamNotes")].join(" "));
      return q.split(/\s+/).every((w) => hay.includes(w));
    });
    const byText = (get) => (a, b) => get(a).localeCompare(get(b), undefined, { sensitivity: "base" });
    if (state.sort === "name") list.sort(byText((r) => str(r, "lastName") || displayName(r)));
    else if (state.sort === "company") list.sort(byText((r) => str(r, "company") || "~"));
    else if (state.sort === "event") list.sort(byText((r) => str(r, "eventTag") || "~"));
    else if (state.sort === "by") list.sort(byText((r) => str(r, "scannedBy") || "~"));
    else list.sort((a, b) => scannedAt(b) - scannedAt(a));
    return list;
  }

  function renderGrid() {
    const grid = $("grid");
    const total = state.team.records.length;
    const list = visibleRecords();
    grid.replaceChildren();
    $("team-empty").hidden = total > 0;
    document.querySelector(".toolbar").hidden = total === 0;
    $("no-match").hidden = !(total > 0 && list.length === 0);
    $("result-line").textContent = total ? (list.length === total ? plural(total, "card") : list.length + " of " + plural(total, "card")) : "";
    const asList = state.view === "list";
    grid.hidden = asList;
    $("list-wrap").hidden = !asList || !list.length;
    if (asList) renderList(list);
    else list.forEach((r, i) => { const li = tile(r); li.style.setProperty("--i", Math.min(i, 24)); grid.append(li); });
    // Claim all: every unclaimed card among the ones SHOWN (the search,
    // the filter and the event chip narrow it), so "claim everything from
    // yesterday's event" is a filter plus one click.
    const open = list.filter((r) => !str(r, "claimedBy"));
    $("claim-all").hidden = open.length < 2;
    $("claim-all-label").textContent = "Claim all " + plural(open.length, "unclaimed card");
    $("mb-claim").hidden = open.length < 2;
  }

  // 5. The list view: a dense, sortable table for a big team.
  const LIST_COLUMNS = [
    ["name", "Name"], ["company", "Company"], ["event", "Event"], ["by", "Shared by"], ["claimed", "Claimed by"], ["note", "Team note"]
  ];
  function renderList(list) {
    const head = $("list").querySelector("thead"), body = $("list").querySelector("tbody");
    head.replaceChildren(); body.replaceChildren();
    const tr = el("tr");
    for (const [key, label] of LIST_COLUMNS) {
      const th = el("th");
      const sortKey = { name: "name", company: "company", event: "event", by: "by" }[key];
      if (sortKey) {
        const b = el("button", null, label + (state.sort === sortKey ? " ↓" : ""));
        b.type = "button";
        if (state.sort === sortKey) b.setAttribute("aria-sort", "ascending");
        b.addEventListener("click", () => { state.sort = sortKey; $("sort").value = sortKey; renderGrid(); });
        th.append(b);
      } else th.textContent = label;
      tr.append(th);
    }
    head.append(tr);
    for (const r of list) {
      const row = el("tr");
      row.tabIndex = 0;
      const who = el("td");
      const w = el("div", "who");
      const url = photoURL(r);
      if (url) { const img = el("img", "thumb"); img.alt = ""; img.loading = "lazy"; img.src = url; w.append(img); }
      else w.append(el("span", "thumb face", cardInitials(r)));
      const txt = el("span");
      txt.append(el("b", null, displayName(r)));
      if (str(r, "title")) txt.append(el("small", null, str(r, "title")));
      w.append(txt); who.append(w); row.append(who);
      row.append(el("td", null, str(r, "company")), el("td", null, str(r, "eventTag")), el("td", null, str(r, "scannedBy")));
      const cl = el("td");
      const claimedBy = str(r, "claimedBy");
      cl.append(el("span", claimedBy ? "status taken" : "status open", claimedBy || "Unclaimed"));
      row.append(cl);
      row.append(el("td", null, str(r, "teamNotes").split(/\r?\n/).find(Boolean) || ""));
      row.addEventListener("click", () => openDetail(r));
      row.addEventListener("keydown", (e) => { if (e.key === "Enter") openDetail(r); });
      body.append(row);
    }
  }
  for (const b of document.querySelectorAll(".view-toggle button")) {
    b.addEventListener("click", () => {
      state.view = b.dataset.view;
      storageSet("cardlio.team.view", state.view);
      for (const x of document.querySelectorAll(".view-toggle button")) x.setAttribute("aria-pressed", String(x === b));
      if (state.team) renderGrid();
    });
    b.setAttribute("aria-pressed", String(b.dataset.view === state.view));
  }

  function tile(r) {
    const li = el("li");
    const b = el("button", "tile");
    b.type = "button";
    const ph = el("div", "ph");
    const url = photoURL(r);
    const face = () => {
      // No photo: typeset the card AS a card (name, title, company, an
      // accent bar) rather than a block of initials.
      ph.classList.add("cardface");
      ph.replaceChildren();
      const top = el("div"), bottom = el("div");
      top.append(el("div", "n", displayName(r)));
      if (str(r, "title")) top.append(el("div", "t", str(r, "title")));
      if (fullName(r) && str(r, "company")) bottom.append(el("div", "c", str(r, "company")));
      bottom.append(el("div", "bar"));
      ph.append(top, bottom);
    };
    if (url) {
      const img = el("img");
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.src = url;
      img.addEventListener("error", face);
      ph.append(img);
    } else {
      face();
    }
    const tb = el("div", "tb");
    tb.append(el("div", "nm", displayName(r)));
    const role = [str(r, "title"), fullName(r) ? str(r, "company") : ""].filter(Boolean).join(" · ");
    if (role) tb.append(el("div", "co", role));
    const place = [str(r, "city"), str(r, "country")].filter(Boolean).join(", ");
    if (place) tb.append(el("div", "ln", place));
    const teamNote = str(r, "teamNotes").split(/\r?\n/).find(Boolean);
    if (teamNote) { const n = el("div", "note"); n.append(icon("note"), el("span", null, teamNote)); tb.append(n); }
    const foot = el("div", "foot");
    const by = str(r, "scannedBy");
    foot.append(el("span", null, [by, when(scannedAt(r))].filter(Boolean).join(" · ")));
    const claimedBy = str(r, "claimedBy");
    if (state.dupes && state.dupes.has(r.recordName)) foot.append(el("span", "status dupe", "Possible duplicate"));
    foot.append(el("span", claimedBy ? "status taken" : "status open", claimedBy ? "Claimed" : "Unclaimed"));
    tb.append(foot);
    b.append(ph, tb);
    b.setAttribute("aria-label", displayName(r) + (role ? ", " + role : "") + (claimedBy ? ", claimed by " + claimedBy : ", unclaimed"));
    b.addEventListener("click", () => openDetail(r));
    li.append(b);
    return li;
  }

  // ---------------------------------------------------------------- detail

  function fieldRow(iconName, label, value, href) {
    const row = el("div", "field");
    row.append(icon(iconName));
    const fv = el("div", "fv");
    if (href) {
      const a = el("a", null, value);
      a.href = href;
      if (/^https?:/.test(href)) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
      fv.append(a);
    } else {
      fv.append(el("div", null, value));
    }
    fv.append(el("div", "fl", label));
    const copy = el("button", "copy");
    copy.type = "button";
    copy.title = "Copy " + label.toLowerCase();
    copy.setAttribute("aria-label", "Copy " + label.toLowerCase());
    copy.append(icon("copy"));
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(value);
        copy.replaceChildren(icon("check"));
        setTimeout(() => copy.replaceChildren(icon("copy")), 1400);
      } catch (e) { toast("Could not copy", true); }
    });
    row.append(fv, copy);
    return row;
  }

  function openDetail(r) {
    state.open = r;
    const photo = $("d-photo");
    photo.replaceChildren();
    const url = photoURL(r);
    if (url) {
      const img = el("img");
      img.alt = "Photo of " + displayName(r) + "'s business card";
      img.src = url;
      img.addEventListener("click", () => openLightbox(url, img.alt));
      photo.append(img);
    } else {
      photo.append(el("span", "noimg", "No photo"));
    }
    $("d-name").textContent = displayName(r);
    $("d-role").textContent = [str(r, "title"), fullName(r) ? str(r, "company") : ""].filter(Boolean).join(" · ");

    const fields = $("d-fields");
    fields.replaceChildren();
    for (const e of emails(r)) fields.append(fieldRow("mail", "Email", e, "mailto:" + encodeURIComponent(e).replace(/%40/g, "@")));
    if (str(r, "mobile")) fields.append(fieldRow("mobile", "Mobile", str(r, "mobile"), "tel:" + str(r, "mobile").replace(/[^\d+]/g, "")));
    if (str(r, "phone")) fields.append(fieldRow("phone", "Phone", str(r, "phone"), "tel:" + str(r, "phone").replace(/[^\d+]/g, "")));
    const web = safeWebURL(str(r, "website"));
    if (str(r, "website")) fields.append(fieldRow("web", "Website", str(r, "website"), web));
    const addr = addressLines(r);
    if (addr.length) {
      fields.append(fieldRow("pin", "Address", addr.join("\n"),
        "https://maps.apple.com/?q=" + encodeURIComponent(addr.join(", "))));
      fields.lastChild.querySelector(".fv > a, .fv > div").style.whiteSpace = "pre-line";
    }
    if (str(r, "eventTag")) fields.append(fieldRow("tag", "Event", str(r, "eventTag")));

    const notes = str(r, "notes");
    $("d-notes").hidden = !notes;
    $("d-notes").textContent = notes;
    $("d-team-notes").value = str(r, "teamNotes");
    $("d-team-notes-save").disabled = true;

    // The same person shared twice (two colleagues scanned the same
    // visitor) — say so, and link the other card.
    const dupe = $("d-dupe");
    dupe.replaceChildren();
    const others = (state.dupes && state.dupes.get(r.recordName)) || [];
    dupe.hidden = !others.length;
    if (others.length) {
      dupe.append("Looks like the same person as ");
      others.forEach((o, i) => {
        const b = el("button", null, displayName(o) + (str(o, "scannedBy") ? " (shared by " + str(o, "scannedBy") + ")" : ""));
        b.type = "button";
        b.addEventListener("click", () => openDetail(o));
        if (i) dupe.append(", ");
        dupe.append(b);
      });
      dupe.append(". Claim one; the team keeps both.");
    }

    const by = str(r, "scannedBy");
    $("d-prov").textContent = "Shared " + [by ? "by " + by : "", when(scannedAt(r)) ? "on " + when(scannedAt(r)) : ""].filter(Boolean).join(" ") + " into " + state.team.name + ".";

    renderDetailActions(r);
    setHash({ team: state.team.id, card: r.recordName });
    const dlg = $("detail");
    if (!dlg.open) dlg.showModal();
    $("d-close").focus();
  }

  function renderDetailActions(r) {
    const actions = $("d-actions");
    actions.replaceChildren();
    const claimedBy = str(r, "claimedBy");
    const dl = el("button", "btn");
    dl.type = "button";
    dl.append(icon("download"), el("span", null, claimedBy ? "Download a copy (vCard)" : "Download vCard"));
    dl.addEventListener("click", () => downloadVCard([r], true));
    if (claimedBy) {
      // A claimed card can still be anyone's to keep (the apps got "Add
      // Copy" the same day): the download is the copy, and stands first.
      const row = el("div", "claimed-row");
      const note = el("div", "claimed-note");
      note.append(icon("check"), el("span", null, "Claimed by " + claimedBy));
      row.append(note);
      if (isMine(r)) {
        const rel = el("button", "btn quiet");
        rel.type = "button";
        rel.append(el("span", null, "Release"));
        rel.title = "Give the lead back to the team — a mis-tap, or someone else should have it";
        rel.addEventListener("click", () => release(r));
        row.append(rel);
      }
      actions.append(row);
      dl.classList.add("primary");
      actions.append(dl);
    } else {
      const claim = el("button", "btn primary");
      claim.type = "button";
      claim.append(icon("hand"), el("span", null, "Claim"));
      claim.addEventListener("click", () => askClaim(r));
      actions.append(claim, dl);
    }
    const ed = el("button", "btn");
    ed.type = "button";
    ed.append(el("span", null, "Edit"));
    ed.title = "Fix a typo in this card for the whole team";
    ed.addEventListener("click", () => openCardForm(r));
    actions.append(ed);
    const link = el("button", "btn");
    link.type = "button";
    link.append(el("span", null, "Copy link"));
    link.title = "A link that opens this card for anyone on the team";
    link.addEventListener("click", async () => {
      const url = location.origin + location.pathname + "#" + new URLSearchParams({ team: state.team.id, card: r.recordName }).toString();
      try { await navigator.clipboard.writeText(url); toast("Link copied"); }
      catch (e) { toast(url); }
    });
    actions.append(link);
  }

  // Undo a claim you made — back to unclaimed for the whole team. Only
  // for a card claimed under the name this browser claims with; the apps
  // read an empty `claimedBy` as open.
  async function release(r) {
    try {
      await setClaimedBy(r, "");
      toast("Released — the card is unclaimed again");
      renderTeam();
      if (state.open === r) openDetail(r);
    } catch (err) {
      toast(err.message || errorText(err), true);
    }
  }

  // The team's shared note on the lead (2026-09-20): one field, last
  // writer wins, the same conflict-checked update as an edit.
  $("d-team-notes").addEventListener("input", () => {
    $("d-team-notes-save").disabled = !state.open || $("d-team-notes").value.trim() === str(state.open, "teamNotes");
  });
  $("d-team-notes-save").addEventListener("click", async () => {
    const r = state.open;
    if (!r) return;
    const text = $("d-team-notes").value.trim();
    $("d-team-notes-save").disabled = true;
    try {
      await updateCard(r, { teamNotes: { value: text, type: "STRING" } });
      toast("Note saved for the team");
      renderGrid();
    } catch (err) {
      toast(err.message || errorText(err), true);
      $("d-team-notes-save").disabled = false;
    }
  });

  // 3. Lightbox: the photo full-size, zoomable, rotatable.
  let lbTurn = 0;
  function openLightbox(url, alt) {
    const img = $("lb-img");
    lbTurn = 0;
    img.classList.remove("zoomed");
    $("lightbox").classList.remove("scroll");
    img.style.transform = "";
    img.src = url; img.alt = alt;
    $("lightbox").showModal();
  }
  $("lb-img").addEventListener("click", () => {
    const z = $("lb-img").classList.toggle("zoomed");
    $("lightbox").classList.toggle("scroll", z);
  });
  $("lb-rotate").addEventListener("click", () => { lbTurn = (lbTurn + 1) % 4; $("lb-img").style.transform = "rotate(" + lbTurn * 90 + "deg)"; });
  $("lb-close").addEventListener("click", () => $("lightbox").close());
  $("lightbox").addEventListener("click", (e) => { if (e.target === $("lightbox")) $("lightbox").close(); });

  $("d-close").addEventListener("click", () => $("detail").close());
  $("detail").addEventListener("click", (e) => { if (e.target === $("detail")) $("detail").close(); });
  // The close event arrives a moment after close(): if another card was
  // opened in between, it is that card's dialog now — keep it.
  $("detail").addEventListener("close", () => {
    if (!$("detail").open) { state.open = null; if (state.team) setHash({ team: state.team.id }); }
  });

  // ----------------------------------------------------------------- claim

  let claiming = [];   // the card, or every unclaimed card shown
  function askClaim(r) { askClaimAll([r]); }
  function askClaimAll(records) {
    claiming = records;
    const one = records.length === 1;
    $("c-title").textContent = one ? "Claim this card?" : "Claim " + plural(records.length, "card") + "?";
    $("c-text").textContent = one
      ? "The team will see " + displayName(records[0]) + " as yours, and the contact downloads as a vCard."
      : "The team will see all " + records.length + " as yours, and they download together as one vCard file. A card someone claims in the meantime is skipped.";
    $("c-fine").textContent = "In the cardlio app the cards stay in the team; a colleague can still download a copy.";
    $("c-fine").hidden = false;
    $("c-go").textContent = one ? "Claim and download" : "Claim all and download";
    $("c-name").value = myName();
    $("claim-dialog").showModal();
    $("c-name").focus();
  }
  $("c-cancel").addEventListener("click", () => $("claim-dialog").close());
  $("claim-all").addEventListener("click", () => {
    const open = visibleRecords().filter((r) => !str(r, "claimedBy"));
    if (open.length) askClaimAll(open);
  });
  $("claim-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("c-name").value.trim();
    if (!name || !claiming.length) return;
    storageSet(NAME_KEY, name);
    $("c-go").disabled = true;
    const won = [], skipped = [];
    let failure = null;
    try {
      for (const r of claiming) {
        try { await claim(r, name); won.push(r); }
        catch (err) { if (err.conflict) skipped.push(r); else { failure = err; break; } }
      }
    } finally {
      $("c-go").disabled = false;
      $("claim-dialog").close();
    }
    if (won.length) downloadVCard(won, true);
    renderTeam();
    if (state.open && claiming.includes(state.open)) openDetail(state.open);
    if (failure) toast(failure.message || errorText(failure), true);
    else if (claiming.length === 1) toast("Claimed. The contact is downloading.");
    else toast("Claimed " + plural(won.length, "card") + (skipped.length ? "; " + skipped.length + " taken by someone else meanwhile" : "") + ". Downloading.");
  });

  // UPDATE, not replace: only `claimedBy` is sent, and the record's change
  // tag makes CloudKit refuse if anyone changed the card since it loaded.
  async function claim(r, name) { await setClaimedBy(r, name); }

  async function setClaimedBy(r, name) {
    const team = state.team;
    const batch = team.db.newRecordsBatch({ zoneID: team.zoneID });
    batch.update([{
      recordType: r.recordType,
      recordName: r.recordName,
      recordChangeTag: r.recordChangeTag,
      fields: { claimedBy: { value: name } }
    }]);
    const response = await batch.commit();
    if (response.hasErrors) {
      const err = response.errors[0];
      const code = err.ckErrorCode || err.serverErrorCode || "";
      if (/CONFLICT|ATOMIC/.test(code)) {
        await refreshTeam(team);
        const e = new Error("Someone changed this card a moment ago. It has been reloaded; check whether it's still unclaimed.");
        e.conflict = true;
        throw e;
      }
      throw new Error("Could not " + (name ? "claim" : "release") + ": " + errorText(err));
    }
    const saved = response.records && response.records[0];
    r.fields.claimedBy = { value: name, type: "STRING" };
    if (saved && saved.recordChangeTag) r.recordChangeTag = saved.recordChangeTag;
  }

  async function refreshTeam(team) {
    const records = await zoneRecords(team.db, team.zoneID);
    team.records = records.filter((x) => x.recordType === "TeamCard");
    renderTeamNav();
    if (state.team === team) renderTeam();
  }

  // ---------------------------------------------------------------- polling
  //
  // Colleagues add cards all day at a fair; the page used to load once.
  // Every 60 s while the tab is visible the selected team's zone is
  // re-read (cheap: zone changes). Claims and edits apply in place; NEW
  // cards are announced by a pill ("3 new cards — show") rather than
  // reshuffling the grid under the reader's cursor.
  const POLL_MS = 60000;
  let pollTimer = null;
  let polling = false;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollTeam, POLL_MS);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pollTeam(); });
  }
  async function pollTeam(force) {
    const team = state.team;
    if (!team || polling || (!force && document.visibilityState !== "visible") || $("claim-dialog").open) return;
    polling = true;
    try {
      const fresh = (await zoneRecords(team.db, team.zoneID)).filter((x) => x.recordType === "TeamCard");
      const known = new Map(team.records.map((r) => [r.recordName, r]));
      const added = fresh.filter((r) => !known.has(r.recordName));
      let changed = false;
      for (const r of fresh) {
        const old = known.get(r.recordName);
        if (old && old.recordChangeTag !== r.recordChangeTag) {
          old.fields = r.fields; old.recordChangeTag = r.recordChangeTag; changed = true;
        }
      }
      const freshNames = new Set(fresh.map((r) => r.recordName));
      const removed = team.records.filter((r) => !freshNames.has(r.recordName));
      if (removed.length) { team.records = team.records.filter((r) => freshNames.has(r.recordName)); changed = true; }
      if (added.length) {
        team.pendingRecords = (team.pendingRecords || []).concat(added.filter((a) => !(team.pendingRecords || []).some((p) => p.recordName === a.recordName)));
        const n = team.pendingRecords.length;
        $("new-pill").textContent = plural(n, "new card") + " — show";
        $("new-pill").hidden = false;
      }
      if (changed) {
        if (state.open && !freshNames.has(state.open.recordName)) $("detail").close();
        renderTeam();
        if (state.open) renderDetailActions(state.open);
      }
    } catch (e) {
      // A failed poll is silent: the Reload button and the next tick remain.
    } finally {
      polling = false;
    }
  }
  $("new-pill").addEventListener("click", () => {
    const team = state.team;
    if (team && team.pendingRecords) { team.records.push(...team.pendingRecords); team.pendingRecords = []; }
    $("new-pill").hidden = true;
    renderTeamNav();
    renderTeam();
  });

  // ------------------------------------------------------------------ join

  let joinGUID = "";
  let joinSeq = 0;

  function joinError(text) {
    $("j-error").textContent = text;
    $("j-error").hidden = !text;
  }

  // What CloudKit's errors mean to someone holding an invite link.
  function inviteProblem(code) {
    if (/ACCESS_DENIED|NOT_FOUND|UNKNOWN_ITEM|PARTICIPANT|SHARE/i.test(code || "")) {
      return "This invite isn't for the Apple ID you're signed in with, or the team no longer exists. " +
        "Ask the team's owner to add this Apple ID in the cardlio app, then use the link again.";
    }
    if (/AUTHENTICATION/i.test(code || "")) return "Your sign-in expired. Sign in again, then use the link again.";
    return "iCloud could not open this invite (" + (code || "unknown error") + ").";
  }

  function resultOf(response) {
    const r = response && response.results && response.results[0];
    return r || null;
  }
  function shareTitle(r) {
    const t = r && r.share && r.share.fields && r.share.fields["cloudkit.title"];
    return (t && t.value) || "";
  }
  function ownerName(r) {
    const n = r && r.ownerIdentity && r.ownerIdentity.nameComponents;
    return n ? [n.givenName, n.familyName].filter(Boolean).join(" ") : "";
  }
  function resultZone(r) {
    return (r && r.zoneID && r.zoneID.zoneName) ||
           (r && r.share && r.share.zoneID && r.share.zoneID.zoneName) || "";
  }

  function openJoin(prefill) {
    joinGUID = "";
    joinError("");
    $("j-preview").hidden = true;
    $("j-go").disabled = true;
    $("j-link").value = prefill ? "https://www.icloud.com/share/" + prefill : "";
    if (!$("join-dialog").open) $("join-dialog").showModal();
    $("j-link").focus();
    if (prefill) previewInvite();
  }

  async function previewInvite() {
    const guid = inviteGUID($("j-link").value);
    const seq = ++joinSeq;
    joinGUID = guid;
    joinError("");
    $("j-preview").hidden = true;
    $("j-go").disabled = !guid;
    if (!guid) {
      if ($("j-link").value.trim()) joinError("That doesn't look like an invite link. It should start with https://www.icloud.com/share/");
      return;
    }
    try {
      const response = await container.fetchRecordInfos([guid]);
      if (seq !== joinSeq) return;
      const r = resultOf(response);
      console.info("[team] invite preview", r ? Object.keys(r) : response);
      if (!r || r.serverErrorCode) { joinError(inviteProblem(r && r.serverErrorCode)); return; }
      const title = shareTitle(r) || "A cardlio team";
      const preview = $("j-preview");
      preview.replaceChildren();
      preview.append(el("span", "avatar", initials(title)));
      const text = el("div");
      text.append(el("b", null, title));
      const owner = ownerName(r);
      const already = r.participantStatus === "ACCEPTED";
      text.append(el("small", null, already ? "You're already on this team." : (owner ? "Invited by " + owner : "Invite for this Apple ID")));
      preview.append(text);
      preview.hidden = false;
      if (already) $("j-go").textContent = "Open team";
    } catch (e) {
      if (seq !== joinSeq) return;
      // A preview is a nicety: joining may still work, so keep the button.
      console.info("[team] invite preview failed", e);
    }
  }

  let previewTimer;
  $("j-link").addEventListener("input", () => {
    $("j-go").textContent = "Join team";
    clearTimeout(previewTimer);
    previewTimer = setTimeout(previewInvite, 350);
  });
  $("j-cancel").addEventListener("click", () => $("join-dialog").close());
  for (const id of ["join-open", "join-open-empty", "join-open-mobile"]) {
    $(id).addEventListener("click", () => openJoin(""));
  }

  $("join-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const guid = joinGUID || inviteGUID($("j-link").value);
    if (!guid) { joinError("Paste the invite link first."); return; }
    $("j-go").disabled = true;
    joinError("");
    try {
      const response = await container.acceptShares([guid]);
      const r = resultOf(response);
      console.info("[team] accept", r ? Object.keys(r) : response);
      const code = (r && r.serverErrorCode) || (response.hasErrors && response.errors[0] && (response.errors[0].ckErrorCode || response.errors[0].serverErrorCode));
      if (!r || code) { joinError(inviteProblem(code)); return; }
      const zone = resultZone(r);
      $("join-dialog").close();
      await load();
      const team = state.teams.find((t) => t.id === zone) ||
                   state.teams.find((t) => !t.owned && t.name === shareTitle(r));
      if (team) {
        selectTeam(team);
        toast("You joined " + team.name + ".");
      } else {
        showAlert("You joined the team, but it isn't showing here yet. Reload in a minute; if it still doesn't appear, open it in the cardlio app on an iPhone or Mac.");
      }
    } catch (err) {
      joinError(inviteProblem(err && (err.ckErrorCode || err.serverErrorCode)) + (err && err.reason ? " " + err.reason : ""));
    } finally {
      $("j-go").disabled = false;
    }
  });

  // ---------------------------------------------------------------- export

  function vEsc(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\;");
  }
  function vFold(line) {
    const out = [];
    let rest = line;
    while (rest.length > 74) { out.push(rest.slice(0, 74)); rest = " " + rest.slice(74); }
    out.push(rest);
    return out.join("\r\n");
  }

  async function photoBase64(r) {
    const url = photoURL(r);
    if (!url) return "";
    try {
      const res = await fetch(url);
      if (!res.ok) return "";
      const bytes = new Uint8Array(await res.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    } catch (e) {
      return ""; // the image host may refuse a script download; the contact still exports
    }
  }

  async function vcard(r, withPhoto) {
    const L = ["BEGIN:VCARD", "VERSION:3.0"];
    L.push("N:" + [str(r, "lastName"), str(r, "firstName"), "", "", ""].map(vEsc).join(";"));
    L.push("FN:" + vEsc(displayName(r)));
    if (str(r, "company")) L.push("ORG:" + vEsc(str(r, "company")));
    if (str(r, "title")) L.push("TITLE:" + vEsc(str(r, "title")));
    for (const e of emails(r)) L.push("EMAIL;TYPE=INTERNET,WORK:" + vEsc(e));
    if (str(r, "mobile")) L.push("TEL;TYPE=CELL:" + vEsc(str(r, "mobile")));
    if (str(r, "phone")) L.push("TEL;TYPE=WORK,VOICE:" + vEsc(str(r, "phone")));
    const url = safeWebURL(str(r, "website"));
    if (url) L.push("URL:" + vEsc(url));
    if (addressLines(r).length) {
      L.push("ADR;TYPE=WORK:" + ["", str(r, "unit"), str(r, "street"), str(r, "city"), "", str(r, "postalCode"), str(r, "country")].map(vEsc).join(";"));
    }
    const note = [str(r, "notes"), str(r, "eventTag") ? "Event: " + str(r, "eventTag") : "",
      "From the cardlio team \"" + state.team.name + "\"" + (str(r, "scannedBy") ? ", shared by " + str(r, "scannedBy") : "")]
      .filter(Boolean).join("\n");
    L.push("NOTE:" + vEsc(note));
    if (withPhoto) {
      const b64 = await photoBase64(r);
      if (b64) L.push("PHOTO;ENCODING=b;TYPE=JPEG:" + b64);
    }
    L.push("END:VCARD");
    return L.map(vFold).join("\r\n") + "\r\n";
  }

  function fileSafe(s) {
    return (s || "cards").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "cards";
  }
  function saveFile(name, type, content) {
    const blob = new Blob([content], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  async function downloadVCard(records, withPhoto) {
    const parts = [];
    for (const r of records) parts.push(await vcard(r, withPhoto));
    const name = records.length === 1 ? displayName(records[0]) : state.team.name;
    saveFile(fileSafe(name) + ".vcf", "text/vcard;charset=utf-8", parts.join(""));
  }

  function csvCell(v) {
    let s = String(v == null ? "" : v);
    // No formulas in a spreadsheet opened from card text — but a plain
    // phone number ("+81 3 5555 0199") is not one and stays as printed.
    if (/^[=+\-@\t\r]/.test(s) && !/^\+[\d\s().\/-]+$/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function downloadCSV(records) {
    saveFile(fileSafe(state.team.name) + ".csv", "text/csv;charset=utf-8", csvText(records));
  }
  function csvText(records) {
    const head = ["First name", "Last name", "Title", "Company", "Emails", "Phone", "Mobile", "Website",
      "Street", "Unit", "Postal code", "City", "Country", "Event", "Notes", "Team notes", "Shared by", "Shared on", "Claimed by"];
    const rows = records.map((r) => [str(r, "firstName"), str(r, "lastName"), str(r, "title"), str(r, "company"),
      emails(r).join("; "), str(r, "phone"), str(r, "mobile"), str(r, "website"), str(r, "street"), str(r, "unit"),
      str(r, "postalCode"), str(r, "city"), str(r, "country"), str(r, "eventTag"), str(r, "notes"), str(r, "teamNotes"), str(r, "scannedBy"),
      scannedAt(r) ? new Date(scannedAt(r)).toISOString().slice(0, 10) : "", str(r, "claimedBy")]);
    return "\ufeff" + [head, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }

  // ------------------------------------------------------------ duplicates
  //
  // The same rule as the apps' DuplicateDetector: an e-mail whose local
  // part carries the person's first or last name (a role address like
  // info@ never does), scoped to the company; or the same first + last +
  // company. One shared key groups two cards.
  function duplicateKeys(r) {
    const first = fold(str(r, "firstName")).replace(/\s+/g, ""), last = fold(str(r, "lastName")).replace(/\s+/g, "");
    const company = fold(str(r, "company"));
    const keys = [];
    for (const e of emails(r)) {
      const lower = e.toLowerCase();
      const at = lower.indexOf("@");
      if (at < 0) continue;
      const local = lower.slice(0, at).replace(/[._-]/g, "");
      if ((first.length >= 2 && local.includes(first)) || (last.length >= 2 && local.includes(last))) keys.push("email:" + lower + "|" + company);
    }
    if (first || last) keys.push("name:" + first + "|" + last + "|" + company);
    return keys;
  }
  function duplicateMap(records) {
    const byKey = new Map();
    for (const r of records) for (const k of duplicateKeys(r)) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(r); }
    const map = new Map();
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      for (const r of group) {
        const others = map.get(r.recordName) || [];
        for (const o of group) if (o !== r && !others.includes(o)) others.push(o);
        map.set(r.recordName, others);
      }
    }
    return map;
  }

  // ------------------------------------------------------- add / edit card
  //
  // A member on Windows meets people too: a card typed in lands in the
  // team as a TeamCard record, `scannedBy` = their name, exactly what the
  // apps show for a shared card. Editing fixes a typo for the whole team
  // (the record only; a colleague's claimed copy in their own library is
  // separate). Both are conflict-checked like a claim.
  const FORM_FIELDS = ["firstName", "lastName", "title", "company", "emails", "phone", "mobile", "website",
    "street", "unit", "postalCode", "city", "country", "eventTag", "notes"];
  let editing = null;
  function openCardForm(r) {
    editing = r || null;
    const form = $("card-form");
    form.reset();
    $("f-error").hidden = true;
    $("f-title").textContent = r ? "Edit card" : "Add a card";
    $("f-text").textContent = r
      ? "Changes the card for the whole team. Copies colleagues already claimed into their own libraries stay as they are."
      : "Someone you met without a card to scan. The team sees it like any shared card.";
    $("f-go").textContent = r ? "Save" : "Add to team";
    $("f-by-label").hidden = !!r;
    if (r) for (const k of FORM_FIELDS) form.elements[k].value = k === "emails" ? emails(r).join(", ") : str(r, k);
    else form.elements.scannedBy.value = myName();
    $("card-dialog").showModal();
    form.elements.firstName.focus();
  }
  $("add-card").addEventListener("click", () => openCardForm(null));
  $("f-cancel").addEventListener("click", () => $("card-dialog").close());
  $("card-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = $("card-form");
    const v = (k) => form.elements[k].value.trim();
    const fields = {};
    for (const k of FORM_FIELDS) {
      if (k === "emails") fields.emails = { value: v("emails").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean), type: "STRING_LIST" };
      else fields[k] = { value: v(k), type: "STRING" };
    }
    if (!fields.firstName.value && !fields.lastName.value && !fields.company.value) {
      $("f-error").textContent = "A name or a company, at least."; $("f-error").hidden = false; return;
    }
    $("f-go").disabled = true;
    try {
      if (editing) {
        await updateCard(editing, fields);
        toast("Saved for the team");
      } else {
        const by = v("scannedBy") || "Someone";
        storageSet(NAME_KEY, by);
        await createCard(fields, by);
        toast("Added to " + state.team.name);
      }
      $("card-dialog").close();
      renderTeamNav();
      renderTeam();
      if (editing && state.open === editing) openDetail(editing);
    } catch (err) {
      $("f-error").textContent = err.message || errorText(err);
      $("f-error").hidden = false;
    } finally {
      $("f-go").disabled = false;
    }
  });

  // `photo`, when given, is a Blob: CloudKit JS uploads a Blob field value
  // as an asset through saveRecords (a records batch cannot carry one).
  // If the upload is refused the card is saved again without the photo.
  async function createCard(fields, by, photo) {
    const team = state.team;
    const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).toUpperCase();
    const base = {
      cardID: { value: id, type: "STRING" },
      scannedBy: { value: by, type: "STRING" },
      scannedAt: { value: Date.now(), type: "TIMESTAMP" },
      claimedBy: { value: "", type: "STRING" }
    };
    const record = { recordType: "TeamCard", recordName: id, fields: Object.assign({}, base, fields) };
    let response;
    let photoSaved = false;
    if (photo) {
      const withPhoto = { recordType: "TeamCard", recordName: id, fields: Object.assign({}, record.fields, { photo: { value: photo } }) };
      response = await team.db.saveRecords([withPhoto], { zoneID: team.zoneID });
      photoSaved = !response.hasErrors;
    }
    if (!photo || response.hasErrors) {
      const batch = team.db.newRecordsBatch({ zoneID: team.zoneID });
      batch.create([record]);
      response = await batch.commit();
      if (response.hasErrors) throw new Error("Could not add the card: " + errorText(response.errors[0]));
    }
    const saved = (response.records && response.records[0]) || {};
    const local = { recordName: id, recordType: "TeamCard", recordChangeTag: saved.recordChangeTag || "", fields: {} };
    for (const [k, f] of Object.entries(record.fields)) local.fields[k] = { value: f.value, type: f.type };
    if (photoSaved) {
      const asset = saved.fields && saved.fields.photo && saved.fields.photo.value;
      local.fields.photo = { value: asset && asset.downloadURL ? asset : { downloadURL: URL.createObjectURL(photo) }, type: "ASSETID" };
    }
    team.records.push(local);
    return { record: local, photoSaved: !!photo && photoSaved };
  }

  // ------------------------------------------------------------ vCard import
  //
  // A .vcf dropped on the page, or picked with Import vCard: one card or a
  // whole address book. vCard 2.1 / 3.0 / 4.0 — folded lines, escaped
  // values, quoted-printable, a photo inline as base64 or a data: URI
  // (a photo behind an http URL is not fetched). Mapped to what a
  // TeamCard holds; extra phones go to the notes so nothing is lost.
  function parseVCards(text) {
    const unfolded = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "");
    const cards = [];
    let cur = null;
    const unescape = (s) => s.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
    const splitEsc = (s) => { const out = []; let buf = ""; for (let i = 0; i < s.length; i++) { const c = s[i]; if (c === "\\" && i + 1 < s.length) { buf += c + s[++i]; } else if (c === ";") { out.push(buf); buf = ""; } else buf += c; } out.push(buf); return out.map(unescape); };
    const qp = (s) => { try { return decodeURIComponent(s.replace(/=\n/g, "").replace(/=([0-9A-F]{2})/gi, "%$1")); } catch (e) { return s; } };
    for (const raw of unfolded.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const head = line.slice(0, colon), value = line.slice(colon + 1);
      const parts = head.split(";");
      const name = parts[0].toUpperCase().replace(/^ITEM\d+\./, "");
      const params = parts.slice(1).map((p) => p.toUpperCase());
      const types = params.flatMap((p) => p.replace(/^TYPE=/, "").split(","));
      const enc = params.find((p) => p.startsWith("ENCODING="));
      const v = enc && /QUOTED-PRINTABLE/.test(enc) ? qp(value) : value;
      if (name === "BEGIN" && v.toUpperCase() === "VCARD") { cur = { firstName: "", lastName: "", title: "", company: "", emails: [], phone: "", mobile: "", website: "", street: "", unit: "", postalCode: "", city: "", country: "", notes: "", eventTag: "", extra: [], photo: null, fn: "" }; continue; }
      if (!cur) continue;
      if (name === "END") { if (v.toUpperCase() === "VCARD") { finishVCard(cur); cards.push(cur); cur = null; } continue; }
      switch (name) {
        case "N": { const n = splitEsc(v); cur.lastName = (n[0] || "").trim(); cur.firstName = [n[1], n[2]].filter(Boolean).join(" ").trim(); break; }
        case "FN": cur.fn = unescape(v).trim(); break;
        case "ORG": cur.company = splitEsc(v)[0].trim(); break;
        case "TITLE": cur.title = unescape(v).trim(); break;
        case "NOTE": cur.notes = unescape(v).trim(); break;
        case "EMAIL": { const e = unescape(v).trim(); if (e && !cur.emails.includes(e)) cur.emails.push(e); break; }
        case "URL": if (!cur.website) cur.website = unescape(v).trim(); break;
        case "TEL": {
          const t = unescape(v).trim();
          if (!t) break;
          const cell = types.some((x) => /CELL|MOBILE|IPHONE/.test(x));
          if (cell && !cur.mobile) cur.mobile = t;
          else if (!cell && !cur.phone && !types.some((x) => /FAX|PAGER/.test(x))) cur.phone = t;
          else cur.extra.push((types.some((x) => /FAX/.test(x)) ? "Fax: " : "Phone: ") + t);
          break;
        }
        case "ADR": {
          if (cur.street || cur.city) { cur.extra.push("Other address: " + splitEsc(v).filter(Boolean).join(", ")); break; }
          const a = splitEsc(v);
          cur.unit = (a[1] || "").trim(); cur.street = (a[2] || "").trim(); cur.city = (a[3] || "").trim();
          cur.postalCode = (a[5] || "").trim(); cur.country = (a[6] || "").trim();
          if (a[4] && a[4].trim()) cur.extra.push("Region: " + a[4].trim());
          break;
        }
        case "PHOTO": {
          let b64 = "", mime = "image/jpeg";
          const m = v.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
          if (m) { mime = m[1]; b64 = m[2]; }
          else if (enc && /^ENCODING=(B|BASE64)$/.test(enc)) { b64 = v; const t = types.find((x) => /JPEG|PNG|GIF|WEBP/.test(x)); if (t) mime = "image/" + t.toLowerCase().replace("JPG", "jpeg"); }
          if (b64) { try { const bin = atob(b64.replace(/\s+/g, "")); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); cur.photo = new Blob([bytes], { type: mime }); } catch (e) { /* not base64 */ } }
          break;
        }
        default: break;
      }
    }
    return cards;
  }
  function finishVCard(c) {
    if (!c.firstName && !c.lastName && c.fn) {
      const w = c.fn.split(/\s+/);
      if (w.length > 1) { c.lastName = w.pop(); c.firstName = w.join(" "); } else c.firstName = c.fn;
    }
    if (c.extra.length) c.notes = [c.notes, ...c.extra].filter(Boolean).join("\n");
    delete c.extra;
  }
  function vcardFields(c) {
    const f = {};
    for (const k of FORM_FIELDS) f[k] = k === "emails" ? { value: c.emails, type: "STRING_LIST" } : { value: c[k] || "", type: "STRING" };
    return f;
  }
  if (cfg.testHooks) window.__cardlioParseVCards = parseVCards;

  let importing = [];
  async function importFiles(files) {
    if (!state.team) { toast("Open a team first", true); return; }
    const parsed = [];
    for (const file of files) {
      if (!/\.vcf$/i.test(file.name) && !/vcard/i.test(file.type)) { toast(file.name + " is not a vCard file", true); continue; }
      parsed.push(...parseVCards(await file.text()));
    }
    const usable = parsed.filter((c) => c.firstName || c.lastName || c.company);
    if (!usable.length) { toast("No contacts found in that file", true); return; }
    importing = usable;
    // Preview: who is coming in, and which of them the team already has
    // (the same duplicate rule as the chips).
    const existing = duplicateMap(state.team.records.concat(usable.map((c, i) => ({ recordName: "import-" + i, recordType: "TeamCard", fields: Object.fromEntries(Object.entries(vcardFields(c)).map(([k, v]) => [k, { value: v.value }])) }))));
    const list = $("i-list");
    list.replaceChildren();
    usable.forEach((c, i) => {
      const li = el("li");
      if (c.photo) { const img = el("img", "ph"); img.alt = ""; img.src = URL.createObjectURL(c.photo); li.append(img); }
      else li.append(el("div", "ph", initials([c.firstName, c.lastName].filter(Boolean).join(" ") || c.company)));
      const who = el("div", "who");
      who.append(el("b", null, [c.firstName, c.lastName].filter(Boolean).join(" ") || c.company),
                 el("span", null, [c.title, c.company, c.emails[0]].filter(Boolean).join(" · ")));
      li.append(who);
      const dupes = (existing.get("import-" + i) || []).filter((o) => !String(o.recordName).startsWith("import-"));
      if (dupes.length) li.append(el("span", "status dupe", "Already in the team"));
      list.append(li);
    });
    $("i-title").textContent = "Import " + plural(usable.length, "card") + "?";
    $("i-text").textContent = "Into " + state.team.name + ", shared under your name. " +
      (usable.some((c) => c.photo) ? "Photos come along. " : "") + "Cards marked as already in the team are imported too — remove them afterwards if they are the same person.";
    $("i-by").value = myName();
    $("i-error").hidden = true;
    $("i-go").textContent = "Import " + plural(usable.length, "card");
    $("import-dialog").showModal();
    $("i-by").focus();
  }
  $("i-cancel").addEventListener("click", () => $("import-dialog").close());
  $("import-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const by = $("i-by").value.trim() || "Someone";
    storageSet(NAME_KEY, by);
    $("i-go").disabled = true;
    let added = 0, noPhoto = 0, failure = null;
    try {
      for (const c of importing) {
        try {
          const r = await createCard(vcardFields(c), by, c.photo);
          added++;
          if (c.photo && !r.photoSaved) noPhoto++;
        } catch (err) { failure = err; break; }
      }
    } finally {
      $("i-go").disabled = false;
      $("import-dialog").close();
    }
    renderTeamNav();
    renderTeam();
    if (failure) toast((added ? "Imported " + plural(added, "card") + "; then: " : "") + (failure.message || errorText(failure)), true);
    else toast("Imported " + plural(added, "card") + (noPhoto ? " (" + noPhoto + " without their photo — iCloud refused the upload)" : ""));
  });
  $("import-vcf").addEventListener("click", () => $("vcf-file").click());
  $("vcf-file").addEventListener("change", async (e) => { await importFiles([...e.target.files]); e.target.value = ""; });

  // Drop anywhere on the page while signed in.
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e) || $("app").hidden) return;
    e.preventDefault();
    dragDepth++;
    $("drop-into").textContent = state.team ? "into " + state.team.name : "";
    $("drop-hint").hidden = false;
  });
  document.addEventListener("dragover", (e) => { if (hasFiles(e) && !$("app").hidden) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  document.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("drop-hint").hidden = true; });
  document.addEventListener("drop", async (e) => {
    if (!hasFiles(e) || $("app").hidden) return;
    e.preventDefault();
    dragDepth = 0;
    $("drop-hint").hidden = true;
    await importFiles([...e.dataTransfer.files]);
  });

  async function updateCard(r, fields) {
    const team = state.team;
    const changed = {};
    for (const [k, f] of Object.entries(fields)) {
      const before = k === "emails" ? emails(r).join("\u0001") : str(r, k);
      const after = k === "emails" ? f.value.join("\u0001") : f.value;
      if (before !== after) changed[k] = f;
    }
    if (!Object.keys(changed).length) return;
    const batch = team.db.newRecordsBatch({ zoneID: team.zoneID });
    batch.update([{ recordType: r.recordType, recordName: r.recordName, recordChangeTag: r.recordChangeTag, fields: changed }]);
    const response = await batch.commit();
    if (response.hasErrors) {
      const err = response.errors[0];
      const code = err.ckErrorCode || err.serverErrorCode || "";
      if (/CONFLICT|ATOMIC/.test(code)) {
        await refreshTeam(team);
        throw new Error("Someone changed this card a moment ago. It has been reloaded; open it again to edit.");
      }
      throw new Error("Could not save: " + errorText(err));
    }
    const saved = response.records && response.records[0];
    for (const [k, f] of Object.entries(changed)) r.fields[k] = { value: f.value, type: f.type };
    if (saved && saved.recordChangeTag) r.recordChangeTag = saved.recordChangeTag;
  }

  // ---------------------------------------------------------------- ZIP
  //
  // "Everything": the vCards with photos, the CSV and each card photo as a
  // JPEG, for handing a fair's haul to whoever loads the CRM. Stored, not
  // compressed — the photos are JPEGs already — so this is the ZIP format
  // in ~40 lines: local headers, a central directory, an end record.
  const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zipStore(entries) {
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    const u16 = (n) => [n & 0xFF, (n >>> 8) & 0xFF], u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];
    const now = new Date(), dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const { name, data } of entries) {
      const n = enc.encode(name), crc = crc32(data);
      const head = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(dosTime), ...u16(dosDate), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(n.length), ...u16(0)]);
      parts.push(head, n, data);
      central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(dosTime), ...u16(dosDate), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(n.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), n);
      offset += head.length + n.length + data.length;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
    return new Blob([...parts, ...central, end], { type: "application/zip" });
  }
  async function exportZip(records) {
    const enc = new TextEncoder();
    const base = fileSafe(state.team.name);
    const entries = [];
    const vcf = [];
    for (const r of records) vcf.push(await vcard(r, true));
    entries.push({ name: base + ".vcf", data: enc.encode(vcf.join("")) });
    entries.push({ name: base + ".csv", data: enc.encode(csvText(records)) });
    const seen = new Map();
    for (const r of records) {
      const url = photoURL(r);
      if (!url) continue;
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        let name = fileSafe(displayName(r));
        const n = (seen.get(name) || 0) + 1; seen.set(name, n);
        if (n > 1) name += " " + n;
        entries.push({ name: "photos/" + name + ".jpg", data: new Uint8Array(await res.arrayBuffer()) });
      } catch (e) { /* the image host may refuse; the vCard still carries what it could */ }
    }
    return { blob: zipStore(entries), count: entries.length };
  }
  if (cfg.testHooks) window.__cardlioZip = async () => { const z = await exportZip(visibleRecords()); return { size: z.blob.size, count: z.count }; };

  // ------------------------------------------------------------- keyboard
  //
  // Arrows move between cards, Home/End jump, Enter opens (a tile is a
  // button). Up/Down use the grid's real column count.
  $("grid").addEventListener("keydown", (e) => {
    const tiles = [...$("grid").querySelectorAll(".tile")];
    const i = tiles.indexOf(document.activeElement);
    if (i < 0 || !tiles.length) return;
    const top = tiles[0].getBoundingClientRect().top;
    const cols = Math.max(1, tiles.filter((t) => Math.abs(t.getBoundingClientRect().top - top) < 2).length);
    const go = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + cols, ArrowUp: i - cols, Home: 0, End: tiles.length - 1 }[e.key];
    if (go === undefined) return;
    e.preventDefault();
    tiles[Math.min(tiles.length - 1, Math.max(0, go))].focus();
  });

  // --------------------------------------------------------------- toolbar

  $("search").addEventListener("input", (e) => { state.query = e.target.value; renderGrid(); });
  for (const b of document.querySelectorAll(".segmented button")) {
    b.addEventListener("click", () => {
      state.filter = b.dataset.filter;
      for (const x of document.querySelectorAll(".segmented button")) x.setAttribute("aria-pressed", String(x === b));
      renderGrid();
    });
  }
  $("sort").addEventListener("change", (e) => { state.sort = e.target.value; renderGrid(); });
  $("team-select").addEventListener("change", (e) => {
    const t = state.teams.find((x) => x.id === e.target.value);
    if (t) selectTeam(t);
  });
  $("refresh").addEventListener("click", () => load());
  // 7. The phone's bottom bar mirrors the toolbar's four actions.
  $("mb-search").addEventListener("click", () => { $("search").scrollIntoView({ block: "center" }); $("search").focus(); });
  $("mb-add").addEventListener("click", () => openCardForm(null));
  $("mb-claim").addEventListener("click", () => $("claim-all").click());
  $("mb-export").addEventListener("click", () => { $("export-btn").scrollIntoView({ block: "center" }); setMenu(true); });

  const exportBtn = $("export-btn"), exportMenu = $("export-menu");
  function setMenu(open) {
    exportMenu.hidden = !open;
    exportBtn.setAttribute("aria-expanded", String(open));
    if (open) exportMenu.querySelector("button").focus();
  }
  exportBtn.addEventListener("click", () => setMenu(exportMenu.hidden));
  document.addEventListener("click", (e) => { if (!exportMenu.hidden && !e.target.closest(".menu-wrap")) setMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !exportMenu.hidden) { setMenu(false); exportBtn.focus(); } });
  for (const b of exportMenu.querySelectorAll("button")) {
    b.addEventListener("click", async () => {
      setMenu(false);
      const list = visibleRecords();
      if (!list.length) { toast("No cards to export", true); return; }
      if (b.dataset.export === "csv") downloadCSV(list);
      else if (b.dataset.export === "zip") {
        toast("Packing " + plural(list.length, "card") + "…");
        const z = await exportZip(list);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(z.blob); a.download = fileSafe(state.team.name) + ".zip";
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      } else await downloadVCard(list, false);
      toast("Exported " + plural(list.length, "card"));
    });
  }
  // "/" jumps to search, as on most web apps.
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !$("app").hidden && document.activeElement.tagName !== "INPUT" && !$("detail").open) {
      e.preventDefault();
      $("search").focus();
    }
  });

  // ------------------------------------------------------------------ start

  // Installable (manifest + a small service worker for the shell) —
  // Windows and Android colleagues get a home-screen icon; iCloud calls
  // always go to the network.
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  if (cfg.testHooks) window.__cardlioTeamPoll = () => pollTeam(true);   // the fake-CloudKit harness only (its tab may be hidden)

  container.setUpAuth()
    .then((user) => (user ? signedIn() : signedOut()))
    .catch((e) => {
      $("welcome").hidden = false;
      toast("iCloud could not start: " + errorText(e), true);
    });
})();
