/* Browser smoke checks against the unchanged dashboard markup and styling.
 * Requires Playwright + Chromium; run: node --test tests/simulation-browser.test.cjs
 * Optional CHROMIUM_PATH selects an existing local Chromium executable.
 * All Deriv connections are replaced before app.js loads. No credentials used.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { readFileSync, existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { chromium } = require("playwright");

const frontend = resolve(__dirname, "../frontend");
let server, browser, origin;
before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/api/deriv/config") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ oauth_ready: false }));
      return;
    }
    const files = { "/": "index.html", "/app.js": "public/app.js", "/research.js": "public/research.js", "/research-evidence.json": "public/research-evidence.json", "/styles.css": "public/styles.css", "/favicon.svg": "public/favicon.svg" };
    const file = files[req.url];
    if (!file) { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : "text/html");
    res.end(readFileSync(resolve(frontend, file)));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.CHROMIUM_PATH || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  browser = await chromium.launch({ headless: true, executablePath });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((r) => server.close(r));
});

async function dashboard(t, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  t.after(() => context.close());
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addInitScript(() => {
    window.__requests = [];
    window.__epoch = 1000;
    window.WebSocket = class {
      static OPEN = 1;
      constructor() {
        this.readyState = 0;
        window.__socket = this;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
      }
      send(raw) {
        const q = JSON.parse(raw);
        window.__requests.push(q);
        if (q.buy || q.sell || q.contract_update) throw new Error("Orders forbidden in simulation tests");
        let msg = {};
        if (q.proposal) msg = { msg_type: "proposal", proposal: {
          ask_price: q.amount, payout: q.amount * (q.contract_type === "DIGITMATCH" ? 9 : q.contract_type === "DIGITDIFF" ? 1.09 : 1.9), commission: 0.36,
          contract_details: { tick_size_barrier: 0.000537, maximum_ticks: 230 },
        } };
        if (q.ticks_history) msg = { history: {
          prices: Array.from({ length: 1000 }, (_, i) => 100 + ((i * 7) % 10) / 100),
          times: Array.from({ length: 1000 }, (_, i) => q.start == null ? 1700000000 + i * 2 : Number(q.end) - 1998 + i * 2),
        }, pip_size: 2 };
        if (q.ticks) this.symbol = q.ticks;
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ ...msg, req_id: q.req_id }) }), 0);
      }
      close() { this.readyState = 3; this.onclose?.(); }
    };
    window.__tick = (price = 100.01, patch = {}) => {
      window.__epoch += 2;
      window.__socket.onmessage({ data: JSON.stringify({ msg_type: "tick", tick: {
        symbol: "R_100", quote: price, pip_size: 3, epoch: window.__epoch, ...patch,
      } }) });
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, [], "Unexpected browser JavaScript errors"));
  await page.goto(origin);
  await page.waitForFunction(() => window.__requests.some((q) => q.ticks));
  await page.evaluate(() => window.__tick());
  await page.locator("#stake-input").fill("100");
  await page.locator("#stake-input").dispatchEvent("change");
  return page;
}

test("browser: Stop blocks New session until settlement, then the new ledger starts clean", { timeout: 15000 }, async (t) => {
  const page = await dashboard(t);
  await page.locator("#start-btn").click();
  await page.evaluate(() => window.__tick());
  await page.locator("#stop-btn").click();
  assert.equal(await page.locator("#start-btn").isDisabled(), true);
  await page.evaluate(() => window.__tick(100.005)); // digit 5 at pip_size 3
  assert.equal(await page.locator("#stat-losses").textContent(), "1");
  await page.locator("#start-btn").click();
  assert.equal(await page.locator("#stat-losses").textContent(), "0");
  assert.equal(await page.locator("#trade-history-body tr").count(), 0);
});

test("browser: a profit target reached while paused stops instead of offering Resume", { timeout: 15000 }, async (t) => {
  const page = await dashboard(t);
  await page.locator('[data-product="accu"]').click();
  await page.locator("#target-input").fill("10");
  await page.locator("#target-input").dispatchEvent("change");
  await page.locator("#start-btn").click();
  await page.evaluate(() => window.__tick(100));
  await page.locator("#pause-btn").click();
  await page.evaluate(() => { for (let i = 0; i < 4; i++) window.__tick(100); });
  assert.equal(await page.locator("#start-btn").textContent(), "New session");
  assert.match(await page.locator("#stat-pnl").textContent(), /12\.55/);
  assert.equal(await page.locator("#stat-wins").textContent(), "1");
});

test("browser: market selection stays locked during a trade; rejected ticks cannot alter its result", { timeout: 15000 }, async (t) => {
  const page = await dashboard(t);
  await page.locator("#maxloss-input").fill("100");
  await page.locator("#maxloss-input").dispatchEvent("change");
  await page.locator("#start-btn").click();
  await page.evaluate(() => window.__tick());
  assert.equal(await page.locator("#symbol-select").isDisabled(), true);
  await page.locator("#pause-btn").click();
  await page.evaluate(() => {
    window.__tick(100.002, { epoch: 1004 }); // duplicate entry timestamp
    window.__tick(100.002, { epoch: 1003 }); // delayed frame
    window.__tick(100.002, { symbol: "R_25" });
    window.__tick(100.005, { epoch: 1006 }); // actual next chronological tick
  });
  assert.equal(await page.locator("#stat-losses").textContent(), "1");
  assert.equal(await page.locator("#start-btn").textContent(), "New session");
  assert.equal(await page.locator("#symbol-select").isDisabled(), false);
});

test("browser: disconnect/fallback shows an unresolved result and disables simulation", { timeout: 15000 }, async (t) => {
  const page = await dashboard(t);
  await page.locator("#start-btn").click();
  await page.evaluate(() => { window.__tick(); window.__socket.close(); startDemoTimer("R_100", false); });
  assert.equal(await page.locator("#start-btn").isDisabled(), true);
  assert.match(await page.locator("#last-trade").textContent(), /UNRESOLVED/);
  assert.match(await page.locator("#stat-trades").textContent(), /unresolved/);
  assert.equal(await page.locator("#stat-wins").textContent(), "0");
  assert.equal(await page.locator("#stat-losses").textContent(), "0");
  assert.match(await page.locator("#trade-history-body").textContent(), /Unknown.*Unresolved/s);
});

test("browser: open drawdown and a zero-profit Multiplier timeout render accurately", { timeout: 15000 }, async (t) => {
  const page = await dashboard(t);
  await page.locator('[data-product="mult"]').click();
  await page.locator("#start-btn").click();
  await page.evaluate(() => { window.__tick(100); window.__tick(99.8); });
  assert.match(await page.locator("#stat-dd").textContent(), /23\.60/);
  await page.evaluate(() => { for (let i = 0; i < 119; i++) window.__tick(100.036); });
  assert.equal(await page.locator("#stat-losses").textContent(), "0");
  assert.match(await page.locator("#last-trade").textContent(), /BREAK-EVEN/);
  assert.match(await page.locator("#stat-trades").textContent(), /1 break-even/);
  assert.match(await page.locator("#trade-history-body").textContent(), /Break-even/);
});

test("browser: mobile dashboard retains its layout with unresolved-status text", { timeout: 15000 }, async (t) => {
  const page = await dashboard(t, { width: 390, height: 844 });
  await page.locator("#start-btn").click();
  await page.evaluate(() => { window.__tick(); window.__socket.close(); });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 2, `Horizontal overflow: ${overflow}px`);
  assert.equal(await page.locator("#start-btn").isVisible(), true);
});

test("browser: virtual research compares contracts and staking without changing the account or simulation", { timeout: 20000 }, async t => {
  const page = await dashboard(t, { width: 390, height: 844 });
  await page.evaluate(() => {
    const timer = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms, ...args) => timer(fn, ms === 1100 ? 0 : ms, ...args);
  });
  await page.locator("#lab-card > summary").click();
  await page.locator("#research-panel > summary").click();
  await page.locator("#research-balance").fill("1");
  await page.locator("#research-run").click();
  await page.locator("#research-output").waitFor({ state: "visible" });
  assert.equal(await page.locator("#research-body tr").count(), 30);
  const noTrade = (await page.locator("#research-selection").innerText()).includes("NO TRADE");
  assert.equal(await page.locator("#research-staking tr").count(), noTrade ? 0 : 4);
  assert.match(await page.locator("#research-status").innerText(), /final 40% held out/);
  assert.match(await page.locator("#research-body").innerText(), /stake outside configured contract limits/);
  assert.match(await page.locator("#research-caveat").innerText(), /not historical executable quotes/);
  assert.match(await page.locator("#research-decision").innerText(), /^NO TRADE/);
  assert.equal(await page.locator("#research-benchmark-staking tr").count(), 4);
  assert.equal(await page.locator("#stat-pnl").innerText(), "$0.00");
  assert.equal(await page.evaluate(() => state.execution), "simulation");
  assert.equal(await page.evaluate(() => window.__requests.some(q => q.buy || q.sell || q.authorize)), false);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 2);
});

test("browser: research refuses invalid funding and shows no substituted results", { timeout: 15000 }, async t => {
  const page = await dashboard(t);
  await page.locator("#lab-card > summary").click();
  await page.locator("#research-panel > summary").click();
  await page.locator("#research-balance").fill("0");
  await page.locator("#research-run").click();
  await page.waitForFunction(() => document.querySelector("#research-status").textContent.startsWith("Research stopped:"));
  assert.match(await page.locator("#research-status").innerText(), /positive amounts/);
  assert.equal(await page.locator("#research-output").isHidden(), true);
});
