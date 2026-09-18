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
// card first, CloudKit refuses and nothing is overwritten).
//
// ⚠️ Card text is untrusted input: always textContent, never innerHTML.

(function () {
  "use strict";

  const cfg = window.CARDLIO_TEAM_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const TEAM_PREFIX = "team-";
  const NAME_KEY = "cardlio.team.claimName";

  const state = {
    teams: [],          // { id, zoneID, db, owned, name, records: [...] }
    team: null,
    filter: "all",
    sort: "new",
    query: "",
    event: "",
    open: null          // record shown in the detail dialog
  };

  // ---------------------------------------------------------------- utils

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  const ICONS = {
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
    $("welcome").hidden = false;
    $("app").hidden = true;
    $("refresh").hidden = true;
    state.teams = [];
    state.team = null;
    container.whenUserSignsIn().then(signedIn).catch((e) => toast(errorText(e), true));
  }

  function signedIn() {
    document.body.classList.remove("signed-out");
    $("welcome").hidden = true;
    $("app").hidden = false;
    $("refresh").hidden = false;
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
    if (!state.teams.length) {
      $("no-teams").hidden = false;
      $("team-view").hidden = true;
      return;
    }
    $("no-teams").hidden = true;
    const wanted = new URLSearchParams(location.hash.slice(1)).get("team") ||
                   (state.team && state.team.id) || storageGet("cardlio.team.last");
    // Otherwise the team with the most recent card: that is the fair in progress.
    const latest = (t) => t.records.reduce((m, r) => Math.max(m, scannedAt(r)), t.createdAt || 0);
    const busiest = [...state.teams].sort((a, b) => latest(b) - latest(a))[0];
    selectTeam(state.teams.find((t) => t.id === wanted) || busiest);
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
    storageSet("cardlio.team.last", team.id);
    history.replaceState(null, "", "#team=" + encodeURIComponent(team.id));
    document.title = team.name + " · cardlio Team";
    for (const b of $("team-nav").querySelectorAll("button")) {
      b.setAttribute("aria-current", b.dataset.team === team.id ? "true" : "false");
    }
    $("team-select").value = team.id;
    $("team-view").hidden = false;
    renderTeam();
  }

  function renderTeam() {
    const team = state.team;
    const records = team.records;
    $("team-name").textContent = team.name + " ";
    $("team-name").append(el("span", team.owned ? "badge" : "badge plain", team.owned ? "Yours" : "Joined"));
    const sub = [];
    if (team.createdAt) sub.push("Started " + when(team.createdAt));
    if (!team.named) sub.push("Open the team library in the cardlio app once to show this team's name here");
    $("team-sub").textContent = sub.join(" · ");

    const claimed = records.filter((r) => str(r, "claimedBy")).length;
    const people = new Set(records.map((r) => str(r, "scannedBy")).filter(Boolean));
    const latest = records.reduce((m, r) => Math.max(m, scannedAt(r)), 0);
    const stats = $("stats");
    stats.replaceChildren();
    for (const [k, v, small] of [
      ["Cards", String(records.length)],
      ["Unclaimed", String(records.length - claimed)],
      ["Shared by", people.size ? [...people].join(", ") : "—", true],
      ["Latest", latest ? when(latest) : "—", true]
    ]) {
      const s = el("div", "stat");
      s.append(el("div", "k", k), el("div", small ? "v small" : "v", v));
      stats.append(s);
    }

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
        str(r, "eventTag"), str(r, "scannedBy"), str(r, "claimedBy"), str(r, "notes")].join(" "));
      return q.split(/\s+/).every((w) => hay.includes(w));
    });
    const byText = (get) => (a, b) => get(a).localeCompare(get(b), undefined, { sensitivity: "base" });
    if (state.sort === "name") list.sort(byText((r) => str(r, "lastName") || displayName(r)));
    else if (state.sort === "company") list.sort(byText((r) => str(r, "company") || "~"));
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
    for (const r of list) grid.append(tile(r));
  }

  function tile(r) {
    const li = el("li");
    const b = el("button", "tile");
    b.type = "button";
    const ph = el("div", "ph");
    const url = photoURL(r);
    if (url) {
      const img = el("img");
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.src = url;
      img.addEventListener("error", () => img.replaceWith(el("span", "initials", cardInitials(r))));
      ph.append(img);
    } else {
      ph.append(el("span", "initials", cardInitials(r)));
    }
    const tb = el("div", "tb");
    tb.append(el("div", "nm", displayName(r)));
    const role = [str(r, "title"), fullName(r) ? str(r, "company") : ""].filter(Boolean).join(" · ");
    if (role) tb.append(el("div", "co", role));
    const place = [str(r, "city"), str(r, "country")].filter(Boolean).join(", ");
    if (place) tb.append(el("div", "ln", place));
    const foot = el("div", "foot");
    const by = str(r, "scannedBy");
    foot.append(el("span", null, [by, when(scannedAt(r))].filter(Boolean).join(" · ")));
    const claimedBy = str(r, "claimedBy");
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

    const by = str(r, "scannedBy");
    $("d-prov").textContent = "Shared " + [by ? "by " + by : "", when(scannedAt(r)) ? "on " + when(scannedAt(r)) : ""].filter(Boolean).join(" ") + " into " + state.team.name + ".";

    renderDetailActions(r);
    const dlg = $("detail");
    if (!dlg.open) dlg.showModal();
    $("d-close").focus();
  }

  function renderDetailActions(r) {
    const actions = $("d-actions");
    actions.replaceChildren();
    const claimedBy = str(r, "claimedBy");
    if (claimedBy) {
      const note = el("div", "claimed-note");
      note.append(icon("check"), el("span", null, "Claimed by " + claimedBy));
      actions.append(note);
    } else {
      const claim = el("button", "btn primary");
      claim.type = "button";
      claim.append(icon("hand"), el("span", null, "Claim"));
      claim.addEventListener("click", () => askClaim(r));
      actions.append(claim);
    }
    const dl = el("button", "btn");
    dl.type = "button";
    dl.append(icon("download"), el("span", null, "Download vCard"));
    dl.addEventListener("click", () => downloadVCard([r], true));
    actions.append(dl);
  }

  $("d-close").addEventListener("click", () => $("detail").close());
  $("detail").addEventListener("click", (e) => { if (e.target === $("detail")) $("detail").close(); });
  // The close event arrives a moment after close(): if another card was
  // opened in between, it is that card's dialog now — keep it.
  $("detail").addEventListener("close", () => { if (!$("detail").open) state.open = null; });

  // ----------------------------------------------------------------- claim

  let claiming = null;
  function askClaim(r) {
    claiming = r;
    $("c-text").textContent = "The team will see " + displayName(r) + " as yours, and the contact downloads as a vCard. " +
      "In the cardlio app, the card stays in the team; add it to your own library there if you want it on your iPhone or Mac.";
    $("c-name").value = storageGet(NAME_KEY);
    $("claim-dialog").showModal();
    $("c-name").focus();
  }
  $("c-cancel").addEventListener("click", () => $("claim-dialog").close());
  $("claim-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("c-name").value.trim();
    if (!name || !claiming) return;
    storageSet(NAME_KEY, name);
    $("c-go").disabled = true;
    try {
      await claim(claiming, name);
      $("claim-dialog").close();
      toast("Claimed. The contact is downloading.");
      downloadVCard([claiming], true);
      renderTeam();
      if (state.open === claiming) openDetail(claiming);
    } catch (err) {
      $("claim-dialog").close();
      toast(err.message || errorText(err), true);
    } finally {
      $("c-go").disabled = false;
    }
  });

  // UPDATE, not replace: only `claimedBy` is sent, and the record's change
  // tag makes CloudKit refuse if anyone changed the card since it loaded.
  async function claim(r, name) {
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
        throw new Error("Someone changed this card a moment ago. It has been reloaded; check whether it's still unclaimed.");
      }
      throw new Error("Could not claim: " + errorText(err));
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
    const head = ["First name", "Last name", "Title", "Company", "Emails", "Phone", "Mobile", "Website",
      "Street", "Unit", "Postal code", "City", "Country", "Event", "Notes", "Shared by", "Shared on", "Claimed by"];
    const rows = records.map((r) => [str(r, "firstName"), str(r, "lastName"), str(r, "title"), str(r, "company"),
      emails(r).join("; "), str(r, "phone"), str(r, "mobile"), str(r, "website"), str(r, "street"), str(r, "unit"),
      str(r, "postalCode"), str(r, "city"), str(r, "country"), str(r, "eventTag"), str(r, "notes"), str(r, "scannedBy"),
      scannedAt(r) ? new Date(scannedAt(r)).toISOString().slice(0, 10) : "", str(r, "claimedBy")]);
    const csv = "\ufeff" + [head, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
    saveFile(fileSafe(state.team.name) + ".csv", "text/csv;charset=utf-8", csv);
  }

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

  container.setUpAuth()
    .then((user) => (user ? signedIn() : signedOut()))
    .catch((e) => {
      $("welcome").hidden = false;
      toast("iCloud could not start: " + errorText(e), true);
    });
})();
