"use strict";
/** Executa todos os arquivos *.test.js desta pasta com o runner nativo do Node. */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function testFiles() {
  return fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js")).sort().map((f) => path.join(__dirname, f));
}

/** Roda uma vez e devolve o código de saída (0 = tudo passou). */
function runOnce({ reporter = "spec" } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", `--test-reporter=${reporter}`, ...testFiles()], { stdio: "inherit", env: process.env });
    child.on("close", (code) => resolve(code === null ? 1 : code));
  });
}

module.exports = { runOnce, testFiles };

if (require.main === module) runOnce().then((code) => process.exit(code));