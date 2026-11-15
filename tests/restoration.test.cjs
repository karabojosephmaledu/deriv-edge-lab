/* Display-only evidence, pricing mathematics and immutable release boundaries. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p));
const evidence = JSON.parse(read('frontend/public/research-evidence.json'));
test('six educational summaries preserve original findings and disclose modeled payouts', () => {
  assert.deepEqual(evidence.categories.map(c => c.id), ['differs','accu','mult','matches','touch','notouch']);
  assert.deepEqual(evidence.historicalFindings, {testsPassed:166,ticks:20000,originalBenchmarks:23,addedAlternatives:7,oldSelectorNet:-226.39,rebuiltDecision:'NO TRADE',touchNet:23.5,touchTrades:95,qualifiedStrategies:0});
  for (const c of evidence.categories) {
    assert.equal(c.qualifiedWindows, 0);
    assert.notEqual(c.verdict, 'SUPPORTED BY EVIDENCE');
    for (const p of c.prices.filter(p => !p.unavailable && p.gross != null)) {
      assert.ok(p.originalQuoteStake > 0 && Number.isFinite(p.gross) && p.gross > 10);
      assert.equal(p.breakEven, 10 / p.gross);
      assert.equal(p.profit, Math.round((p.gross - 10) * 100) / 100);
      assert.equal(p.expectedValue, Math.round((p.probabilityAssumption * p.profit - (1-p.probabilityAssumption) * 10) * 100) / 100);
    }
  }
});
test('release preserves archived evaluation, frozen research logic, callback and verification', () => {
  for (const p of ['research/REBUILD-V2.md','research/protocol-v2.json','research/public-sample.json','research/unseen-v2.json.gz','frontend/public/research.js']) {
    assert.deepEqual(read(p), execFileSync('git',['show','9d6cc76:'+p],{cwd:root}));
  }
  for (const p of ['backend/lib/deriv_demo.py','backend/routers/deriv.py']) {
    assert.deepEqual(read(p), execFileSync('git',['show','a5556bc:'+p],{cwd:root}));
  }
  const html = read('frontend/index.html').toString();
  assert.match(html, /name="deriv-site-verification" content="0b67cfedb4148eebd4d50ef1b0609f4af1cf25c4d163ec5c54f56a8dbce89fa9"/);
  assert.match(read('frontend/public/app.js').toString(), /const redirectUri = \(\) => location.origin \+ "\/api\/deriv\/callback"/);
});
