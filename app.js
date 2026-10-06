// team.cardlio.app — the cardlio team library in the browser.
//
// Reads, through Apple's CloudKit JS, the teams this Apple ID OWNS
// (private database) and has JOINED (shared database): a team is a
// "team-…" zone holding a TeamInfo record (its name) and TeamCard records.
//
// "MY CARDS" (2026-10-05): the same private database holds the person's
// own card library (Core Data's zone, "com.apple.coredata.cloudkit.zone").
// That format is Apple's mirror of the apps' SwiftData store, and one
// record it cannot take could stop the person's whole sync — so the page
// only ever UPDATES four fields of an existing card (leadRating, eventTag,
// notes, followUpDoneAt + modifiedAt; see updateLibraryCard), proven in
// Development first. It never creates or deletes a library record. mycards.js turns those records into the shape the
// team view shows. Downloads from My cards need the "unlocked" marker the
// apps write into the zone "cardlio-web" (handbook/plan-web-library.md).
//
// TEAM WRITES ("team-…" zones): claims, edits, notes, ratings, new and
// deleted cards, each conflict-checked (if someone else changed the
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
    filter: storageGet("cardlio.team.filter") || "all",
    rating: storageGet("cardlio.team.rating") || "",      // "", hot, warm, cold
    sort: storageGet("cardlio.team.sort") || "new",
    selected: new Set(),   // recordNames ticked for a bulk action (12)
    query: "",
    event: "",
    open: null,         // record shown in the detail dialog
    pendingNew: 0,      // cards the background poll saw that are not shown yet
    view: storageGet("cardlio.team.view") || "grid",
    mfilter: storageGet("cardlio.mine.filter") || "all",   // My cards: all, owed, reconnect, notes
    country: "",
    industry: "",
    company: "",    // the app's search tokens (Company: …, Interest: …), picked from the suggestions
    interest: ""
  };
  // A stable colour per person, for the avatars.
  function personHue(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  const myName = () => storageGet(NAME_KEY);
  const isMine = (r) => { const n = myName(); return !!n && str(r, "claimedBy").localeCompare(n, undefined, { sensitivity: "base" }) === 0; };

  // The lead rating and interest tags the 3.2 apps put on a team card
  // (2026-10-02): `leadRating` is "hot" | "warm" | "cold" | "", anything
  // else reads as not rated; `leadInterests` is the labels, one per line.
  // On the web they are the TEAM's rating — one value, last writer wins,
  // like team notes; a claimed copy in someone's own library keeps its own.
  const RATINGS = { hot: { label: "Hot", rank: 3 }, warm: { label: "Warm", rank: 2 }, cold: { label: "Cold", rank: 1 } };
  function rating(r) { const v = str(r, "leadRating").trim().toLowerCase(); return RATINGS[v] ? v : ""; }
  function interestList(text) {
    const seen = new Set();
    return String(text || "").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
  }
  function interests(r) { return interestList(str(r, "leadInterests")); }
  function ratingMark(v, withLabel) {
    const s = el("span", "rating " + v);
    s.append(icon(v));
    if (withLabel) s.append(el("span", null, RATINGS[v].label));
    s.title = RATINGS[v].label + " lead";
    return s;
  }

  // ---------------------------------------------------------------- utils

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  const ICONS = {
    hot: '<path d="M12 3c1 3.2 4.2 4.6 4.2 8.6a4.2 4.2 0 0 1-8.4 0c0-1.5.6-2.7 1.5-3.6C10 9.6 12 7 12 3z"/>',
    warm: '<circle cx="12" cy="12" r="3.6"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M6 18l1.4-1.4M16.6 7.4L18 6"/>',
    cold: '<path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/><path d="M9.6 4.6L12 7l2.4-2.4M9.6 19.4L12 17l2.4 2.4"/>',
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
  function emails(record) { return listOf(record, "emails"); }
  function listOf(record, name) {
    const v = f(record, name);
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
    return [str(r, "building"), line1, line2, str(r, "country")].filter(Boolean);
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
  function toast(text, isError, details) {
    const t = $("toast");
    t.textContent = text;
    if (details) {
      // A "Copy details" button for a failure worth reporting (the full
      // upload URL, say) — it keeps the toast up until it is clicked.
      const b = document.createElement("button");
      b.type = "button"; b.className = "toast-copy"; b.textContent = "Copy details";
      b.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(details); b.textContent = "Copied"; } catch (e) { b.textContent = "Could not copy"; }
        setTimeout(() => t.classList.remove("show"), 1500);
      });
      t.append(" ", b);
    }
    t.classList.toggle("error", !!isError);
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), details ? 60000 : (isError ? 5200 : 2600));
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

  // persist: false is the fallback when the browser refuses to keep the
  // sign-in (AUTH_PERSIST_ERROR, seen once in Chrome): signed in for this
  // tab only, rather than not at all.
  const configure = (persist) => CloudKit.configure({
    containers: [{
      containerIdentifier: cfg.containerIdentifier,
      environment: cfg.environment,
      apiTokenAuth: {
        apiToken: cfg.apiToken,
        persist,
        signInButton: { id: "apple-sign-in-button", theme: "white-with-outline" },
        signOutButton: { id: "apple-sign-out-button", theme: "black" }
      }
    }]
  });
  let container, sources;
  function useContainer(persist) {
    configure(persist);
    container = CloudKit.getDefaultContainer();
    sources = [
      { db: container.privateCloudDatabase, owned: true },
      { db: container.sharedCloudDatabase, owned: false }
    ];
  }
  useContainer(true);

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

  // ------------------------------------------------------------- my cards
  //
  // The person's own library as one more "team": { personal: true }. It is
  // kept across reloads (`personal`), because after the first full read
  // only CHANGES are fetched, with the zone's sync token. desiredKeys keeps
  // the photos and OCR text on the server (a full read without it was
  // 18 MB / 17 s); `trimmed` records whether CloudKit honoured it.
  const LIB = window.CardlioLibrary;
  const MINE_ID = "mine";
  let personal = null;
  // For a console check when something looks wrong: __cardlioMine() returns
  // counts and field NAMES only — never a card's contents.
  const diag = { keys: {}, fetches: [], pollErrors: [] };
  window.__cardlioMine = () => {
    const lib = personal;
    const photos = lib ? lib.records.map((r) => photoURL(r)) : [];
    return {
      cards: lib ? lib.records.length : null, records: lib ? lib.byName.size : null, pending: lib ? lib.pendingRecords.length : null,
      photosInline: photos.filter((u) => u.startsWith("data:")).length, photosAsset: photos.filter((u) => u && !u.startsWith("data:")).length,
      trimmed: lib ? lib.trimmed : null, unlocked: lib ? lib.unlocked : null, hasSyncToken: !!(lib && lib.syncToken),
      visible: document.visibilityState, fetches: diag.fetches.slice(-10), pollErrors: diag.pollErrors.slice(-5), fieldsSeen: diag.keys
    };
  };

  async function libraryChanges(db, zoneID, syncToken) {
    const changed = [], deleted = [];
    let token = syncToken, trimmed = true;
    for (let page = 0; page < 400; page++) {
      const zone = { zoneID, syncToken: token, desiredKeys: LIB.DESIRED_KEYS, desiredRecordTypes: [LIB.RECORD_TYPE] };
      const response = await db.fetchRecordZoneChanges([zone], { desiredKeys: LIB.DESIRED_KEYS });
      if (response.hasErrors) throw response.errors[0];
      const z = response.zones && response.zones[0];
      if (!z) break;
      for (const r of z.records || []) {
        if (r.deleted) deleted.push(r.recordName);
        else if (r.recordType === LIB.RECORD_TYPE) {
          for (const [k, v] of Object.entries(r.fields || {})) {
            const key = k + ":" + (v && v.type ? v.type : typeof (v && v.value)) + (v && v.value === "" ? ":empty" : "");
            diag.keys[key] = (diag.keys[key] || 0) + 1;
          }
          if (r.fields && (r.fields.CD_rawText || r.fields.CD_imageData)) trimmed = false;
          changed.push(r);
        }
      }
      token = z.syncToken;
      if (!z.moreComing) break;
    }
    return { changed, deleted, syncToken: token, trimmed };
  }

  // Apply the changes since the last read. With `announce`, cards that are
  // new wait in pendingRecords behind the "N new cards" pill, as on a team.
  async function syncPersonal(lib, announce) {
    const first = lib.syncToken === undefined;
    const t0 = Date.now();
    const { changed, deleted, syncToken, trimmed } = await libraryChanges(lib.db, lib.zoneID, lib.syncToken);
    diag.fetches.push({ at: new Date().toLocaleTimeString(), ms: Date.now() - t0, incremental: !first, changed: changed.length, deleted: deleted.length });
    if (first) {
      lib.trimmed = trimmed;
      if (!trimmed) console.info("cardlio: iCloud ignored desiredKeys — My cards loaded every field (slower).");
    }
    lib.syncToken = syncToken;
    let touched = false;
    const gone = new Set(deleted);
    for (const name of gone) if (lib.byName.delete(name)) touched = true;
    lib.pendingRecords = (lib.pendingRecords || []).filter((p) => !gone.has(p.recordName));
    for (const raw of changed) {
      const card = LIB.adaptRecord(raw);
      const old = lib.byName.get(raw.recordName);
      const pendingAt = lib.pendingRecords.findIndex((p) => p.recordName === raw.recordName);
      if (old) {
        old.fields = card.fields; old.recordChangeTag = card.recordChangeTag; old.cardID = card.cardID;
        touched = true;
      } else if (pendingAt >= 0) {
        lib.pendingRecords[pendingAt] = card;
      } else if (announce) {
        lib.pendingRecords.push(card);
      } else {
        lib.byName.set(raw.recordName, card);
        touched = true;
      }
    }
    if (touched || first) lib.records = LIB.dedupe([...lib.byName.values()]);
    return { touched, added: !!lib.pendingRecords.length };
  }

  // The marker the apps write when the unlock is owned (one record per
  // platform, in the person's own iCloud). No zone, no record → locked.
  async function readUnlocked(db) {
    try { return LIB.isUnlocked(await zoneRecords(db, { zoneName: LIB.WEB_ZONE })); }
    catch (e) { return false; }
  }

  async function loadPersonal() {
    const db = container.privateCloudDatabase;
    const response = await db.fetchAllRecordZones();
    if (response.hasErrors) throw response.errors[0];
    const zone = (response.zones || []).find((z) => z.zoneID.zoneName === LIB.ZONE);
    if (!zone) return null;   // cardlio never synced a library to this iCloud
    const lib = personal && personal.db === db ? personal : {
      id: MINE_ID, personal: true, owned: true, named: true, name: "My cards", createdAt: 0,
      db, zoneID: zone.zoneID, byName: new Map(), records: [], pendingRecords: [], unlocked: false
    };
    await syncPersonal(lib, lib === personal);
    lib.unlocked = await readUnlocked(db);
    personal = lib;
    return lib;
  }

  // ------------------------------------------------------------- auth flow

  function signedOut() {
    document.title = "cardlio Team";
    document.body.classList.add("signed-out");
    document.body.classList.remove("signed-in-view");
    $("mobile-bar").hidden = true;
    $("account").hidden = true;
    $("welcome").hidden = false;
    $("invite-banner").hidden = !sessionGet(PENDING_KEY);
    $("app").hidden = true;
    $("refresh").hidden = true;
    state.teams = [];
    state.team = null;
    personal = null;
    document.body.classList.remove("mine", "locked");
    container.whenUserSignsIn().then(signedIn).catch((e) => toast(errorText(e), true));
  }

  function signedIn() {
    document.body.classList.remove("signed-out");
    document.body.classList.add("signed-in-view");
    $("welcome").hidden = true;
    $("app").hidden = false;
    $("refresh").hidden = false;
    $("mobile-bar").hidden = false;
    $("account").hidden = false;
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
      let mineError = "";
      const [{ teams, failures }, mine] = await Promise.all([
        discoverTeams(),
        loadPersonal().catch((e) => { mineError = errorText(e); return personal; })
      ]);
      state.teams = mine ? [mine, ...teams] : teams;
      if (failures.length && !teams.length && !mine) showAlert("Could not read your teams from iCloud: " + failures[0]);
      else if (failures.length) showAlert("Some teams could not be read: " + failures[0]);
      else if (mineError) showAlert("Could not read your own cards from iCloud: " + mineError);
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
    // Otherwise the team with the most recent card: that is the fair in
    // progress. Someone with no team lands on My cards.
    const latest = (t) => t.records.reduce((m, r) => Math.max(m, scannedAt(r)), t.createdAt || 0);
    const busiest = state.teams.filter((t) => !t.personal).sort((a, b) => latest(b) - latest(a))[0];
    selectTeam(state.teams.find((t) => t.id === wanted) || busiest || state.teams[0]);
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
    $("mine-nav").replaceChildren();
    select.replaceChildren();
    $("mine-side").hidden = !state.teams.some((t) => t.personal);
    for (const team of state.teams) {
      const li = el("li");
      const b = el("button");
      b.type = "button";
      b.dataset.team = team.id;
      const av = el("span", "avatar", initials(team.name));
      const mid = el("span");
      mid.append(el("div", "t-name", team.name));
      mid.append(el("div", "t-sub", team.personal ? "Only you" : team.owned ? "Yours" : "Joined"));
      b.append(av, mid, el("span", "t-count", String(team.records.length)));
      b.addEventListener("click", () => selectTeam(team));
      li.append(b);
      (team.personal ? $("mine-nav") : nav).append(li);

      const opt = el("option", null, team.name + " (" + team.records.length + ")");
      opt.value = team.id;
      select.append(opt);
    }
  }

  // My cards hides the team-only controls (body.mine) and, until the
  // unlock marker is there, every download (body.locked).
  function applyMode() {
    const t = state.team;
    document.body.classList.toggle("mine", !!(t && t.personal));
    document.body.classList.toggle("locked", !!(t && t.personal && !t.unlocked));
    if (t && t.personal && state.sort === "by") { state.sort = "new"; $("sort").value = "new"; }
  }
  function downloadsAllowed() {
    return !state.team || !state.team.personal || !!state.team.unlocked;
  }
  // Every download path asks this first; false = the explanation instead.
  function mayDownload() {
    if (downloadsAllowed()) return true;
    $("locked-dialog").showModal();
    $("l-ok").focus();
    return false;
  }

  function selectTeam(team) {
    if (state.team !== team) state.selected.clear();
    // Values belong to one library: a team's countries are not My cards'.
    if (!state.team || state.team.id !== team.id) { state.country = state.industry = state.company = state.interest = ""; }
    state.team = team;
    state.event = "";
    $("new-pill").hidden = !(team.pendingRecords && team.pendingRecords.length);
    storageSet("cardlio.team.last", team.id);
    setHash({ team: team.id });
    document.title = team.name + (team.personal ? " · cardlio" : " · cardlio Team");
    for (const b of document.querySelectorAll("#team-nav button, #mine-nav button")) {
      b.setAttribute("aria-current", b.dataset.team === team.id ? "true" : "false");
    }
    applyMode();
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

  // The line under the title: plain facts, the actionable ones as links.
  function summaryLink(text, act) {
    const b = el("button", "linkish", text);
    b.type = "button";
    b.addEventListener("click", act);
    return b;
  }
  function renderSummary(parts) {
    const sub = $("team-sub");
    sub.replaceChildren();
    parts.forEach((p, i) => { if (i) sub.append(" · "); sub.append(p); });
  }

  // Filters live in the Filters panel; these keep its buttons, the chips
  // under the toolbar and the count on the button in step.
  function pressIn(groupId, attr, value) {
    for (const x of document.querySelectorAll("#" + groupId + " button")) x.setAttribute("aria-pressed", String(x.dataset[attr] === value));
  }
  function setFilter(v) { state.filter = v; storageSet("cardlio.team.filter", v); pressIn("filter-group", "filter", v); renderGrid(); }
  function setMFilter(v) { state.mfilter = v; storageSet("cardlio.mine.filter", v); pressIn("mine-filter-group", "mfilter", v); renderGrid(); }
  function setRating(v) { state.rating = v; storageSet("cardlio.team.rating", v); pressIn("rating-group", "rating", v); renderGrid(); }
  function activeFilters() {
    const out = [];
    const label = (groupId, attr, value) => {
      const b = [...document.querySelectorAll("#" + groupId + " button")].find((x) => x.dataset[attr] === value);
      return b ? b.textContent.trim() : value;
    };
    if (!state.team) return out;
    if (state.team.personal) {
      if (state.mfilter !== "all") out.push({ text: label("mine-filter-group", "mfilter", state.mfilter), clear: () => setMFilter("all") });
    } else if (state.filter !== "all") {
      out.push({ text: label("filter-group", "filter", state.filter), clear: () => setFilter("all") });
    }
    if (state.company) out.push({ text: "Company: " + state.company, clear: () => { state.company = ""; renderGrid(); } });
    if (state.country) out.push({ text: "Country: " + state.country, clear: () => { state.country = ""; $("country-filter").value = ""; renderGrid(); } });
    if (state.industry) out.push({ text: "Industry: " + state.industry, clear: () => { state.industry = ""; $("industry-filter").value = ""; renderGrid(); } });
    if (state.interest) out.push({ text: "Interest: " + state.interest, clear: () => { state.interest = ""; renderGrid(); } });
    if (state.rating) out.push({ text: RATINGS[state.rating].label + " leads", clear: () => setRating("") });
    return out;
  }
  function renderActiveFilters() {
    const active = activeFilters();
    $("filters-count").textContent = String(active.length);
    $("filters-count").hidden = !active.length;
    const box = $("active-filters");
    box.replaceChildren();
    box.hidden = !active.length;
    if (!active.length) return;
    box.append(el("span", "lead-in", "Showing"));
    for (const a of active) {
      const c = el("button", "filter-chip");
      c.type = "button";
      c.setAttribute("aria-label", "Remove filter: " + a.text);
      c.append(el("span", null, a.text), el("span", "x", "\u00d7"));
      c.addEventListener("click", a.clear);
      box.append(c);
    }
    if (active.length > 1) {
      const all = el("button", "linkish", "Clear all");
      all.type = "button";
      all.addEventListener("click", () => { for (const a of activeFilters()) a.clear(); });
      box.append(all);
    }
  }

  function renderTeam() {
    const team = state.team;
    const records = team.records;
    if (team.personal) { renderPersonal(team); return; }
    $("team-name").textContent = team.name + " ";
    $("team-name").append(el("span", team.owned ? "badge" : "badge plain", team.owned ? "Yours" : "Joined"));
    const sub = [];
    const stamps = records.map(scannedAt).filter(Boolean);
    if (stamps.length) {
      const a = when(Math.min(...stamps)), b = when(Math.max(...stamps));
      sub.push(a === b ? "Cards from " + a : "Cards from " + a + " to " + b);
    } else if (team.createdAt) sub.push("Started " + when(team.createdAt));
    if (!team.named) sub.push("Open the team library in the cardlio app once to show this team's name here");
    const open = records.filter((r) => !str(r, "claimedBy")).length;
    const line = [plural(records.length, "card")];
    if (records.length) line.push(open ? summaryLink(open + " unclaimed", () => setFilter("open")) : "all claimed");
    renderSummary(line.concat(sub));
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
    stats.append(weekStat(records));
    renderEventChips(records);
    renderGrid();
  }

  // The last seven days as bars (cards shared to a team, or added to the library).
  function weekStat(records) {
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
    return s4;
  }

  function renderEventChips(records) {
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
  }

  // My cards: the head, four numbers that matter for one person's
  // network, and the country / industry pickers built from the cards.
  function renderPersonal(lib) {
    const records = lib.records;
    $("team-name").textContent = lib.name + " ";
    $("team-name").append(el("span", "badge plain", "Only you"));
    const owed = records.filter(LIB.followUpOwed).length;
    const due = records.filter((r) => LIB.reconnectDue(r)).length;
    const line = [plural(records.length, "card")];
    if (owed) line.push(summaryLink(plural(owed, "follow-up") + " owed", () => setMFilter("owed")));
    if (due) line.push(summaryLink(due + (due === 1 ? " person" : " people") + " to reconnect with", () => setMFilter("reconnect")));
    line.push("from your iCloud");
    if (!lib.unlocked) line.push(summaryLink("downloads come with the unlock", () => mayDownload()));
    renderSummary(line);
    state.dupes = null;
    const stats = $("stats");
    stats.replaceChildren();
    const stat = (k, v, title) => { const c = el("div", "stat"); c.append(el("div", "k", k), el("div", "v", String(v))); if (title) c.title = title; stats.append(c); };
    stat("Cards", records.length);
    stat("Follow-ups owed", records.filter(LIB.followUpOwed).length, "Cards you marked as owing a follow-up");
    const now = Date.now();
    stat("Reconnect due", records.filter((r) => LIB.reconnectDue(r, now)).length, "Keep in touch: the time to reconnect has come");
    stats.append(weekStat(records));
    fillPicker($("country-filter"), "Any country", records.map((r) => str(r, "country")), "country");
    fillPicker($("industry-filter"), "Any industry", records.map((r) => str(r, "industry")), "industry");
    renderEventChips(records);
    renderGrid();
  }
  function fillPicker(select, anyLabel, values, key) {
    const counts = new Map();
    for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
    const names = [...counts.keys()].sort((a, b) => a.localeCompare(b));
    if (state[key] && !counts.has(state[key])) state[key] = "";
    select.replaceChildren();
    const any = el("option", null, anyLabel); any.value = ""; select.append(any);
    for (const n of names) { const o = el("option", null, n + " (" + counts.get(n) + ")"); o.value = n; select.append(o); }
    select.value = state[key] || "";
    select.disabled = !names.length;
  }

  // Search works like the apps' (CardSearchToken + BusinessCard.matches):
  // the text is looked for in every field, and the suggestions under the
  // search field turn a typed value into a filter — Country, Company,
  // Industry, Event, Interest, Lead, Follow-up, Keep in touch.
  const same = (a, b) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
  function searchText(r) {
    return fold([fullName(r), str(r, "firstNameAlternative"), str(r, "lastNameAlternative"), str(r, "phoneticName"),
      str(r, "title"), str(r, "company"), emails(r).join(" "),
      str(r, "phone"), str(r, "mobile"), str(r, "website"), str(r, "city"), str(r, "country"), str(r, "isoCountryCode"),
      str(r, "eventTag"), str(r, "scannedBy"), str(r, "claimedBy"), str(r, "notes"), str(r, "teamNotes"),
      rating(r) ? RATINGS[rating(r)].label : "", interests(r).join(" "),
      str(r, "honorific"), str(r, "fax"), listOf(r, "additionalPhones").join(" "), str(r, "building"), str(r, "street"),
      str(r, "unit"), str(r, "postalCode"), str(r, "industry"), str(r, "linkedin"), str(r, "wechat"),
      str(r, "translatedTitle"), str(r, "translatedCompany"), str(r, "translatedAddress")].join(" "));
  }
  function passesFilters(r, now) {
    const personal = !!state.team.personal;
    if (personal) {
      if (state.mfilter === "owed" && !LIB.followUpOwed(r)) return false;
      if (state.mfilter === "reconnect" && !LIB.reconnectDue(r, now)) return false;
      if (state.mfilter === "notes" && !str(r, "notes")) return false;
    } else {
      const taken = !!str(r, "claimedBy");
      if (state.filter === "open" && taken) return false;
      if (state.filter === "taken" && !taken) return false;
      if (state.filter === "mine" && !isMine(r)) return false;
      if (state.filter === "notes" && !str(r, "teamNotes").trim()) return false;
    }
    if (state.country && !same(str(r, "country"), state.country)) return false;
    if (state.industry && !same(str(r, "industry"), state.industry)) return false;
    if (state.company && !same(str(r, "company"), state.company)) return false;
    if (state.interest && !interests(r).some((i) => same(i, state.interest))) return false;
    if (state.rating && rating(r) !== state.rating) return false;
    if (state.event && str(r, "eventTag") !== state.event) return false;
    return true;
  }

  function visibleRecords() {
    const q = fold(state.query.trim());
    const now = Date.now();
    let list = state.team.records.filter((r) => {
      if (!passesFilters(r, now)) return false;
      if (!q) return true;
      const hay = searchText(r);
      return q.split(/\s+/).every((w) => hay.includes(w));
    });
    const byText = (get) => (a, b) => get(a).localeCompare(get(b), undefined, { sensitivity: "base" });
    if (state.sort === "name") list.sort(byText((r) => str(r, "lastName") || displayName(r)));
    else if (state.sort === "company") list.sort((a, b) => byText((r) => str(r, "company") || "~")(a, b) || byText((r) => str(r, "lastName") || displayName(r))(a, b));
    else if (state.sort === "event") list.sort(byText((r) => str(r, "eventTag") || "~"));
    else if (state.sort === "by") list.sort(byText((r) => str(r, "scannedBy") || "~"));
    else if (state.sort === "rating") list.sort((a, b) => ((RATINGS[rating(b)] || {}).rank || 0) - ((RATINGS[rating(a)] || {}).rank || 0) || scannedAt(b) - scannedAt(a));
    else list.sort((a, b) => scannedAt(b) - scannedAt(a));
    return list;
  }

  function renderGrid() {
    const grid = $("grid");
    const total = state.team.records.length;
    const list = visibleRecords();
    grid.replaceChildren();
    const personal = !!state.team.personal;
    $("team-empty").hidden = total > 0 || personal;
    $("mine-empty").hidden = total > 0 || !personal;
    document.querySelector(".toolbar").hidden = total === 0;
    $("no-match").hidden = !(total > 0 && list.length === 0);
    $("result-line").textContent = total ? (list.length === total ? plural(total, "card") : list.length + " of " + plural(total, "card")) : "";
    const asList = state.view === "list", asStats = state.view === "stats";
    const asMap = state.view === "map" && mapOffered();
    grid.hidden = asList || asStats || asMap;
    $("map-view").hidden = !asMap;
    // The Map button exists only on My cards: on a team the map view
    // falls back to the cards, and the toggle says so.
    for (const x of document.querySelectorAll(".view-toggle button")) x.setAttribute("aria-pressed", String(x.dataset.view === (state.view === "map" && !asMap ? "grid" : state.view)));
    $("list-wrap").hidden = !asList || !list.length;
    $("overview").hidden = !asStats || !list.length;
    // A ticked card that left the team (deleted in the app) leaves the selection.
    const alive = new Set(state.team.records.map((r) => r.recordName));
    for (const id of state.selected) if (!alive.has(id)) state.selected.delete(id);
    renderRecap(list, asStats);
    if (asMap) renderMap(list);
    else if (asStats) renderOverview(list);
    else if (asList) renderList(list);
    else {
      // Newest first reads as time: Last 7 days / Last 30 days / Earlier,
      // headed only when the cards shown span more than one of them.
      const day = 86400000, now = Date.now();
      // Sorted by company or event, the same headings group by that value.
      const bucket = state.sort === "company" ? (r) => str(r, "company") || "No company"
        : state.sort === "event" ? (r) => str(r, "eventTag") || "No event"
        : (r) => { const age = now - scannedAt(r); return age < 7 * day ? "Last 7 days" : age < 30 * day ? "Last 30 days" : "Earlier"; };
      const grouped = ["new", "company", "event"].includes(state.sort) && new Set(list.map(bucket)).size > 1;
      let last = "";
      list.forEach((r, i) => {
        if (grouped && bucket(r) !== last) {
          last = bucket(r);
          const head = el("li", "group-head");
          const n = list.filter((x) => bucket(x) === last).length;
          head.append(el("h2", null, last), el("span", null, state.sort === "company" ? (n === 1 ? "1 person" : n + " people") : plural(n, "card")));
          grid.append(head);
        }
        const li = tile(r); li.style.setProperty("--i", Math.min(i, 24)); grid.append(li);
      });
    }
    renderActiveFilters();
    renderToday();
    $("sel-hint").hidden = asStats || asMap || !(list.length > 1 && !state.selected.size);
    $("sel-hint").textContent = personal ? "Tick cards to rate, tag or download several at once. Shift-click ticks a range."
      : "Tick cards to claim, download or export just those. Shift-click ticks a range.";
    if (!personal && state.filter === "mine" && !myName() && total) $("no-match").querySelector("p").textContent = "Claim a card first — \"Mine\" shows the cards claimed under your name.";
    else $("no-match").querySelector("p").textContent = "Try a different search, or show all cards.";
    renderSelectionBar(list);
    // Claim all: every unclaimed card among the ones SHOWN (the search,
    // the filter and the event chip narrow it), so "claim everything from
    // yesterday's event" is a filter plus one click.
    const open = personal ? [] : list.filter((r) => !str(r, "claimedBy"));
    $("claim-all").hidden = open.length < 2;
    $("claim-all-label").textContent = "Claim all " + plural(open.length, "unclaimed card");
    $("mb-claim").hidden = open.length < 2;
  }

  // 5. The list view: a dense, sortable table for a big team.
  const LIST_COLUMNS = [
    ["name", "Name"], ["company", "Company"], ["rating", "Rating"], ["event", "Event"], ["by", "Shared by"], ["claimed", "Claimed by"], ["note", "Team note"]
  ];
  const MINE_COLUMNS = [
    ["name", "Name"], ["company", "Company"], ["rating", "Rating"], ["event", "Event"], ["place", "Place"], ["added", "Added"], ["note", "Note"]
  ];
  function renderList(list) {
    const head = $("list").querySelector("thead"), body = $("list").querySelector("tbody");
    head.replaceChildren(); body.replaceChildren();
    const tr = el("tr");
    const allTh = el("th", "pick-cell");
    const allBox = el("input"); allBox.type = "checkbox";
    allBox.setAttribute("aria-label", "Select all shown");
    allBox.checked = list.length > 0 && list.every((r) => state.selected.has(r.recordName));
    allBox.addEventListener("change", () => { if (allBox.checked) list.forEach((r) => state.selected.add(r.recordName)); else list.forEach((r) => state.selected.delete(r.recordName)); renderGrid(); });
    allTh.append(allBox); tr.append(allTh);
    const personal = !!state.team.personal;
    for (const [key, label] of personal ? MINE_COLUMNS : LIST_COLUMNS) {
      const th = el("th");
      const sortKey = { name: "name", company: "company", rating: "rating", event: "event", by: "by" }[key];
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
      row.classList.toggle("picked", state.selected.has(r.recordName));
      const pc = el("td", "pick-cell");
      const box = el("input"); box.type = "checkbox"; box.checked = state.selected.has(r.recordName);
      box.setAttribute("aria-label", "Select " + displayName(r));
      box.addEventListener("click", (e) => { e.stopPropagation(); togglePick(r, list, e.shiftKey); });
      pc.append(box); row.append(pc);
      const who = el("td");
      const w = el("div", "who");
      const url = photoURL(r);
      if (url) { const img = el("img", "thumb"); img.alt = ""; img.loading = "lazy"; img.src = url; w.append(img); }
      else w.append(el("span", "thumb face", cardInitials(r)));
      const txt = el("span");
      txt.append(el("b", null, displayName(r)));
      if (str(r, "title")) txt.append(el("small", null, str(r, "title")));
      w.append(txt); who.append(w); row.append(who);
      const rc = el("td", "rating-cell");
      if (rating(r)) rc.append(ratingMark(rating(r), true));
      if (interests(r).length) rc.append(el("small", null, interests(r).join(", ")));
      if (personal) {
        row.append(el("td", null, str(r, "company")), rc, el("td", null, str(r, "eventTag")),
          el("td", null, [str(r, "city"), str(r, "country")].filter(Boolean).join(", ")), el("td", null, when(scannedAt(r))),
          el("td", null, str(r, "notes").split(/\r?\n/).find(Boolean) || ""));
        row.addEventListener("click", () => openDetail(r));
        row.addEventListener("keydown", (e) => { if (e.key === "Enter") openDetail(r); });
        body.append(row);
        continue;
      }
      row.append(el("td", null, str(r, "company")), rc, el("td", null, str(r, "eventTag")), el("td", null, str(r, "scannedBy")));
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
    b.addEventListener("click", () => { if (state.team) setView(b.dataset.view); });
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
      const card = el("div", "face-card"), top = el("div"), bottom = el("div");
      top.append(el("div", "n", displayName(r)));
      if (str(r, "title")) top.append(el("div", "t", str(r, "title")));
      if (fullName(r) && str(r, "company")) bottom.append(el("div", "c", str(r, "company")));
      bottom.append(el("div", "bar"));
      card.append(top, bottom);
      ph.append(card);
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
    // The rating sits beside the name, in the text area: on the photo it
    // covered the name of a typeset (photo-less) card.
    const nmRow = el("div", "nm-row");
    nmRow.append(el("div", "nm", displayName(r)));
    if (rating(r)) nmRow.append(ratingMark(rating(r), true));
    tb.append(nmRow);
    const role = [str(r, "title"), fullName(r) ? str(r, "company") : ""].filter(Boolean).join(" · ");
    if (role) tb.append(el("div", "co", role));
    const place = [str(r, "city"), str(r, "country")].filter(Boolean).join(", ");
    if (place) tb.append(el("div", "ln", place));
    const personal = !!r.personal;
    const teamNote = str(r, personal ? "notes" : "teamNotes").split(/\r?\n/).find(Boolean);
    if (teamNote) { const n = el("div", "note"); n.append(icon("note"), el("span", null, teamNote)); tb.append(n); }
    const foot = el("div", "foot");
    const by = str(r, "scannedBy");
    foot.append(el("span", null, [by, when(scannedAt(r))].filter(Boolean).join(" · ")));
    const claimedBy = str(r, "claimedBy");
    let status = "";
    if (personal) {
      // Your own card: what you owe this person, not who holds the lead.
      if (LIB.followUpOwed(r)) status = "follow-up owed";
      else if (LIB.reconnectDue(r)) status = "reconnect due";
      if (status) foot.append(el("span", status === "follow-up owed" ? "status owed" : "status due", status === "follow-up owed" ? "Follow up" : "Reconnect"));
    } else {
      if (state.dupes && state.dupes.has(r.recordName)) foot.append(el("span", "status dupe", "Possible duplicate"));
      foot.append(el("span", claimedBy ? "status taken" : "status open", claimedBy ? "Claimed" : "Unclaimed"));
    }
    tb.append(foot);
    b.append(ph, tb);
    b.setAttribute("aria-label", displayName(r) + (role ? ", " + role : "") + (rating(r) ? ", " + RATINGS[rating(r)].label + " lead" : "") +
      (personal ? (status ? ", " + status : "") : claimedBy ? ", claimed by " + claimedBy : ", unclaimed"));
    b.addEventListener("click", () => openDetail(r));
    li.append(b);

    // 12. The tick for a bulk action — a sibling of the tile button.
    const pick = el("button", "pick");
    pick.type = "button";
    pick.setAttribute("aria-pressed", String(state.selected.has(r.recordName)));
    pick.setAttribute("aria-label", "Select " + displayName(r));
    pick.append(icon("check"));
    pick.addEventListener("click", (e) => { e.stopPropagation(); togglePick(r, visibleRecords(), e.shiftKey); });
    li.classList.toggle("picked", state.selected.has(r.recordName));
    li.append(pick);
    return li;
  }

  // 12. Multi-select: tick tiles, then claim / download / export just those.
  let lastPick = null;
  function togglePick(r, list, range) {
    const on = !state.selected.has(r.recordName);
    if (range && lastPick) {
      const a = list.findIndex((x) => x.recordName === lastPick), b = list.findIndex((x) => x.recordName === r.recordName);
      if (a >= 0 && b >= 0) {
        for (const x of list.slice(Math.min(a, b), Math.max(a, b) + 1)) { if (on) state.selected.add(x.recordName); else state.selected.delete(x.recordName); }
        lastPick = r.recordName; renderGrid(); return;
      }
    }
    if (on) state.selected.add(r.recordName); else state.selected.delete(r.recordName);
    lastPick = r.recordName;
    renderGrid();
  }
  function selectedRecords() {
    // In the current sort order, whether or not the filter still shows them.
    const order = new Map(visibleRecords().map((r, i) => [r.recordName, i]));
    return state.team.records.filter((r) => state.selected.has(r.recordName))
      .sort((a, b) => (order.get(a.recordName) ?? 1e9) - (order.get(b.recordName) ?? 1e9));
  }
  function renderSelectionBar(shown) {
    const n = state.selected.size;
    $("sel-bar").hidden = n === 0;
    if (!n) return;
    const sel = selectedRecords();
    const open = sel.filter((r) => !str(r, "claimedBy"));
    const hiddenCount = sel.filter((r) => !shown.includes(r)).length;
    $("sel-count").textContent = plural(n, "card") + " selected" + (hiddenCount ? " (" + hiddenCount + " not shown)" : "");
    $("sel-all").hidden = shown.every((r) => state.selected.has(r.recordName));
    $("sel-claim").hidden = !!state.team.personal || open.length === 0;
    $("sel-claim").textContent = open.length === n ? "Claim" : "Claim " + open.length + " unclaimed";
  }
  $("sel-all").addEventListener("click", () => { visibleRecords().forEach((r) => state.selected.add(r.recordName)); renderGrid(); });
  $("sel-none").addEventListener("click", () => { state.selected.clear(); renderGrid(); });
  $("sel-claim").addEventListener("click", () => { const open = selectedRecords().filter((r) => !str(r, "claimedBy")); if (open.length) askClaimAll(open); });
  $("sel-vcf").addEventListener("click", async () => { if (!mayDownload()) return; const s = selectedRecords(); await downloadVCard(s, false); toast("Exported " + plural(s.length, "card")); });
  $("sel-csv").addEventListener("click", () => { if (!mayDownload()) return; const s = selectedRecords(); downloadCSV(s); toast("Exported " + plural(s.length, "card")); });
  $("sel-zip").addEventListener("click", async () => { if (!mayDownload()) return; const s = selectedRecords(); toast("Packing " + plural(s.length, "card") + "…"); await downloadZip(s); toast("Exported " + plural(s.length, "card")); });
  $("sel-print").addEventListener("click", () => { if (mayDownload()) printSheet(selectedRecords(), "selected"); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.selected.size && !$("detail").open && !document.querySelector("dialog[open]")) { state.selected.clear(); renderGrid(); }
  });

  // 9. Print sheet: a roster on paper, built when printing starts.
  let printScope = null;   // records to print, or null for "the cards shown"
  function printSheet(records, label) {
    printScope = { records, label };
    window.print();
  }
  function buildPrintSheet() {
    if (!state.team) return;
    const scope = printScope || { records: visibleRecords(), label: null };
    const sheet = $("print-sheet");
    sheet.replaceChildren();
    sheet.append(el("h1", null, state.team.name));
    if (!downloadsAllowed()) {   // the browser's own Print command, while locked
      sheet.append(el("p", "meta", "Printing your cards comes with the cardlio unlock, the same one purchase as in the app."));
      return;
    }
    const personal = !!state.team.personal;
    const what = scope.label === "selected" ? plural(scope.records.length, "selected card")
      : (scope.records.length === state.team.records.length ? plural(scope.records.length, "card") : scope.records.length + " of " + plural(state.team.records.length, "card") + " (filtered)");
    const bits = [what];
    if (state.event) bits.push(state.event);
    if (state.query.trim()) bits.push("search: " + state.query.trim());
    bits.push("printed " + new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
    sheet.append(el("p", "meta", bits.join(" · ")));
    if (state.event && scope.records.length) sheet.append(el("p", "meta", recapFacts(scope.records).join(" · ")));
    const table = el("table"), thead = el("thead"), tbody = el("tbody");
    const hr = el("tr");
    const heads = personal ? ["", "Name", "Company", "Rating", "Contact", "Event", "Added", "Note"]
      : ["", "Name", "Company", "Rating", "Contact", "Shared by", "Claimed by", "Team note"];
    for (const h of heads) hr.append(el("th", h ? null : "tick", h));
    thead.append(hr);
    for (const r of scope.records) {
      const tr = el("tr");
      const tick = el("td", "tick"); tick.append(el("i")); tr.append(tick);
      const nm = el("td"); nm.append(el("b", null, displayName(r))); if (str(r, "title")) nm.append(el("small", null, str(r, "title"))); tr.append(nm);
      const co = el("td"); co.append(el("span", null, str(r, "company"))); const place = [str(r, "city"), str(r, "country")].filter(Boolean).join(", "); if (place) co.append(el("small", null, place)); tr.append(co);
      const rt = el("td"); if (rating(r)) rt.append(el("b", null, RATINGS[rating(r)].label)); if (interests(r).length) rt.append(el("small", null, interests(r).join(", "))); tr.append(rt);
      const ct = el("td"); for (const line of [emails(r)[0], str(r, "mobile") || str(r, "phone")].filter(Boolean)) ct.append(el("div", null, line)); tr.append(ct);
      if (personal) {
        tr.append(el("td", null, str(r, "eventTag")), el("td", null, when(scannedAt(r))), el("td", "note", str(r, "notes")));
        tbody.append(tr);
        continue;
      }
      tr.append(el("td", null, [str(r, "scannedBy"), when(scannedAt(r))].filter(Boolean).join("\n")));
      tr.append(el("td", str(r, "claimedBy") ? "claimed" : null, str(r, "claimedBy") || "—"));
      tr.append(el("td", "note", str(r, "teamNotes")));
      tbody.append(tr);
    }
    table.append(thead, tbody);
    sheet.append(table);
    sheet.append(el("p", "foot", personal ? "team.cardlio.app · My cards" : "team.cardlio.app · " + state.team.name));
  }
  window.addEventListener("beforeprint", buildPrintSheet);
  window.addEventListener("afterprint", () => { printScope = null; });

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
      // No photo: the card typeset as a card, as in the gallery.
      const card = el("div", "face-card big"), top = el("div"), bottom = el("div");
      top.append(el("div", "n", displayName(r)));
      if (str(r, "title")) top.append(el("div", "t", str(r, "title")));
      if (fullName(r) && str(r, "company")) bottom.append(el("div", "c", str(r, "company")));
      bottom.append(el("div", "bar"));
      card.append(top, bottom);
      photo.append(card);
    }
    $("d-name").textContent = displayName(r);
    $("d-role").textContent = [str(r, "title"), fullName(r) ? str(r, "company") : ""].filter(Boolean).join(" · ");

    const fields = $("d-fields");
    fields.replaceChildren();
    for (const e of emails(r)) fields.append(fieldRow("mail", "Email", e, "mailto:" + encodeURIComponent(e).replace(/%40/g, "@")));
    const tel = (v) => "tel:" + v.replace(/[^\d+]/g, "");
    if (str(r, "mobile")) fields.append(fieldRow("mobile", "Mobile", str(r, "mobile"), tel(str(r, "mobile"))));
    if (str(r, "phone")) fields.append(fieldRow("phone", "Phone", str(r, "phone"), tel(str(r, "phone"))));
    for (const p of listOf(r, "additionalPhones")) fields.append(fieldRow("phone", "Phone", p, tel(p)));
    if (str(r, "fax")) fields.append(fieldRow("phone", "Fax", str(r, "fax")));
    const web = safeWebURL(str(r, "website"));
    if (str(r, "website")) fields.append(fieldRow("web", "Website", str(r, "website"), web));
    if (str(r, "linkedin")) fields.append(fieldRow("web", "LinkedIn", str(r, "linkedin"), safeWebURL(str(r, "linkedin"))));
    if (str(r, "wechat")) fields.append(fieldRow("mobile", "WeChat", str(r, "wechat")));
    const addr = addressLines(r);
    if (addr.length) {
      fields.append(fieldRow("pin", "Address", addr.join("\n"),
        "https://maps.apple.com/?q=" + encodeURIComponent(addr.join(", "))));
      fields.lastChild.querySelector(".fv > a, .fv > div").style.whiteSpace = "pre-line";
    }
    if (str(r, "eventTag") && !r.personal) fields.append(fieldRow("tag", "Event", str(r, "eventTag")));   // My cards: in the edit box
    if (r.personal) { personalRows(r, fields); renderMineEdit(r); }

    const notes = str(r, "notes");
    $("d-notes").hidden = !notes;
    $("d-notes").textContent = notes;
    renderLead(r);
    $("d-interest-add").value = "";
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

    // Everyone else you know at this company (team: on this team).
    const also = $("d-also");
    also.replaceChildren();
    const co = fold(str(r, "company"));
    const mates = co ? state.team.records.filter((x) => x !== r && fold(str(x, "company")) === co) : [];
    also.hidden = !mates.length;
    if (mates.length) {
      also.append("Also at " + str(r, "company") + ": ");
      mates.slice(0, 5).forEach((o, i) => {
        if (i) also.append(", ");
        const b = el("button", null, displayName(o));
        b.type = "button";
        b.addEventListener("click", () => openDetail(o));
        also.append(b);
      });
      if (mates.length > 5) also.append(" and " + (mates.length - 5) + " more");
      const all = el("button", "all", "Show all " + (mates.length + 1));
      all.type = "button";
      all.addEventListener("click", () => { $("detail").close(); state.company = str(r, "company"); setView(state.view === "stats" ? "grid" : state.view); });
      also.append(" · ", all);
    }

    const by = str(r, "scannedBy");
    $("d-prov").textContent = r.personal
      ? [when(scannedAt(r)) ? "Added to your library on " + when(scannedAt(r)) + "." : "", "Rating, event, notes and follow-up can be changed here; everything else in the cardlio app."].filter(Boolean).join(" ")
      : "Shared " + [by ? "by " + by : "", when(scannedAt(r)) ? "on " + when(scannedAt(r)) : ""].filter(Boolean).join(" ") + " into " + state.team.name + ".";

    renderDetailActions(r);
    setHash({ team: state.team.id, card: r.recordName });
    // Step through the cards shown (the current search and filters), as
    // when leafing through a fair's stack.
    const order = visibleRecords(), at = order.indexOf(r);
    $("d-nav").hidden = at < 0 || order.length < 2;
    $("d-pos").textContent = at >= 0 ? (at + 1) + " of " + order.length : "";
    const dlg = $("detail");
    if (!dlg.open) dlg.showModal();
    $("d-close").focus();
  }

  // A library card's own fields: industry, interests, a done follow-up,
  // keep-in-touch and the stored translation. (Rating, event and an owed
  // follow-up are in the edit box below.)
  function personalRows(r, fields) {
    if (str(r, "industry")) fields.append(fieldRow("tag", "Industry", str(r, "industry")));
    if (interests(r).length) fields.append(fieldRow("tag", "Interests", interests(r).join(", ")));
    const done = f(r, "followUpDoneAt");
    if (done) fields.append(fieldRow("check", "Follow-up", "Done on " + when(done)));

    const translated = [str(r, "translatedTitle"), str(r, "translatedCompany"), str(r, "translatedAddress")].filter(Boolean);
    if (translated.length) {
      fields.append(fieldRow("tag", "Translation", translated.join("\n")));
      fields.lastChild.querySelector(".fv > div").style.whiteSpace = "pre-line";
    }
  }

  // ------------------------------------------------- edits to your own cards
  //
  // The fields the web may change (owner, 2026-10-05/06), each proven in
  // Development first with the app's --web-edit-check: lead rating, event,
  // notes (a dated line, or the whole text), follow-up done, "I was in
  // touch" (lastContactAt), "I owe a follow-up" (only on a card with no
  // follow-up yet — "Owe again" must CLEAR the done date, which stays in
  // the app), the keep-in-touch cadence (INT64), interests, title, company,
  // website, LinkedIn, WeChat and industry. Never names, numbers, e-mails,
  // the address or photos: the app normalises those (phone format, Apple
  // Maps check) and Caller ID / contact sync depend on it. Each save changes those
  // keys and CD_modifiedAt — nothing else — as a conflict-checked update:
  // if the card changed on a device since this page read it, iCloud refuses
  // and nothing is overwritten. Proven in the Development environment first
  // (the app's --web-edit-check: the apps take the change in, keep every
  // other field, and their own next edit of the card syncs normally).
  // Names, phones, e-mails, address, photos, new and deleted cards stay in
  // the apps.
  async function updateLibraryCard(r, changes, quiet) {
    const lib = state.team;
    if (!lib || !lib.personal) throw new Error("Not a card of your library");
    const now = Date.now();
    const fields = { CD_modifiedAt: { value: now, type: "TIMESTAMP" } };
    const isInt = (k) => k === "keepInTouchMonths";
    for (const [k, v] of Object.entries(changes)) fields["CD_" + k] = { value: v, type: typeof v === "number" ? (isInt(k) ? "INT64" : "TIMESTAMP") : "STRING" };
    const batch = lib.db.newRecordsBatch({ zoneID: lib.zoneID });
    batch.update([{ recordType: LIB.RECORD_TYPE, recordName: r.recordName, recordChangeTag: r.recordChangeTag, fields }]);
    const response = await batch.commit();
    if (response.hasErrors) {
      const err = response.errors[0];
      const code = err.ckErrorCode || err.serverErrorCode || "";
      if (/CONFLICT|ATOMIC|CHANGED/.test(code)) {
        if (quiet) throw Object.assign(new Error("changed elsewhere"), { conflict: true });
        try { await syncPersonal(lib, false); } catch (e) { /* the reload is best effort */ }
        renderTeam();
        if (state.open && state.open.recordName === r.recordName) openDetail(state.open);
        throw new Error("This card changed on one of your devices a moment ago. It has been reloaded — check it and try again.");
      }
      throw new Error("Could not save: " + errorText(err));
    }
    const saved = response.records && response.records[0];
    for (const [k, v] of Object.entries(changes)) {
      if (v === "" || v == null || (isInt(k) && !v)) delete r.fields[k]; else r.fields[k] = { value: v };
    }
    r.fields.modifiedAt = { value: now };
    if (saved && saved.recordChangeTag) r.recordChangeTag = saved.recordChangeTag;
  }

  async function saveMine(r, changes, done) {
    try {
      await updateLibraryCard(r, changes);
      toast(done);
      renderTeam();
      if (state.open === r) openDetail(r);
    } catch (err) {
      toast(err.message || errorText(err), true);
    }
  }

  function renderMineEdit(r) {
    const box = $("m-rating");
    box.replaceChildren();
    for (const v of ["hot", "warm", "cold"]) {
      const b = el("button", "rate " + v);
      b.type = "button";
      b.append(icon(v), el("span", null, RATINGS[v].label));
      b.setAttribute("aria-pressed", String(rating(r) === v));
      b.addEventListener("click", () => saveMine(r, { leadRating: rating(r) === v ? "" : v }, rating(r) === v ? "Rating cleared" : "Rated " + RATINGS[v].label));
      box.append(b);
    }
    const follow = $("m-follow");
    follow.replaceChildren();
    const info = LIB.reconnectInfo(r);
    const owed = LIB.followUpOwed(r);
    follow.hidden = !owed && !info;
    const line = (text, purpose, doneLabel, doneChange, doneToast) => {
      const row = el("div", "follow-line");
      row.append(el("span", "what", text));
      const btns = el("span", "btns");
      btns.append(...followButtons(r, purpose, doneLabel, doneChange, doneToast));
      row.append(btns);
      follow.append(row);
    };
    if (owed) line("You owe a follow-up since " + when(f(r, "followUpOwedAt")) + ".", "followUp", "Mark done", { followUpDoneAt: Date.now() }, "Follow-up marked done");
    else {
      const done = f(r, "followUpDoneAt");
      const row = el("div", "follow-line");
      if (done) row.append(el("span", "what", "Followed up on " + when(done) + ". To owe them another, use Owe again in the app."));
      else {
        row.append(el("span", "what", "No follow-up marked."));
        const b = el("button", "btn small");
        b.type = "button";
        b.append(el("span", null, "I owe a follow-up"));
        b.addEventListener("click", () => saveMine(r, { followUpOwedAt: Date.now() }, "Follow-up marked as owed"));
        const btns = el("span", "btns");
        btns.append(b);
        row.append(btns);
      }
      follow.append(row);
      follow.hidden = false;
    }
    if (info) {
      const due = LIB.reconnectDue(r);
      line("Keep in touch " + everyMonths(info.months) + " · " + (info.fromContact ? "last in touch " : "met ") + when(info.last) + " · " + (due ? "due now" : "next on " + when(info.dueOn)) + ".",
        "reconnect", "I was in touch", { lastContactAt: Date.now() }, "Marked as in touch today");
    }
    $("m-kit").value = String(f(r, "keepInTouchMonths") || 0);
    if (!$("m-kit").value) { const o = el("option", null, "Every " + f(r, "keepInTouchMonths") + " months"); o.value = String(f(r, "keepInTouchMonths")); $("m-kit").append(o); $("m-kit").value = o.value; }
    fillDetails(r);
    $("m-event").value = str(r, "eventTag");
    $("m-event-save").disabled = true;
    $("m-note").value = "";
    $("m-note-add").disabled = true;
  }
  // -- more fields (2026-10-06): the cadence and the details editor
  $("m-kit").addEventListener("change", () => {
    const r = state.open;
    if (!r || !r.personal) return;
    const n = Number($("m-kit").value) || 0;
    saveMine(r, { keepInTouchMonths: n }, n ? "Keep in touch " + everyMonths(n) : "Keep in touch turned off");
  });
  const DETAIL_FIELDS = [["m-title", "title"], ["m-company", "company"], ["m-industry", "industry"], ["m-website", "website"], ["m-linkedin", "linkedin"], ["m-wechat", "wechat"], ["m-notes", "notes"]];
  const normInterests = (text) => {
    const seen = new Set(), out = [];
    for (const t of text.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)) { const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(t); } }
    return out.join("\n");
  };
  function detailChanges(r) {
    const ch = {};
    for (const [id, k] of DETAIL_FIELDS) { const v = $(id).value.trim(); if (v !== str(r, k)) ch[k] = v; }
    const it = normInterests($("m-interests").value);
    if (it !== interests(r).join("\n")) ch.leadInterests = it;
    return ch;
  }
  function fillDetails(r) {
    for (const [id, k] of DETAIL_FIELDS) $(id).value = str(r, k);
    $("m-interests").value = interests(r).join("\n");
    const dl = $("m-industries");
    dl.replaceChildren();
    for (const v of [...new Set(state.team.records.map((x) => str(x, "industry")).filter(Boolean))].sort()) { const o = document.createElement("option"); o.value = v; dl.append(o); }
    $("m-details-save").disabled = true;
  }
  for (const [id] of DETAIL_FIELDS.concat([["m-interests"]])) {
    $(id).addEventListener("input", () => { $("m-details-save").disabled = !state.open || !Object.keys(detailChanges(state.open)).length; });
  }
  $("m-details-save").addEventListener("click", () => {
    const r = state.open;
    if (!r || !r.personal) return;
    const ch = detailChanges(r);
    if (!Object.keys(ch).length) return;
    $("m-details-save").disabled = true;
    saveMine(r, ch, "Saved — " + Object.keys(ch).length + (Object.keys(ch).length === 1 ? " field" : " fields") + " changed");
  });

  $("m-event").addEventListener("input", () => {
    $("m-event-save").disabled = !state.open || $("m-event").value.trim() === str(state.open, "eventTag");
  });
  $("m-event").addEventListener("keydown", (e) => { if (e.key === "Enter" && !$("m-event-save").disabled) { e.preventDefault(); $("m-event-save").click(); } });
  $("m-event-save").addEventListener("click", () => {
    const r = state.open;
    if (!r || !r.personal) return;
    const v = $("m-event").value.trim();
    $("m-event-save").disabled = true;
    saveMine(r, { eventTag: v }, v ? "Event saved" : "Event cleared");
  });
  $("m-note").addEventListener("input", () => { $("m-note-add").disabled = !$("m-note").value.trim(); });
  $("m-note-add").addEventListener("click", () => {
    const r = state.open;
    const line = $("m-note").value.trim().replace(/\s*\n\s*/g, " ");
    if (!r || !r.personal || !line) return;
    $("m-note-add").disabled = true;
    const before = str(r, "notes");
    const added = when(Date.now()) + " · " + line;
    saveMine(r, { notes: before ? before + "\n" + added : added }, "Note added");
  });

  // ----------------------------------------------- overview (2026-10-06)
  //
  // The apps' Stats, on the web: everything computed in the browser from
  // the cards shown (search and filters apply). One series per chart, in the
  // one accent colour, every bar labelled — the lead split too: Hot and Warm
  // are too close to tell apart by colour alone (checked with the dataviz
  // validator), so the labels carry the identity. A row is a button: it
  // filters to those cards and shows them.
  function countBy(list, get) {
    const m = new Map();
    for (const r of list) {
      const vals = [].concat(get(r)).map((v) => (v || "").trim()).filter(Boolean);
      for (const v of vals) { const k = fold(v); const c = m.get(k) || { label: v, n: 0 }; c.n++; m.set(k, c); }
    }
    return [...m.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  }
  function barPanel(title, rows, opts) {
    const o = opts || {};
    const panel = el("section", "ov-panel" + (o.wide ? " wide" : ""));
    const head = el("div", "ov-head");
    head.append(el("h2", null, title));
    if (o.note) head.append(el("span", "ov-note", o.note));
    panel.append(head);
    if (!rows.length) { panel.append(el("p", "ov-empty", o.empty || "Nothing yet")); return panel; }
    const max = Math.max(...rows.map((r) => r.n), 1);
    const shown = rows.slice(0, o.limit || 8);
    for (const r of shown) {
      const row = el(r.pick ? "button" : "div", "bar-row");
      if (r.pick) { row.type = "button"; row.title = plural(r.n, "card") + " — show them"; row.addEventListener("click", () => { r.pick(); setView("grid"); }); }
      row.append(el("span", "lbl", r.label));
      const track = el("span", "track");
      const fill = el("i");
      fill.style.width = Math.max(2, Math.round(100 * r.n / max)) + "%";
      track.append(fill);
      row.append(track, el("span", "val", String(r.n)));
      panel.append(row);
    }
    if (rows.length > shown.length) panel.append(el("p", "ov-more", "and " + (rows.length - shown.length) + " more"));
    return panel;
  }
  function monthPanel(list) {
    const panel = el("section", "ov-panel wide");
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push({ y: d.getFullYear(), m: d.getMonth(), n: 0 }); }
    for (const r of list) {
      const t = scannedAt(r); if (!t) continue;
      const d = new Date(t);
      const slot = months.find((x) => x.y === d.getFullYear() && x.m === d.getMonth());
      if (slot) slot.n++;
    }
    const total = months.reduce((a, b) => a + b.n, 0), max = Math.max(...months.map((x) => x.n), 1);
    const head = el("div", "ov-head");
    head.append(el("h2", null, "Cards added"), el("span", "ov-note", plural(total, "card") + " in the last 12 months"));
    panel.append(head);
    const cols = el("div", "cols");
    const fmt = new Intl.DateTimeFormat(undefined, { month: "short" });
    for (const x of months) {
      const c = el("div", "col");
      c.title = plural(x.n, "card") + " · " + new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(x.y, x.m, 1));
      const bar = el("div", "colbar");
      const fill = el("i", x.n ? null : "zero");
      fill.style.height = (x.n ? Math.max(4, Math.round(100 * x.n / max)) : 0) + "%";
      bar.append(fill);
      c.append(el("span", "cv", x.n ? String(x.n) : ""), bar, el("span", "cm", fmt.format(new Date(x.y, x.m, 1))));
      cols.append(c);
    }
    panel.append(cols);
    return panel;
  }
  function leadRows(list) {
    const rows = ["hot", "warm", "cold"].map((k) => ({ label: RATINGS[k].label, n: list.filter((r) => rating(r) === k).length, pick: () => setRating(k) })).filter((x) => x.n);
    const none = list.filter((r) => !rating(r)).length;
    if (none) rows.push({ label: "Not rated", n: none });
    return rows;
  }
  function renderOverview(list) {
    const box = $("overview");
    box.replaceChildren();
    if (!list.length) return;
    const personal = !!state.team.personal;
    box.append(monthPanel(list));
    box.append(barPanel("Lead rating", leadRows(list), { note: "how warm the leads are" }));
    if (personal) {
      const now = Date.now();
      const rows = [
        { label: "Follow-up owed", n: list.filter(LIB.followUpOwed).length, pick: () => setMFilter("owed") },
        { label: "Follow-up done", n: list.filter((r) => !!f(r, "followUpDoneAt")).length },
        { label: "Reconnect due", n: list.filter((r) => LIB.reconnectDue(r, now)).length, pick: () => setMFilter("reconnect") },
        { label: "Keeping in touch", n: list.filter((r) => !!LIB.reconnectInfo(r)).length }
      ].filter((x) => x.n);
      box.append(barPanel("Following up", rows, { empty: "No follow-ups or keep-in-touch set yet" }));
    } else {
      const claimed = list.filter((r) => str(r, "claimedBy")).length;
      box.append(barPanel("Claims", [{ label: "Unclaimed", n: list.length - claimed, pick: () => setFilter("open") }, { label: "Claimed", n: claimed, pick: () => setFilter("taken") }].filter((x) => x.n)));
      box.append(barPanel("Shared by", countBy(list, (r) => str(r, "scannedBy"))));
    }
    const pick = (setter) => (row) => Object.assign(row, { pick: () => setter(row.label) });
    box.append(barPanel("Countries", countBy(list, (r) => str(r, "country")).map(pick((v) => { state.country = v; $("country-filter").value = v; renderGrid(); }))));
    box.append(barPanel("Industries", countBy(list, (r) => str(r, "industry")).map(pick((v) => { state.industry = v; $("industry-filter").value = v; renderGrid(); }))));
    box.append(barPanel("Companies", countBy(list, (r) => str(r, "company")).map(pick((v) => { state.company = v; renderGrid(); }))));
    box.append(barPanel("Events", countBy(list, (r) => str(r, "eventTag")).map(pick((v) => { state.event = v; renderTeam(); }))));
  }
  // ------------------------------------------------ map (2026-10-06)
  //
  // My cards on Apple Maps (MapKit JS): a pin per card the apps placed —
  // they geocode the address at scan time, so the page only reads
  // latitude / longitude and sends no address anywhere. MapKit loads the
  // first time the Map view opens, never before, and only when config.js
  // carries a token. Apple then sees the map area being looked at, not
  // the cards: pins are drawn in the browser.
  const MAPKIT_URL = cfg.mapkitURL || "https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.core.js";
  const mapState = { loading: null, map: null, ids: "", failed: "" };
  const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function mapTokenExpiry() {
    try {
      const part = String(cfg.mapkitToken || "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const exp = JSON.parse(atob(part + "===".slice((part.length + 3) % 4))).exp;
      return typeof exp === "number" ? exp * 1000 : 0;
    } catch (e) { return 0; }
  }
  const mapOffered = () => !!cfg.mapkitToken && !!(state.team && state.team.personal);
  $("view-map").hidden = !cfg.mapkitToken;
  function hasPlace(r) { return typeof f(r, "latitude") === "number" && typeof f(r, "longitude") === "number"; }
  function loadMapKit() {
    if (mapState.loading) return mapState.loading;
    mapState.loading = new Promise((resolve, reject) => {
      const cb = "__cardlioMapKitReady";
      window[cb] = () => { delete window[cb]; resolve(window.mapkit); };
      const sc = document.createElement("script");
      sc.src = MAPKIT_URL;
      sc.crossOrigin = "anonymous";
      sc.async = true;
      sc.dataset.callback = cb;
      sc.dataset.libraries = "map,annotations";
      sc.dataset.initialToken = cfg.mapkitToken;
      sc.onerror = () => reject(new Error("MapKit did not load"));
      document.head.append(sc);
    }).then((mk) => {
      // "Unauthorized": the token expired or was revoked; the rest of the
      // page does not depend on it.
      mk.addEventListener("error", (e) => {
        const why = e && e.status;
        mapState.failed = why === "Too Many Requests" ? "Apple Maps is busy — try again in a minute."
          : "Apple Maps did not accept the map key (it may have expired). Everything else on this page works as usual.";
        if (state.view === "map") renderGrid();
        if (why === "Too Many Requests") setTimeout(() => { mapState.failed = ""; }, 60000);
      });
      return mk;
    });
    mapState.loading.catch(() => { mapState.loading = null; });
    return mapState.loading;
  }
  function mapProblem(text) {
    $("map").hidden = true;
    $("map-pick").hidden = true;
    $("map-note").textContent = text;
    $("map-view").classList.add("problem");
  }
  function renderMap(list) {
    $("map-view").classList.remove("problem");
    $("map-pick").hidden = true;
    const exp = mapTokenExpiry();
    if (!exp) return mapProblem("The map key in this page is not valid. Everything else works as usual.");
    if (exp < Date.now()) return mapProblem("The map key expired on " + new Date(exp).toLocaleDateString("en", { day: "numeric", month: "long", year: "numeric" }) + ". Everything else works as usual.");
    if (mapState.failed) return mapProblem(mapState.failed);
    $("map").hidden = false;
    const placed = list.filter(hasPlace);
    const missing = list.length - placed.length;
    $("map-note").textContent = !placed.length ? "None of these cards has a location yet. The apps place a card when Apple Maps finds its address."
      : missing ? plural(missing, "card") + " without a location — the apps place a card when Apple Maps finds its address." : "";
    loadMapKit().then((mk) => drawMap(mk, placed)).catch(() => mapProblem("Apple Maps could not be loaded. Check the connection and open the map again."));
  }
  function drawMap(mk, placed) {
    if (state.view !== "map" || $("map-view").hidden) return;
    const scheme = () => (darkQuery && darkQuery.matches ? mk.Map.ColorSchemes.Dark : mk.Map.ColorSchemes.Light);
    const accent = () => getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#4F46E5";
    let map = mapState.map;
    if (!map) {
      map = mapState.map = new mk.Map($("map"), {
        colorScheme: scheme(), showsPointsOfInterest: false, isRotationEnabled: false,
        showsCompass: mk.FeatureVisibility.Hidden, showsMapTypeControl: false
      });
      if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener("change", () => {
        map.colorScheme = scheme();
        for (const a of map.annotations) a.color = accent();
      });
      // A cluster shows its count; tapping it zooms in, unless every card
      // in it shares one address — then zooming cannot split it, so the
      // cards are listed under the map instead.
      map.annotationForCluster = (cluster) => {
        cluster.glyphText = String(cluster.memberAnnotations.length);
        cluster.color = accent();
        cluster.calloutEnabled = false;
        return cluster;
      };
      map.addEventListener("select", (e) => {
        const a = e.annotation;
        if (!a) return;
        setTimeout(() => { map.selectedAnnotation = null; }, 0);
        const members = a.memberAnnotations;
        if (members && members.length) {
          const c0 = members[0].coordinate;
          const oneSpot = members.every((m) => Math.abs(m.coordinate.latitude - c0.latitude) < 1e-4 && Math.abs(m.coordinate.longitude - c0.longitude) < 1e-4);
          if (oneSpot) showMapPick(members);
          else map.showItems(members, { animate: true, padding: new mk.Padding(70, 70, 70, 70) });
          return;
        }
        const r = a.data && state.team.records.find((x) => x.recordName === a.data.id);
        if (r) openDetail(r);
      });
      map.addEventListener("region-change-start", () => { $("map-pick").hidden = true; });
    }
    map.removeAnnotations(map.annotations);
    const anns = placed.map((r) => {
      const name = displayName(r), company = str(r, "company");
      return new mk.MarkerAnnotation(new mk.Coordinate(f(r, "latitude"), f(r, "longitude")), {
        title: name, subtitle: company && company !== name ? company : "",
        glyphText: initials(name), color: accent(), calloutEnabled: false,
        clusteringIdentifier: "cards", animates: false, data: { id: r.recordName }
      });
    });
    map.addAnnotations(anns);
    // Fit the pins when the set changes (a filter, a search) — not on
    // every poll, which would undo the user's own pan and zoom.
    const ids = placed.map((r) => r.recordName).sort().join("|");
    if (ids !== mapState.ids) {
      mapState.ids = ids;
      if (anns.length) map.showItems(anns, { animate: false, padding: new mk.Padding(60, 60, 60, 60) });
    }
  }
  function showMapPick(members) {
    const box = $("map-pick");
    box.replaceChildren(el("h3", null, plural(members.length, "card") + " at this address"));
    const ul = el("ul");
    for (const m of members) {
      const r = m.data && state.team.records.find((x) => x.recordName === m.data.id);
      if (!r) continue;
      const b = el("button", "map-pick-row"); b.type = "button";
      b.append(el("strong", null, displayName(r)));
      if (m.subtitle) b.append(el("span", null, m.subtitle));
      b.addEventListener("click", () => openDetail(r));
      const li = el("li"); li.append(b); ul.append(li);
    }
    box.append(ul);
    box.hidden = false;
  }
  if (cfg.testHooks) window.__cardlioMapState = () => ({ loaded: !!window.mapkit, ids: mapState.ids, failed: mapState.failed, pins: mapState.map ? mapState.map.annotations.length : 0, note: $("map-note").textContent });

  function setView(v) {
    state.view = v;
    storageSet("cardlio.team.view", v);
    for (const x of document.querySelectorAll(".view-toggle button")) x.setAttribute("aria-pressed", String(x.dataset.view === v));
    renderGrid();
  }

  // -------------------------------------------- event recap (2026-10-06)
  //
  // An event picked from the chips gets a short recap above its cards:
  // how many, when, how warm, what is owed or claimed, where from — with
  // Download and Print for the report after the fair.
  function recapFacts(list) {
    const personal = !!state.team.personal;
    const stamps = list.map(scannedAt).filter(Boolean);
    const span = stamps.length ? (() => { const a = when(Math.min(...stamps)), b = when(Math.max(...stamps)); return a === b ? a : a + " – " + b; })() : "";
    const leads = ["hot", "warm", "cold"].map((k) => [k, list.filter((r) => rating(r) === k).length]).filter(([, n]) => n);
    const facts = [plural(list.length, "card") + (span ? " · " + span : "")];
    if (leads.length) facts.push(leads.map(([k, n]) => n + " " + RATINGS[k].label.toLowerCase()).join(" · ") + (list.length - leads.reduce((a, [, n]) => a + n, 0) ? " · " + (list.length - leads.reduce((a, [, n]) => a + n, 0)) + " not rated" : ""));
    if (personal) {
      const owed = list.filter(LIB.followUpOwed).length, done = list.filter((r) => !!f(r, "followUpDoneAt")).length;
      if (owed || done) facts.push([owed ? owed + " follow-up" + (owed === 1 ? "" : "s") + " owed" : "", done ? done + " done" : ""].filter(Boolean).join(" · "));
    } else {
      const claimed = list.filter((r) => str(r, "claimedBy")).length;
      facts.push((list.length - claimed) + " unclaimed · " + claimed + " claimed");
    }
    const countries = countBy(list, (r) => str(r, "country"));
    if (countries.length) facts.push(countries.slice(0, 4).map((c) => c.label + " " + c.n).join(" · ") + (countries.length > 4 ? " · " + (countries.length - 4) + " more countries" : ""));
    const companies = countBy(list, (r) => str(r, "company")).length;
    if (companies) facts.push(plural(companies, "company") .replace("companys", "companies"));
    return facts;
  }
  function renderRecap(list, asStats) {
    const box = $("event-recap");
    box.replaceChildren();
    box.hidden = !state.event || asStats || !list.length;
    if (box.hidden) return;
    const head = el("div", "recap-head");
    head.append(el("h2", null, state.event));
    const btns = el("div", "recap-btns");
    const ov = el("button", "btn small"); ov.type = "button"; ov.append(el("span", null, "Overview")); ov.addEventListener("click", () => setView("stats"));
    const pr = el("button", "btn small"); pr.type = "button"; pr.append(el("span", null, "Print recap")); pr.addEventListener("click", () => { if (mayDownload()) printSheet(null, null); });
    const dl = el("button", "btn small"); dl.type = "button"; dl.append(icon("download"), el("span", null, "Download")); dl.addEventListener("click", () => { closePops(); if (mayDownload()) { $("export-btn").scrollIntoView({ block: "center" }); setMenu(true); } });
    btns.append(ov, pr, dl);
    head.append(btns);
    box.append(head);
    const ul = el("ul", "recap-facts");
    for (const t of recapFacts(list)) ul.append(el("li", null, t));
    box.append(ul);
  }

  // ------------------------------------ share My cards to a team (2026-10-06)
  //
  // A copy of each selected card's details becomes a TeamCard in the chosen
  // team (the same record the apps' Share with Team writes), without the
  // photo: a browser cannot upload an asset to iCloud (2026-09-21). Cards
  // the team already has (the duplicate rule) are skipped. My cards is not
  // touched.
  function teamFieldsFrom(r) {
    const out = {};
    const put = (k, v) => { if (v) out[k] = { value: v, type: "STRING" }; };
    put("firstName", str(r, "firstName")); put("lastName", str(r, "lastName"));
    put("title", str(r, "title")); put("company", str(r, "company"));
    put("phone", str(r, "phone")); put("mobile", str(r, "mobile")); put("website", str(r, "website"));
    put("street", [str(r, "building"), str(r, "street")].filter(Boolean).join(", "));
    put("unit", str(r, "unit")); put("postalCode", str(r, "postalCode")); put("city", str(r, "city")); put("country", str(r, "country"));
    put("eventTag", str(r, "eventTag")); put("leadRating", rating(r)); put("leadInterests", interests(r).join("\n"));
    const extra = [str(r, "notes"),
      str(r, "honorific") ? "Honorific: " + str(r, "honorific") : "",
      str(r, "fax") ? "Fax: " + str(r, "fax") : "",
      ...listOf(r, "additionalPhones").map((p) => "Phone: " + p),
      str(r, "linkedin") ? "LinkedIn: " + str(r, "linkedin") : "",
      str(r, "wechat") ? "WeChat: " + str(r, "wechat") : ""].filter(Boolean).join("\n");
    put("notes", extra);
    if (emails(r).length) out.emails = { value: emails(r), type: "STRING_LIST" };
    return out;
  }
  let shareCards = [];
  function openShare(cards) {
    const teams = state.teams.filter((t) => !t.personal);
    if (!teams.length) { toast("Join or create a team first — teams are created in the cardlio app", true); return; }
    shareCards = cards;
    const sel = $("sh-team");
    sel.replaceChildren();
    for (const t of teams) { const o = el("option", null, t.name + (t.owned ? "" : " (joined)")); o.value = t.id; sel.append(o); }
    const last = storageGet("cardlio.team.shareTo");
    if (teams.some((t) => t.id === last)) sel.value = last;
    $("sh-by").value = myName();
    $("sh-text").textContent = (cards.length === 1 ? displayName(cards[0]) : plural(cards.length, "card")) + " → a team.";
    $("sh-error").hidden = true;
    $("share-dialog").showModal();
  }
  $("sel-share").addEventListener("click", () => openShare(selectedRecords()));
  $("sh-cancel").addEventListener("click", () => $("share-dialog").close());
  $("share-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const team = state.teams.find((t) => t.id === $("sh-team").value);
    const by = $("sh-by").value.trim();
    if (!team || !by) return;
    storageSet(NAME_KEY, by);
    storageSet("cardlio.team.shareTo", team.id);
    $("sh-go").disabled = true;
    const known = new Set(team.records.flatMap(duplicateKeys));
    let added = 0, skipped = 0, failed = 0, firstError = "";
    for (const r of shareCards) {
      if (duplicateKeys(r).some((k) => known.has(k))) { skipped++; continue; }
      try {
        await createCard(teamFieldsFrom(r), by, null, team);
        duplicateKeys(r).forEach((k) => known.add(k));
        added++;
      } catch (err) { failed++; firstError = firstError || err.message || errorText(err); }
    }
    $("sh-go").disabled = false;
    $("share-dialog").close();
    renderTeamNav();
    const bits = [];
    if (added) bits.push("Shared " + plural(added, "card") + " to " + team.name);
    if (skipped) bits.push(plural(skipped, "card") + " the team already had");
    if (failed) bits.push(failed + " failed: " + firstError);
    toast(bits.join(" · ") || "Nothing to share", !!failed);
  });

  // ------------------------------------- follow up from anywhere (2026-10-06)
  //
  // The Today strip, the follow-up email (plain, or drafted with the
  // person's own Claude / Gemini key under the apps' drafting rules), a
  // calendar reminder as a file, and rating / tagging several cards at once.
  function everyMonths(m) { return m === 12 ? "every year" : m === 1 ? "every month" : "every " + m + " months"; }
  function followButtons(r, purpose, doneLabel, doneChange, doneToast) {
    const out = [];
    if (emails(r).length) {
      const m = el("button", "btn small");
      m.type = "button";
      m.append(icon("mail"), el("span", null, "Email"));
      m.addEventListener("click", () => openMail(r, purpose));
      out.push(m);
    }
    const rm = el("button", "btn small");
    rm.type = "button";
    rm.append(el("span", null, "Remind me"));
    rm.addEventListener("click", () => openRemind(r, purpose));
    out.push(rm);
    const d = el("button", "btn small");
    d.type = "button";
    d.append(icon("check"), el("span", null, doneLabel));
    d.addEventListener("click", () => saveMine(r, Object.assign({}, doneChange, Object.fromEntries(Object.keys(doneChange).map((k) => [k, Date.now()]))), doneToast));
    out.push(d);
    return out;
  }

  function renderToday() {
    const box = $("today"), lib = state.team;
    if (!lib || !lib.personal) { box.hidden = true; return; }
    const now = Date.now();
    const quiet = !state.query.trim() && !activeFilters().length && !state.event;
    const owed = lib.records.filter(LIB.followUpOwed).sort((a, b) => (f(a, "followUpOwedAt") || 0) - (f(b, "followUpOwedAt") || 0));
    const due = lib.records.filter((r) => LIB.reconnectDue(r, now)).sort((a, b) => LIB.reconnectInfo(a).dueOn - LIB.reconnectInfo(b).dueOn);
    box.hidden = !quiet || (!owed.length && !due.length);
    if (box.hidden) return;
    const col = (id, title, list, filter, sub, purpose, doneLabel, doneKey, doneToast) => {
      const c = $(id);
      c.replaceChildren();
      c.hidden = !list.length;
      if (!list.length) return;
      const head = el("div", "today-head");
      head.append(el("h2", null, title), el("span", "n", String(list.length)));
      if (list.length > 5) head.append(summaryLink("Show all", () => setMFilter(filter)));
      c.append(head);
      for (const r of list.slice(0, 5)) {
        const row = el("div", "today-row");
        const av = el("span", "av", cardInitials(r));
        av.style.background = `hsl(${personHue(displayName(r))} 55% 45%)`;
        const who = el("div", "who");
        const nm = el("button", "nm", displayName(r));
        nm.type = "button";
        nm.addEventListener("click", () => openDetail(r));
        who.append(nm, el("span", "sub", [fullName(r) ? str(r, "company") : "", sub(r)].filter(Boolean).join(" · ")));
        const btns = el("div", "btns");
        btns.append(...followButtons(r, purpose, doneLabel, { [doneKey]: now }, doneToast));
        row.append(av, who, btns);
        c.append(row);
      }
    };
    col("today-owed", "Follow-ups you owe", owed, "owed", (r) => "since " + when(f(r, "followUpOwedAt")), "followUp", "Done", "followUpDoneAt", "Follow-up marked done");
    col("today-due", "Time to reconnect", due, "reconnect", (r) => { const i = LIB.reconnectInfo(r); return everyMonths(i.months) + " · " + (i.fromContact ? "last in touch " : "met ") + when(i.last); },
      "reconnect", "In touch", "lastContactAt", "Marked as in touch today");
  }

  // -- the email
  function greetingFor(r) {
    const hon = str(r, "honorific"), first = str(r, "firstName"), last = str(r, "lastName");
    if (hon && last) return hon + " " + last;
    return first || fullName(r) || "";
  }
  function plainDraft(r, purpose) {
    const ev = str(r, "eventTag"), greet = greetingFor(r), sign = myName() || "[Your name]", co = str(r, "company");
    const hello = greet ? "Dear " + greet + ",\n\n" : "Hello,\n\n";
    if (purpose === "reconnect") {
      const i = LIB.reconnectInfo(r);
      const since = i && i.fromContact ? "since we last spoke" : ev ? "since we met at " + ev : "since we met";
      return { subject: "Catching up", body: hello + "It has been a while " + since + (co && fullName(r) ? ", and I hope all is well at " + co : "") + ". Would you have time for a short call in the coming weeks?\n\nBest regards,\n" + sign };
    }
    const its = interests(r);
    return { subject: ev ? "Good to meet you at " + ev : "Good to meet you",
      body: hello + "It was good to meet you" + (ev ? " at " + ev : "") + "." + (its.length ? " I would be glad to share more about " + (its.length > 1 ? its.slice(0, -1).join(", ") + " and " + its[its.length - 1] : its[0]) + "." : "") + " Let us stay in touch.\n\nBest regards,\n" + sign };
  }
  // The apps' drafting rules (FollowUpDraft.swift), for Claude / Gemini.
  const DRAFT_RULES = "You draft short follow-up emails after business meetings, based on a scanned business card and optional meeting notes.\n\nCRITICAL RULES:\n- Use ONLY the facts provided: the contact's details and the meeting notes. NEVER invent meeting circumstances, dates, commitments, or shared interests that are not in the notes.\n- If no meeting notes are provided, keep the body generic: it was good to meet, brief interest in staying in touch. Do not guess where or why they met.\n- Address the person naturally (first name unless an honorific like Dr. or Capt. is present — then honorific + family name).\n- Never include placeholders other than '[Your name]' when the sender name is missing.\n- No signatures beyond the sign-off line. No subject inside the body.\n\nAnswer with JSON only, no markdown: {\"subject\": \"...\", \"body\": \"...\"}. subject: short, specific, no quotes, no 'Re:'. body: greeting using the person's name, 2-4 short sentences, sign-off on its own line ending with the sender's name (or '[Your name]' if no sender name was given).";
  const TONES = { professional: ["Professional", "Business-formal but not stiff. Complete sentences."], warm: ["Warm", "Friendly and personable while staying professional."], brief: ["Brief", "As short as politeness allows — two sentences plus sign-off."] };
  function draftPrompt(r, purpose, tone) {
    const facts = [];
    if (displayName(r)) facts.push("Name: " + displayName(r));
    if (str(r, "honorific")) facts.push("Honorific: " + str(r, "honorific"));
    if (str(r, "title")) facts.push("Job title: " + str(r, "title"));
    if (str(r, "company")) facts.push("Company: " + str(r, "company"));
    const place = [str(r, "city"), str(r, "country")].filter(Boolean).join(", ");
    if (place) facts.push("Location: " + place);
    if (str(r, "eventTag")) facts.push("Met at: " + str(r, "eventTag"));
    if (interests(r).length) facts.push("They were interested in: " + interests(r).join(", "));
    const monthYear = (ms) => new Date(ms).toLocaleDateString("en", { month: "long", year: "numeric" });
    if (purpose === "reconnect") {
      const i = LIB.reconnectInfo(r);
      if (i) facts.push((i.fromContact ? "Last in touch: " : "First met: ") + monthYear(i.last));
    }
    const notes = str(r, "notes"), sender = myName();
    let p = "CONTACT:\n" + facts.join("\n") + "\n\nMEETING NOTES:\n" + (notes || "(none)");
    p += "\n\nSENDER NAME: " + (sender || "(unknown — use [Your name])");
    p += "\n\nTONE: " + TONES[tone][0] + " — " + TONES[tone][1];
    if (purpose === "reconnect") p += "\n\nPURPOSE: A friendly check-in with someone the sender met a while ago and has not been in touch with since the date above. Do NOT write as if the meeting just happened. Suggest catching up; never invent news, offers or plans.";
    return p;
  }
  async function draftWithAI(provider, key, prompt) {
    let res;
    if (provider === "claude") {
      res = await fetch(AI.claude.url, { method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model: AI.claude.model, max_tokens: 800, system: DRAFT_RULES, messages: [{ role: "user", content: prompt }] }) });
    } else {
      res = await fetch(AI.gemini.url, { method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], systemInstruction: { parts: [{ text: DRAFT_RULES }] },
          generationConfig: { responseMimeType: "application/json", maxOutputTokens: 2048 } }) });
    }
    if (!res.ok) {
      let detail = "";
      try { const j = await res.json(); detail = (j.error && (j.error.message || j.error.type)) || ""; } catch (e) { /* */ }
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error(AI[provider].label + " rejected the key" + (detail ? ": " + detail : "")), { badKey: true });
      throw new Error(AI[provider].label + " answered " + res.status + (detail ? ": " + detail : ""));
    }
    const j = await res.json();
    const text = provider === "claude" ? (j.content || []).map((b) => b.text || "").join("")
      : (((j.candidates || [])[0] || {}).content || { parts: [] }).parts.map((x) => x.text || "").join("");
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error(AI[provider].label + " returned no draft");
    const out = JSON.parse(text.slice(a, b + 1));
    if (typeof out.body !== "string" || !out.body.trim()) throw new Error(AI[provider].label + " returned no draft");
    return { subject: typeof out.subject === "string" ? out.subject.trim() : "", body: out.body.trim() };
  }
  let mailFor = null, mailPurpose = "followUp", mailTone = "professional";
  function openMail(r, purpose) {
    mailFor = r; mailPurpose = purpose;
    const to = $("e-to");
    to.replaceChildren();
    for (const e of emails(r)) { const o = el("option", null, e); o.value = e; to.append(o); }
    const d = plainDraft(r, purpose);
    $("e-subject").value = d.subject;
    $("e-body").value = d.body;
    $("e-title").textContent = (purpose === "reconnect" ? "Reconnect with " : "Follow up with ") + displayName(r);
    const p = aiProvider();
    $("e-draft").textContent = aiKey(p) ? "Draft with " + AI[p].label : "Draft with AI…";
    $("e-fine").textContent = "Draft with AI sends this person's name, title, company, city, event, interests and your notes on the card to " + AI[p].label + " under your own key — only when you press it. The email opens in your own mail app; nothing is sent from here.";
    const markable = purpose === "followUp" ? LIB.followUpOwed(r) : !!LIB.reconnectInfo(r);
    $("e-mark-label").hidden = !markable;
    $("e-mark-text").textContent = purpose === "followUp" ? "Mark the follow-up done" : "Mark as in touch today";
    $("e-mark").checked = true;
    $("e-error").hidden = true;
    $("mail-dialog").showModal();
    $("e-body").focus();
  }
  for (const b of document.querySelectorAll("#e-tone button")) {
    b.addEventListener("click", () => {
      mailTone = b.dataset.tone;
      for (const x of document.querySelectorAll("#e-tone button")) x.setAttribute("aria-pressed", String(x === b));
    });
  }
  async function runDraft() {
    const r = mailFor, p = aiProvider(), key = aiKey(p);
    if (!r) return;
    if (!key) { openKeys(() => { $("e-draft").textContent = "Draft with " + AI[aiProvider()].label; runDraft(); }); return; }
    $("e-draft").disabled = true;
    $("e-error").hidden = true;
    const label = $("e-draft").textContent;
    $("e-draft").textContent = "Drafting…";
    try {
      const d = await draftWithAI(p, key, draftPrompt(r, mailPurpose, mailTone));
      if (d.subject) $("e-subject").value = d.subject;
      $("e-body").value = d.body;
    } catch (err) {
      $("e-error").textContent = err.message || String(err);
      $("e-error").hidden = false;
      if (err.badKey) openKeys(() => runDraft());
    } finally {
      $("e-draft").disabled = false;
      $("e-draft").textContent = label;
    }
  }
  $("e-draft").addEventListener("click", runDraft);
  $("e-cancel").addEventListener("click", () => $("mail-dialog").close());
  $("e-copy").addEventListener("click", async () => {
    const text = ($("e-subject").value ? $("e-subject").value + "\n\n" : "") + $("e-body").value;
    try { await navigator.clipboard.writeText(text); toast("Copied"); } catch (e) { toast("Could not copy", true); }
  });
  $("mail-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const r = mailFor;
    if (!r) return;
    const to = $("e-to").value;
    const url = "mailto:" + encodeURIComponent(to).replace(/%40/g, "@") + "?subject=" + encodeURIComponent($("e-subject").value) + "&body=" + encodeURIComponent($("e-body").value);
    const a = document.createElement("a");
    a.href = url;
    document.body.append(a); a.click(); a.remove();
    $("mail-dialog").close();
    if (!$("e-mark-label").hidden && $("e-mark").checked) {
      if (mailPurpose === "followUp") saveMine(r, { followUpDoneAt: Date.now() }, "Follow-up marked done");
      else saveMine(r, { lastContactAt: Date.now() }, "Marked as in touch today");
    }
  });

  // -- the reminder, as a calendar file
  let remindFor = null, remindPurpose = "followUp";
  const ymd = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  function openRemind(r, purpose) {
    remindFor = r; remindPurpose = purpose;
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(0, 0, 0, 0);
    let day = tomorrow;
    if (purpose === "reconnect") { const i = LIB.reconnectInfo(r); if (i && i.dueOn > tomorrow.getTime()) day = new Date(i.dueOn); }
    $("r-date").value = ymd(day);
    $("r-time").value = "09:00";
    $("r-title").textContent = purpose === "reconnect" ? "Remind me to get back in touch" : "Remind me to follow up";
    const what = (purpose === "reconnect" ? "Reconnect with " : "Follow up with ") + displayName(r) + (fullName(r) && str(r, "company") ? " · " + str(r, "company") : "");
    $("r-text").textContent = /[.!?]$/.test(what) ? what : what + ".";
    $("remind-dialog").showModal();
  }
  function icsText(r, purpose, start) {
    const pad = (n) => String(n).padStart(2, "0");
    const local = (d) => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "T" + pad(d.getHours()) + pad(d.getMinutes()) + "00";
    const utc = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const esc = (t) => String(t).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
    const summary = (purpose === "reconnect" ? "Reconnect with " : "Follow up with ") + displayName(r) + (fullName(r) && str(r, "company") ? " (" + str(r, "company") + ")" : "");
    const desc = [[str(r, "title"), str(r, "company")].filter(Boolean).join(", "), emails(r)[0] ? "Email: " + emails(r)[0] : "",
      (str(r, "mobile") || str(r, "phone")) ? "Phone: " + (str(r, "mobile") || str(r, "phone")) : "", str(r, "eventTag") ? "Met at: " + str(r, "eventTag") : "",
      "Card: " + location.origin + location.pathname + "#" + new URLSearchParams({ team: MINE_ID, card: r.recordName }).toString()].filter(Boolean).join("\n");
    const uid = (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)) + "@team.cardlio.app";
    return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//cardlio//team.cardlio.app//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "BEGIN:VEVENT", "UID:" + uid, "DTSTAMP:" + utc(new Date()), "DTSTART:" + local(start), "DURATION:PT15M",
      "SUMMARY:" + esc(summary), "DESCRIPTION:" + esc(desc),
      "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc(summary), "TRIGGER:PT0M", "END:VALARM",
      "END:VEVENT", "END:VCALENDAR"].map(vFold).join("\r\n") + "\r\n";
  }
  $("r-cancel").addEventListener("click", () => $("remind-dialog").close());
  $("remind-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const r = remindFor;
    if (!r || !$("r-date").value) return;
    const [y, m, d] = $("r-date").value.split("-").map(Number);
    const [hh, mm] = ($("r-time").value || "09:00").split(":").map(Number);
    const start = new Date(y, m - 1, d, hh, mm);
    saveFile(fileSafe((remindPurpose === "reconnect" ? "Reconnect - " : "Follow up - ") + displayName(r)) + ".ics", "text/calendar;charset=utf-8", icsText(r, remindPurpose, start));
    $("remind-dialog").close();
    toast("Reminder downloaded — open it to add it to your calendar");
  });

  // -- several cards at once (My cards)
  async function bulkUpdate(changesFor, doneText) {
    const lib = state.team;
    if (!lib || !lib.personal) return;
    const cards = selectedRecords();
    let done = 0, failed = 0, step = 0;
    for (const r of cards) {
      step++;
      const ch = changesFor(r);
      if (!ch) continue;
      toast("Saving " + step + " of " + cards.length + "…");
      try { await updateLibraryCard(r, ch, true); done++; } catch (e) { failed++; }
    }
    if (failed) { try { await syncPersonal(lib, false); } catch (e) { /* best effort */ } }
    renderTeam();
    toast(doneText(done) + (failed ? " · " + plural(failed, "card") + " changed on a device meanwhile — check and try again" : ""), !!failed);
  }
  $("sel-rate").addEventListener("change", (e) => {
    const v = e.target.value;
    e.target.value = "";
    if (!v) return;
    const target = v === "clear" ? "" : v;
    bulkUpdate((r) => (rating(r) === target ? null : { leadRating: target }),
      (n) => (target ? "Rated " + plural(n, "card") + " " + RATINGS[target].label : "Cleared the rating on " + plural(n, "card")));
  });
  $("sel-event").addEventListener("click", () => {
    const lib = state.team;
    if (!lib || !lib.personal) return;
    const dl = $("be-events");
    dl.replaceChildren();
    for (const ev of [...new Set(lib.records.map((r) => str(r, "eventTag")).filter(Boolean))].sort()) { const o = document.createElement("option"); o.value = ev; dl.append(o); }
    $("be-text").textContent = plural(state.selected.size, "card") + " selected.";
    $("be-event").value = "";
    $("bulk-event-dialog").showModal();
    $("be-event").focus();
  });
  $("be-cancel").addEventListener("click", () => $("bulk-event-dialog").close());
  $("bulk-event-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("be-event").value.trim();
    $("bulk-event-dialog").close();
    bulkUpdate((r) => (str(r, "eventTag") === v ? null : { eventTag: v }),
      (n) => (v ? "Set the event on " + plural(n, "card") : "Cleared the event on " + plural(n, "card")));
  });

  function stepDetail(delta) {
    const r = state.open;
    if (!r || !state.team) return;
    const order = visibleRecords(), at = order.indexOf(r);
    if (at < 0 || order.length < 2) return;
    openDetail(order[(at + delta + order.length) % order.length]);
  }
  $("d-prev").addEventListener("click", () => stepDetail(-1));
  $("d-next").addEventListener("click", () => stepDetail(1));
  $("detail").addEventListener("keydown", (e) => {
    if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    e.preventDefault();
    stepDetail(e.key === "ArrowLeft" ? -1 : 1);
  });

  function renderDetailActions(r) {
    const actions = $("d-actions");
    actions.replaceChildren();
    if (r.personal) {
      const dl = el("button", "btn primary");
      dl.type = "button";
      dl.append(icon("download"), el("span", null, "Download vCard"));
      if (!downloadsAllowed()) dl.title = "Downloads come with the cardlio unlock";
      dl.addEventListener("click", () => { if (mayDownload()) downloadVCard([r], true); });
      const link = el("button", "btn");
      link.type = "button";
      link.append(el("span", null, "Copy link"));
      link.title = "A link to this card — it opens for you, signed in with this Apple Account";
      link.addEventListener("click", async () => {
        const url = location.origin + location.pathname + "#" + new URLSearchParams({ team: MINE_ID, card: r.recordName }).toString();
        try { await navigator.clipboard.writeText(url); toast("Link copied"); }
        catch (e) { toast(url); }
      });
      actions.append(dl);
      if (emails(r).length) {
        const w = el("button", "btn");
        w.type = "button";
        w.append(icon("mail"), el("span", null, "Write email"));
        w.addEventListener("click", () => openMail(r, LIB.followUpOwed(r) || !LIB.reconnectDue(r) ? "followUp" : "reconnect"));
        actions.append(w);
      }
      actions.append(link);
      if (state.teams.some((t) => !t.personal)) {
        const sh = el("button", "btn");
        sh.type = "button";
        sh.append(el("span", null, "Share to team"));
        sh.addEventListener("click", () => openShare([r]));
        actions.append(sh);
      }
      return;
    }
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
    if (canDelete(r)) {
      const del = el("button", "btn quiet");
      del.type = "button";
      del.append(el("span", null, "Delete"));
      del.title = state.team.owned ? "Remove this card from the team for everyone" : "Remove a card you added from the team for everyone";
      del.addEventListener("click", () => askDelete(r));
      actions.append(del);
    }
  }

  // DELETE a card from the team (2026-09-22). The apps have no per-card
  // delete (only the owner deletes a whole team), so this is the rule's
  // first surface: the team's OWNER may delete any card; a member only a
  // card they shared themselves (`scannedBy` = the name this browser claims
  // with — the same self-declared name Claim uses, nothing stronger exists
  // on the web). The record goes with its photo; claimed copies in people's
  // libraries are separate records and stay. Conflict-checked like an edit:
  // CloudKit refuses if the card changed since it loaded.
  const sharedByMe = (r) => { const n = myName(); return !!n && str(r, "scannedBy").localeCompare(n, undefined, { sensitivity: "base" }) === 0; };
  function canDelete(r) { return !!state.team && (state.team.owned || sharedByMe(r)); }

  function askDelete(r) {
    const who = [str(r, "firstName"), str(r, "lastName")].filter(Boolean).join(" ") || "This card";
    const co = str(r, "company");
    const claimedBy = str(r, "claimedBy");
    $("x-text").textContent = who + (co ? " · " + co : "") + (claimedBy ? " — claimed by " + claimedBy : "") + ".";
    $("delete-form").dataset.record = r.recordName;
    $("delete-dialog").showModal();
    $("x-cancel").focus();
  }
  $("x-cancel").addEventListener("click", () => $("delete-dialog").close());
  $("delete-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = state.team && state.team.records.find((x) => x.recordName === $("delete-form").dataset.record);
    if (!r) { $("delete-dialog").close(); return; }
    $("x-go").disabled = true;
    try {
      await deleteCard(r);
      toast("Deleted — the card is gone from the team");
    } catch (err) {
      toast(err.message || errorText(err), true);
    } finally {
      $("x-go").disabled = false;
      $("delete-dialog").close();
    }
  });

  async function deleteCard(r) {
    const team = state.team;
    const batch = team.db.newRecordsBatch({ zoneID: team.zoneID });
    batch.delete([{ recordType: r.recordType, recordName: r.recordName, recordChangeTag: r.recordChangeTag }]);
    const response = await batch.commit();
    if (response.hasErrors) {
      const err = response.errors[0];
      const code = err.ckErrorCode || err.serverErrorCode || "";
      if (/CONFLICT|ATOMIC/.test(code)) {
        await refreshTeam(team);
        throw new Error("Someone changed this card a moment ago. It has been reloaded; open it again to delete.");
      }
      if (/NOT_FOUND|UNKNOWN_ITEM/.test(code)) {
        // Already gone (deleted from an app meanwhile): treat as done.
      } else {
        throw new Error("Could not delete: " + errorText(err));
      }
    }
    team.records = team.records.filter((x) => x.recordName !== r.recordName);
    if (team.pendingRecords) team.pendingRecords = team.pendingRecords.filter((x) => x.recordName !== r.recordName);
    state.selected.delete(r.recordName);
    if (state.open === r) { state.open = null; $("detail").close(); }
    renderTeamNav();
    renderTeam();
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

  // The team's rating of the lead and its interest tags: each tap saves at
  // once, one field, conflict-checked like every other edit.
  function renderLead(r) {
    const box = $("d-rating");
    box.replaceChildren();
    for (const v of ["hot", "warm", "cold"]) {
      const b = el("button", "rate " + v);
      b.type = "button";
      b.append(icon(v), el("span", null, RATINGS[v].label));
      b.setAttribute("aria-pressed", String(rating(r) === v));
      b.addEventListener("click", () => saveLead(r, { leadRating: { value: rating(r) === v ? "" : v, type: "STRING" } }));
      box.append(b);
    }
    const tags = $("d-interests");
    tags.replaceChildren();
    for (const t of interests(r)) {
      const c = el("span", "tag", t);
      const x = el("button", null, "\u00d7");
      x.type = "button";
      x.setAttribute("aria-label", "Remove " + t);
      x.addEventListener("click", () => saveLead(r, { leadInterests: { value: interests(r).filter((i) => i !== t).join("\n"), type: "STRING" } }));
      c.append(x);
      tags.append(c);
    }
    // Offer the labels the team already uses, so "pricing" is not also "Pricing ".
    const mine = new Set(interests(r).map((i) => i.toLowerCase()));
    const known = interestList(state.team.records.flatMap(interests).join("\n")).filter((i) => !mine.has(i.toLowerCase()));
    const dl = $("interest-list");
    dl.replaceChildren();
    for (const k of known) { const o = document.createElement("option"); o.value = k; dl.append(o); }
  }
  async function saveLead(r, fields) {
    try {
      await updateCard(r, fields);
      if (state.open === r) renderLead(r);
      renderGrid();
    } catch (err) { toast(err.message || errorText(err), true); }
  }
  $("d-interest-add").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const r = state.open, t = e.target.value.trim();
    if (!r || !t) return;
    e.target.value = "";
    saveLead(r, { leadInterests: { value: interestList(interests(r).concat(t).join("\n")).join("\n"), type: "STRING" } });
  });

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
    for (const r of won) state.selected.delete(r.recordName);
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
    if (!team || polling || (!force && document.visibilityState !== "visible") || $("claim-dialog").open || $("delete-dialog").open) return;
    polling = true;
    if (team.personal) { try { await pollPersonal(team); } catch (e) { diag.pollErrors.push(new Date().toLocaleTimeString() + " " + errorText(e)); } finally { polling = false; } return; }
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
  // My cards: only the changes since the last read (the sync token), and
  // the unlock marker again — a purchase in the app shows up within a minute.
  async function pollPersonal(lib) {
    const { touched, added } = await syncPersonal(lib, true);
    const unlocked = await readUnlocked(lib.db);
    const unlockChanged = unlocked !== lib.unlocked;
    lib.unlocked = unlocked;
    if (state.team !== lib) return;
    if (added) {
      $("new-pill").textContent = plural(lib.pendingRecords.length, "new card") + " — show";
      $("new-pill").hidden = false;
    }
    if (touched || unlockChanged) {
      if (state.open && !lib.records.includes(state.open)) { state.open = null; $("detail").close(); }
      applyMode();
      renderTeamNav();
      renderTeam();
      if (state.open) renderDetailActions(state.open);
    }
  }

  $("new-pill").addEventListener("click", () => {
    const team = state.team;
    if (team && team.personal) {
      for (const card of team.pendingRecords || []) team.byName.set(card.recordName, card);
      team.pendingRecords = [];
      team.records = LIB.dedupe([...team.byName.values()]);
    } else if (team && team.pendingRecords) { team.records.push(...team.pendingRecords); team.pendingRecords = []; }
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
    if (url.startsWith("data:")) return url.slice(url.indexOf(",") + 1);   // a library thumbnail, already base64
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
  // The photo's bytes for the ZIP: a data: URL is decoded here (the page's
  // CSP does not let fetch() read one), anything else is downloaded.
  async function photoBytes(url) {
    if (url.startsWith("data:")) {
      const bin = atob(url.slice(url.indexOf(",") + 1));
      const a = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
      return a;
    }
    const res = await fetch(url);
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
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
    for (const p of listOf(r, "additionalPhones")) L.push("TEL;TYPE=VOICE:" + vEsc(p));
    if (str(r, "fax")) L.push("TEL;TYPE=WORK,FAX:" + vEsc(str(r, "fax")));
    const url = safeWebURL(str(r, "website"));
    if (url) L.push("URL:" + vEsc(url));
    if (addressLines(r).length) {
      const street = [str(r, "building"), str(r, "street")].filter(Boolean).join(", ");
      L.push("ADR;TYPE=WORK:" + ["", str(r, "unit"), street, str(r, "city"), "", str(r, "postalCode"), str(r, "country")].map(vEsc).join(";"));
    }
    const note = [str(r, "notes"), str(r, "eventTag") ? "Event: " + str(r, "eventTag") : "",
      r.personal ? "" : "From the cardlio team \"" + state.team.name + "\"" + (str(r, "scannedBy") ? ", shared by " + str(r, "scannedBy") : "")]
      .filter(Boolean).join("\n");
    if (note) L.push("NOTE:" + vEsc(note));
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
  async function downloadZip(records) {
    const z = await exportZip(records);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(z.blob); a.download = fileSafe(state.team.name) + ".zip";
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function downloadCSV(records) {
    saveFile(fileSafe(state.team.name) + ".csv", "text/csv;charset=utf-8", csvText(records));
  }
  function csvText(records) {
    if (state.team && state.team.personal) return csvMine(records);
    const head = ["First name", "Last name", "Title", "Company", "Emails", "Phone", "Mobile", "Website",
      "Street", "Unit", "Postal code", "City", "Country", "Event", "Rating", "Interests", "Notes", "Team notes", "Shared by", "Shared on", "Claimed by"];
    const rows = records.map((r) => [str(r, "firstName"), str(r, "lastName"), str(r, "title"), str(r, "company"),
      emails(r).join("; "), str(r, "phone"), str(r, "mobile"), str(r, "website"), str(r, "street"), str(r, "unit"),
      str(r, "postalCode"), str(r, "city"), str(r, "country"), str(r, "eventTag"),
      rating(r) ? RATINGS[rating(r)].label : "", interests(r).join("; "), str(r, "notes"), str(r, "teamNotes"), str(r, "scannedBy"),
      scannedAt(r) ? new Date(scannedAt(r)).toISOString().slice(0, 10) : "", str(r, "claimedBy")]);
    return "\ufeff" + [head, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }

  // My cards: the library's own columns (no team, no claims).
  function csvMine(records) {
    const day = (r, k) => (f(r, k) ? new Date(f(r, k)).toISOString().slice(0, 10) : "");
    const head = ["Honorific", "First name", "Last name", "Title", "Company", "Industry", "Emails", "Phone", "Mobile", "Fax", "Other phones",
      "Website", "LinkedIn", "WeChat", "Building", "Street", "Unit", "Postal code", "City", "Country", "Event", "Rating", "Interests",
      "Follow-up owed", "Follow-up done", "Keep in touch (months)", "Notes", "Added"];
    const rows = records.map((r) => [str(r, "honorific"), str(r, "firstName"), str(r, "lastName"), str(r, "title"), str(r, "company"),
      str(r, "industry"), emails(r).join("; "), str(r, "phone"), str(r, "mobile"), str(r, "fax"), listOf(r, "additionalPhones").join(" / "),   // "/" keeps the formula guard quiet on "+…"
      str(r, "website"), str(r, "linkedin"), str(r, "wechat"), str(r, "building"), str(r, "street"), str(r, "unit"), str(r, "postalCode"),
      str(r, "city"), str(r, "country"), str(r, "eventTag"), rating(r) ? RATINGS[rating(r)].label : "", interests(r).join("; "),
      day(r, "followUpOwedAt"), day(r, "followUpDoneAt"), f(r, "keepInTouchMonths") || "", str(r, "notes"), day(r, "addedAt")]);
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
    "street", "unit", "postalCode", "city", "country", "eventTag", "notes", "leadRating", "leadInterests"];
  let editing = null;
  let formPhoto = null;   // a Blob read from a card photo, saved with the new card
  function openCardForm(r, prefill) {
    editing = r || null;
    const form = $("card-form");
    form.reset();
    $("f-error").hidden = true;
    formPhoto = null;
    $("f-scan").hidden = true;
    if (prefill) {
      for (const k of FORM_FIELDS) if (prefill.fields[k] != null) form.elements[k].value = prefill.fields[k];
      if (prefill.preview) {
        // The photo is shown for checking the fields and NOT saved: the
        // apps share a cropped, straightened card image; a raw phone photo
        // with the table around it is not one (owner, 2026-09-21).
        $("f-photo").src = URL.createObjectURL(prefill.preview);
        $("f-scan-title").textContent = "Read by " + prefill.engine;
        $("f-scan").hidden = false;
      }
    }
    $("f-title").textContent = r ? "Edit card" : "Add a card";
    $("f-text").textContent = r
      ? "Changes the card for the whole team. Copies colleagues already claimed into their own libraries stay as they are."
      : "Someone you met without a card to scan. The team sees it like any shared card.";
    $("f-go").textContent = r ? "Save" : "Add to team";
    $("f-by-label").hidden = !!r;
    if (r) for (const k of FORM_FIELDS) {
      form.elements[k].value = k === "emails" ? emails(r).join(", ") : k === "leadRating" ? rating(r) : k === "leadInterests" ? interests(r).join(", ") : str(r, k);
    }
    else form.elements.scannedBy.value = myName();
    if (prefill && !form.elements.eventTag.value && state.event) form.elements.eventTag.value = state.event;
    $("card-dialog").showModal();
    form.elements.firstName.focus();
  }
  $("f-scan-drop").addEventListener("click", () => { $("f-scan").hidden = true; });
  $("add-card").addEventListener("click", () => openCardForm(null));
  $("f-cancel").addEventListener("click", () => $("card-dialog").close());
  $("card-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = $("card-form");
    const v = (k) => form.elements[k].value.trim();
    const fields = {};
    for (const k of FORM_FIELDS) {
      if (k === "emails") fields.emails = { value: v("emails").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean), type: "STRING_LIST" };
      else if (k === "leadInterests") fields[k] = { value: interestList(v(k).split(/[,;\n]/).join("\n")).join("\n"), type: "STRING" };
      else fields[k] = { value: v(k), type: "STRING" };
    }
    // Like the apps: a new card carries the lead fields only when they are set.
    if (!editing) for (const k of ["leadRating", "leadInterests"]) if (!fields[k].value) delete fields[k];
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
        const made = await createCard(fields, by, formPhoto);
        if (formPhoto && !made.photoSaved) toast("Added to " + state.team.name + " — without the photo. Upload failed: " + made.photoError, true, "upload URL: " + lastUploadURL + "\nstatus: " + (lastUploadStatus || "none") + "\nerror: " + made.photoError + "\nUA: " + navigator.userAgent);
        else toast("Added to " + state.team.name);
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
  async function createCard(fields, by, photo, target) {
    const team = target || state.team;
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
    let photoError = "";
    if (photo) {
      const withPhoto = { recordType: "TeamCard", recordName: id, fields: Object.assign({}, record.fields, { photo: { value: photo } }) };
      // The asset upload is the one iCloud call that can THROW (a blocked
      // host, a dropped connection) rather than answer with errors — the
      // card must still land, without its photo, and say why.
      try {
        response = await team.db.saveRecords([withPhoto], { zoneID: team.zoneID });
        photoSaved = !response.hasErrors;
        if (response.hasErrors) photoError = errorText(response.errors[0]);
      } catch (err) {
        response = { hasErrors: true };
        photoError = (err && (err.reason || err.message)) || String(err);
        if (uploadWhere()) photoError += " · upload: " + uploadWhere();
        if (lastCSPBlock) photoError += " (the browser blocked " + lastCSPBlock + ")";
        console.warn("[cardlio] photo upload failed", err, lastCSPBlock);
      }
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
    return { record: local, photoSaved: !!photo && photoSaved, photoError };
  }
  // CloudKit JS posts the asset bytes with an XMLHttpRequest to a URL
  // Apple hands back; a failure there is reported as a bare NETWORK_ERROR.
  // Remember the last non-API URL opened and its final status so the
  // message can name the host (the upload host is not documented).
  let lastUploadURL = "", lastUploadStatus = "";
  (function () {
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      const u = String(url);
      // Everything but the ordinary API calls (records/…, zones/…, users/…,
      // and the assets/upload token request itself).
      if (/^https?:/.test(u) && !/\/database\/1\/.*\/(records|zones|users|subscriptions|assets\/upload|assets\/rereference)\b/.test(u)) {
        lastUploadURL = u; lastUploadStatus = "";
        this.addEventListener("loadend", () => { lastUploadStatus = this.status + (this.status === 0 ? " (blocked before a response — CORS or a policy)" : ""); });
        this.addEventListener("error", () => { console.warn("[cardlio] upload XHR error", u); });
      }
      return open.apply(this, arguments);
    };
  })();
  function uploadWhere() {
    if (!lastUploadURL) return "";
    try { const u = new URL(lastUploadURL); return u.host + u.pathname.slice(0, 24) + "… → " + (lastUploadStatus || "no response"); } catch (e) { return lastUploadURL.slice(0, 60); }
  }
  // A Content-Security-Policy block looks like a network failure to
  // CloudKit JS; remember the host so the message can name it.
  let lastCSPBlock = "";
  document.addEventListener("securitypolicyviolation", (e) => {
    lastCSPBlock = e.blockedURI || e.violatedDirective;
    console.warn("[cardlio] CSP blocked", e.blockedURI, e.violatedDirective);
  });

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
    const photos = files.filter((f) => /^image\//.test(f.type));
    for (const file of files) {
      if (photos.includes(file)) continue;
      if (!/\.vcf$/i.test(file.name) && !/vcard/i.test(file.type)) { toast(file.name + " is not a vCard or image file", true); continue; }
      parsed.push(...parseVCards(await file.text()));
    }
    if (photos.length) scanPhotos(photos);
    if (!parsed.length) return;
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

  // ------------------------------------------- read a card photo (BYOK)
  //
  // The same call the apps make for "Refine with Claude / Gemini": the
  // photo, downscaled to 1600 px, and the apps' own extraction prompt —
  // one prompt, two clients, the same fields back. The member's own key
  // (Anthropic allows a browser call with an explicit header; Gemini with
  // a key restricted to this site) lives in this browser only. The
  // fields pre-fill the Add card form for a check; the photo is saved as
  // the record's asset exactly like a vCard photo.
  const AI = {
    prompt: "You extract structured contact details from the photo of a single business card. When two photos are given they are the FRONT and the BACK of the same card — read both; the address, phone or e-mail is often printed on the back only.\n\nReturn ONLY valid JSON matching this schema exactly. No markdown, no commentary.\n{\n  \"firstName\": \"\",\n  \"lastName\": \"\",\n  \"honorific\": \"\",\n  \"title\": \"\",\n  \"company\": \"\",\n  \"emails\": [],\n  \"phone\": \"\",\n  \"mobile\": \"\",\n  \"fax\": \"\",\n  \"website\": \"\",\n  \"building\": \"\",\n  \"street\": \"\",\n  \"unit\": \"\",\n  \"postalCode\": \"\",\n  \"city\": \"\",\n  \"country\": \"\",\n  \"isoCountryCode\": \"\"\n}\n\nRules:\n- Use empty strings (or empty array) for fields not on the card.\n- emails: ALL email addresses on the card, primary first.\n- phone / mobile / fax: pick the labeled one. Unlabeled numbers go in phone unless one is clearly a cell.\n- building: building / development name (e.g. \"The Concourse\", \"Marina Bay Financial Centre Tower 1\"). Empty if none.\n- unit: level + unit / suite / floor (\"#08-15\", \"Suite 1500\", \"Apt 4B\"). Empty if none.\n- street: street address line (e.g. \"300 Beach Road\").\n- city: locality. For city-states, the city IS the country (Singapore → city \"Singapore\").\n- country: full English country name (\"Singapore\", \"United Kingdom\", \"Germany\").\n- isoCountryCode: ISO 3166-1 alpha-2 (\"SG\", \"GB\", \"DE\").\n- GENDER honorifics (\"Mr.\", \"Mrs.\", \"Ms.\", \"Miss\", \"Herr\", \"Frau\") are NOT part of the name and should be DROPPED entirely. Do NOT put them in `honorific`.\n- ACADEMIC and PROFESSIONAL honorifics / ranks — \"Dr.\", \"Dr.-Ing.\", \"PhD\", \"Ph.D.\", \"Prof.\", \"Professor\", \"Capt.\", \"Captain\", \"Lt.\", \"Col.\", \"Chief Engineer\", \"Chief Officer\", \"Ing.\", \"Rev.\", \"Sister\" — go into the `honorific` field, NOT into firstName / lastName. If the card prints \"Capt. N. P. Singh\", set honorific=\"Capt.\", firstName=\"N. P.\", lastName=\"Singh\". Multiple credentials combine with spaces (\"Dr. PhD\").\n- For \"James P. Smith\" → firstName \"James P.\", lastName \"Smith\".\n- European particles (\"van der Berg\", \"de la Cruz\") stay with lastName.\n- If the card has the name in BOTH Latin and a non-Latin script, prefer the Latin version.\n- Do not invent values. An empty string is safer than wrong.\n- Output JSON only.\nAddress conventions — follow these exactly:\n- city: the city name ALONE. Never include a prefecture, province, state or region, and drop a \"-shi\" or \"-City\" suffix from the city name.\n- postalCode: the code itself only. If the code is printed with a country letter prefix before a dash, omit that prefix and the dash.",
    claude: { model: "claude-sonnet-4-6", url: "https://api.anthropic.com/v1/messages", label: "Claude", console: "console.anthropic.com" },
    gemini: { model: "gemini-2.5-flash", url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", label: "Gemini", console: "aistudio.google.com" }
  };
  const KEY_KEYS = { claude: "cardlio.team.key.claude", gemini: "cardlio.team.key.gemini" };
  function sessionGet(k) { try { return sessionStorage.getItem(k) || ""; } catch (e) { return ""; } }
  function sessionSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function aiKey(p) { return sessionGet(KEY_KEYS[p]) || storageGet(KEY_KEYS[p]); }
  function aiProvider() { const p = storageGet("cardlio.team.ai"); return p === "gemini" ? "gemini" : "claude"; }
  function setKeyForm(p) {
    for (const b of document.querySelectorAll("#k-provider button")) b.setAttribute("aria-pressed", String(b.dataset.provider === p));
    $("k-claude-label").hidden = p !== "claude";
    $("k-gemini-label").hidden = p !== "gemini";
    $("k-fine").textContent = "Get a key at " + AI[p].console + ". A card costs about a cent." + (p === "gemini" ? " Restrict the key to this site (HTTP referrer team.cardlio.app) in Google AI Studio." : "");
  }
  let keysThen = null;   // what to do once a key is saved (a scan that was waiting)
  function openKeys(then) {
    keysThen = then || null;
    const p = aiProvider();
    setKeyForm(p);
    $("k-claude").value = aiKey("claude");
    $("k-gemini").value = aiKey("gemini");
    $("k-remember").checked = !!(storageGet(KEY_KEYS.claude) || storageGet(KEY_KEYS.gemini));
    $("k-forget").hidden = !(aiKey("claude") || aiKey("gemini"));
    $("k-error").hidden = true;
    $("keys-dialog").showModal();
    $(p === "gemini" ? "k-gemini" : "k-claude").focus();
  }
  for (const b of document.querySelectorAll("#k-provider button")) b.addEventListener("click", () => { storageSet("cardlio.team.ai", b.dataset.provider); setKeyForm(b.dataset.provider); });
  $("ai-keys").addEventListener("click", () => openKeys(null));
  $("k-cancel").addEventListener("click", () => { keysThen = null; $("keys-dialog").close(); });
  $("k-forget").addEventListener("click", () => {
    for (const k of Object.values(KEY_KEYS)) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) { /* */ } }
    $("k-claude").value = ""; $("k-gemini").value = ""; $("k-forget").hidden = true;
    toast("Keys forgotten");
  });
  $("keys-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const p = aiProvider();
    const claude = $("k-claude").value.trim(), gemini = $("k-gemini").value.trim();
    if (!(p === "claude" ? claude : gemini)) { $("k-error").textContent = "Paste the " + AI[p].label + " key first."; $("k-error").hidden = false; return; }
    const remember = $("k-remember").checked;
    for (const [prov, val] of [["claude", claude], ["gemini", gemini]]) {
      try { localStorage.removeItem(KEY_KEYS[prov]); sessionStorage.removeItem(KEY_KEYS[prov]); } catch (err) { /* */ }
      if (val) (remember ? storageSet : sessionSet)(KEY_KEYS[prov], val);
    }
    $("keys-dialog").close();
    const then = keysThen; keysThen = null;
    if (then) then();
  });

  // Downscale to 1600 px on the long side, JPEG 0.85, upright per EXIF —
  // what the apps send. Claude refuses images past 5 MB; a phone photo
  // is 8–12 MB raw.
  async function downscaledJPEG(file, maxDim) {
    let bitmap;
    try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch (e) { bitmap = await createImageBitmap(file); }
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    bitmap.close && bitmap.close();
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    if (!blob) throw new Error("Could not read that image");
    return blob;
  }
  function base64Of(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = () => rej(new Error("Could not read that image")); r.readAsDataURL(blob); });
  }
  async function readCardWith(provider, key, jpeg, signal) {
    const b64 = await base64Of(jpeg);
    let res;
    if (provider === "claude") {
      res = await fetch(AI.claude.url, {
        method: "POST", signal,
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model: AI.claude.model, max_tokens: 1024,
          system: [{ type: "text", text: AI.prompt, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
            { type: "text", text: "Extract the structured contact fields from this business card." }
          ] }]
        })
      });
    } else {
      res = await fetch(AI.gemini.url, {
        method: "POST", signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ parts: [
            { inline_data: { mime_type: "image/jpeg", data: b64 } },
            { text: "Extract the structured contact fields from this business card." }
          ] }],
          systemInstruction: { parts: [{ text: AI.prompt }] },
          generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192 }
        })
      });
    }
    if (!res.ok) {
      let detail = "";
      try { const j = await res.json(); detail = (j.error && (j.error.message || j.error.type)) || ""; } catch (e) { /* */ }
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error(AI[provider].label + " rejected the key" + (detail ? ": " + detail : "")), { badKey: true });
      if (res.status === 429) throw new Error(AI[provider].label + " is rate-limiting — try again in a minute");
      throw new Error(AI[provider].label + " answered " + res.status + (detail ? ": " + detail : ""));
    }
    const j = await res.json();
    let text = "";
    if (provider === "claude") text = ((j.content || []).map((b) => b.text || "")).join("");
    else text = (((j.candidates || [])[0] || {}).content || { parts: [] }).parts.map((p) => p.text || "").join("");
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error(AI[provider].label + " returned no fields");
    return JSON.parse(text.slice(a, b + 1));
  }
  // The model's schema → the form (a TeamCard has no honorific, fax or
  // building: building joins the street line, fax and honorific go to the
  // notes, as the vCard import does with extra numbers).
  function formFieldsFrom(m) {
    const s = (k) => (typeof m[k] === "string" ? m[k].trim() : "");
    const f = {
      firstName: s("firstName"), lastName: s("lastName"), title: s("title"), company: s("company"),
      emails: (Array.isArray(m.emails) ? m.emails : []).map((e) => String(e).trim()).filter(Boolean).join(", "),
      phone: s("phone"), mobile: s("mobile"), website: s("website"),
      street: [s("building"), s("street")].filter(Boolean).join(", "),
      unit: s("unit"), postalCode: s("postalCode"), city: s("city"), country: s("country")
    };
    const notes = [];
    if (s("honorific")) notes.push(s("honorific"));
    if (s("fax")) notes.push("Fax: " + s("fax"));
    if (notes.length) f.notes = notes.join("\n");
    return f;
  }
  let scanQueue = [], scanning = false, scanAbort = null;
  function scanPhotos(files) {
    if (!state.team) { toast("Open a team first", true); return; }
    scanQueue.push(...files);
    if (!scanning) nextScan();
  }
  async function nextScan() {
    const file = scanQueue.shift();
    if (!file) { scanning = false; return; }
    scanning = true;
    const provider = aiProvider();
    if (!aiKey(provider)) { scanQueue.unshift(file); scanning = false; openKeys(() => nextScan()); return; }
    let jpeg;
    try { jpeg = await downscaledJPEG(file, 1600); }
    catch (err) { toast(err.message, true); return nextScan(); }
    $("s-photo").src = URL.createObjectURL(jpeg);
    $("s-text").textContent = "Reading the card with " + AI[provider].label + "…" + (scanQueue.length ? " (" + scanQueue.length + " more waiting)" : "");
    if (!$("scan-dialog").open) $("scan-dialog").showModal();
    scanAbort = new AbortController();
    try {
      const m = await readCardWith(provider, aiKey(provider), jpeg, scanAbort.signal);
      $("scan-dialog").close();
      openCardForm(null, { fields: formFieldsFrom(m), preview: jpeg, engine: AI[provider].label });
      // The next photo waits until this form is closed.
      $("card-dialog").addEventListener("close", () => nextScan(), { once: true });
    } catch (err) {
      $("scan-dialog").close();
      if (err.name === "AbortError") { scanQueue = []; scanning = false; return; }
      if (err.badKey) { scanQueue.unshift(file); scanning = false; toast(err.message, true); openKeys(() => nextScan()); return; }
      if (err instanceof TypeError) toast("Could not reach " + AI[provider].label + " — offline, or the browser blocked the call", true);
      else toast(err.message, true);
      nextScan();
    }
  }
  $("s-cancel").addEventListener("click", () => { if (scanAbort) scanAbort.abort(); $("scan-dialog").close(); });
  $("scan-photo").addEventListener("click", () => $("photo-file").click());
  $("photo-file").addEventListener("change", (e) => { scanPhotos([...e.target.files]); e.target.value = ""; });
  // On a phone the same input offers the camera or the photo library.
  $("mb-scan").addEventListener("click", () => $("photo-file").click());
  if (cfg.testHooks) { window.__cardlioScan = (files) => scanPhotos(files); window.__cardlioReadCard = readCardWith; }

  // Drop anywhere on the page while signed in.
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  const readOnlyView = () => !!(state.team && state.team.personal);
  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e) || $("app").hidden || readOnlyView()) return;
    e.preventDefault();
    dragDepth++;
    $("drop-into").textContent = (state.team ? "into " + state.team.name : "") + " — a .vcf file, or a photo of a card";
    $("drop-hint").hidden = false;
  });
  document.addEventListener("dragover", (e) => { if (hasFiles(e) && !$("app").hidden) { e.preventDefault(); e.dataTransfer.dropEffect = readOnlyView() ? "none" : "copy"; } });
  document.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("drop-hint").hidden = true; });
  document.addEventListener("drop", async (e) => {
    if (!hasFiles(e) || $("app").hidden) return;
    e.preventDefault();
    dragDepth = 0;
    $("drop-hint").hidden = true;
    if (readOnlyView()) { toast("Cards are added to your library in the cardlio app — or open a team to add them there", true); return; }
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
        const data = await photoBytes(url);
        if (!data) continue;
        let name = fileSafe(displayName(r));
        const n = (seen.get(name) || 0) + 1; seen.set(name, n);
        if (n > 1) name += " " + n;
        entries.push({ name: "photos/" + name + ".jpg", data });
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

  // ---- search suggestions (the apps' search tokens) ----
  function suggestionsFor(text) {
    const q = fold(text.trim());
    if (!q || !state.team) return [];
    const now = Date.now();
    const base = state.team.records.filter((r) => passesFilters(r, now));
    const out = [];
    if (state.team.personal) {
      if (state.mfilter !== "owed" && "follow up owed followup".includes(q) && base.some(LIB.followUpOwed)) out.push({ kind: "Follow-up", value: "Owed", apply: () => setMFilter("owed") });
      if (state.mfilter !== "reconnect" && "reconnect keep in touch due".includes(q) && base.some((r) => LIB.reconnectDue(r, now))) out.push({ kind: "Keep in touch", value: "Due", apply: () => setMFilter("reconnect") });
    }
    for (const k of ["hot", "warm", "cold"]) {
      if ((k.startsWith(q) || "lead".startsWith(q) || q.startsWith("lead")) && state.rating !== k && base.some((r) => rating(r) === k)) {
        out.push({ kind: "Lead", value: RATINGS[k].label, apply: () => setRating(k) });
      }
    }
    // Field values that contain the text, most frequent first, three of each kind.
    const top = (values, kind, current, apply) => {
      const counts = new Map();
      for (const raw of values) {
        const v = (raw || "").trim();
        if (!v || !fold(v).includes(q) || (current && same(v, current))) continue;
        const key = fold(v);
        const c = counts.get(key) || { value: v, count: 0 };
        c.count++;
        counts.set(key, c);
      }
      [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 3)
        .forEach((c) => out.push({ kind, value: c.value, count: c.count, apply: () => apply(c.value) }));
    };
    top(base.flatMap(interests), "Interest", state.interest, (v) => { state.interest = v; renderGrid(); });
    top(base.map((r) => str(r, "country")), "Country", state.country, (v) => { state.country = v; $("country-filter").value = v; renderGrid(); });
    top(base.map((r) => str(r, "company")), "Company", state.company, (v) => { state.company = v; renderGrid(); });
    top(base.map((r) => str(r, "industry")), "Industry", state.industry, (v) => { state.industry = v; $("industry-filter").value = v; renderGrid(); });
    top(base.map((r) => str(r, "eventTag")), "Event", state.event, (v) => { state.event = v; renderTeam(); });
    return out;
  }
  let suggest = [], suggestAt = -1;
  function renderSuggest() {
    const box = $("search-suggest"), input = $("search");
    suggest = suggestionsFor(input.value).slice(0, 12);
    if (suggestAt >= suggest.length) suggestAt = -1;
    box.replaceChildren();
    box.hidden = !suggest.length;
    input.setAttribute("aria-expanded", String(!!suggest.length));
    input.removeAttribute("aria-activedescendant");
    suggest.forEach((sg, i) => {
      const o = el("div", "opt");
      o.id = "sg-" + i;
      o.setAttribute("role", "option");
      o.setAttribute("aria-selected", String(i === suggestAt));
      o.append(el("span", "k", sg.kind), el("span", "v", sg.value));
      if (sg.count) o.append(el("span", "n", String(sg.count)));
      o.addEventListener("mousedown", (e) => e.preventDefault());   // keep the focus in the field
      o.addEventListener("click", () => pickSuggestion(i));
      box.append(o);
      if (i === suggestAt) input.setAttribute("aria-activedescendant", o.id);
    });
  }
  function pickSuggestion(i) {
    const sg = suggest[i];
    if (!sg) return;
    // Like the apps: the typed text becomes the filter.
    $("search").value = "";
    state.query = "";
    suggestAt = -1;
    sg.apply();
    renderSuggest();
  }
  $("search").addEventListener("input", (e) => { state.query = e.target.value; suggestAt = -1; renderGrid(); renderSuggest(); });
  $("search").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!suggest.length) return;
      e.preventDefault();
      suggestAt = e.key === "ArrowDown" ? Math.min(suggest.length - 1, suggestAt + 1) : Math.max(-1, suggestAt - 1);
      renderSuggest();
    } else if (e.key === "Enter" && suggestAt >= 0) {
      e.preventDefault();
      pickSuggestion(suggestAt);
    } else if (e.key === "Escape" && suggest.length) {
      e.stopPropagation();
      suggest = [];
      $("search-suggest").hidden = true;
      $("search").setAttribute("aria-expanded", "false");
    }
  });
  $("search").addEventListener("focus", () => renderSuggest());
  $("search").addEventListener("blur", () => { $("search-suggest").hidden = true; $("search").setAttribute("aria-expanded", "false"); });
  for (const b of document.querySelectorAll("#filter-group button")) {
    b.addEventListener("click", () => setFilter(b.dataset.filter));
    b.setAttribute("aria-pressed", String(b.dataset.filter === state.filter));
  }
  if (![...document.querySelectorAll("#filter-group button")].some((b) => b.dataset.filter === state.filter)) state.filter = "all";
  if (!["all", "owed", "reconnect", "notes"].includes(state.mfilter)) state.mfilter = "all";
  for (const b of document.querySelectorAll("#mine-filter-group button")) {
    b.addEventListener("click", () => setMFilter(b.dataset.mfilter));
    b.setAttribute("aria-pressed", String(b.dataset.mfilter === state.mfilter));
  }
  $("country-filter").addEventListener("change", (e) => { state.country = e.target.value; renderGrid(); });
  $("industry-filter").addEventListener("change", (e) => { state.industry = e.target.value; renderGrid(); });
  if (!RATINGS[state.rating]) state.rating = "";
  for (const b of document.querySelectorAll("#rating-group button")) {
    b.addEventListener("click", () => setRating(b.dataset.rating));
    b.setAttribute("aria-pressed", String(b.dataset.rating === state.rating));
  }
  $("sort").addEventListener("change", (e) => { state.sort = e.target.value; storageSet("cardlio.team.sort", state.sort); renderGrid(); });
  if ([...$("sort").options].some((o) => o.value === state.sort)) $("sort").value = state.sort; else state.sort = "new";
  $("team-select").addEventListener("change", (e) => {
    const t = state.teams.find((x) => x.id === e.target.value);
    if (t) selectTeam(t);
  });
  $("refresh").addEventListener("click", () => load());
  // 7. The phone's bottom bar mirrors the toolbar's four actions.
  $("mb-search").addEventListener("click", () => { $("search").scrollIntoView({ block: "center" }); $("search").focus(); });
  $("mb-add").addEventListener("click", () => openCardForm(null));
  $("mb-claim").addEventListener("click", () => $("claim-all").click());
  $("mb-export").addEventListener("click", () => { if (!mayDownload()) return; $("export-btn").scrollIntoView({ block: "center" }); setMenu(true); });

  // The other popovers: Add (teams), Filters, Account. One open at a time;
  // a click outside or Esc closes it.
  const pops = [["add-btn", "add-menu"], ["filters-btn", "filters-pop"], ["account-btn", "account-pop"]];
  function closePops(except) {
    for (const [b, m] of pops) {
      if (m === except) continue;
      if (m === "account-pop") $(m).classList.remove("open"); else $(m).hidden = true;
      $(b).setAttribute("aria-expanded", "false");
    }
  }
  for (const [b, m] of pops) {
    $(b).addEventListener("click", () => {
      const isOpen = m === "account-pop" ? $(m).classList.contains("open") : !$(m).hidden;
      closePops(m);
      setMenu(false);
      if (m === "account-pop") $(m).classList.toggle("open", !isOpen); else $(m).hidden = isOpen;
      $(b).setAttribute("aria-expanded", String(!isOpen));
    });
  }
  for (const id of ["add-card", "scan-photo", "import-vcf", "ai-keys"]) $(id).addEventListener("click", () => closePops());
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) closePops(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePops(); });

  const exportBtn = $("export-btn"), exportMenu = $("export-menu");
  function setMenu(open) {
    exportMenu.hidden = !open;
    exportBtn.setAttribute("aria-expanded", String(open));
    if (open) exportMenu.querySelector("button").focus();
  }
  exportBtn.addEventListener("click", () => { closePops(); if (!exportMenu.hidden) setMenu(false); else if (mayDownload()) setMenu(true); });
  document.addEventListener("click", (e) => { if (!exportMenu.hidden && !e.target.closest(".menu-wrap")) setMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !exportMenu.hidden) { setMenu(false); exportBtn.focus(); } });
  for (const b of exportMenu.querySelectorAll("button")) {
    b.addEventListener("click", async () => {
      setMenu(false);
      if (!mayDownload()) return;
      const list = visibleRecords();
      if (!list.length) { toast("No cards to export", true); return; }
      if (b.dataset.export === "csv") downloadCSV(list);
      else if (b.dataset.export === "zip") {
        toast("Packing " + plural(list.length, "card") + "…");
        await downloadZip(list);
      } else if (b.dataset.export === "print") { printSheet(null, null); return; }
      else await downloadVCard(list, false);
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

  if (cfg.testHooks) window.__cardlioTeamPoll = () => pollTeam(true);
  if (cfg.testHooks) window.__cardlioCsv = () => csvText(visibleRecords());   // the fake-CloudKit harness only (its tab may be hidden)

  const startAuth = () => container.setUpAuth().then((user) => (user ? signedIn() : signedOut()));
  startAuth().catch((e) => {
    if (/AUTH_PERSIST_ERROR/.test(errorText(e))) {
      useContainer(false);
      return startAuth();
    }
    throw e;
  }).catch((e) => {
    $("welcome").hidden = false;
    toast("iCloud could not start: " + errorText(e), true);
  });
})();
