// cardlio library probe — Phase 0 of handbook/plan-web-library.md (app repo).
//
// READ-ONLY: fetchAllRecordZones + fetchRecordZoneChanges on the private
// database, nothing else. The report holds field NAMES, TYPES, COUNTS and
// SIZES only — never a field value — because it is meant to be copied out
// of the browser and pasted into a chat. List fields are described by
// their encoding and item count; photos by their file signature and
// whether this browser can decode them.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const out = $("out");
  const lines = [];
  const say = (s) => { lines.push(s); out.textContent = lines.join("\n"); };
  const cfg = window.CARDLIO_TEAM_CONFIG || {};
  const CD_ZONE = "com.apple.coredata.cloudkit.zone";

  if (!window.CloudKit || !cfg.apiToken) { out.textContent = "CloudKit JS did not load."; return; }
  CloudKit.configure({
    containers: [{
      containerIdentifier: cfg.containerIdentifier,
      environment: cfg.environment,
      apiTokenAuth: {
        apiToken: cfg.apiToken, persist: false,   // one-time page: keep the token in memory only (AUTH_PERSIST_ERROR in the owner's browser with persist: true)
        signInButton: { id: "apple-sign-in-button", theme: "white-with-outline" },
        signOutButton: { id: "apple-sign-out-button", theme: "black" }
      }
    }]
  });
  const container = CloudKit.getDefaultContainer();

  const why = (e) => (e && (e.ckErrorCode || e.reason || e.message)) || String(e);
  function signedIn(user) {
    $("run").disabled = false;
    $("recheck").hidden = true;
    out.textContent = "Signed in" + (user && user.userRecordName ? "" : "") + ". Press Run the probe.";
    container.whenUserSignsOut().then(signedOut).catch((e) => { out.textContent = "Sign-out error: " + why(e); });
  }
  function signedOut() {
    $("run").disabled = true;
    $("recheck").hidden = false;
    out.textContent = "Not signed in. Press \u201cSign in with Apple ID\u201d above (it can take a few seconds to appear).\n"
      + "If the Apple window closes and nothing changes here, press \u201cCheck sign-in again\u201d, or reload the page.";
    container.whenUserSignsIn().then(signedIn).catch((e) => { out.textContent = "Sign-in error: " + why(e); });
  }
  function check() {
    out.textContent = "Starting iCloud\u2026";
    const slow = setTimeout(() => {
      if (out.textContent.startsWith("Starting")) out.textContent = "iCloud is taking long to answer. Check the connection, or reload the page.";
    }, 15000);
    container.setUpAuth()
      .then((user) => { clearTimeout(slow); user ? signedIn(user) : signedOut(); })
      .catch((e) => { clearTimeout(slow); out.textContent = "iCloud could not start: " + why(e); $("recheck").hidden = false; });
  }
  $("recheck").addEventListener("click", check);
  check();

  $("copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(out.textContent); $("copy").textContent = "Copied"; }
    catch { $("copy").textContent = "Select the text and copy it"; }
  });

  // ---------------------------------------------------------------- helpers

  function b64bytes(b64, max) {
    const bin = atob(b64);
    const n = max ? Math.min(max, bin.length) : bin.length;
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = bin.charCodeAt(i);
    return { bytes: a, length: bin.length };
  }
  const ascii = (a, from, to) => String.fromCharCode(...a.slice(from, to));
  function signature(a) {
    if (a.length >= 8 && a[0] === 0x89 && ascii(a, 1, 4) === "PNG") return "PNG";
    if (a.length >= 3 && a[0] === 0xff && a[1] === 0xd8 && a[2] === 0xff) return "JPEG";
    if (a.length >= 12 && ascii(a, 4, 8) === "ftyp") return "ISO-BMFF " + ascii(a, 8, 12).trim();
    if (a.length >= 8 && ascii(a, 0, 8) === "bplist00") return "bplist00";
    if (a.length >= 1 && (a[0] === 0x5b || a[0] === 0x7b)) return "JSON?";
    return "unknown (" + Array.from(a.slice(0, 4)).map((x) => x.toString(16).padStart(2, "0")).join(" ") + ")";
  }

  // Minimal binary-plist reader: returns a SHAPE, never values.
  function bplistShape(a) {
    const dv = new DataView(a.buffer, a.byteOffset, a.byteLength);
    const t = a.length - 32;
    const offSize = a[t + 6], refSize = a[t + 7];
    const numObjects = Number(dv.getBigUint64(t + 8));
    const top = Number(dv.getBigUint64(t + 16));
    const tableOff = Number(dv.getBigUint64(t + 24));
    const readN = (o, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + a[o + i]; return v; };
    const offset = (i) => readN(tableOff + i * offSize, offSize);
    const kinds = {};
    let archiver = false;
    for (let i = 0; i < numObjects; i++) {
      const o = offset(i), m = a[o] >> 4;
      const k = { 0: "simple", 1: "int", 2: "real", 3: "date", 4: "data", 5: "ascii", 6: "utf16", 8: "uid", 10: "array", 13: "dict" }[m] || "other";
      kinds[k] = (kinds[k] || 0) + 1;
      if (m === 5) {
        let len = a[o] & 0xf, p = o + 1;
        if (len === 0xf) { const ib = 1 << (a[p] & 0xf); len = readN(p + 1, ib); p += 1 + ib; }
        if (ascii(a, p, p + len) === "$archiver") archiver = true;
      }
    }
    const to = offset(top), tm = a[to] >> 4;
    let topCount = a[to] & 0xf;
    if (topCount === 0xf) { const ib = 1 << (a[to + 1] & 0xf); topCount = readN(to + 2, ib); }
    const topKind = { 10: "array", 13: "dict", 5: "string", 6: "string" }[tm] || "other";
    return { archiver, topKind, topCount, kinds };
  }
  function describeBlob(b64) {
    const { bytes, length } = b64bytes(b64);
    const sig = signature(bytes);
    if (sig === "bplist00") {
      try {
        const s = bplistShape(bytes);
        return `bplist, ${s.archiver ? "NSKeyedArchiver" : "plain"}, top ${s.topKind}[${s.topCount}], objects ${JSON.stringify(s.kinds)}, ${length} B`;
      } catch (e) { return `bplist (unparsed: ${e.message}), ${length} B`; }
    }
    if (sig === "JSON?") {
      try { const v = JSON.parse(new TextDecoder().decode(bytes)); return `JSON ${Array.isArray(v) ? "array[" + v.length + "]" : typeof v}, ${length} B`; }
      catch { return `starts like JSON but does not parse, ${length} B`; }
    }
    return `${sig}, ${length} B`;
  }
  const decodable = (url) => new Promise((resolve) => {
    const img = new Image();
    const t = setTimeout(() => resolve("timeout"), 15000);
    img.onload = () => { clearTimeout(t); resolve(`decodes (${img.naturalWidth}x${img.naturalHeight})`); };
    img.onerror = () => { clearTimeout(t); resolve("this browser CANNOT decode it"); };
    img.src = url;
  });
  async function assetSignature(url) {
    try {
      const r = await fetch(url);
      if (!r.ok) return `fetch ${r.status}`;
      const buf = new Uint8Array(await r.arrayBuffer());
      return `${signature(buf.slice(0, 16))}, ${buf.length} B via fetch`;
    } catch (e) { return `fetch blocked (${e.message})`; }
  }
  const pct = (n, d) => d ? `${n}/${d} (${Math.round((100 * n) / d)} %)` : `${n}/0`;
  const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

  // ---------------------------------------------------------------- probe

  $("run").addEventListener("click", async () => {
    $("run").disabled = true;
    lines.length = 0;
    const t0 = performance.now();
    const db = container.privateCloudDatabase;
    try {
      say(`cardlio library probe — ${new Date().toISOString()}`);
      say(`browser: ${navigator.userAgent.replace(/\s+/g, " ")}`);
      const zr = await db.fetchAllRecordZones();
      if (zr.hasErrors) throw zr.errors[0];
      const zones = zr.zones || [];
      const names = zones.map((z) => z.zoneID.zoneName);
      say(`private zones: ${zones.length} (team-* ${names.filter((n) => n.startsWith("team-")).length}, core data zone ${names.includes(CD_ZONE) ? "PRESENT" : "MISSING"}, other: ${names.filter((n) => !n.startsWith("team-") && n !== CD_ZONE).join(", ") || "none"})`);
      const zone = zones.find((z) => z.zoneID.zoneName === CD_ZONE);
      if (!zone) { say("No Core Data zone in this account's private database — signed in with the right Apple Account?"); return; }

      // fetch the whole zone, paging
      const records = []; let syncToken, pages = 0, jsonBytes = 0;
      for (; pages < 500; pages++) {
        const r = await db.fetchRecordZoneChanges([{ zoneID: zone.zoneID, syncToken }]);
        if (r.hasErrors) throw r.errors[0];
        const z = r.zones && r.zones[0];
        if (!z) break;
        for (const rec of z.records || []) { if (!rec.deleted) { records.push(rec); jsonBytes += JSON.stringify(rec).length; } }
        syncToken = z.syncToken;
        say(`  page ${pages + 1}: ${records.length} records so far`);
        if (!z.moreComing) { pages++; break; }
      }
      lines.splice(lines.length - pages, pages); // drop the progress lines
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      say(`fetched ${records.length} records in ${pages} page(s), ${secs} s, ~${Math.round(jsonBytes / 1024)} KB of record JSON (assets not downloaded)`);

      const byType = {};
      for (const r of records) byType[r.recordType] = (byType[r.recordType] || 0) + 1;
      say(`record types: ${JSON.stringify(byType)}`);

      const cards = records.filter((r) => r.recordType === "CD_BusinessCard");
      say("");
      say(`== CD_BusinessCard: ${cards.length} records ==`);
      const fields = {};
      for (const c of cards) for (const [k, v] of Object.entries(c.fields || {})) {
        const f = fields[k] || (fields[k] = { types: {}, present: 0, sizes: [] });
        f.types[v.type] = (f.types[v.type] || 0) + 1;
        const val = v.value;
        const empty = val === "" || val === null || val === undefined || (Array.isArray(val) && !val.length);
        if (!empty) f.present++;
        if (v.type === "BYTES" && typeof val === "string") f.sizes.push(Math.floor(val.length * 3 / 4));
        if (v.type === "ASSETID" && val && val.size) f.sizes.push(val.size);
        if (v.type === "STRING" && typeof val === "string") f.sizes.push(val.length);
      }
      say("field                               type(s)            non-empty       median size");
      for (const k of Object.keys(fields).sort()) {
        const f = fields[k];
        say(`${k.padEnd(36)}${Object.keys(f.types).join("+").padEnd(19)}${pct(f.present, cards.length).padEnd(16)}${f.sizes.length ? median(f.sizes) : "-"}`);
      }

      // list fields: emails, additionalPhones (shape only)
      say("");
      say("== list fields (encoding shape, no values) ==");
      for (const name of ["CD_emails", "CD_additionalPhones"]) {
        const samples = cards.map((c) => c.fields && c.fields[name]).filter((v) => v && v.value);
        if (!samples.length) { say(`${name}: not present on any card`); continue; }
        say(`${name}: type ${samples[0].type}, on ${samples.length} cards`);
        const seen = {};
        for (const s of samples.slice(0, 200)) {
          const d = s.type === "BYTES" ? describeBlob(s.value).replace(/, \d+ B$/, "") : (Array.isArray(s.value) ? `native list[${s.value.length}]` : typeof s.value);
          const key = d.replace(/\[\d+\]/g, "[n]").replace(/"(ascii|utf16|array|dict|uid|int|simple|data|date|real|other)":\d+/g, '"$1":n');
          if (!seen[key]) { seen[key] = 0; say(`  e.g. ${d}`); }
          seen[key]++;
        }
        say(`  shapes: ${JSON.stringify(seen)}`);
      }

      // ids and duplicates
      say("");
      say("== ids ==");
      const idField = ["CD_id", "CD_uuid"].find((n) => fields[n]);
      if (!idField) say("no CD_id field found");
      else {
        const counts = {};
        for (const c of cards) { const v = c.fields[idField] && c.fields[idField].value; const k = typeof v === "string" ? v : JSON.stringify(v); counts[k] = (counts[k] || 0) + 1; }
        const groups = Object.values(counts);
        say(`${idField}: type ${Object.keys(fields[idField].types).join("+")}, ${groups.length} distinct ids over ${cards.length} records, ${groups.filter((n) => n > 1).length} ids with duplicates (largest group ${Math.max(...groups)})`);
      }
      say(`recordName pattern: ${cards.slice(0, 3).map((c) => c.recordName.replace(/[0-9A-Fa-f]/g, "x")).join(" | ")}`);

      // photos
      say("");
      say("== photos ==");
      for (const base of ["CD_imageData", "CD_backImageData", "CD_thumbnailData"]) {
        const inline = cards.filter((c) => c.fields[base] && c.fields[base].value).length;
        const asset = cards.filter((c) => c.fields[base + "_ckAsset"] && c.fields[base + "_ckAsset"].value).length;
        say(`${base}: inline bytes on ${inline}, _ckAsset on ${asset}, of ${cards.length}`);
      }
      const inlineSigs = {};
      for (const c of cards) {
        const v = c.fields.CD_imageData && c.fields.CD_imageData.value;
        if (v) { const s = signature(b64bytes(v, 16).bytes); inlineSigs[s] = (inlineSigs[s] || 0) + 1; }
      }
      if (Object.keys(inlineSigs).length) say(`inline CD_imageData formats: ${JSON.stringify(inlineSigs)}`);
      const withAsset = cards.filter((c) => c.fields.CD_imageData_ckAsset && c.fields.CD_imageData_ckAsset.value && c.fields.CD_imageData_ckAsset.value.downloadURL);
      const step = Math.max(1, Math.floor(withAsset.length / 6));
      const picks = withAsset.filter((_, i) => i % step === 0).slice(0, 6);
      for (const [i, c] of picks.entries()) {
        const url = c.fields.CD_imageData_ckAsset.value.downloadURL;
        const [sig, dec] = await Promise.all([assetSignature(url), decodable(url)]);
        say(`  photo asset sample ${i + 1}: ${sig}; <img>: ${dec}`);
      }

      // modified / other bookkeeping fields
      say("");
      say(`== done in ${((performance.now() - t0) / 1000).toFixed(1)} s. Nothing was written. ==`);
      $("copy").disabled = false;
    } catch (e) {
      say(`ERROR: ${(e && (e.ckErrorCode || e.reason || e.message)) || e}`);
    } finally {
      $("run").disabled = false;
    }
  });
})();
