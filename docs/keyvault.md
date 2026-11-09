# Claude tokens from a KeyVault

Instead of keeping the two Claude subscription tokens (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN_FALLBACK`)
in `.env`, the gateway can fetch them from a [KeyVault](https://github.com/vinhduong-051102/key_store) with a one-time
code from Google Authenticator: **Hệ thống → Gói Claude → Lấy từ KeyVault** on each plan's card.

Each fetch is an export (the key under a one-off data key) and an unlock with the code (the data key, wrapped for
the gateway's X25519 public key). Both are opened in the gateway with `recipient.key`, so the token never crosses
the network in the clear. Each code works once: fetching the second plan waits for the next code (~30 s).

What comes out goes to `data/secrets/claude/tokens.json`. The gateway lays it over its environment at start and after
each fetch; the CAD, mesh3d and Studio containers mount that folder (`/run/claude`, read-only) and read it before every
Claude run. A fetched token wins over `.env` and is in use at once, with no restart.

## Registering the gateway (once)

With [`kvclient.py`](https://github.com/vinhduong-051102/key_store/blob/main/client/kvclient.py) (`pip install
cryptography qrcode`), in `data/secrets/keyvault` (`KV_DIR`, gitignored with the rest of `data/`):

```sh
python kvclient.py keygen --out recipient.key           # no passphrase: the gateway reads it unattended
KV_ALLOW_HTTP=1 python kvclient.py request --server http://100.112.133.34:8000 --own-key recipient.key \
  --name bambu-lab-h2d-gateway --contact ... --reason ...
python kvclient.py status                               # until an admin approves it, then within 7 days:
KV_ALLOW_HTTP=1 python kvclient.py claim                # scan the QR in Google Authenticator, enter a code
```

`claim` saves the API key in `kv-request.json`, where the gateway reads it (or set `KV_API_KEY`). `KV_ALLOW_HTTP=1` is
for a server on plain HTTP: keep it on a private link such as Tailscale.

## .env

```
KV_SERVER=http://100.112.133.34:8000
KV_KEY_PRIMARY=<name or id of the key holding Gói 1's token>
KV_KEY_FALLBACK=<name or id of the key holding Gói 2's token>
```

The keys the gateway may fetch: `KV_ALLOW_HTTP=1 KV_API_KEY=... python kvclient.py keys --server ...`; a fetch
with a wrong name lists them too. Then recreate the gateway and the workers once, so they
mount the token folder:

```sh
docker compose -f docker-compose.gateway.yml up -d --no-build
docker compose -f docker-compose.cad.yml up -d --no-build
docker compose -f docker-compose.mesh3d.yml up -d --no-build
docker compose -f docker-compose.studio.yml up -d --no-build
```
