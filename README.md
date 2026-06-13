# token-poker

Planning poker, but you estimate features in **LLM tokens** instead of story points —
with a rough **cost rollup** (tokens × model price). Real-time over WebSockets.

A host creates a room, players join by link, a story is shown, everyone privately picks a
token-estimate card, all reveal at once, discuss outliers, optionally re-vote, then move on.
The app sums accepted estimates into a token + dollar total per the selected model.

Rooms can optionally estimate **story points side-by-side with tokens** (a creation-time
checkbox): each player picks a points card and a token card per round, and the results
table reports the team's measured tokens-per-point ratio — so the SP↔token correlation
is discovered from your own data instead of assumed.

Rooms run in one of two modes, picked at creation:

- **Backlog** — type stories in (title + description), estimate them one by one, export a
  markdown summary.
- **Quick rounds** — no story text ever enters the app. Votes are auto-numbered ("Vote #1",
  "Vote #2", …); the host starts a round, the team discusses the issue in their own tracker
  or call, votes, and "Accept → next vote" opens the next round in one click. Useful when
  issue titles are confidential and can't be pasted into outside tools.

## Stack

- **Server:** Node + TypeScript + Socket.IO, SQLite (`better-sqlite3`), zod validation.
- **Web:** Vite + React + TypeScript.
- **Shared:** one TypeScript package with the deck, pricing table, and event/snapshot types.

Authoritative room state lives in memory and is mirrored to SQLite so a restart rehydrates
active rooms. Every mutation pushes a fresh per-viewer snapshot (votes stay hidden until
reveal). Rooms are reached via random `/r/<slug>` links that **expire** automatically.

## Run locally (no server, no domain, no TLS)

```bash
npm install
npm run dev
```

Open **http://localhost:5173**. Open a 2nd/3rd window (or incognito) to play multiple
players — you'll see live joins, votes, and reveals.

- Test across devices on your LAN: `HOST=0.0.0.0 npm run dev`, then visit
  `http://<your-LAN-IP>:5173` from a phone.
- Production-style local run (single port, built assets): `npm run start:local` →
  http://localhost:3000.

## Useful scripts

| Command | What it does |
|---|---|
| `npm run dev` | Node server (`:3000`) + Vite dev server (`:5173`, proxies WS/API) |
| `npm run build` | Build web (`web/dist`) and server (`server/dist`) |
| `npm run start:local` | Build, then serve everything from Node on `:3000` |
| `npm run typecheck` | Type-check all workspaces |
| `npm run test:security` | Run abuse/security checks against a server on `:3000` |
| `npm run scan:secrets` | Scan the whole tree for committed secrets (the pre-commit hook runs this on staged files) |

## Config (env vars — local and prod differ only here)

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | server port |
| `HOST` | `127.0.0.1` | bind address (`0.0.0.0` for LAN/prod) |
| `SERVE_STATIC` | `0` | `1` to serve `web/dist` from Node |
| `CORS_ORIGIN` | `*` | restrict to your domain in prod — **required** when `NODE_ENV=production` (the server refuses to start on `*`) |
| `TRUST_PROXY` | `0` | set `1` only when behind a proxy (Caddy) that sets `X-Forwarded-For`; otherwise client IPs are taken from the socket so per-IP limits can't be spoofed |
| `IDLE_TTL_MS` | `14400000` | room idle expiry (4h) |
| `MAX_TTL_MS` | `86400000` | absolute room cap (24h) |
| `MAX_ROOMS_PER_IP` | `20` | per-IP room cap |
| `MAX_SOCKETS_PER_IP` | `30` | per-IP concurrent socket cap (flood guard) |
| `MAX_ROOMS` | `50000` | global cap on total live rooms (distributed-flood backstop) |
| `DB_PATH` | `./data/dev.sqlite` | SQLite file |

## Contributing

Secrets are kept out of git by a **pre-commit hook**. `npm install` runs a `prepare`
step that points this repo's `core.hooksPath` at [`.githooks/`](.githooks/), so the
[`secret-scan`](scripts/secret-scan.mjs) check runs automatically before every commit and
blocks anything that looks like a private key or API token. Run it on demand with
`npm run scan:secrets`.

The hook is repo-local, skips gracefully if Node isn't installed, and is fully reversible
(`git config --unset core.hooksPath`). If a match is a false positive, add the marker
`secret-scan-ok` on that line.

## Deployment

Deployment to a small VPS (Hetzner) with Caddy + systemd is a separate, optional step.
Nothing in the local workflow above requires it.

- **[`deploy/DEPLOY.md`](deploy/DEPLOY.md)** — step-by-step secure deployment guide (server,
  firewall, TLS, systemd), with ready-to-use `Caddyfile`, systemd unit, env template, and
  redeploy script alongside it in [`deploy/`](deploy/).
- **[`docs/PLAN.md`](docs/PLAN.md)** — the original implementation plan (architecture, domain
  model, security model, build order).
