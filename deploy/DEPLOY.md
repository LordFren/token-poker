# Deploying token-poker securely on a small VPS (Hetzner)

A step-by-step guide to run token-poker on a cheap Linux VPS behind Caddy with
automatic HTTPS. Everything here uses placeholders — substitute your own values
where you see `UPPER_CASE` or `example.com`.

**Architecture:** the Node app listens only on `127.0.0.1` (never public). Caddy
sits in front on ports 80/443, terminates TLS, and reverse-proxies to Node.
Secrets and config live in an env file on the server that is **not** in this repo.

```
Browser ──HTTPS/WSS──▶ Caddy (:443) ──HTTP, localhost──▶ Node (:3000) ──▶ SQLite file
```

Companion files in this folder:

- `Caddyfile` — reverse proxy + auto-HTTPS (reads the hostname from `$DOMAIN`)
- `token-poker.service` — hardened systemd unit (runs as a non-root user)
- `token-poker.env.example` — template for the server-only config file
- `deploy.sh` — pull / build / restart for subsequent deploys

---

## 0. Prerequisites

- A VPS provider account (this guide assumes Hetzner Cloud).
- A domain (or subdomain) you can point at the server. A real domain gives you a
  clean `https://...` link with a valid certificate. Without one you can use a
  free `sslip.io` hostname (see §3) as a fallback.
- An SSH key pair on your own machine (see §1).

---

## 1. Create an SSH key (on your local machine)

```bash
ssh-keygen -t ed25519 -C "token-poker"
```

- Press Enter to accept the default location, or give it a distinct name if you
  already have keys.
- A passphrase is optional but recommended (encrypts the key at rest).

This produces two files in `~/.ssh/`:

- the **private** key (no extension) — never share or upload this.
- the **public** key (`.pub`) — this is the one you give the provider.

Copy the public key to your clipboard:

```bash
pbcopy < ~/.ssh/id_ed25519.pub   # macOS
```

---

## 2. Provision the server

In the provider console:

1. **Create a server.**
2. **Image:** Ubuntu LTS (24.04).
3. **Type:** a small ARM instance is plenty (e.g. 2 vCPU / 4 GB). The default
   local disk (tens of GB) is far more than this app needs — **no extra volume
   required.** The database is a single small, intentionally ephemeral SQLite
   file. Optionally enable the provider's automated **Backups** for peace of mind.
4. **SSH key:** paste the **public** key from §1. Do not enable password login.
5. **Firewall:** create one that **allows inbound TCP 22, 80, and 443 only**.
   Provider firewalls are allow-lists — anything not listed is denied by default,
   so there is no "block" action to set. Leave **outbound empty** (empty = all
   outbound allowed), which the server needs for package installs and certs.
6. Note the server's public IP address.

> Optional tightening: restrict the inbound SSH (22) rule to your own IP only.
> Skip this if your local IP changes, or you may lock yourself out.

---

## 3. Point DNS at the server

Add a single **A record** for the hostname you'll use, pointing at the server IP.

- **Subdomain of an existing domain** (e.g. via Cloudflare): add an `A` record
  with name `poker` → server IP. It becomes `poker.example.com`.
- **Cloudflare proxy toggle:** start with **DNS only (grey cloud)**. Then Caddy
  obtains its own certificate normally and the app sees real client IPs (so the
  per-IP abuse limits stay accurate). Only use the proxied (orange) mode if you
  want Cloudflare's edge; if you do, set SSL/TLS mode to **Full (strict)** and be
  prepared to switch Caddy to a DNS-01 challenge.
- **No domain?** Use `YOUR-IP-WITH-DASHES.sslip.io` (e.g. an IP `a.b.c.d` becomes
  `a-b-c-d.sslip.io`) anywhere this guide says the hostname. Swap in a real
  domain later by changing two lines.

---

## 4. Connect and harden (run as root on the server)

SSH in:

```bash
ssh root@[server-ip]
```

Update and install baseline tooling:

```bash
apt update && apt -y upgrade
apt -y install ufw fail2ban unattended-upgrades rsync
dpkg-reconfigure -plow unattended-upgrades      # choose "Yes"
```

