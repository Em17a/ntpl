# Nightplay Rewrite v2 — Preservation-First Plan

## Safety rules

- This branch is isolated: `rewrite-v2-clean`. Do not deploy it to production until acceptance checks pass.
- Production branch `cloudflare-migration` remains untouched during the rewrite.
- Do not delete, rename, or migrate production D1 data as part of code cleanup.
- Preserve the current Cloudflare deployment contract: Worker entry `src/index.ts`, Static Assets `public/`, Durable Object binding `NIGHTPLAY_ROOM`, D1 binding `DB`, and the existing database ID.
- Keep old Netlify/server implementations read-only as reference until each feature has a replacement and regression test. Only then decide whether to remove them from the release branch.
- Reference project: `erhaerha66/duet-rhythm-plus`, tag `v1.1.1`, MIT license. Preserve its license notice for any substantial copied portions.

## Feature preservation checklist

The rewrite is not complete unless each applicable item has a replacement and a passing regression test:

- [ ] Main landing page and existing navigation / responsive mobile layout
- [ ] Guest identity, age confirmation, nickname and profile preferences
- [ ] Random matchmaking: gender preference, role preference and voice preference. The current Nightplay UI/schema has no separate shared-round-limit preference; do not invent one solely because the reference project has it.
- [ ] Dedicated matchmaking waiting screen and elapsed-seconds timer
- [ ] Cancel matchmaking: immediate UI exit, server-side cancellation, safe handling of join/poll/cancel races
- [ ] Matched room handoff: both clients receive the same valid room and distinct roles
- [ ] Private room creation, custom room name, room code join
- [ ] Public room publishing, public room list and spectator/watch flow
- [ ] Two-person room membership, reconnect/recovery, heartbeat, expiry (5–120 minutes where configured)
- [ ] Room chat, text contact blocking, and local-only voice contact protection with privacy safeguards
- [ ] WebRTC voice signaling, explicit microphone permission and current relay behavior
- [ ] Challenge / metronome state, pause/resume/end, controller/receiver permissions
- [ ] S/M quick phrases displayed in the challenge UI, not unintentionally emitted to public chat
- [ ] Friends, friend requests, presence and friend chat
- [ ] Match history and add-friend-after-match flow
- [ ] Online counts / active-room directory
- [ ] Existing security headers, origin checks, validation, rate limits and secrets handling

## Initial repository findings

- Cloudflare production entry is `src/index.ts`; static frontend is `public/index.html`.
- Current deployment bindings are declared in `wrangler.jsonc`; preserve the existing D1 binding and Durable Object class/migration compatibility.
- The repository still contains the former Netlify implementation (`netlify/`, `server.ts`, root `index.ts`, old schema/config/docs). These are not the active Wrangler entry points, but they may contain feature behavior and must not be deleted until mapped.
- Current matchmaking has an HTTP path in the Worker plus legacy matchmaking handling in the Durable Object. The rewrite should define one authoritative matchmaking state machine and one client-facing contract.
- The current single-file frontend is large; split it by responsibility only after its DOM IDs, event handlers, and feature behavior have been inventoried.

## Target architecture

1. **Client UI** — page shell, matchmaking screen/timer, room view, social/public-room panels.
2. **Client services** — typed API client, matchmaking lifecycle, room sync, WebRTC signaling, chat/social actions.
3. **Worker API** — `src/index.ts` is a small static/API router; feature APIs are split into focused modules.
4. **Matchmaking coordinator** — `src/matchmaking-api.ts`, `src/matchmaking-service.ts`, and `src/matchmaking-core.ts` own the HTTP contract, authoritative queue, compatibility, cancellation tombstones, leases and atomic room allocation.
5. **Room runtime** — `src/nightplay-room.ts` owns live membership, chat, challenge state, WebRTC signaling and room lifecycle.
6. **Supporting APIs** — social, public-room/directory, RTC configuration and contact protection are separate modules.
7. **Persistence** — D1 repository operations and explicit migrations; preserve existing schema/data compatibility.
8. **Regression suite** — feature-level tests, API contract tests, matchmaking race tests, privacy guards and build/type checks.

## Acceptance gates before merge/deploy

- All feature checklist items are mapped and tested.
- Two independent browser clients can match and enter the same room with opposite roles.
- Cancel returns to the idle screen promptly; the server confirms cancellation; delayed join/poll requests cannot resurrect the queue entry.
- Match timer starts on entry to the waiting screen, advances once per second, and stops on match/cancel/error.
- Private/public rooms, spectator flow, chat, voice signaling, challenge controls, quick phrases, friends and history pass regression tests.
- `npm run check` passes on the rewrite branch.
- Cloudflare deployment dry-run succeeds without changing production resources.
- Only after the user reviews the test result should the rewrite be merged and deployed.


## Current rewrite status (not final acceptance)

- The frontend shell, stylesheet and browser application are separate files.
- The Worker router and Durable Object room runtime are separate modules; the Durable Object export name and Cloudflare bindings remain unchanged.
- Matchmaking has one HTTP contract; the duplicate WebSocket matchmaking path was removed from both client and server.
- Social, room-directory, RTC configuration and contact-protection logic have dedicated modules.
- Automated CI currently covers 44 tests and runs TypeScript checks plus Wrangler dry-run. The final head must be checked again after the last edit.
- Real two-device matching, microphone/model behavior, spectator flow and all end-to-end UI interactions still require browser testing before merge/deploy.
