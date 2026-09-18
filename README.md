# team.cardlio.app

The cardlio team library in the browser. Static, served by GitHub Pages
from `main` (custom domain in `CNAME`).

Status: placeholder page. The planned page uses Apple's CloudKit JS to read
the team zones (`TeamCard` records) after the visitor signs in with their
Apple ID. It is kept apart from cardlio.app on purpose: the main site makes
no third-party requests at all, and this page will have to talk to Apple's
iCloud.

DNS: a CNAME record `team` → `dive76.github.io` at the domain's DNS host.

## /spike/ — CloudKit JS test (read-only)

https://team.cardlio.app/spike/ signs in with an Apple ID and lists the
teams that account owns (private database) and joined (shared database),
then a team's cards with their photos. It only opens zones named `team-…`
(the same private database also holds the person's own card library) and
never writes.

Needs the CloudKit API token in `spike/config.js`. The token is public by
design: CloudKit honours it only for the allowed origin, and every read
still needs the visitor's own Apple ID sign-in.
