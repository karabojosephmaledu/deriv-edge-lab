// Load the same dependency-free browser engine in Node, despite frontend's ESM package.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const sandbox = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../frontend/public/research.js"), "utf8"), sandbox);
module.exports = sandbox.module.exports;
