'use strict';
// Password hashing / verification. New hashes: scrypt with low cost (this is a
// sandbox; logins must be fast). Verifies source-data formats too: bcrypt
// ($2a/$2b/$2y$, Postmill/GitLab), argon2 ($argon2id$...), plain$ (fixtures).
const crypto = require('node:crypto');

const SCRYPT_N = 1024;

function hashPassword(password, { N = SCRYPT_N } = {}) {
  const salt = crypto.randomBytes(12).toString('base64url');
  const hash = crypto.scryptSync(String(password), salt, 32, { N, r: 8, p: 1 }).toString('base64url');
  return `scrypt$${N}$${salt}$${hash}`;
}

async function verifyPassword(password, stored) {
  if (!stored || password == null) return false;
  password = String(password);
  if (stored.startsWith('scrypt$')) {
    const [, N, salt, hash] = stored.split('$');
    const got = crypto.scryptSync(password, salt, 32, { N: +N, r: 8, p: 1 });
    const want = Buffer.from(hash, 'base64url');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }
  if (/^\$2[abxy]\$/.test(stored)) {
    const { bcryptVerify } = require('hash-wasm');
    return bcryptVerify({ password, hash: stored.replace(/^\$2[xy]\$/, '$2b$') });
  }
  if (stored.startsWith('$argon2')) {
    const { argon2Verify } = require('hash-wasm');
    return argon2Verify({ password, hash: stored });
  }
  if (stored.startsWith('plain$')) return stored.slice(6) === password;
  return false; // unknown format: give the site a cfg.auth.verify()
}

module.exports = { hashPassword, verifyPassword };
