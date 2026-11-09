# Claude plans from a KeyVault

Every Claude feature (Thiết kế AI, mô hình từ ảnh, nhận xét timelapse, nhận diện chi tiết, Studio's **AI tối ưu**,
phân tích lỗi) runs on the **Claude plans** fetched from a
[KeyVault](https://github.com/vinhduong-051102/key_store/blob/main/HUONG_DAN_LAY_KEY.md). There are no fixed plans
and no tokens in `.env`: **each Claude token the KeyVault grants the gateway is a plan**, named after its key, as many
as there are. They are managed on **Hệ thống → KeyVault: các gói Claude**, or with `npx tsx scripts/keyvault.ts`;
both work on the same files.

- **Tự động** (the default on Hệ thống → Gói Claude) goes through the plans in the KeyVault's order, moving to the
  next whenever one is out of usage; or one plan can be picked, for every task or for one AI model when it is made.
- A key granted shows as a plan at once (**Kiểm tra**, and the gateway reads the list again every 10 minutes); it is
  used once its token is fetched. A key the KeyVault takes back loses its plan the next time the list is read.
- A key fetched that is no Claude token (`sk-ant-…`) is hidden from the plans.

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

- `keyvault.json`: server, request id and claim token, API key, recipient id, stage and the keys granted. The
  authenticator's secret stays only until activation.
- `keyvault-recipient.key`: the private key, PEM PKCS8 without a passphrase so the gateway reads it unattended. Made
  here, never sent anywhere.

The plans go to `CLAUDE_TOKENS_FILE` (`data/secrets/claude/tokens.json`, mode 600):
`{plans: [{id, name, token, fetched_at}], not_claude: [key ids]}`. The gateway reads it on each use; the CAD, mesh3d
and Studio containers mount `data/secrets/claude` at `/run/claude` and read it before every Claude run, so a new
token is in use at once, with no restart. A job given one plan keeps its id (the KeyVault key's) in its `job.json`.

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

**Kết nối lại** (any stage) starts over with a new request and a new key pair; **Gỡ kết nối** disconnects. Both move
`keyvault.json` and the private key to `.backup-<time>/`; the plans fetched stay in use.

## The plans

Once connected, each plan on the card has, with a code:

- **Lấy & dùng** (**Lấy lại** once fetched): fetched, tried, kept as that plan when it works.
- **Kiểm tra**: fetched and tried, not kept: whether it works, how much of its 5-hour and 7-day allowance is used, and
  whether a plan runs on that very token already.

## CLI

```sh
npx tsx scripts/keyvault.ts request --name bambu-lab-h2d-gateway --contact ... --reason ...
npx tsx scripts/keyvault.ts status                 # asks the KeyVault while the request is open; lists the plans
npx tsx scripts/keyvault.ts claim                  # prints the authenticator's secret once
npx tsx scripts/keyvault.ts activate --otp 123456
npx tsx scripts/keyvault.ts import --api-key kv_... [--pem their.key]
npx tsx scripts/keyvault.ts pubkey | keys | reset
npx tsx scripts/keyvault.ts fetch --key-id <id or name> --otp 123456 --use              # tried, then used as a plan
npx tsx scripts/keyvault.ts fetch --key-id <id or name> --otp 123456 --out some.key     # to a file, mode 600
npx tsx scripts/keyvault.ts test --key-id <id or name> --otp 123456
```

The containers need the plans folder mounted once (already in the compose files):
`docker compose -f docker-compose.<cad|mesh3d|studio>.yml up -d --no-build`.
