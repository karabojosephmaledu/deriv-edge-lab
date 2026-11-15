/* Offline deployment/config checks: node --test tests/deployment.test.cjs */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync, mkdtempSync, cpSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve, join } = require("node:path");
const { execFileSync } = require("node:child_process");

const root = resolve(__dirname, "..");
const source = readFileSync(join(root, "frontend/public/app.js"), "utf8");

function configApp(fetch) {
  const timers = new Map();
  let seq = 0;
  const oauth = { hidden: true };
  const context = vm.createContext({
    AbortController, fetch,
    document: { getElementById: (id) => id === "oauth-block" ? oauth : null },
    setTimeout: (fn, delay) => { const id = ++seq; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(source.replace(/\ninit\(\);\s*$/, "\n"), context);
  const api = vm.runInContext("({ loadConfig, state })", context);
  return {
    ...api, timers, oauth,
    async retry() {
      const [id, timer] = [...timers].find(([, t]) => t.delay !== 4000);
      timers.delete(id);
      await timer.fn();
      return timer.delay;
    },
  };
}

const config = {
  app_id: "public-app-id", oauth_ready: true,
  public_ws_url: "wss://api.derivws.com/trading/v1/options/ws/public",
  api_base: "https://api.derivws.com", oauth_authorize_url: "https://auth.deriv.com/oauth2/auth",
};
const ok = (body = config) => ({ ok: true, json: async () => body });

test("configuration succeeds immediately with no retry or leftover timeout", async () => {
  let request;
  const a = configApp(async (url, options) => { request = { url, options }; return ok(); });
  await a.loadConfig();
  assert.equal(request.url, "/api/deriv/config");
  assert.equal(request.options.cache, "no-store");
  assert.equal(a.state.cfg.app_id, config.app_id);
  assert.equal(a.state.cfg.oauth_ready, true);
  assert.equal(a.oauth.hidden, false);
  assert.equal(a.timers.size, 0);
});

test("a waking backend can recover after timeout and enable OAuth in the already-open dialog", async () => {
  let calls = 0;
  const a = configApp(async (_, { signal }) => {
    if (++calls > 1) return ok();
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  });
  const first = a.loadConfig();
  [...a.timers.values()].find((t) => t.delay === 4000).fn();
  await first;
  assert.equal(a.state.cfg.oauth_ready, false);
  assert.equal(a.oauth.hidden, true);
  assert.equal(a.timers.size, 1);
  assert.equal(await a.retry(), 5000);
  assert.equal(calls, 2);
  assert.equal(a.state.cfg.oauth_ready, true);
  assert.equal(a.oauth.hidden, false);
  assert.equal(a.timers.size, 0);
});

test("HTTP errors retry in the background instead of treating an error page as config", async () => {
  let calls = 0;
  const a = configApp(async () => ++calls === 1 ? { ok: false } : ok());
  await a.loadConfig();
  assert.equal(a.state.cfg.oauth_ready, false);
  assert.equal(a.timers.size, 1);
  await a.retry();
  assert.equal(a.state.cfg.oauth_ready, true);
});

test("network failure retries are bounded and clean up aborted request timers", async () => {
  let calls = 0;
  const a = configApp(async () => { calls++; throw new Error("offline"); });
  await a.loadConfig();
  const delays = [];
  while (a.timers.size) delays.push(await a.retry());
  assert.deepEqual(delays, [5000, 10000, 15000, 20000]);
  assert.equal(calls, 5);
  assert.equal(a.state.cfg.oauth_ready, false);
});

test("invalid JSON from a cold-start loading page is retried", async () => {
  let calls = 0;
  const a = configApp(async () => ++calls === 1 ? { ok: true, json: async () => { throw new SyntaxError("HTML response"); } } : ok());
  await a.loadConfig();
  assert.equal(a.state.cfg.oauth_ready, false);
  await a.retry();
  assert.equal(a.state.cfg.oauth_ready, true);
});

test("invalid config cannot enable OAuth or replace public endpoints", async () => {
  const a = configApp(async () => ok({ oauth_ready: "true", app_id: "bad-response" }));
  const id = a.state.cfg.app_id;
  await a.loadConfig();
  assert.equal(a.state.cfg.app_id, id);
  assert.equal(a.state.cfg.oauth_ready, false);
  assert.equal(a.oauth.hidden, true);
  assert.equal(a.timers.size, 1);
});

test("a valid unconfigured backend remains unconfigured without repeated requests", async () => {
  const a = configApp(async () => ok({ oauth_ready: false, app_id: "1089" }));
  const id = a.state.cfg.app_id;
  await a.loadConfig();
  assert.equal(a.state.cfg.app_id, id);
  assert.equal(a.state.cfg.oauth_ready, false);
  assert.equal(a.oauth.hidden, true);
  assert.equal(a.timers.size, 0);
});

test("the actual Render static build preserves dashboard assets and routes to the existing backend", (t) => {
  const yaml = readFileSync(join(root, "render.yaml"), "utf8");
  const frontend = yaml.slice(yaml.indexOf("name: deriv-edge-lab-web"));
  const build = frontend.match(/buildCommand: (.+)/)[1];
  const publish = frontend.match(/staticPublishPath: (.+)/)[1];
  const destination = frontend.match(/destination: (.+)/)[1];
  const temp = mkdtempSync(join(tmpdir(), "deriv-static-build-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  cpSync(join(root, "frontend"), join(temp, "frontend"), { recursive: true, filter: (p) => !p.includes("node_modules") });
  execFileSync("sh", ["-c", build], { cwd: temp });
  for (const [input, output] of [["public/account.js", "account.js"], ["public/research-evidence.json", "research-evidence.json"], ["index.html", "index.html"], ["public/app.js", "app.js"], ["public/styles.css", "styles.css"], ["public/favicon.svg", "favicon.svg"]]) {
    assert.deepEqual(readFileSync(join(temp, publish, output)), readFileSync(join(root, "frontend", input)));
  }
  assert.equal(destination.replace("*", "deriv/config"), "https://deriv-edge-lab-2oux.onrender.com/api/deriv/config");
});
