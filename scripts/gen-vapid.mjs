// Web Push 用の VAPID 鍵を作る。 使い方: node scripts/gen-vapid.mjs
// 出てきた 2 つを Cloudflare に設定する(秘密鍵は、人に見せない・リポジトリに入れない):
//   npx wrangler secret put VAPID_PUBLIC_KEY
//   npx wrangler secret put VAPID_PRIVATE_KEY
//   (任意) npx wrangler secret put VAPID_SUBJECT   例: mailto:you@example.com
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = privateKey.export({ format: "jwk" });
const b64u = (b) => Buffer.from(b).toString("base64url");
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);

console.log("VAPID_PUBLIC_KEY=" + b64u(pub));
console.log("VAPID_PRIVATE_KEY=" + jwk.d);
console.log("\n# 上の 2 行を、それぞれ wrangler secret put に貼ってください(ローカル検証なら .dev.vars に書く)。");
