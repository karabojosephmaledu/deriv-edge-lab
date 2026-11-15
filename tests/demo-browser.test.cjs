/* Actual-Demo UI protocol with a local mock broker; no external orders or credentials. */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { readFileSync, existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { chromium } = require("playwright");
const root = resolve(__dirname, "../frontend");
let server, browser, origin, model;

function fresh() {
  return { connected: false, enabled: true, balance: 10000, calls: [], revision: 0,
    run: { id: null, status: "idle", net: 0, history: [], pending: null, error: null } };
}
function snapshot() {
  const account = { id: "DOT-test", currency: "USD", isVirtual: true, balance: model.balance };
  return { connected: model.connected, csrf: "mock-csrf", session_view: "mock-view", revision: ++model.revision,
    account, accounts: [account], owner: "Demo tester", run: model.run };
}

before(async () => {
  server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const send = (status, data) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/deriv/config") return send(200, { oauth_ready: true, demo_execution_enabled: model.enabled });
    if (req.url.startsWith("/api/deriv/")) {
      model.calls.push({ path: req.url, method: req.method, body });
      if (["/api/deriv/session", "/api/deriv/token"].includes(req.url) && req.method === "POST") {
        model.connected = true;
        res.setHeader("Set-Cookie", "mock-demo-session=present; HttpOnly; SameSite=Lax; Path=/api/deriv");
        return send(200, snapshot());
      }
      if (!model.connected) return send(401, { detail: "Sign in again" });
      if (req.method === "POST" && req.headers["x-deriv-csrf"] !== "mock-csrf") return send(403, { detail: "CSRF check failed" });
      if (req.url === "/api/deriv/demo/start") model.run = { id: "run-test", status: "running", net: 0, history: [], pending: null, error: null };
      if (req.url === "/api/deriv/demo/signal" && model.run.status === "running" && !model.run.pending) {
        model.balance = 9900;
        model.run.pending = { id: "order-test", contract_id: 123, product: "differs", label: "Differs 5", stake: 100, profit: -2 };
      }
      if (req.url === "/api/deriv/demo/control") model.run.status = { pause: "paused", resume: "running", stop: "done" }[body.action];
      if (req.url === "/api/deriv/disconnect") { model.connected = false; return send(200, { connected: false }); }
      return send(200, snapshot());
    }
    const files = { "/": "index.html", "/app.js": "public/app.js", "/research.js": "public/research.js", "/styles.css": "public/styles.css", "/favicon.svg": "public/favicon.svg" };
    if (!files[req.url]) { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", req.url.endsWith(".js") ? "application/javascript" : req.url.endsWith(".css") ? "text/css" : "text/html");
    res.end(readFileSync(resolve(root, files[req.url])));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined });
});
after(async () => { await browser?.close(); if (server) await new Promise((r) => server.close(r)); });

