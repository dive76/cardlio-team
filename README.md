# team.cardlio.app

The cardlio team library in the browser. Static, served by GitHub Pages
from `main` (custom domain in `CNAME`).

Status: placeholder page. The planned page uses Apple's CloudKit JS to read
the team zones (`TeamCard` records) after the visitor signs in with their
Apple ID. It is kept apart from cardlio.app on purpose: the main site makes
no third-party requests at all, and this page will have to talk to Apple's
iCloud.

DNS: a CNAME record `team` → `dive76.github.io` at the domain's DNS host.

## The page

`index.html` + `app.js` + `app.css` — no build step. Sign in with an Apple
ID (Apple's CloudKit JS; token in `config.js`, public by design, locked to
this origin), then:

  * teams the account OWNS (private database) and JOINED (shared database);
    a team is a `team-…` zone with a `TeamInfo` record (its name — the web
    API cannot see the zone-wide share the apps take it from);
  * stats, search (accent-insensitive), All / Unclaimed / Claimed, event
    chips, sort; a detail view with every field, copy buttons, mail / tel /
    Apple Maps links;
  * vCard per card (photo embedded when the image host allows it), vCard or
    CSV export of what is on screen;
  * JOIN a team from its iCloud invite link (pasted, or
    `team.cardlio.app/#join=<link>`, kept through Apple's sign-in):
    `fetchRecordInfos` previews it, `acceptShares` accepts it for the
    signed-in Apple ID — which must be on the team's list (invite-only).
    This is what lets someone without an iPhone or Mac join.
  * CLAIM — the page's only write to a team: `claimedBy` on one `TeamCard`, sent as a
    conflict-checked UPDATE (only that field; refused if the card changed).

Safety: the private database also holds the person's own card library, so
the page opens only `team-…` zones. Card text is untrusted: textContent
only; websites must parse as http(s); CSV cells that could be formulas are
prefixed. CSP allows scripts from this site and Apple's CDN only.

`/spike/` forwards here (the first read-only test lived there).

## What it does (2026-09-19)

- Lists the teams the signed-in Apple ID owns or joined; search, filter (unclaimed / claimed / event), sort.
- Claim a card (with the name you claim under) — or **Claim all** the unclaimed cards shown, downloaded as one vCard file.
- **Release** a card you claimed yourself (a mis-tap); a claimed card can still be **downloaded as a copy**.
- **Auto-refresh**: every 60 s while the tab is visible the team's zone is re-read; claims apply in place, new cards show as a "N new cards — show" pill.
- **Deep links**: `#team=<zone>&card=<recordName>` opens a card; **Copy link** in the detail.
- **Installable** (web manifest + a small service worker for the shell; every iCloud call stays on the network).
- Join a team from an invite link.
- **Add a card** by hand (a member on Windows meets people too) — a `TeamCard` record with `scannedBy` = their name; **Edit** a card for the whole team (only the changed fields are sent; claimed copies in libraries are separate).
- **Import vCard** — drop a `.vcf` anywhere on the page (or pick one): vCard 2.1 / 3.0 / 4.0, one card or a whole address book. ⚠️ Photos in the file are NOT uploaded in practice: CloudKit's asset host (`cws.icloud-content.com`) refuses the browser's cross-origin POST, so the card is saved without its photo (verified live 2026-09-21). A preview lists the contacts and marks the ones the team already holds.
- **Everything (ZIP)**: the vCards with photos, the CSV and each card photo as a JPEG — a stored ZIP written in the page.
- **Dashboard**: unclaimed and who claimed how many, who shared how many, the last seven days as bars.
- **Keyboard**: `/` to search, arrows / Home / End across the cards, Enter opens.
- **Possible duplicate**: the apps' detector rule (a personal e-mail at the same company, or the same name + company) flags two cards of one visitor and links them.
- **Team notes** on a card (the `teamNotes` field, deployed 2026-09-20): anyone on the team edits, the first line shows on the tile and in the list, the CSV carries the column.
- **Looks (2026-09-20)**: a card without a photo is typeset AS a card (name, title, company, accent bar) instead of initials; the team header is a hero with the cards' date range and the people who shared or claimed (as the cards name them — the web API cannot read the share's participant list); a photo opens full-size in a lightbox (click to zoom, rotate); tiles rise in, dialogs ease in, empty states carry a card illustration; a **list view** toggle (dense table: name, company, event, shared by, claimed by, note; sortable on the first four; the choice is remembered); a dark-mode contrast pass; on a phone a **bottom action bar** (Search · Add · Claim all · Export) replaces the toolbar buttons and the grid goes single-column under 480 px.
- **Multi-select** (2026-09-20): tick a tile (top-right) or a list row — shift-click for a range — and a selection bar offers Claim (the unclaimed ones), vCard, CSV, ZIP and Print for just those; Esc clears.
- **Filters** "Mine" (claimed under your name) and "With notes"; the filter, the sort and the grid/list choice are remembered per browser.
- **Read a card photo with your own AI key** (2026-09-21): Scan photo (or drop a photo on the page; on a phone the bottom bar's Scan offers the camera or the library) sends the photo, downscaled to 1600 px, to Claude or Gemini under the member's **own** API key — the app's exact extraction prompt and field schema, so the two clients read the same way — and pre-fills the Add card form, with the photo shown beside it for the check; the photo itself is NOT saved (the apps share a cropped, straightened card image — a raw phone photo is not one). The key lives in this browser only (session, or remembered on the device; Forget keys clears it). Building joins the street line; honorific and fax go to the notes, since a TeamCard has neither. Anthropic is called with its browser-access header; a Gemini key should be restricted to this site's referrer. CSP allows exactly those two hosts.
- **Print sheet** (Export → Print sheet, or Print on the selection bar): a roster on paper — tick box, name and title, company and place, e-mail and mobile, shared by, claimed by, team note — of the cards shown (or selected), with the filter and time in the header.

Writes: `claimedBy` on a `TeamCard` (claim and release), creating a `TeamCard`, editing a `TeamCard`'s fields — each a conflict-checked batch — and accepting an invite.
