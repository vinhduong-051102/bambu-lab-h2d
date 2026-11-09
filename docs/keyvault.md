# Claude tokens from a KeyVault

The two Claude subscription tokens (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN_FALLBACK`) can come from a
[KeyVault](https://github.com/vinhduong-051102/key_store/blob/main/HUONG_DAN_LAY_KEY.md) instead of `.env`:
**Hệ thống → KeyVault cho token gói Claude** on the dashboard, or `npx tsx scripts/keyvault.ts` on this machine. Both
work on the same files.

Fetching a key takes three things: the gateway's API key (`kv_…`), its X25519 private key, and a code from Google
Authenticator on the phone of whoever looks after it. Each fetch is an export (the key under a one-off data key) and an
unlock with the code within 5 minutes (the data key, wrapped for the gateway's public key); both are opened in the
gateway, so a token never crosses the network in the clear.

- Each code works once: fetching the next key waits for the next code (~30 s). Three wrong codes cancel the export;
  five in a row lock the gateway out for 15 minutes.
- The clocks of this machine and the phone must be right (NTP on).
- A fetched token is tried first (one tiny Claude call, as the limits card does) and kept only when it works; a plan
  whose new token fails keeps its old one. It is kept on disk, so a reboot asks for nothing: fetch again only when the
  key expires or is changed.
- A token's value is never shown, logged or printed: the page shows its last 4 characters.

## Files

In `KV_DIR` (`data/secrets/keyvault`, outside git), mode 600, written whole (tmp + rename):

- `keyvault.json`: server, request id and claim token, API key, recipient id, stage, the keys granted, and the key each
  plan took last (so the next fetch only takes a code). The authenticator's secret stays only until activation.
- `keyvault-recipient.key`: the private key, PEM PKCS8 without a passphrase so the gateway reads it unattended. Made
  here, never sent anywhere.

The tokens go to `CLAUDE_TOKENS_FILE` (`data/secrets/claude/tokens.json`, mode 600). The gateway lays it over its
environment at start and every 30 s; the CAD, mesh3d and Studio containers mount `data/secrets/claude` at
`/run/claude` and read it before every Claude run. A token there wins over `.env`; an empty one drops `.env`'s.

The server: `KV_SERVER` in `.env`, else the one the gateway registered with, else `http://100.112.133.34:8000`. Plain
http is only accepted to loopback, private (10/8, 172.16/12, 192.168/16) and Tailscale (100.64.0.0/10) addresses;
anything else needs https.

## Registering (once)

The card walks through the stages: **none → pending → approved → claimed → active** (or rejected).

1. **Tự gửi yêu cầu**: name, contact, reason. The key pair is made here and only the public key is sent.
2. An admin approves it on the KeyVault; **Kiểm tra lại** sees it.
3. **Nhận thông tin** (once only, within 7 days of approval): the API key, and the authenticator's secret shown with
   its QR. In Google Authenticator: + → Quét mã QR, or + → Nhập khóa thiết lập with the secret.
4. The code it shows → **Kích hoạt**. The secret is forgotten.

Or **Quản trị viên đăng ký giúp**: **Hiện public key**, send it to the admin; paste the API key they send back (and,
optionally, a PEM private key of theirs), checked at once with the key list. Scan their QR the same way.

**Gỡ kết nối** moves `keyvault.json` and the private key to `.backup-<time>/`; fetched tokens stay in use.

## Using a key

Once connected, the card lists the keys granted. Each one is guessed to a plan from its name (accents and separators
ignored: `claude-fallback`, `Gói dự phòng`, `CLAUDE_CODE_OAUTH_TOKEN` …):

- **Lấy & dùng** with a code: fetched, tried, kept for that plan when it works.
- **Kiểm tra** with a code: fetched and tried, not kept: whether it works, how much of its 5-hour and 7-day allowance is
  used, and whether a plan runs on that very token already.
- Under **Token của các gói**, each plan shows where its token comes from (KeyVault, `.env`, dropped) and its last 4;
  **Lấy từ KeyVault** fetches its key again with just a code.
- **Bỏ các mục không từ KeyVault** (once at least one plan comes from the KeyVault) stops using the `.env` tokens of
  the others: their values are copied to `data/secrets/claude/.backup-<time>/` first. The lines stay in `.env`, which
  the gateway's container cannot edit; remove them by hand if you like.

## CLI

```sh
npx tsx scripts/keyvault.ts request --name bambu-lab-h2d-gateway --contact ... --reason ...
npx tsx scripts/keyvault.ts status                 # asks the KeyVault while the request is open
npx tsx scripts/keyvault.ts claim                  # prints the authenticator's secret once
npx tsx scripts/keyvault.ts activate --otp 123456
npx tsx scripts/keyvault.ts import --api-key kv_... [--pem their.key]
npx tsx scripts/keyvault.ts pubkey | keys | reset
npx tsx scripts/keyvault.ts fetch --key-id <id or name> --otp 123456 --target primary   # tried, then used
npx tsx scripts/keyvault.ts fetch --key-id <id or name> --otp 123456 --out some.key     # to a file, mode 600
npx tsx scripts/keyvault.ts test --key-id <id or name> --otp 123456
```

The containers need the token folder mounted once (already in the compose files):
`docker compose -f docker-compose.<cad|mesh3d|studio>.yml up -d --no-build`.
