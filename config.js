// CloudKit web access for team.cardlio.app.
//
// The API token is PUBLIC by design: CloudKit only honours it for the
// origins allowed in the CloudKit console (team.cardlio.app), and it
// grants nothing by itself — every read still needs the visitor to sign
// in with their own Apple ID. Create it in the CloudKit console:
// iCloud.gruenitz.CardOCR → API Access → API Tokens → New, with
// Sign-in Callback "postMessage" and allowed origin https://team.cardlio.app.
window.CARDLIO_TEAM_CONFIG = {
  containerIdentifier: "iCloud.gruenitz.CardOCR",
  environment: "production",
  apiToken: "5eaae7c31e30ec4b88fb359cf3e582c905a312741b53e14166b0afd0410ae521"
};
