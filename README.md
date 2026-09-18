# team.cardlio.app

The cardlio team library in the browser. Static, served by GitHub Pages
from `main` (custom domain in `CNAME`).

Status: placeholder page. The planned page uses Apple's CloudKit JS to read
the team zones (`TeamCard` records) after the visitor signs in with their
Apple ID. It is kept apart from cardlio.app on purpose: the main site makes
no third-party requests at all, and this page will have to talk to Apple's
iCloud.

DNS: a CNAME record `team` → `dive76.github.io` at the domain's DNS host.
