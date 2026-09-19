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
- **Everything (ZIP)**: the vCards with photos, the CSV and each card photo as a JPEG — a stored ZIP written in the page.
- **Dashboard**: unclaimed and who claimed how many, who shared how many, the last seven days as bars.
- **Keyboard**: `/` to search, arrows / Home / End across the cards, Enter opens.
- **Possible duplicate**: the apps' detector rule (a personal e-mail at the same company, or the same name + company) flags two cards of one visitor and links them.

Writes: `claimedBy` on a `TeamCard` (claim and release), creating a `TeamCard`, editing a `TeamCard`'s fields — each a conflict-checked batch — and accepting an invite.
