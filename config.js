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
  apiToken: "5eaae7c31e30ec4b88fb359cf3e582c905a312741b53e14166b0afd0410ae521",
  // MapKit JS token for the My cards map (2026-10-06). Also public by
  // design: it is a JWT whose origin claim limits it to team.cardlio.app.
  // Empty = no Map button. Made by CardOCR/scripts/mapkit-token.swift from
  // the MapKit JS key (kept outside every repo); it lasts a year — renew it
  // before mapkitTokenExpires, or the map says the key has expired.
  mapkitToken: "eyJhbGciOiJFUzI1NiIsImtpZCI6Ik43QzRLVk4zWEMiLCJ0eXAiOiJKV1QifQ.eyJleHAiOjE4MjI4MjEwNDQsImlhdCI6MTc5MTI4NTA0NCwiaXNzIjoiOUhFRTRaMjQ5OCIsIm9yaWdpbiI6Imh0dHBzOlwvXC90ZWFtLmNhcmRsaW8uYXBwIn0.ol8YTt5HpdwNQdFmViQnF6s4jNjg2ZNJyaavxztylz7YW_Ji4_dAAczIkNuarxl5bmOThn9WxTU8oBqH1HEMQw",
  mapkitTokenExpires: "2027-10-06"
};
