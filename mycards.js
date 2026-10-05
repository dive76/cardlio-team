// team.cardlio.app — "My cards": how the person's OWN cardlio library is
// read from their private iCloud (handbook/plan-web-library.md in the app
// repo). Pure functions only, no CloudKit and no DOM, so they can be
// tested without a browser; app.js does the fetching and the showing.
//
// The apps store the library with SwiftData, mirrored by Core Data into
// the zone "com.apple.coredata.cloudkit.zone": record type
// CD_BusinessCard, one CD_<property> field per stored property. That
// format is Apple's, not ours: the page reads it, and changes only four
// plain fields of an existing card (app.js, updateLibraryCard).
//
// Measured on the owner's library (2026-10-05, 564 cards): the two list
// properties (emails, additionalPhones) arrive as BYTES holding an
// NSKeyedArchiver binary plist; dates as TIMESTAMP (ms); the photo is
// inline HEIC/PNG or a 1.7 MB asset, so the page shows the small JPEG
// thumbnail the apps write since 3.2.5 (CD_thumbnailData, inline or as
// CD_thumbnailData_ckAsset).
//
// ⚠️ Card text is untrusted: the caller sets it with textContent only.

(function (root) {
  "use strict";

  const ZONE = "com.apple.coredata.cloudkit.zone";
  const RECORD_TYPE = "CD_BusinessCard";
  const WEB_ZONE = "cardlio-web";           // the "unlocked" marker the apps write

  // The fields the page shows. Everything else on the record — the photos,
  // the OCR text, the sync bookkeeping — is left on the server: a full
  // fetch was 18 MB, mostly inline photos.
  const TEXT_FIELDS = ["firstName", "lastName", "honorific", "title", "company", "industry",
    "phone", "mobile", "fax", "website", "wechat", "linkedin",
    "building", "street", "unit", "postalCode", "city", "country",
    "notes", "eventTag", "leadRating", "leadInterests",
    "translatedTitle", "translatedCompany", "translatedAddress"];
  const DATE_FIELDS = ["addedAt", "modifiedAt", "followUpOwedAt", "followUpDoneAt", "lastContactAt"];
  const DESIRED_KEYS = ["CD_id", "CD_emails", "CD_additionalPhones", "CD_keepInTouchMonths",
    "CD_thumbnailData", "CD_thumbnailData_ckAsset"]
    .concat(TEXT_FIELDS.map((k) => "CD_" + k), DATE_FIELDS.map((k) => "CD_" + k));

  // ------------------------------------------------- binary plist reader

  function base64Bytes(b64) {
    const bin = atob(b64);
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }

  // A minimal bplist00 reader: every object type an NSKeyedArchiver
  // archive of strings uses. Returns the object graph with UIDs as
  // { uid: n }. Throws on anything it does not understand.
  function readBplist(a) {
    if (a.length < 40 || String.fromCharCode(...a.slice(0, 8)) !== "bplist00") throw new Error("not a bplist");
    const t = a.length - 32;
    const offSize = a[t + 6], refSize = a[t + 7];
    const big = (o) => { let v = 0; for (let i = 0; i < 8; i++) v = v * 256 + a[o + i]; return v; };
    const numObjects = big(t + 8), top = big(t + 16), tableOff = big(t + 24);
    const readN = (o, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + a[o + i]; return v; };
    const offset = (i) => readN(tableOff + i * offSize, offSize);
    const cache = new Map();
    const lengthAt = (o) => {            // the count in the marker's low nibble, or an int object after it
      const low = a[o] & 0xf;
      if (low !== 0xf) return { n: low, p: o + 1 };
      const ib = 1 << (a[o + 1] & 0xf);
      return { n: readN(o + 2, ib), p: o + 2 + ib };
    };
    function obj(i, depth) {
      if (depth > 64) throw new Error("too deep");
      if (cache.has(i)) return cache.get(i);
      const o = offset(i), m = a[o] >> 4, low = a[o] & 0xf;
      let v;
      if (m === 0x0) v = low === 0x8 ? false : low === 0x9 ? true : null;
      else if (m === 0x1) v = readN(o + 1, 1 << low);
      else if (m === 0x2) { const dv = new DataView(a.buffer, a.byteOffset + o + 1, 1 << low); v = low === 3 ? dv.getFloat64(0) : dv.getFloat32(0); }
      else if (m === 0x3) v = new DataView(a.buffer, a.byteOffset + o + 1, 8).getFloat64(0);
      else if (m === 0x4) { const { n, p } = lengthAt(o); v = a.slice(p, p + n); }
      else if (m === 0x5) { const { n, p } = lengthAt(o); v = new TextDecoder("latin1").decode(a.slice(p, p + n)); }
      else if (m === 0x6) { const { n, p } = lengthAt(o); let s = ""; for (let k = 0; k < n; k++) s += String.fromCharCode(a[p + 2 * k] * 256 + a[p + 2 * k + 1]); v = s; }
      else if (m === 0x8) v = { uid: readN(o + 1, low + 1) };
      else if (m === 0xa) { const { n, p } = lengthAt(o); v = []; cache.set(i, v); for (let k = 0; k < n; k++) v.push(obj(readN(p + k * refSize, refSize), depth + 1)); }
      else if (m === 0xd) {
        const { n, p } = lengthAt(o); v = {}; cache.set(i, v);
        for (let k = 0; k < n; k++) v[obj(readN(p + k * refSize, refSize), depth + 1)] = obj(readN(p + (n + k) * refSize, refSize), depth + 1);
      } else throw new Error("bplist object type " + m);
      cache.set(i, v);
      return v;
    }
    if (numObjects < 1 || top >= numObjects) throw new Error("bad trailer");
    return obj(top, 0);
  }

  // An NSKeyedArchiver archive of an NSArray of NSString → ["a", "b"].
  function unarchiveStrings(bytes) {
    const root = readBplist(bytes);
    if (!root || !Array.isArray(root.$objects) || !root.$top) throw new Error("not a keyed archive");
    const objects = root.$objects;
    const resolve = (x) => (x && typeof x === "object" && "uid" in x ? objects[x.uid] : x);
    const asString = (x) => {
      x = resolve(x);
      if (typeof x === "string") return x === "$null" ? "" : x;
      if (x && typeof x === "object" && typeof resolve(x["NS.string"]) === "string") return resolve(x["NS.string"]);
      return "";
    };
    const top = resolve(root.$top.root !== undefined ? root.$top.root : Object.values(root.$top)[0]);
    const items = top && Array.isArray(top["NS.objects"]) ? top["NS.objects"] : [];
    return items.map(asString).filter(Boolean);
  }

  // A list field however it arrives: the NSKeyedArchiver bytes the apps
  // write today, or (defensively) a plain list or JSON. Unreadable → [].
  function stringList(field) {
    if (!field || field.value == null) return [];
    const v = field.value;
    if (Array.isArray(v)) return v.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim());
    if (typeof v !== "string" || !v) return [];
    try {
      const bytes = base64Bytes(v);
      if (bytes[0] === 0x5b) { const j = JSON.parse(new TextDecoder().decode(bytes)); return Array.isArray(j) ? j.filter((s) => typeof s === "string" && s.trim()) : []; }
      return unarchiveStrings(bytes).map((s) => s.trim()).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  // ------------------------------------------------------------ adapter

  // A CD_BusinessCard record → the shape the team page already shows
  // ({ fields: { firstName: { value } … } }), so tiles, list, search and
  // exports read a personal card exactly like a team card. `scannedAt` is
  // the card's addedAt; `photo` is the thumbnail.
  function adaptRecord(rec) {
    const raw = rec.fields || {};
    const get = (k) => raw["CD_" + k];
    const fields = {};
    for (const k of TEXT_FIELDS) {
      const x = get(k);
      if (x && typeof x.value === "string" && x.value.trim()) fields[k] = { value: x.value };
    }
    for (const k of DATE_FIELDS) {
      const x = get(k);
      if (x && typeof x.value === "number") fields[k] = { value: x.value };
    }
    const months = get("keepInTouchMonths");
    if (months && typeof months.value === "number" && months.value > 0) fields.keepInTouchMonths = { value: months.value };
    const mails = stringList(get("emails"));
    if (mails.length) fields.emails = { value: mails };
    const others = stringList(get("additionalPhones"));
    if (others.length) fields.additionalPhones = { value: others };
    if (fields.addedAt) fields.scannedAt = { value: fields.addedAt.value };
    const url = thumbnailURL(raw);
    if (url) fields.photo = { value: { downloadURL: url } };
    const id = get("id");
    return {
      recordName: rec.recordName,
      recordType: RECORD_TYPE,
      recordChangeTag: rec.recordChangeTag,
      cardID: (id && typeof id.value === "string" && id.value) || rec.recordName,
      personal: true,
      fields
    };
  }

  function thumbnailURL(raw) {
    const inline = raw.CD_thumbnailData;
    if (inline && typeof inline.value === "string" && inline.value.length > 16) return "data:image/jpeg;base64," + inline.value;
    const asset = raw.CD_thumbnailData_ckAsset;
    if (asset && asset.value && asset.value.downloadURL) return asset.value.downloadURL;
    return "";
  }

  // One card per cardlio id, the most recently modified copy (the apps'
  // uniqueAlive rule; the owner's library had no duplicates on 2026-10-05).
  function dedupe(records) {
    const best = new Map();
    const mod = (r) => (r.fields.modifiedAt && r.fields.modifiedAt.value) || 0;
    for (const r of records) {
      const have = best.get(r.cardID);
      if (!have || mod(r) > mod(have)) best.set(r.cardID, r);
    }
    return [...best.values()];
  }

  // -------------------------------------------------------- the rules

  const dateOf = (r, k) => (r.fields[k] && typeof r.fields[k].value === "number" ? r.fields[k].value : 0);

  // CardKit FollowUp.state: done once a done date exists, owed while only
  // the owed date does.
  function followUpOwed(r) {
    return !!dateOf(r, "followUpOwedAt") && !dateOf(r, "followUpDoneAt");
  }

  // CardKit KeepInTouch.state: due when the cadence has passed since the
  // last time in touch (the latest of "I was in touch", a done follow-up,
  // and the scan), counted in calendar months from that day's start.
  function reconnectDue(r, now) {
    const months = r.fields.keepInTouchMonths ? r.fields.keepInTouchMonths.value : 0;
    if (!months) return false;
    const added = dateOf(r, "addedAt");
    const contact = Math.max(dateOf(r, "lastContactAt"), dateOf(r, "followUpDoneAt"));
    const last = contact && contact >= added ? contact : added;
    if (!last) return false;
    const d = new Date(last);
    const due = new Date(d.getFullYear(), d.getMonth() + months, d.getDate());
    const today = new Date(now || Date.now());
    today.setHours(0, 0, 0, 0);
    return today >= due;
  }

  // The marker: any WebEntitlement record saying unlocked (one per
  // platform; either unlocks the web downloads).
  function isUnlocked(records) {
    return records.some((r) => r.recordType === "WebEntitlement" && r.fields && r.fields.unlocked && Number(r.fields.unlocked.value) === 1);
  }

  root.CardlioLibrary = {
    ZONE, RECORD_TYPE, WEB_ZONE, DESIRED_KEYS,
    readBplist, unarchiveStrings, stringList, adaptRecord, dedupe,
    followUpOwed, reconnectDue, isUnlocked
  };
})(typeof window !== "undefined" ? window : globalThis);
