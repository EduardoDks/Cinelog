"use strict";
/**
 * Loop de testes contínuo: roda a suíte e ROTA DE NOVO sempre que um arquivo do site ou dos testes mudar.
 *   npm run test:watch            -> observa e repete (suíte completa, ~1 min por ciclo)
 *   npm run test:watch:fast       -> observa e repete só os testes rápidos (poucos segundos)
 *   node tests/watch.js --once    -> roda uma única vez (igual a npm test)
 * Opções: --fast (pula os testes de navegador)  --once (não observa)
 * Usa verificação por data de modificação (funciona igual no Windows, macOS e Linux).
 */
const fs = require("node:fs");
const path = require("node:path");
const { runOnce } = require("./run");
const { FRONTEND_DIR } = require("./_support/env");

const WATCHED = [FRONTEND_DIR, __dirname];
const EXT = new Set([".js", ".html", ".css", ".json"]);
const IGNORED = new Set(["node_modules", "artifacts", ".git"]);
const INTERVAL_MS = 700;
const DEBOUNCE_MS = 400;

function snapshot() {
  const state = new Map();
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (EXT.has(path.extname(entry.name))) { try { const st = fs.statSync(full); state.set(full, `${st.mtimeMs}:${st.size}`); } catch { /* arquivo sumiu */ } }
    }
  };
  WATCHED.forEach(walk);
  return state;
}

function changedFiles(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((f) => before.get(f) !== after.get(f)).map((f) => path.relative(process.cwd(), f));
}

const stamp = () => new Date().toLocaleTimeString("pt-BR");
let cycle = 0;

async function cycleRun(reason) {
  cycle += 1;
  if (process.stdout.isTTY) console.clear();
  const mode = process.env.CINELOG_E2E === "skip" ? " · modo rápido" : "";
  console.log(`\n=== Ciclo ${cycle} · ${stamp()} · ${reason}${mode} ===\n`);
  const started = Date.now();
  const code = await runOnce();
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${code === 0 ? "✔ TUDO PASSOU" : "✖ HÁ FALHAS (código " + code + ")"} · ${secs}s · ${stamp()}`);
  return code;
}

async function main() {
  if (process.argv.includes("--fast")) process.env.CINELOG_E2E = "skip"; // herdado pelos processos de teste
  if (process.argv.includes("--once")) process.exit(await cycleRun("execução única"));

  let known = snapshot();
  let running = false;
  let pending = null;
  await cycleRun("primeira execução");
  console.log("\nObservando alterações em:\n  " + WATCHED.map((d) => path.relative(process.cwd(), d) || ".").join("\n  ") + "\n(Ctrl+C para sair)");

  let lastChange = 0;
  setInterval(async () => {
    const now = snapshot();
    const changes = changedFiles(known, now);
    if (changes.length) { known = now; lastChange = Date.now(); pending = changes; }
    if (pending && !running && Date.now() - lastChange >= DEBOUNCE_MS) {
      const files = pending; pending = null; running = true;
      await cycleRun(`alterado: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` (+${files.length - 3})` : ""}`);
      known = snapshot(); running = false;
      console.log("\nObservando alterações... (Ctrl+C para sair)");
    }
  }, INTERVAL_MS);
}

main();