async function open(t, oauth = false, mobile = false) {
  model = fresh();
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
  t.after(() => context.close());
  await context.route("**/*", (r) => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
  await context.addInitScript(({ oauth }) => {
    sessionStorage.setItem("del.cred", JSON.stringify({ token: "old-storage-canary" }));
    if (oauth) sessionStorage.setItem("del.pkce", JSON.stringify({ state: "mock-state", verifier: "x".repeat(43) }));
    window.__ws = [];
    window.__epoch = Math.floor(Date.now() / 1000);
    window.WebSocket = class {
      static OPEN = 1;
      constructor(url) { this.readyState = 0; this.url = url; window.__ws.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
      send(raw) {
        const q = JSON.parse(raw);
        if (q.buy || q.sell) throw new Error("Browser must never send broker orders");
        const msg = { req_id: q.req_id };
        if (q.proposal) msg.proposal = { ask_price: q.amount, payout: q.amount * 1.09, commission: .36, contract_details: { tick_size_barrier: .000537, maximum_ticks: 230 } };
        setTimeout(() => this.onmessage?.({ data: JSON.stringify(msg) }), 0);
      }
      close() { this.readyState = 3; this.onclose?.(); }
    };
    window.__tick = () => {
      window.__epoch += 2;
      window.__ws[0].onmessage({ data: JSON.stringify({ msg_type: "tick", tick: { symbol: "R_100", quote: 100.01, pip_size: 2, epoch: window.__epoch } }) });
    };
  }, { oauth });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(origin + (oauth ? "/#code=synthetic-code&state=mock-state" : "/"));
  await page.waitForFunction(() => window.__ws.length > 0 && window.__ws[0].readyState === 1);
  await page.evaluate(() => window.__tick());
  if (!oauth) {
    await page.locator("#connect-button").click();
    await page.locator("#token-input").fill("private-form-test-canary");
    await page.locator("#token-connect-button").click();
  }
  await page.waitForFunction(() => document.getElementById("account-live").hidden === false);
  return page;
}

test("browser Demo: login alone places no orders, and credentials never enter storage", { timeout: 15000 }, async (t) => {
  const page = await open(t);
  assert.equal(await page.locator("#execution-mode").inputValue(), "simulation");
  assert.equal(model.calls.some((c) => /demo\/(start|signal)/.test(c.path)), false);
  const data = await page.evaluate(() => ({ session: JSON.stringify(sessionStorage), local: JSON.stringify(localStorage), cookies: document.cookie, cred: state.cred }));
  assert.doesNotMatch(data.session + data.local, /private-form-test-canary|old-storage-canary/);
  assert.doesNotMatch(data.cookies, /mock-demo-session/);
  assert.equal(data.cred.token, undefined);
  assert.equal(await page.locator("#token-input").inputValue(), "");
});

test("browser Demo: explicit Start submits signals, shows actual debit and uses backend settlement", { timeout: 15000 }, async (t) => {
  const page = await open(t);
  await page.locator("#execution-mode").selectOption("demo");
  await page.locator("#stake-input").fill("100");
  await page.locator("#stake-input").dispatchEvent("change");
  assert.equal(model.calls.some((c) => c.path.endsWith("/demo/start")), false);
  await page.locator("#start-btn").click();
  await page.waitForFunction(() => state.demo?.status === "running" && !state.demoBusy);
  await page.evaluate(() => window.__tick());
  await page.waitForFunction(() => document.getElementById("last-trade").textContent.includes("contract 123"));
  assert.match(await page.locator("#balance-value").textContent(), /9,900\.00/);
  assert.equal(await page.locator("#stat-wins").textContent(), "0");
  assert.equal(await page.locator("#stake-input").isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__ws.every((s) => s.url.includes("/ws/public"))), true);
  model.balance = 10007.5;
  model.run = { ...model.run, status: "paused", pending: null, net: 7.5, history: [
    { id: "order-test", contract_id: 123, product: "differs", label: "Differs 5", stake: 100, buy_price: 100, sell_price: 107.5, symbol: "R_100", profit: 7.5, status: "win", closed_at: Date.now() / 1000 },
  ] };
  await page.waitForFunction(() => document.getElementById("stat-pnl").textContent.includes("7.50"));
  assert.match(await page.locator("#balance-value").textContent(), /10,007\.50/);
  assert.match(await page.locator("#trade-history-body").textContent(), /7\.50/);
  assert.equal(await page.locator("#stat-wins").textContent(), "1");
});

test("browser Demo: Pause and Stop reach the backend and prevent further entry signals", { timeout: 15000 }, async (t) => {
  const page = await open(t);
  await page.locator("#execution-mode").selectOption("demo");
  await page.locator("#start-btn").click();
  await page.locator("#pause-btn").click();
  await page.waitForFunction(() => document.getElementById("start-btn").textContent === "Resume Demo");
  await page.evaluate(() => window.__tick());
  assert.equal(model.calls.filter((c) => c.path.endsWith("/demo/signal")).length, 0);
  await page.locator("#stop-btn").click();
  await page.waitForFunction(() => document.getElementById("start-btn").textContent === "Start Demo trading");
  assert.equal(model.run.status, "done");
});

test("browser Demo: OAuth cookie login works with no access token in the response, including mobile", { timeout: 15000 }, async (t) => {
  const page = await open(t, true, true);
  assert.equal(model.calls.some((c) => c.path === "/api/deriv/token"), true);
  assert.equal(await page.locator("#account-type").textContent(), "Demo");
  await page.locator("#execution-mode").selectOption("demo");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 2, `Mobile overflow: ${overflow}`);
});

test("browser Demo: late status responses cannot replace newer controls or balances", { timeout: 15000 }, async (t) => {
  const page = await open(t);
  await page.locator("#execution-mode").selectOption("demo");
  await page.locator("#start-btn").click();
  await page.waitForFunction(() => state.demo?.status === "running" && !state.demoBusy);
  await page.evaluate(() => {
    const current = { connected: true, accounts: state.accounts, account: { ...state.account, balance: 999999 },
      csrf: state.csrf, session_view: state.sessionView, revision: state.snapshotRevision - 1,
      run: { ...state.demo, status: "idle" } };
    applyDemoSnapshot(current);
    applyDemoSnapshot({ ...current, session_view: "old-session", revision: 9999999 });
  });
  assert.match(await page.locator("#balance-value").textContent(), /10,000\.00/);
  assert.equal(await page.evaluate(() => state.demo.status), "running");
});

test("browser Demo: manual digits are preserved and payout risk uses actual $15.05 settlements, not public estimates", { timeout: 15000 }, async t => {
  const page = await open(t);
  assert.equal(await page.locator("button[data-digit]").count(), 10);
  await page.locator("#execution-mode").selectOption("demo");
  assert.equal(await page.locator("#tk-profit").innerText(), "Quoted at entry");
  await page.evaluate(() => {
    state.settings.stake = 200;
    const last = { product: "differs", symbol: "R_100", stake: 200, status: "win", digit: 1,
      quoted_payout: 219.30, quoted_profit: 19.30, sell_price: 215.05, profit: 15.05 };
    state.demo = { ...state.demo, history: [last], pending: null };
    renderTicket();
  });
  assert.equal(await page.locator("#tk-profit").innerText(), "+$15.05");
  assert.match(await page.locator("#tk-note").innerText(), /93\.0% wins/);
  assert.match(await page.locator("#tk-note").innerText(), /13\.3 such wins/);
});

test("browser Demo: research selection cannot replace the manual Demo digit", { timeout: 15000 }, async t => {
  const page = await open(t);
  await page.locator("#execution-mode").selectOption("demo");
  await page.locator('button[data-digit="7"]').click();
  await page.locator("#start-btn").click();
  await page.waitForFunction(() => state.demo?.status === "running" && !state.demoBusy);
  const start = model.calls.find(c => c.path === "/api/deriv/demo/start");
  assert.equal(start.body.digit, 7);
  assert.equal("digit_mode" in start.body, false);
  assert.equal(await page.evaluate(() => state.settings.autoDigit), false);
});
