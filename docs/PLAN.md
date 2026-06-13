# token-poker — Implementation Plan

## Context

We're building **token-poker** from scratch in an empty git repo. It's a fun twist on
agile **planning poker**: instead of estimating story points, a team estimates **how many
LLM tokens** a feature/task will take to develop, and the app rolls that up into a
**rough cost estimate** (tokens × model price). Standard planning-poker flow otherwise —
host creates a room, players join with a code, a story is presented, everyone privately
picks a token-estimate card, all reveal at once, discuss outliers, optionally re-vote,
then move on.

**Deployment target (decided):** a cheap **Hetzner Cloud VPS** (root Linux, e.g. ARM
**CAX11** ~€3.79/mo). Because we control the box, real-time is done with **true WebSocket
push** (no polling) and we use a single-language TypeScript stack. The tradeoff vs. shared
hosting is that we own the ops (reverse proxy, TLS, process manager, deploys) — covered in
the deploy section.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Realtime + backend | **Node.js + TypeScript + Socket.IO** | Socket.IO *rooms* map 1:1 to poker rooms; built-in auto-reconnect + presence; true push |
| DB | **SQLite** via `better-sqlite3` | Zero external service, single file, ideal at this scale; survives restarts |
| Frontend | **Vite + React + TypeScript** | Reactive UI fits live-pushed state; we control the build on the VPS |
| Reverse proxy + TLS | **Caddy** | Automatic HTTPS (Let's Encrypt); serves static build + proxies WS to Node; sets security headers |
| Process mgmt | **systemd** unit (`Restart=always`) | Built-in, no extra dependency |
| Input validation | **zod** schemas on every inbound event | Reject malformed/oversized payloads at the boundary |
| Shared types | npm **workspaces** | Server and web share event/payload types — no drift |

## Repository layout (npm workspaces monorepo)

```
token-poker/
├── package.json                 # workspaces: ["server","web","shared"]
├── shared/                      # shared TS types (card deck, event payloads, snapshot)
│   └── src/types.ts
├── server/
│   ├── src/
│   │   ├── index.ts             # http server + Socket.IO bootstrap, /healthz
│   │   ├── events.ts            # socket handlers: join, vote, reveal, reset, next, addStory
│   │   ├── rooms.ts             # in-memory room registry + state machine (authoritative)
│   │   ├── db.ts                # better-sqlite3: persistence + rehydrate on boot
│   │   ├── pricing.ts           # model pricing table + cost calc
│   │   └── snapshot.ts          # build per-client snapshot (enforces vote privacy)
│   ├── package.json
│   └── tsconfig.json
├── web/
│   ├── src/
│   │   ├── main.tsx
│   │   ├── socket.ts            # socket.io-client wrapper + reconnect/rejoin
│   │   ├── store.ts             # client state from pushed snapshots (React context/zustand)
│   │   ├── deck.ts              # card labels (display)
│   │   └── screens/            # Landing, Room, Voting, Reveal, Results
│   ├── index.html
│   ├── vite.config.ts          # dev proxy → local Node; build → web/dist
│   └── package.json
├── deploy/
│   ├── Caddyfile
│   ├── token-poker.service      # systemd unit
│   └── deploy.sh                # git pull → npm ci → build → restart
└── README.md
```

## Running & testing locally (no VPS, no Caddy, no domain)

This is the **primary path** — the whole app runs self-contained on your machine before any
deployment exists. Local and production differ **only by environment variables** (CORS
origin, bind address, TLS termination), never by code, so what you test locally is what
ships.

- `npm run dev` — runs the Node + Socket.IO server and the Vite dev server concurrently
  (Vite proxies `/socket.io` to the local Node server). Open `http://localhost:5173`.
  SQLite is just a local file (`./data/dev.sqlite`); nothing external is required.
- **Multi-user testing on one machine:** open 2–3 browser windows/incognito tabs — each is a
  separate player; you'll see live joins/votes/reveals across them.
- **Multi-device testing on your LAN (optional):** set `HOST=0.0.0.0` and hit
  `http://<your-laptop-LAN-IP>:5173` from a phone/another laptop. Works over plain
  `http`/`ws` on localhost/LAN — no certs needed.
- `npm run start:local` — production-style run *without* infra: builds the web app and has
  Node serve `web/dist` + the socket on a single port (`http://localhost:3000`). Lets you
  exercise the exact built artifact locally before deploying.

Deployment to Hetzner is a **separate, optional section at the end** — you do not need any of
it to run, test, or demo the app.

## Domain model

Authoritative state lives **in memory** in `rooms.ts` and is mirrored to **SQLite** so a
restart rehydrates active rooms. Entities:

- **Room** — `code` (random URL-safe slug, see *Shareable URLs* below), `hostToken`,
  `modelId`, `outputRatio` (default 0.5), players, stories, `createdAt`, `updatedAt`,
  **`expiresAt`**.
- **Player** — `id`, `token` (secret), `name`, `isHost`, `isSpectator`, `online`.
- **Story** — `id`, `title`, `description`, `status` (`pending|voting|revealed|done`),
  `round`, `finalEstimate?`.
- **Vote** — `storyId`, `playerId`, `round`, `cardValue` (string; numeric buckets + the
  `?`/`☕` sentinels coexist; rollups cast numeric only).

SQLite schema mirrors these (rooms, players, stories, votes) with FKs `ON DELETE CASCADE`.
On boot, load non-expired rooms into memory; a periodic sweep purges expired rooms.

### Shareable URLs that expire

- Each room gets a **randomly generated, URL-safe slug** (`crypto.randomBytes` → base58,
  ~8 chars, ambiguous chars dropped). The slug is both the type-in **code** and the path of
  a shareable link: **`https://<host>/r/<slug>`**. Visiting the link opens the join screen
  with the room prefilled — no code typing needed. Locally this is `http://localhost:5173/r/<slug>`.
- **Expiry:** every room carries `expiresAt`. Default policy (configurable via env):
  **idle expiry ~4h** since last activity, **absolute cap ~24h**. The sweep deletes expired
  rooms (CASCADE removes players/stories/votes), so the link stops working by design.
- **Expired link UX:** requesting `/r/<slug>` for a gone/expired room shows a clean
  "**This room has expired**" screen with a button to create a new one — no stack traces,
  no silent failure. Slugs are single-use per room and not recycled.
- Generous entropy + expiry + rate limiting together make link-guessing impractical; the
  slug itself is the join capability (privileged actions still need the secret tokens).

## Real-time protocol (Socket.IO)

All actions are socket events; **every mutation re-emits a fresh snapshot** to the room —
`io.to(code).emit('state', snapshot)`. No polling, no version counter needed (the server
pushes on change).

**Client → server**
- `room:create {name, modelId}` → `{code, hostToken, playerToken, snapshot}`
- `room:join {code, name, playerToken?}` → `{playerToken, snapshot}` (rejoin if token given)
- `vote {storyId, round, cardValue}`
- host-only (require `hostToken`): `reveal {storyId}`, `reset {storyId}` (new round),
  `nextStory {storyId, finalEstimate?}`, `addStory {title, description?}`

**Server → client**
- `state {snapshot}` — full authoritative snapshot (single source of truth for render)
- `error {message}`

**Vote privacy is server-enforced in `snapshot.ts`:** pre-reveal, the snapshot includes
only `{playerId, hasVoted}` — `cardValue` appears only when the story is `revealed`. The
client never receives hidden votes.

**Presence & reconnection:** a live socket = online; `disconnect` marks the player offline
and broadcasts. `socket.io-client` auto-reconnects; on reconnect the client re-emits
`room:join` with the stored `playerToken` to rejoin the channel and restore state. Offline
players are excluded from "waiting on N voters" so reveal isn't blocked by someone who left.

**Auth:** `playerToken`/`hostToken` are random secrets in `localStorage` (keyed by room
code); host-only events verify `hostToken` server-side.

## Token-estimation + cost feature

**Card deck:** `1k, 5k, 10k, 25k, 50k, 100k, 250k, 500k, 1M, ?, ☕`. Numeric cards are raw
ints; `?`/`☕` are sentinels excluded from all math.

**Pricing table** in `server/src/pricing.ts`, seeded with current Claude per-**million**-
token prices (verified via the claude-api reference):

```ts
export const PRICING = {
  'claude-opus-4-8':   { label: 'Opus 4.8',   in: 5.00,  out: 25.00 },
  'claude-sonnet-4-6': { label: 'Sonnet 4.6', in: 3.00,  out: 15.00 },
  'claude-haiku-4-5':  { label: 'Haiku 4.5',  in: 1.00,  out: 5.00  },
  'claude-fable-5':    { label: 'Fable 5',    in: 10.00, out: 50.00 },
} as const;
```

**Cost rollup (server-side):** split an estimate into input/output by the room's
`outputRatio` (default 0.5):
`costUsd = estimate * ((1 - ratio) * priceIn + ratio * priceOut) / 1_000_000`.
Computed per `done` story and as a room total; included in every snapshot so all clients
agree. **At reveal:** show median, mean, min/max, spread over numeric votes; host picks
`finalEstimate` (default = median rounded to nearest bucket), then accepts → next story.

## Frontend screens (`web/src/screens`, rendered from the pushed snapshot)

1. **Landing** — Create room (name + model dropdown) / Join room (code + name).
2. **Lobby/Room** — player list with online dots + "voted" checks; host controls; model + effective $/1k-tokens badge; **"Copy invite link"** (`/r/<slug>`) + a subtle room-expiry hint ("expires in ~3h").
3. **Voting** — story title/description, card-deck buttons, your pick highlighted, live "N of M voted" (no values); host Reveal button.
4. **Reveal** — all cards face-up by player (flip animation), aggregates, outliers highlighted; host Re-vote or Accept→next with editable `finalEstimate`.
5. **Results** — table of done stories (title, final tokens, cost), grand totals, model used; copy-to-clipboard (markdown/CSV) for pasting into a ticket.
6. **Expired** — shown when `/r/<slug>` points to a gone/expired room: "This room has expired" + create-new button.

## Design / UI — dark + violet, modern & sleek

A clean, minimal, dev-tool aesthetic. **All theming via CSS custom properties (design
tokens)** in one place, so the palette is centralized (and a light theme could be added later
by swapping variables).

**Palette**
```
--bg        #0D0D12   /* near-black canvas */
--surface   #17171F   /* cards, panels    */
--surface-2 #1F1F2A   /* raised / hover   */
--border    #2A2A38   /* hairline borders */
--text      #ECECF1
--muted     #9A9AA8
--accent    #7C5CFF   /* electric violet — selection, primary buttons, focus */
--accent-2  #A78BFA   /* lighter violet for gradients/glow */
--success   #34D399   --warn #F59E0B   --danger #F87171
```

**Typography & numerals**
- Display/UI: a distinctive modern grotesk (e.g. **Space Grotesk** or **Geist**) — deliberately
  *not* Inter/Roboto/system defaults, to avoid generic "AI slop" look.
- **Token counts & costs in a monospace with tabular figures** (e.g. **Geist Mono** /
  **JetBrains Mono**) — fits the numeric/LLM theme and keeps columns aligned.

**Feel**
- Generous spacing, ~14–16px card radius, 1px hairline borders, restrained shadows, a soft
  violet **glow** on the active/selected card and primary buttons.
- Subtle micro-interactions: card hover lift, **flip animation on reveal**, smooth presence-dot
  and toast transitions. Respect `prefers-reduced-motion`.
- Fully responsive (works on a phone for quick mobile voting).
- No heavy CSS framework — plain CSS (with variables) or CSS Modules via Vite; minimal deps.

## Build order — Part A: build & test entirely locally

These phases need **nothing but your laptop** (`npm run dev`). The app is fully usable and
testable at the end of Phase 4 with no server, domain, or deployment. The **dark + violet
design tokens** are set up in Phase 0 and applied as each screen is built.

- **Phase 0 — Scaffold:** workspaces, `shared/types.ts`, server bootstrap + `/healthz`, Vite app shell, SQLite schema in `db.ts`. Verify `npm run dev` serves web + connects socket.
- **Phase 1 — Room lifecycle + shareable URLs:** `room:create` / `room:join`, random slug, **`/r/<slug>` routing + copy-invite-link**, in-memory registry, snapshot push, Landing + Room UI. **Tokens, zod validation, and host-token gating land here** (security is built in from the first endpoint, not bolted on). Prove two browser windows see each other join via a pasted link.
- **Phase 2 — Voting + reveal:** `addStory`, `vote`, `reveal`, `reset`, `nextStory`; voting/reveal views; server-side vote privacy. Prove simultaneous reveal.
- **Phase 3 — Cost feature:** pricing, aggregates, `finalEstimate`, results screen, model selector.
- **Phase 4 — Resilience, expiry & abuse limits:** SQLite persistence + boot rehydrate, presence/online dots, reconnect-rejoin from localStorage, **room `expiresAt` + sweep + Expired screen + expiry hint in UI**, rate limiting + per-IP/room caps, `maxHttpBufferSize`, error toasts, clipboard export. All testable locally (restart the local server; set a short TTL to watch a room expire; run the security script against localhost).

→ **Stop here and use the app locally as long as you like.** Deployment below is optional.

## Build order — Part B: deployment (later, optional — only when you're happy locally)

- **Phase 5 — Deploy & hardening:** provision Hetzner VPS, SSH key-only + ufw + fail2ban + unattended-upgrades, Caddy (HTTPS + security headers + CSP) → Node on `127.0.0.1`, systemd unit, smoke test across two devices. **No app code changes** — only env vars (CORS origin, bind, TLS via Caddy) differ from local.

## Security & abuse hardening

The server is a public, unauthenticated WS endpoint — anyone can connect. Threat model and
mitigations, by layer:

**Identity & authorization**
- Identity is a **128-bit crypto-random `playerToken`** (`crypto.randomBytes`), not the
  display name. Host actions require a separate secret **`hostToken`**, verified server-side
  on every host-only event. The client can never set `isHost`/`playerId` — the server
  assigns them. Tokens are never included in snapshots sent to *other* players.
- Room codes are deliberately **join capabilities** (like a meeting link). They grant join,
  nothing more; all privileged actions still require the secret tokens.

**Vote integrity & privacy**
- Raw votes live only in server memory; `snapshot.ts` omits `cardValue` until a story is
  `revealed`. The server is the sole holder of hidden votes — clients cannot peek, and a
  player can't overwrite another's vote (votes keyed by authenticated `playerId`).

**Input validation & injection**
- **Every inbound event payload is parsed with a zod schema** — exact shapes, `cardValue`
  restricted to a known enum, hard length caps (name ≤40, title ≤255, description ≤2000).
  Malformed/oversized payloads are rejected before any handler runs (also blocks unexpected
  types / prototype-pollution shapes).
- SQLite access is **prepared statements only** (`better-sqlite3`) — no string-built SQL.

**XSS**
- React escapes all rendered text by default; **no `dangerouslySetInnerHTML`**. Caddy sets a
  strict **Content-Security-Policy** (plus `X-Content-Type-Options`, `Referrer-Policy`,
  `X-Frame-Options: DENY`).

**DoS / resource exhaustion**
- Socket.IO `maxHttpBufferSize` small (~8 KB); per-socket **token-bucket rate limiting** on
  events; per-IP connection cap. Caps on **rooms-per-IP, players-per-room, stories-per-room**.
- **Room TTL + idle sweep** bounds memory and disk; bot/flood rooms expire automatically.
- Caddy provides a first-line connection/request limit and request-body cap.

**Transport & CORS**
- **HTTPS/WSS only** (Caddy auto-TLS); HSTS; 80→443 redirect. Socket.IO `cors.origin`
  restricted to our own domain — cross-origin handshakes rejected. Auth tokens travel in
  payload/localStorage (no ambient auth cookie), so classic CSRF doesn't apply.

**Host / server hardening**
- Non-root service user; **SSH key-only** (password auth disabled); `ufw` allows only
  22/80/443; **fail2ban** on SSH; **unattended-upgrades** for OS patches. Node binds to
  `127.0.0.1` only (sole public surface is Caddy). SQLite file perms restricted to the
  service user.

**Supply chain**
- Minimal dependencies; pinned versions; `npm ci`; `npm audit` (and Dependabot) in CI.

## Key risks & edge cases

- **State authority:** in-memory room state is the single source of truth; SQLite is the durable mirror. Snapshots are server-built — clients never compute shared state.
- **Restart durability:** rehydrate active (non-stale) rooms from SQLite on boot; clients auto-reconnect and re-join.
- **Ghost players:** mark offline on `disconnect`; exclude from "waiting on N voters"; don't delete (they may reconnect).
- **Sentinel cards:** always filter out `?`/`☕` before averaging, or one `?` poisons the math.
- **Slug collisions:** ~8-char base58 ≈ 30 trillion combos; retry on the rare collision. Expiry frees slugs over time without recycling live ones.
- **Abuse:** require secret tokens for mutations; per-socket/IP rate limiting; input length caps.
- **ARM (CAX11):** `better-sqlite3` ships ARM prebuilds / compiles cleanly on Ubuntu ARM — confirm during Phase 5.

## Verification

**Local (the main path — no deployment required):**
- `npm run dev` — Vite dev server proxies WS/API to the local Node server.
- Multi-user: open 2–3 browser windows → create + join, vote, reveal, re-vote, next story; confirm updates are **instant** (push, not polling) and votes stay hidden until reveal.
- Restart test: kill & restart the server → confirm rooms rehydrate from SQLite and clients reconnect and restore state.
- **Security checks:** a script that (a) sends malformed/oversized payloads → rejected by zod; (b) attempts host-only events with a wrong/absent `hostToken` → rejected; (c) confirms a pre-reveal snapshot contains no `cardValue`; (d) floods events → rate-limited. Verify React escapes a room/name/title containing `<script>`.

**Deploy to Hetzner VPS (Ubuntu 24.04, CAX11) — optional, only after you're satisfied locally:**
1. Provision VPS; SSH in; create non-root user; `ufw allow 22,80,443`.
2. Install Node LTS + Caddy.
3. `git clone`, `npm ci`, build web (`vite build` → `web/dist`) and server (`tsc`).
4. **Caddyfile:** serve `web/dist` static, reverse-proxy `/socket.io/*` and `/healthz` to `127.0.0.1:3000`; point a domain at the box for automatic HTTPS; add security headers (HSTS, CSP, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`).
5. Install + enable `token-poker.service` (systemd, `Restart=always`); SQLite file on disk.
6. Smoke test the full flow over HTTPS across two devices; restart the service and confirm reconnection.
