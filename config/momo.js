// Mobile Money integration layer.
//
// This is a stub so the rest of the app has a stable interface to build
// against. Replace the body of each function with real calls to:
//   - MTN MoMo Collections API   https://momodeveloper.mtn.com
//   - Airtel Money Open API      https://developers.airtel.africa
//
// Both providers work the same way from this app's point of view:
//   1. initiateMomoPayment() sends a payment request → student gets a
//      prompt on their phone to approve/enter their PIN.
//   2. The provider calls YOUR webhook (routes/momo-webhook.js) when the
//      student approves or the request times out/fails.
//   3. The webhook updates the transaction + credits the wallet.
//
// Never poll for payment status from the frontend — always confirm via
// the provider's webhook/callback, which is the source of truth.

const crypto = require('crypto');

// Merchant/collection codes identify WHICH account gets credited.
// They are not secrets on their own, but API calls also need a real
// subscription/API key from each provider's developer portal (see .env) —
// the merchant code alone cannot authenticate a request.
const MTN_MERCHANT_CODE = process.env.MTN_MERCHANT_CODE || '171790';
const AIRTEL_MERCHANT_CODE = process.env.AIRTEL_MERCHANT_CODE || '434366';

const MTN_BASE_URL = process.env.MTN_MOMO_ENV === 'production'
  ? 'https://momoapi.mtn.com'
  : 'https://sandbox.momodeveloper.mtn.com';

// Caches the OAuth token in memory so we don't fetch a new one per request —
// MTN explicitly recommends this (see scripts/mtn-sandbox-setup.js comments).
let mtnTokenCache = { token: null, expiresAt: 0 };

async function getMtnAccessToken() {
  if (mtnTokenCache.token && Date.now() < mtnTokenCache.expiresAt) return mtnTokenCache.token;

  const auth = Buffer.from(`${process.env.MTN_MOMO_API_USER}:${process.env.MTN_MOMO_API_KEY}`).toString('base64');
  const res = await fetch(`${MTN_BASE_URL}/collection/token/`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Ocp-Apim-Subscription-Key': process.env.MTN_MOMO_SUBSCRIPTION_KEY,
    },
  });
  if (!res.ok) throw new Error(`MTN token request failed: ${res.status}`);
  const data = await res.json();
  mtnTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

async function requestMtnPayment({ phone, amount, reference }) {
  const token = await getMtnAccessToken();
  // MTN requires X-Reference-Id to be a UUID — it's THEIR transaction ID, separate from
  // our own order/transaction id (which goes in externalId, a free-form field). We return
  // this UUID as referenceId; callers store it as external_ref and the webhook matches on it.
  const mtnReferenceId = crypto.randomUUID();
  const res = await fetch(`${MTN_BASE_URL}/collection/v1_0/requesttopay`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Reference-Id': mtnReferenceId,
      'X-Target-Environment': process.env.MTN_MOMO_ENV === 'production' ? 'mtnuganda' : 'sandbox',
      'Ocp-Apim-Subscription-Key': process.env.MTN_MOMO_SUBSCRIPTION_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: String(amount),
      currency: 'EUR', // MTN sandbox only accepts EUR — switch to UGX once you're approved for production
      externalId: String(reference), // our own order/transaction id, for our own records
      payer: { partyIdType: 'MSISDN', partyId: phone },
      payerMessage: 'Busitema Restaurant order',
      payeeNote: `Merchant ${MTN_MERCHANT_CODE}`,
    }),
  });
  if (res.status !== 202) throw new Error(`MTN requestToPay failed: ${res.status} ${await res.text()}`);
  return { referenceId: mtnReferenceId };
}

async function initiateMomoPayment({ phone, amount, method, reference }) {
  const hasMtnCreds = process.env.MTN_MOMO_API_USER && process.env.MTN_MOMO_API_KEY && process.env.MTN_MOMO_SUBSCRIPTION_KEY;

  if (method === 'mtn_momo' && hasMtnCreds) {
    return requestMtnPayment({ phone, amount, reference });
  }
  if (method === 'airtel_money') {
    // return await airtelClient.collect({
    //   reference: `order-${reference}`,
    //   subscriber: { msisdn: phone },
    //   transaction: { amount, id: reference },
    //   merchantId: AIRTEL_MERCHANT_CODE,
    // });
  }
  // Stub response — used automatically until real credentials are set in .env
  return { referenceId: `stub-${reference}-${Date.now()}`, merchantCode: method === 'mtn_momo' ? MTN_MERCHANT_CODE : AIRTEL_MERCHANT_CODE };
}

module.exports = { initiateMomoPayment, MTN_MERCHANT_CODE, AIRTEL_MERCHANT_CODE };
