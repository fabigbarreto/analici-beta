import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

const password = readFileSync(0, 'utf8');
if ([...password].length < 14 || Buffer.byteLength(password) > 512) {
  console.error('Use uma senha com pelo menos 14 caracteres e até 512 bytes.');
  process.exit(1);
}

const salt = randomBytes(16);
const digest = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
console.log('scrypt$' + salt.toString('hex') + '$' + digest.toString('hex'));
