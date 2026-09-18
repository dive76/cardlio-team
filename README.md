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
  * CLAIM — the page's only write: `claimedBy` on one `TeamCard`, sent as a
    conflict-checked UPDATE (only that field; refused if the card changed).

Safety: the private database also holds the person's own card library, so
the page opens only `team-…` zones. Card text is untrusted: textContent
only; websites must parse as http(s); CSV cells that could be formulas are
prefixed. CSP allows scripts from this site and Apple's CDN only.

`/spike/` forwards here (the first read-only test lived there).
