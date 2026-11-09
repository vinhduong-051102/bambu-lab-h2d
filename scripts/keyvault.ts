/**
 * The KeyVault from the command line, on the same files as the dashboard (KV_DIR, CLAUDE_TOKENS_FILE): see
 * docs/keyvault.md. A key's value is never printed: `fetch` makes it that key's Claude plan (--use) or puts it in a file
 * (--out, mode 600).
 *
 *   npx tsx scripts/keyvault.ts request --name <n> --contact <c> --reason <r> [--organization <o>] [--requested-keys <k>]
 *   npx tsx scripts/keyvault.ts status | claim | activate --otp <code> | pubkey | keys | reset
 *   npx tsx scripts/keyvault.ts import --api-key kv_... [--pem <private key file>]
 *   npx tsx scripts/keyvault.ts fetch --key-id <id or name> --otp <code> (--use | --out <file>)
 *   npx tsx scripts/keyvault.ts test --key-id <id or name> --otp <code>
 */
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import path from 'path';
import { planList, refreshPlans, testVaultKey, useVaultKey } from '../src/domain/ai/keyVault';
import {
  activate,
  claim,
  fetchKey,
  importApiKey,
  KVError,
  publicKey,
  refreshStatus,
  requestAccess,
  reset,
  vaultView,
  writeSecret,
} from '../src/domain/keyvault/keyVaultClient';

config();

const [command, ...rest] = process.argv.slice(2);
const args: Record<string, string> = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) args[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? 'true' : rest[++i];
}
const need = (name: string) => {
  if (!args[name]) throw new KVError(`Thiếu --${name}`);
  return args[name];
};

async function printStatus() {
  const v = await vaultView();
  console.log(`Máy chủ: ${v.server}`);
  console.log(`Trạng thái: ${v.stage}${v.reviewNote ? ` (ghi chú: ${v.reviewNote})` : ''}${v.claimExpiresAt ? `, nhận trước ${v.claimExpiresAt} UTC` : ''}`);
  for (const p of await planList()) {
    console.log(`  ${p.id}  ${p.name}  ${p.fetched ? `gói đang dùng ${p.last4}` : 'chưa lấy token'}${p.granted ? '' : ' (không còn trên KeyVault)'}`);
  }
}

async function main() {
  switch (command) {
    case 'request':
      await requestAccess({ name: need('name'), contact: need('contact'), reason: need('reason'), organization: args.organization, requested_keys: args['requested-keys'] }, args.server);
      console.log('Đã gửi yêu cầu. Chờ quản trị viên duyệt rồi chạy: status, claim.');
      return;
    case 'status':
      if ((await vaultView()).requestId) await refreshStatus();
      return printStatus();
    case 'claim': {
      const s = await claim();
      console.log('Thêm vào Google Authenticator: + → Nhập khóa thiết lập, secret:');
      console.log(`  ${s.totp_secret}`);
      console.log(`  (${s.otpauth_uri})`);
      console.log('Rồi kích hoạt: activate --otp <mã>');
      return;
    }
    case 'activate':
      await activate(need('otp'));
      await refreshPlans();
      console.log('Đã kích hoạt.');
      return printStatus();
    case 'import':
      await importApiKey(need('api-key'), args.pem ? readFileSync(args.pem, 'utf8') : undefined, args.server);
      await refreshPlans();
      console.log('Đã lưu API key và kiểm tra được danh sách key.');
      return printStatus();
    case 'pubkey':
      console.log(await publicKey());
      return;
    case 'keys':
      await refreshPlans();
      return printStatus();
    case 'fetch': {
      if (args.use) {
        const used = await useVaultKey(need('key-id'), need('otp'));
        console.log(`Đã thử và dùng token ${used.last4} làm gói ${used.keyName}.`);
        return;
      }
      const out = need('out');
      const { key, value } = await fetchKey(need('key-id'), need('otp'));
      await writeSecret(path.resolve(out), value);
      console.log(`Đã lưu key ${key.name} (${value.length} byte) vào ${out} (quyền 600).`);
      return;
    }
    case 'test': {
      const t = await testVaultKey(need('key-id'), need('otp'));
      console.log(t.usable ? `Dùng được: ${t.keyName} ${t.last4}, 5 giờ ${t.fiveHour ?? '?'}, 7 ngày ${t.sevenDay ?? '?'}${t.sameAs ? `, trùng ${t.sameAs}` : ''}` : `Không dùng được: ${t.error}`);
      return;
    }
    case 'reset': {
      const backup = await reset();
      console.log(backup ? `Đã gỡ kết nối; file cũ ở ${backup}` : 'Chưa có kết nối nào.');
      return;
    }
    default:
      console.log('Lệnh: request | status | claim | activate | import | pubkey | keys | fetch | test | reset (xem đầu file scripts/keyvault.ts)');
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(err instanceof KVError ? `Lỗi: ${err.message}` : err);
  process.exitCode = 1;
});
