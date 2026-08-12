// Generates one member credential for one project.
//
//   node aggregator/make-credential.js minh@example.com
//
// Prints two things: the JSON entry for config.json, and the line the member puts in their own
// local env file. The token is shown once and is not stored anywhere — config.json keeps only a
// scrypt hash, so a stolen config cannot be replayed as a credential.
const crypto = require('crypto');

const email = (process.argv[2] || '').trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('usage: node make-credential.js <member-email>');
  process.exit(1);
}

// 24 bytes of base64url. Long enough that guessing is not a threat model, short enough to paste.
const token = crypto.randomBytes(24).toString('base64url');
const salt = crypto.randomBytes(8).toString('hex');
const hash = crypto.scryptSync(token, salt, 32).toString('hex');

console.log(`\nAdd to config.json under the project's "members":\n`);
console.log(`      ${JSON.stringify(email)}: {`);
console.log(`        "salt": "${salt}",`);
console.log(`        "hash": "${hash}"`);
console.log(`      }`);
console.log(`\nSend this to ${email} for their local env file — over a channel you would send any`);
console.log(`other credential over, and only once, because it is not recoverable from config.json:\n`);
console.log(`      AGENT_KNOWLEDGE_USER=${email}`);
console.log(`      AGENT_KNOWLEDGE_TOKEN=${token}\n`);