Host firewall (in addition to the provider firewall):

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
systemctl enable --now fail2ban
```

Lock SSH to keys only — in `/etc/ssh/sshd_config` ensure:

```
PasswordAuthentication no
PermitRootLogin prohibit-password
```

Then `systemctl restart ssh`. **Keep your current session open and verify a new
SSH session works in another terminal before closing it.**

---

## 5. Create a non-root service user

```bash
adduser --system --group --home /opt/token-poker SERVICE_USER
mkdir -p /opt/token-poker /var/www/token-poker
```

> The companion `token-poker.service` unit assumes a service user; use the same
> name there as you pick here.

---

## 6. Install Node and Caddy

```bash
# Node LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt -y install nodejs
```

Install **Caddy** from its official apt repository — follow the current 4-line
snippet at <https://caddyserver.com/docs/install#debian-ubuntu-raspbian>. The apt
install also sets up Caddy's own systemd service and `/etc/caddy/Caddyfile`.

---

## 7. Get the code and build

```bash
cd /opt/token-poker
git clone YOUR_REPO_URL .
chown -R SERVICE_USER:SERVICE_USER /opt/token-poker

sudo -u SERVICE_USER bash -c 'npm ci && npm run build'

# Publish the built static site for Caddy to serve
rsync -a --delete web/dist/ /var/www/token-poker/

# SQLite data directory owned by the service user
mkdir -p server/data && chown SERVICE_USER:SERVICE_USER server/data
```

---

## 8. Configure server-only secrets/config

This file lives only on the server and is **never** committed.

```bash
cp deploy/token-poker.env.example /etc/token-poker.env
nano /etc/token-poker.env        # set CORS_ORIGIN to https://YOUR_HOSTNAME
chown root:SERVICE_USER /etc/token-poker.env
chmod 640 /etc/token-poker.env   # root writes, service user reads, others none
```

`CORS_ORIGIN` must be your exact public origin (scheme + host, no trailing slash).
The server **refuses to start in production if it is `*`** — a deliberate
fail-closed guard.

---

## 9. Install and start the service

```bash
cp deploy/token-poker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now token-poker
systemctl status token-poker
curl -fsS http://127.0.0.1:3000/healthz && echo OK
```

The unit runs as the non-root service user, reads the env file, restarts on
crash, and is sandboxed so it can only write to the data directory.

---

## 10. Point Caddy at the app

```bash
cp deploy/Caddyfile /etc/caddy/Caddyfile
```

Give Caddy your hostname without baking it into the repo:

```bash
systemctl edit caddy
```

Add:

```ini
[Service]
Environment=DOMAIN=YOUR_HOSTNAME
```

Then:

```bash
systemctl restart caddy
systemctl status caddy
```

Caddy fetches a certificate automatically and the app goes live at
`https://YOUR_HOSTNAME`.

---

## 11. Verify

- Open the HTTPS URL on two devices — create a room, join via the link, vote,
  reveal. Updates should be instant (real WebSocket push).
- Restart the service (`systemctl restart token-poker`) and confirm active rooms
  rehydrate and clients reconnect.
- Run the bundled abuse checks against the live host (see `scripts/` for the
  exact environment variable it reads).

---

## Subsequent deploys

After initial setup, shipping a change is one command on the server, run as the
service user from the app directory:

```bash
./deploy/deploy.sh
```

It pulls, runs `npm ci`, builds, syncs the static files, restarts the service,
and health-checks.

---

## Security summary

- Node binds to `127.0.0.1` only; Caddy is the sole public surface.
- Real TLS/WSS via Caddy auto-certificates; the app already sets CSP/HSTS and
  other security headers itself.
- Key-only SSH, host firewall + provider firewall (only 22/80/443), fail2ban on
  SSH, unattended security upgrades.
- Non-root, sandboxed service; config/secrets in a `640` env file outside the repo.
- App-layer hardening lives in the code: input validation, host-token gating,
  per-IP/socket rate limits, and automatic room expiry.
