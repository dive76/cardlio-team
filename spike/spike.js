// team.cardlio.app — CloudKit JS spike (read-only).
//
// Question it answers: can a browser, signed in with an Apple ID, reach
// the teams the cardlio apps create — the ones you own (private
// database) AND the ones you joined (shared database) — and show their
// cards, photos included?
//
// ⚠️ The same private database also holds the person's own card library
// (SwiftData's zone). This page only ever opens zones named "team-…",
// and it never writes: no save, no delete, no claim.

(function () {
  "use strict";

  const cfg = window.CARDLIO_TEAM_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const TEAM_PREFIX = "team-";
  const SHARE_RECORD = "cloudkit.zoneshare";

  function log(...parts) {
    const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
    $("log").textContent += line + "\n";
    console.log("[team]", ...parts);
  }

  function status(text, isError) {
    $("status").textContent = text;
    $("status").classList.toggle("error", !!isError);
    $("status").hidden = !text;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text; // never innerHTML: card text is untrusted
    return node;
  }

  function field(record, name) {
    const f = record.fields && record.fields[name];
    return f ? f.value : undefined;
  }

  function errorText(e) {
    if (!e) return "Unknown error";
    return [e.ckErrorCode || e.serverErrorCode, e.reason || e.message].filter(Boolean).join(": ") || String(e);
  }

  if (!cfg.apiToken) {
    status("Not set up yet: config.js has no CloudKit API token.", true);
    log("Missing apiToken in config.js");
    return;
  }
  if (!window.CloudKit) {
    status("Could not load Apple's CloudKit script.", true);
    return;
  }

  CloudKit.configure({
    containers: [{
      containerIdentifier: cfg.containerIdentifier,
      environment: cfg.environment,
      apiTokenAuth: {
        apiToken: cfg.apiToken,
        persist: true,
        signInButton: { id: "apple-sign-in-button", theme: "black" },
        signOutButton: { id: "apple-sign-out-button", theme: "black" }
      }
    }]
  });

  const container = CloudKit.getDefaultContainer();
  const databases = [
    { db: container.privateCloudDatabase, owned: true, label: "private" },
    { db: container.sharedCloudDatabase, owned: false, label: "shared" }
  ];

  function signedOut() {
    status("Sign in with your Apple ID to see your teams.");
    $("teams").hidden = true;
    $("cards").hidden = true;
    container.whenUserSignsIn().then(signedIn).catch((e) => status(errorText(e), true));
  }

  function signedIn(user) {
    log("Signed in", user && user.userRecordName ? "(user record " + user.userRecordName.slice(0, 8) + "…)" : "");
    container.whenUserSignsOut().then(signedOut);
    loadTeams();
  }

  // Teams = zones named team-… that still carry their zone-wide share
  // (the apps' own rule: a zone without its share is a deleted team's husk).
  async function loadTeams() {
    status("Looking for teams…");
    const teams = [];
    for (const { db, owned, label } of databases) {
      let response;
      try {
        response = await db.fetchAllRecordZones();
      } catch (e) {
        log(label, "zones failed:", errorText(e));
        continue;
      }
      if (response.hasErrors) { log(label, "zones errors:", response.errors.map(errorText)); continue; }
      const zones = (response.zones || []).filter((z) => z.zoneID.zoneName.startsWith(TEAM_PREFIX));
      log(label, "database:", (response.zones || []).length, "zone(s),", zones.length, "team zone(s)");
      for (const zone of zones) {
        const team = { zoneID: zone.zoneID, db, owned, label, name: zone.zoneID.zoneName, share: "unknown" };
        try {
          const r = await db.fetchRecords([{ recordName: SHARE_RECORD, zoneID: zone.zoneID }]);
          const share = r.records && r.records[0];
          if (share && !share.serverErrorCode) {
            team.share = "present";
            const title = field(share, "cloudkit.title");
            if (title) team.name = title;
            team.participants = (share.participants || []).length;
            log(team.zoneID.zoneName, "share fields:", Object.keys(share.fields || {}));
          } else {
            team.share = "absent";
          }
        } catch (e) {
          team.share = /NOT_FOUND|UNKNOWN_ITEM/i.test(errorText(e)) ? "absent" : "unknown";
          log(team.zoneID.zoneName, "share lookup:", errorText(e));
        }
        if (team.share !== "absent") teams.push(team);
      }
    }
    showTeams(teams);
  }

  function showTeams(teams) {
    const list = $("team-list");
    list.replaceChildren();
    $("teams").hidden = false;
    if (!teams.length) {
      status("No teams found for this Apple ID. Create one in the cardlio app, or accept an invite on this Apple ID first.");
      return;
    }
    status("");
    teams.sort((a, b) => a.name.localeCompare(b.name));
    for (const team of teams) {
      const item = el("li");
      const button = el("button");
      button.append(el("span", null, team.name));
      const bits = [team.owned ? "Yours" : "Joined", team.label + " database"];
      if (team.participants != null) bits.push(team.participants + " on the share");
      button.append(el("small", null, bits.join(" · ")));
      button.addEventListener("click", () => {
        list.querySelectorAll("button").forEach((b) => b.removeAttribute("aria-current"));
        button.setAttribute("aria-current", "true");
        loadCards(team);
      });
      item.append(button);
      list.append(item);
    }
    if (teams.length === 1) list.querySelector("button").click();
  }

  // Zone changes, not a query: a query needs queryable indexes the
  // schema does not have (the apps read teams the same way).
  async function loadCards(team) {
    $("cards").hidden = false;
    $("team-title").textContent = team.name;
    $("team-meta").textContent = "Loading cards…";
    $("card-list").replaceChildren();
    const records = [];
    let syncToken;
    try {
      for (let page = 0; page < 50; page++) {
        const response = await team.db.fetchRecordZoneChanges([{ zoneID: team.zoneID, syncToken }]);
        if (response.hasErrors) throw response.errors[0];
        const zone = response.zones && response.zones[0];
        if (!zone) break;
        for (const r of zone.records || []) {
          if (!r.deleted && r.recordType === "TeamCard") records.push(r);
        }
        syncToken = zone.syncToken;
        if (!zone.moreComing) break;
      }
    } catch (e) {
      $("team-meta").textContent = "Could not read this team: " + errorText(e);
      log(team.zoneID.zoneName, "cards failed:", errorText(e));
      return;
    }
    records.sort((a, b) => (field(b, "scannedAt") || 0) - (field(a, "scannedAt") || 0));
    const claimed = records.filter((r) => field(r, "claimedBy")).length;
    $("team-meta").textContent = records.length + (records.length === 1 ? " card" : " cards") + ", " + (records.length - claimed) + " unclaimed";
    log(team.zoneID.zoneName, records.length, "card(s)");
    for (const r of records) $("card-list").append(cardView(r));
  }

  function cardView(r) {
    const li = el("li", "card");
    const photo = field(r, "photo");
    if (photo && photo.downloadURL) {
      const img = el("img");
      img.alt = "Photo of the card";
      img.loading = "lazy";
      img.src = photo.downloadURL.replace("${f}", "card.jpg");
      li.append(img);
    }
    const body = el("div", "body");
    const name = [field(r, "firstName"), field(r, "lastName")].filter(Boolean).join(" ") || "No name";
    body.append(el("div", "name", name));
    const sub = [field(r, "title"), field(r, "company")].filter(Boolean).join(" · ");
    if (sub) body.append(el("div", "sub", sub));
    const emails = field(r, "emails") || [];
    for (const line of [emails.join(", "), field(r, "phone"), field(r, "mobile"), field(r, "website"),
                        [field(r, "street"), field(r, "unit")].filter(Boolean).join(", "),
                        [field(r, "postalCode"), field(r, "city"), field(r, "country")].filter(Boolean).join(" ")]) {
      if (line) body.append(el("div", "line", line));
    }
    const by = field(r, "scannedBy");
    const at = field(r, "scannedAt");
    const when = at ? new Date(at).toLocaleDateString() : "";
    if (by || when) body.append(el("div", "line", "Shared by " + (by || "someone") + (when ? ", " + when : "")));
    const claimedBy = field(r, "claimedBy");
    if (claimedBy) body.append(el("div", "claimed", "Claimed by " + claimedBy));
    li.append(body);
    return li;
  }

  container.setUpAuth()
    .then((user) => (user ? signedIn(user) : signedOut()))
    .catch((e) => { status("CloudKit could not start: " + errorText(e), true); log("setUpAuth failed:", errorText(e)); });
})();
