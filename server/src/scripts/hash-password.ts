import { hashPassword } from '../lib/crypto.js';

// Reads a password on stdin and prints the XSLOP_ADMIN_HASH value. Example:
//   printf '%s' "$PASSWORD" | node server/dist/scripts/hash-password.js
const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
if (password.length < 12) {
  console.error('The password must have at least 12 characters.');
  process.exitCode = 1;
} else {
  console.log(await hashPassword(password));
}
