"use strict";
/**
 * Infraestrutura de testes em navegador REAL (Chromium via Playwright).
 *  - serve a pasta do site em http://127.0.0.1:<porta> aplicando os cabeçalhos do vercel.json (CSP etc.);
 *  - intercepta TODAS as chamadas externas (Cinemeta, AniList, imagens): testes offline e determinísticos;
 *  - qualquer outra requisição externa é bloqueada e registrada (o app só pode falar com origens conhecidas).
 *
 * Se o Playwright/Chromium não estiver instalado, os testes de navegador são PULADOS com aviso
 * (use CINELOG_E2E=required para transformar isso em falha).
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { FRONTEND_DIR, fixtures } = require("./env");

let playwright = null;
try { playwright = require("playwright"); } catch { /* opcional */ }

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
};

function vercelHeaders() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(FRONTEND_DIR, "vercel.json"), "utf8"));
    return (config.headers || []).flatMap((h) => h.headers || []);
  } catch { return []; }
}

/** headers=false simula hospedagens sem cabeçalhos (ex.: GitHub Pages): só vale o que está no HTML. */
function startServer({ headers = true } = {}) {
  const extra = headers ? vercelHeaders() : [];
  const server = http.createServer((req, res) => {
    let pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (pathname === "/") pathname = "/index.html";
    const file = path.normalize(path.join(FRONTEND_DIR, pathname));
    if (!file.startsWith(FRONTEND_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    const h = { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" };
    extra.forEach(({ key, value }) => { h[key] = value; });
    res.writeHead(200, h);
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })
    )
  );
}

// ---------------------------------------------------------------------------
// Navegador compartilhado por arquivo de teste
// ---------------------------------------------------------------------------
const E = { ready: false, reason: null, browser: null, init: null };

function ensureBrowser() {
  if (E.init) return E.init;
  E.init = (async () => {
    if (!playwright) { E.reason = "Playwright não instalado (rode: npm install && npx playwright install chromium)"; return; }
    try { E.browser = await playwright.chromium.launch(); E.ready = true; }
    catch (error) { E.reason = "Chromium indisponível (rode: npx playwright install chromium): " + String(error.message).split("\n")[0]; }
  })();
  return E.init;
}
async function closeBrowser() { if (E.browser) { await E.browser.close(); E.browser = null; } }

// ---------------------------------------------------------------------------
// Mocks das APIs externas
// ---------------------------------------------------------------------------
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS" };

/** Cada função recebe a URL/corpo e devolve { body | rawBody, status, abort, hang, delay, contentType }. */
function defaultMocks() {
  return {
    movies: () => ({ body: fixtures.cineMovies }),
    series: () => ({ body: fixtures.cineSeries }),
    anilist: () => ({ body: fixtures.anilist }),
    meta: () => ({ body: fixtures.meta }),
  };
}

async function installMocks(context, origin, overrides = {}) {
  const mocks = { ...defaultMocks(), ...overrides };
  const log = { calls: [], blocked: [], images: [] };

  // Rede de segurança: nada externo sai sem ser interceptado.
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
    log.blocked.push(url);
    return route.abort("blockedbyclient");
  });

  const respond = async (route, spec) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (spec.hang) return undefined; // nunca responde (para testar timeout)
    if (spec.delay) await new Promise((r) => setTimeout(r, spec.delay));
    if (spec.abort) return route.abort(spec.abort);
    const body = spec.rawBody !== undefined ? spec.rawBody : JSON.stringify(spec.body === undefined ? {} : spec.body);
    return route.fulfill({ status: spec.status || 200, headers: { ...CORS, "content-type": spec.contentType || "application/json" }, body });
  };
  const record = (route) => {
    const req = route.request();
    if (req.method() !== "OPTIONS") log.calls.push({ url: req.url(), method: req.method(), body: req.postData() });
  };

  await context.route(/https:\/\/v3-cinemeta\.strem\.io\/catalog\/movie\//, (route) => { record(route); return respond(route, mocks.movies(route.request().url())); });
  await context.route(/https:\/\/v3-cinemeta\.strem\.io\/catalog\/series\//, (route) => { record(route); return respond(route, mocks.series(route.request().url())); });
  await context.route(/https:\/\/v3-cinemeta\.strem\.io\/meta\//, (route) => { record(route); return respond(route, mocks.meta(route.request().url())); });
  await context.route("https://graphql.anilist.co/**", (route) => { record(route); return respond(route, mocks.anilist(route.request().postData())); });
  await context.route(/https:\/\/(m\.media-amazon\.com|images\.metahub\.space|s\d+\.anilist\.co|image\.tmdb\.org)\//, (route) => {
    log.images.push(route.request().url());
    return route.fulfill({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
  });

  return { mocks, log };
}

// ---------------------------------------------------------------------------
// Sessão de teste (1 contexto isolado por teste)
// ---------------------------------------------------------------------------
async function newSession(t, { headers = true, viewport = { width: 1280, height: 800 }, seed = null, mocks = {}, onDialog = "accept" } = {}) {
  if (process.env.CINELOG_E2E === "skip") { t.skip("modo rápido (--fast): testes de navegador pulados"); return null; }
  await ensureBrowser();
  if (!E.ready) {
    if (process.env.CINELOG_E2E === "required") throw new Error(E.reason);
    t.skip(E.reason);
    return null;
  }
  const server = await startServer({ headers });
  const context = await E.browser.newContext({ viewport, acceptDownloads: true, serviceWorkers: "block" });
  const installed = await installMocks(context, server.url, mocks);

  if (seed) {
    // Semeia o localStorage UMA vez por aba (não volta a semear depois de um reload).
    await context.addInitScript((entries) => {
      if (!sessionStorage.getItem("__seeded")) {
        entries.forEach(([k, v]) => localStorage.setItem(k, v));
        sessionStorage.setItem("__seeded", "1");
      }
    }, Object.entries(seed));
  }

  const page = await context.newPage();
  const session = { page, context, server, mocks: installed.mocks, log: installed.log, errors: [], dialogs: [], csp: [], consoleErrors: [] };
  page.on("pageerror", (e) => session.errors.push(String(e.message || e)));
  page.on("dialog", async (d) => { session.dialogs.push({ type: d.type(), message: d.message() }); await (onDialog === "accept" ? d.accept() : d.dismiss()); });
  page.on("console", (msg) => {
    const text = msg.text();
    if (/Content[- ]Security[- ]Policy|Refused to (load|execute|connect|apply)/i.test(text)) session.csp.push(text);
    if (msg.type() === "error") session.consoleErrors.push(text);
  });

  session.goto = () => page.goto(server.url + "/");
  session.search = async (query) => {
    await page.fill("#searchInput", query);
    await page.press("#searchInput", "Enter");
    await page.waitForFunction(() => {
      const text = document.getElementById("mediaGrid").textContent;
      return !text.includes("Buscando");
    });
  };
  t.after(async () => { await context.close(); await server.close(); });
  return session;
}

/** Contraste WCAG (texto x fundo opaco mais próximo) dos seletores informados. */
function contrastReport(page, selectors) {
  return page.evaluate((sels) => {
    const parse = (c) => { const p = c.match(/rgba?\(([^)]+)\)/)[1].split(",").map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };
    const channel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const lum = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    const bgOf = (el) => { for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c.a > 0.99) return c; } return { r: 22, g: 24, b: 28, a: 1 }; };
    return sels.map((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { sel, missing: true };
      const fg = parse(getComputedStyle(el).color), bg = bgOf(el);
      const L1 = lum(fg), L2 = lum(bg);
      return { sel, ratio: Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100 };
    });
  }, selectors);
}

module.exports = { E, ensureBrowser, closeBrowser, startServer, newSession, contrastReport, PNG };