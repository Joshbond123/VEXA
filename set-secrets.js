/*
 * Set GitHub Actions secrets for VEXA repo.
 * Uses crypto_box_seal (anonymous encryption) which produces self-contained
 * ciphertext: ephemeralPublicKey || nonce || encrypted(message).
 *
 * Secret values are read from environment variables, never hardcoded.
 * Example:
 *   GH_PAT=xxx NVIDIA_API_KEY=xxx EMULATOR_STATE_KEY=xxx node set-secrets.js
 */

const sodium = require('libsodium-wrappers');

const OWNER = 'Joshbond123';
const REPO = 'VEXA';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

// Public key fetched from GitHub API (this is public, safe to commit)
const PUBLIC_KEY_B64 = '16OO2OCt6jBQrmNGr35ci3z/YL7d+ES1FtRP/cYAVFA=';

// Secrets to set — values must be provided via environment variables
const SECRET_NAMES = [
  'NVIDIA_API_KEY',
  'EMULATOR_ACCESS_TOKEN',
  'EMULATOR_GATEWAY_SECRET',
  'GH_PAT',
  'EMULATOR_STATE_KEY',
];

async function encryptSecret(plaintext, publicKeyB64) {
  await sodium.ready;
  const binkey = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL);
  const binsec = sodium.from_string(plaintext);

  // crypto_box_seal: anonymous encryption, output = ephemeralPk || nonce || ciphertext
  const sealed = sodium.crypto_box_seal(binsec, binkey);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

async function getRepoPublicKey(pat) {
  const res = await fetch(`${API}/actions/secrets/public-key`, {
    headers: { Authorization: 'Bearer ' + pat, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error('Failed to get public key: ' + res.status);
  return await res.json();
}

async function setSecret(name, value, keyId, publicKey, pat) {
  const encryptedValue = await encryptSecret(value, publicKey);
  const res = await fetch(`${API}/actions/secrets/${name}`, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + pat,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      encrypted_value: encryptedValue,
      key_id: keyId,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error('Failed to set ' + name + ': ' + res.status + ' ' + txt);
  }
  return { name: name, status: res.status };
}

async function main() {
  const pat = process.env.GH_PAT;
  if (!pat) {
    console.error('Error: GH_PAT environment variable is required');
    process.exit(1);
  }

  try {
    const keyInfo = await getRepoPublicKey(pat);
    console.log('Got public key, key_id:', keyInfo.key_id);

    const results = [];
    for (const name of SECRET_NAMES) {
      const value = process.env[name];
      if (!value) {
        console.error(`Error: ${name} environment variable is required`);
        process.exit(1);
      }
      try {
        const result = await setSecret(name, value, keyInfo.key_id, keyInfo.key, pat);
        results.push(result);
        console.log('OK set secret:', name);
      } catch (err) {
        console.error('ERR failed to set', name + ':', err.message);
      }
    }

    console.log('\n--- Summary ---');
    console.log('Secrets set:', results.length);
    for (const r of results) console.log('  ' + r.name + ': ' + r.status);
  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exit(1);
  }
}

main();