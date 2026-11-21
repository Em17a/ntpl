# Nightplay Rewrite v2 — Code Audit

## Scope and safety

- Work is isolated to `rewrite-v2-clean`.
- Production branch `cloudflare-migration` and the production D1 database are unchanged.
- Cloudflare bindings, Durable Object class/migration, and D1 database ID remain unchanged.
- The reference implementation is `erhaerha66/duet-rhythm-plus@v1.1.1` (MIT). Its remote multiplayer lifecycle is being adapted to Cloudflare rather than copying its Node server runtime.

## Active Cloudflare surface

- Worker entry/router: `src/index.ts`
- Durable Object room runtime: `src/nightplay-room.ts`
- Matchmaking contract: `src/matchmaking-api.ts`
- Matchmaking persistence/coordinator: `src/matchmaking-service.ts`
- Match compatibility and role assignment: `src/matchmaking-core.ts`
- Guest social APIs: `src/social-api.ts`
- Public-room, online-presence and spectator directory APIs: `src/directory-api.ts`
- Authenticated WebRTC ICE/TURN configuration: `src/rtc-api.ts`
- Contact text/voice moderation rules: `src/contact-protection.ts`
- Durable Object class export: `NightplayRoom` re-exported from `src/index.ts`, implemented in `src/nightplay-room.ts`
- Static shell: `public/index.html`
- Styles: `public/styles.css`
- Browser application: `public/app.js`

## Existing HTTP API inventory

- `POST /api/matchmaking` — join, poll, cancel
- `GET /api/public-rooms` — public room directory
- `GET /api/rooms/:code` — room availability/expiry
- `POST /api/online/heartbeat` — site online count
- `GET /api/watchable` — rooms with mutual spectator consent
- `POST /api/friends/presence`
- `GET /api/friends`
- `PATCH /api/friends/profile`
- `POST /api/friends/request`
- `POST /api/friends/respond`
- `GET /api/dm` and `POST /api/dm`
- `GET /api/history`
- `GET /api/rtc-config`
- `GET /api/health`

## Existing WebSocket room protocol inventory

- `join`, `ping`, `leave`
- `chat`, `typing`, `action`
- `metronome_state`, `metronome_emergency_stop`
- `voice_signal`
- `watch_join`, `watch_consent`, `watch_leave`

The previous parallel WebSocket matchmaking protocol (`matchmaking_join`, `matchmaking_cancel`, and its socket-local poll state) has been removed. The browser now uses one HTTP matchmaking contract; WebSocket is used for the matched room handoff and live room features only.

## Reference multiplayer behavior mapped

The reference project's core pairing behavior is in `server/game.mjs`:
- A single authoritative queue is owned by the server-side state coordinator.
- Pairing checks reciprocal gender preferences, opposite/automatic roles, voice agreement, and shared round limits.
- Queue membership is refreshed by polling/touch operations.
- Cancellation is tied to the current match attempt ID so a late request cannot cancel a later attempt.
- A successful pair is removed from the queue and creates one authoritative room with two participants.

Nightplay adaptations:
- Each match attempt uses a fresh UUID `clientId` as its attempt identity.
- `joinMatchmaking` is now the only function that can create or refresh a waiting row.
- A cancelled row is retained as a tombstone; a delayed initial join cannot recreate it.
- Poll actively attempts pairing and refreshes the queue lease.
- Cancellation never overwrites a committed match; it returns the matched room if the match won the race.
- Room allocation and both participant seats are committed together through D1 batch.
- Gender and role compatibility remain reciprocal; voice preferences now follow the reference project's agreement rule rather than being a soft ranking-only preference.
- Challenge-limit matching is not added as a new preference until an existing Nightplay UI control and persisted field are confirmed; the reference's round-limit model is not assumed to exist in Nightplay.

## Changes completed in this branch

- Extracted the 39 KB inline stylesheet into `public/styles.css`.
- Extracted the 60 KB inline browser application into `public/app.js`; `public/index.html` is now the page shell.
- Updated the frontend syntax test to validate the extracted asset and shell references.
- Added a single `joinMatchmaking` service entry point.
- Removed the unused duplicate WebSocket matchmaking join/cancel/poll implementation.
- Extracted request validation and HTTP state mapping into `src/matchmaking-api.ts`.
- Added tests for the HTTP join/poll/handoff contract, cancellation tombstones, cancellation-vs-poll races, and origin rejection.
- Added reciprocal voice-preference compatibility tests.
- Extracted social, public-room/directory and RTC configuration endpoints from the Durable Object class.
- Restored text contact blocking on both client and server, including 12-second split-message context and in-memory escalation state.
- Restored local-only Chinese voice contact detection; microphone access fails closed if the on-device model/API is unavailable, and WebRTC uplink passes through a 1.6-second audio delay/gate.

## Still required before acceptance

- Inspect and refactor the room lifecycle / Durable Object responsibilities without changing the deployed class name or migration compatibility.
- Map every frontend feature and every HTTP/WebSocket action to regression coverage.
- Add deterministic race tests for join/poll/cancel ordering and duplicate requests.
- Validate public room publishing, custom names, room expiry, spectator consent and reconnect.
- Validate voice signaling and TURN configuration, including the on-device Chinese model flow and the 1.6-second outbound audio gate.
- Validate contact-protection text patterns, split-message handling, violation escalation, and fail-closed voice behavior.
- Validate challenge/metronome permissions, stop/end behavior and S/M quick-phrase placement.
- Validate friend requests, direct messages, presence, history and post-match friend action.
- Run `npm run check` on the final rewrite head.
- Perform two-device browser testing before merge/deploy.
- Do not merge or deploy until the user reviews the result.
