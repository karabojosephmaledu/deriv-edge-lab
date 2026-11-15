const { test } = require("node:test");
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const R = require("../scripts/research-engine.cjs");
const fresh = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, "research/unseen-v2.json.gz"))));
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex");

test("new evaluation identifies the implementation and protocol frozen before capture", () => {
  assert.equal(fresh.protocol_sha256, hash("research/protocol-v2.json"));
  assert.equal(fresh.engine_sha256, hash("frontend/public/research.js"));
  const source = execFileSync("git", ["show", fresh.frozen_commit + ":frontend/public/research.js"], { cwd: root });
  assert.equal(crypto.createHash("sha256").update(source).digest("hex"), fresh.engine_sha256);
  const commitTime = Number(execFileSync("git", ["show", "-s", "--format=%ct", fresh.frozen_commit], { cwd: root, encoding: "utf8" }).trim());
  assert.ok(commitTime <= fresh.captured_at);
});

test("20,000 evaluation ticks occupy four complete windows outside previously inspected data", () => {
  const old = JSON.parse(fs.readFileSync(path.join(root, "research/public-sample.json")));
  assert.equal(fresh.periods.length, 4);
  assert.equal(fresh.periods.reduce((n, p) => n + p.prices.length, 0), 20000);
  for (const data of fresh.periods) {
    R.validate(data); assert.equal(data.prices.length, 5000);
    const previous = old.markets.find(m => m.symbol === data.symbol);
    for (const p of previous.periods) assert.ok(data.times.at(-1) < p.times[0] || data.times[0] > p.times.at(-1));
  }
});

test("all new candidates retain their original benchmark and cannot access an account transport", () => {
  assert.equal(R.strategies.length, 30);
  for (const s of R.strategies.filter(s => s.benchmark)) assert.ok(R.strategies.some(b => b.id === s.benchmark && !b.benchmark));
  const source = fs.readFileSync(path.join(root, "frontend/public/research.js"), "utf8");
  assert.doesNotMatch(source, /\b(fetch|WebSocket|localStorage|sessionStorage)\s*[.(]/);
});

test("protocol uses a new historical evaluation and makes no forward-testing claim", () => {
  assert.match(fresh.role, /not a prospective forward test/);
  const protocol = JSON.parse(fs.readFileSync(path.join(root, "research/protocol-v2.json")));
  assert.equal(protocol.evaluation_wallet.staking, "flat");
  assert.equal(protocol.criteria.variable_exit_models_eligible_for_selection, false);
});
