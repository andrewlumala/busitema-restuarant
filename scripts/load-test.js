// A basic load test — simulates many students hitting the menu endpoint at once,
// the most common read during a lunch rush. Not a substitute for real load testing
// tools (k6, Artillery), but gives you a quick sanity check with zero extra setup.
//
// Usage: node scripts/load-test.js [concurrent] [base_url]
// Example: node scripts/load-test.js 50 http://localhost:4000

const CONCURRENT = parseInt(process.argv[2]) || 50;
const BASE_URL = process.argv[3] || 'http://localhost:4000';

async function hitMenu(i) {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/api/menu`);
    const elapsed = Date.now() - start;
    return { ok: res.ok, status: res.status, elapsed };
  } catch (err) {
    return { ok: false, status: 'error', elapsed: Date.now() - start, error: err.message };
  }
}

async function main() {
  console.log(`Firing ${CONCURRENT} concurrent requests to ${BASE_URL}/api/menu...\n`);
  const start = Date.now();
  const results = await Promise.all(Array.from({ length: CONCURRENT }, (_, i) => hitMenu(i)));
  const totalTime = Date.now() - start;

  const successful = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);
  const times = successful.map(r => r.elapsed).sort((a, b) => a - b);
  const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
  const p95 = times.length ? times[Math.floor(times.length * 0.95)] : 0;

  console.log(`✅ Successful: ${successful.length}/${CONCURRENT}`);
  console.log(`❌ Failed: ${failed.length}/${CONCURRENT}`);
  console.log(`⏱  Average response time: ${avg}ms`);
  console.log(`⏱  95th percentile: ${p95}ms`);
  console.log(`⏱  Total wall time: ${totalTime}ms`);
  if (failed.length > 0) {
    console.log('\nFirst few failures:', failed.slice(0, 3));
  }
  console.log('\nFor a real pilot: try this with 100-200 concurrent (the size of an actual lunch');
  console.log('rush) against your DEPLOYED url, not localhost, since network latency matters too.');
}

main();
