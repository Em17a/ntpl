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
- [ ] Random matchmaking: gender preference, role preference, voice preference, shared challenge limits
- [ ] Dedicated matchmaking waiting screen and elapsed-seconds timer
- [ ] Cancel matchmaking: immediate UI exit, server-side cancellation, safe handling of join/poll/cancel races
- [ ] Matched room handoff: both clients receive the same valid room and distinct roles
- [ ] Private room creation, custom room name, room code join
- [ ] Public room publishing, public room list and spectator/watch flow
- [ ] Two-person room membership, reconnect/recovery, heartbeat, expiry (5–120 minutes where configured)
- [ ] Room chat and existing moderation/report safeguards
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
3. **Worker API** — validation/auth/identity and stable HTTP contracts; no duplicate business logic.
4. **Matchmaking coordinator** — server-authoritative queue, compatibility rules, cancellation tombstones, lease/heartbeat, atomic room allocation and idempotent handoff.
5. **Room runtime** — Durable Object owns live room membership, chat, challenge state, signaling and room lifecycle.
6. **Persistence** — D1 repository layer and explicit migrations; preserve existing schema/data compatibility.
7. **Regression suite** — feature-level tests, API contract tests, matchmaking race tests, and build/type checks.

## Acceptance gates before merge/deploy

- All feature checklist items are mapped and tested.
- Two independent browser clients can match and enter the same room with opposite roles.
- Cancel returns to the idle screen promptly; the server confirms cancellation; delayed join/poll requests cannot resurrect the queue entry.
- Match timer starts on entry to the waiting screen, advances once per second, and stops on match/cancel/error.
- Private/public rooms, spectator flow, chat, voice signaling, challenge controls, quick phrases, friends and history pass regression tests.
- `npm run check` passes on the rewrite branch.
- Cloudflare deployment dry-run succeeds without changing production resources.
- Only after the user reviews the test result should the rewrite be merged and deployed.
