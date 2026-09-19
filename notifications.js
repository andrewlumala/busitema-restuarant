// SMS notification layer.
//
// Stub, same pattern as config/momo.js — swap the body of sendSms() for a
// real call once you've picked a provider. Africa's Talking is the most
// common SMS gateway in Uganda and has a UGX-priced pay-as-you-go plan:
//   https://africastalking.com
//
// Usage elsewhere in the app: notify students/guests by phone when their
// order is ready — the moment they're most likely to be away from the app.

async function sendSms({ phone, message }) {
  if (!process.env.SMS_API_KEY) {
    console.log(`[SMS stub] would send to ${phone}: "${message}"`);
    return { sent: false, stub: true };
  }
  // Example for Africa's Talking (uncomment and adjust once you have credentials):
  // const AfricasTalking = require('africastalking')({
  //   apiKey: process.env.SMS_API_KEY,
  //   username: process.env.SMS_USERNAME,
  // });
  // return AfricasTalking.SMS.send({ to: [phone], message });
  return { sent: false, stub: true };
}

module.exports = { sendSms };
