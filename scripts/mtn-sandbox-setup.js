// Run this ONCE to create your MTN MoMo sandbox credentials.
//
// Prerequisite: you've subscribed to the Collections product at
// momodeveloper.mtn.com and copied your Subscription Key.
//
// Usage:
//   MTN_SUBSCRIPTION_KEY=your_key_here node scripts/mtn-sandbox-setup.js
//
// It prints an API User (UUID) and API Key — copy both into your .env as
// MTN_MOMO_API_USER and MTN_MOMO_API_KEY. You cannot retrieve the API Key
// again after this runs, so save it immediately.

const crypto = require('crypto');

const SUBSCRIPTION_KEY = process.env.MTN_SUBSCRIPTION_KEY;
const BASE_URL = 'https://sandbox.momodeveloper.mtn.com';
const CALLBACK_HOST = process.env.MTN_CALLBACK_HOST || 'webhook.site'; // replace with your real domain when ready

if (!SUBSCRIPTION_KEY) {
  console.error('Set MTN_SUBSCRIPTION_KEY before running this script.');
  process.exit(1);
}

async function main() {
  const apiUser = crypto.randomUUID();

  // Step 1: create the API user
  const createUserRes = await fetch(`${BASE_URL}/v1_0/apiuser`, {
    method: 'POST',
    headers: {
      'X-Reference-Id': apiUser,
      'Ocp-Apim-Subscription-Key': SUBSCRIPTION_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ providerCallbackHost: CALLBACK_HOST }),
  });
  if (!createUserRes.ok) {
    throw new Error(`Failed to create API user: ${createUserRes.status} ${await createUserRes.text()}`);
  }

  // Step 2: generate the API key for that user
  const createKeyRes = await fetch(`${BASE_URL}/v1_0/apiuser/${apiUser}/apikey`, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': SUBSCRIPTION_KEY },
  });
  if (!createKeyRes.ok) {
    throw new Error(`Failed to create API key: ${createKeyRes.status} ${await createKeyRes.text()}`);
  }
  const { apiKey } = await createKeyRes.json();

  console.log('\n✅ Sandbox credentials created — copy these into your .env now:\n');
  console.log(`MTN_MOMO_API_USER=${apiUser}`);
  console.log(`MTN_MOMO_API_KEY=${apiKey}`);
  console.log(`MTN_MOMO_SUBSCRIPTION_KEY=${SUBSCRIPTION_KEY}`);
  console.log('\n(The API Key cannot be retrieved again — save it now.)\n');
}

main().catch((err) => {
  console.error('Sandbox provisioning failed:', err.message);
  process.exit(1);
});
