"use strict";
/**
 * 3) SEGURANÇA CLIENT-SIDE
 * XSS (DOM instrumentado + navegador real), CSP, poluição de protótipo e endurecimento estático.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { newSession, closeBrowser } = require("./_support/browser");
const { freshEnv, record, seedItems, mockFetch, fixtures, read, flush, cards, quickButtons, doSearch, titlesOf, findAll, hasClass } = require("./_support/env");

after(closeBrowser);

const PAYLOADS = [
  "<script>alert('xss')</script>",
  "<img src=x onerror=alert(1)>",
  '"><svg onload=alert(1)>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  "javascript:alert(1)",
  "'); alert(1);//",
  '<a href="javascript:alert(1)">clique</a>',
  "{{constructor.constructor('alert(1)')()}}",
  "${alert(1)}",
  "\u202Eevil\u202C",
];

const maliciousApis = (payload) => ({
  "catalog/movie/top": { body: { metas: [{ id: "tt0000001", imdb_id: "tt0000001", type: "movie", name: payload, poster: "javascript:alert(1)", releaseInfo: "2001", description: payload }] } },
  "catalog/series/top": { body: { metas: [{ id: "tt0000002", imdb_id: "tt0000002", type: "series", name: payload, poster: "data:text/html,<script>alert(1)</script>", releaseInfo: "2002" }] } },
  "graphql.anilist.co": { body: { data: { Page: { media: [{ id: 9, title: { english: payload, romaji: payload }, description: payload, coverImage: { large: "javascript:alert(1)" }, seasonYear: 2000 }] } } } },
  "meta/movie/tt0000001.json": { body: { meta: { description: payload, imdbRating: "7" } } },
  "meta/series/tt0000002.json": { body: { meta: { description: payload, imdbRating: "7" } } },
});

const ALLOWED_TAGS = new Set(["article", "div", "span", "button", "img", "p", "a"]);
function assertDomIsSafe(dom, label = "") {
  assert.deepEqual(dom.rec.unsafe, [], `${label} escritas inseguras no DOM`);
  assert.deepEqual([...new Set(dom.rec.createdTags)].filter((t) => !ALLOWED_TAGS.has(t)), [], `${label} elementos perigosos criados`);
  assert.deepEqual(dom.rec.attributes.filter(([k]) => /^on/i.test(k) || ["srcdoc", "style", "href", "formaction"].includes(k.toLowerCase())), [], `${label} atributos perigosos`);
  dom.rec.images.forEach((src) => assert.ok(src.startsWith("https://") || src.startsWith("data:image/svg+xml"), `${label} src de imagem inseguro: ${src}`));
}

describe("XSS — DOM instrumentado (toda escrita insegura é registrada)", () => {
  for (const payload of PAYLOADS) {
    it(`título/sinopse maliciosos vindos das APIs: ${JSON.stringify(payload).slice(0, 50)}`, async () => {
      global.fetch = mockFetch(maliciousApis(payload));
      const c = freshEnv({ app: true });
      await doSearch(c, "xss");
      assert.ok(cards(c.grid).length >= 3);
      assert.ok(titlesOf(c.grid).includes(payload), "o título deve aparecer como TEXTO, idêntico ao original");
      quickButtons(cards(c.grid)[0])[0].dispatch("click");
      cards(c.grid)[1].dispatch("click"); await flush();
      assert.ok(c.D.modalOverview.textContent === payload || c.D.modalOverview.textContent.length > 0);
      c.D.mediaForm.dispatch("submit");
      c.D.btnBack.dispatch("click");
      assertDomIsSafe(c.dom, "busca/modal/backlog:");
    });

    it(`backup importado com payload em título, comentário, sinopse, pôster e id: ${JSON.stringify(payload).slice(0, 40)}`, async () => {
      const c = freshEnv();
      const evil = [
        { id: "imdb:movie:tt0000001", title: payload, review: payload, overview: payload, poster_path: "javascript:alert(1)", status: "watched", rating: 5, year: 2000 },
        { id: "imdb:tv:tt0000002", title: "ok", poster_path: "data:text/html,<script>alert(1)</script>", status: "<script>", category: payload },
        { id: `imdb:movie:tt0000003${payload}`, title: "id forjado" },
        { id: "imdb:movie:tt0000004", title: payload, poster_path: "//evil.example/x.png", year: payload, score: payload, rating: payload },
      ];
      const result = c.S.importData(JSON.stringify({ items: evil }));
      assert.equal(result.skipped, 1, "o id forjado deve ser rejeitado");
      global.fetch = mockFetch(fixtures.OK);
      const app = freshEnv({ app: true, seed: c.store });
      assert.ok(titlesOf(app.grid).includes(payload));
      cards(app.grid)[0].dispatch("click"); await flush();
      assertDomIsSafe(app.dom, "backlog importado:");
      app.S.getBacklog().forEach((i) => { assert.ok(!i.poster_path || i.poster_path.startsWith("https://")); assert.ok(["watched", "plan_to_watch"].includes(i.status)); });
    });
  }

  it("texto digitado na busca é exibido como texto e vai codificado na URL", async () => {
    const calls = []; global.fetch = mockFetch(fixtures.OK, calls);
    const c = freshEnv({ app: true });
    const q = "<script>alert('xss')</script>";
    await doSearch(c, q);
    assert.equal(c.D.pageTitle.textContent, `Resultados para: "${q}"`);
    assert.ok(calls.every((x) => !x.url.includes("<") && !x.url.includes(">")));
    assertDomIsSafe(c.dom);
  });

  it("comentário com HTML salvo pelo modal volta como texto puro ao reabrir", async () => {
    global.fetch = mockFetch(fixtures.OK);
    const c = freshEnv({ app: true });
    await doSearch(c, "batman");
    cards(c.grid)[0].dispatch("click"); await flush();
    c.D.modalReview.value = "<img src=x onerror=alert(1)>";
    c.D.mediaForm.dispatch("submit");
    cards(c.grid)[0].dispatch("click");
    assert.equal(c.D.modalReview.value, "<img src=x onerror=alert(1)>");
    assertDomIsSafe(c.dom);
  });

  it("poluição de protótipo via backup (__proto__/constructor) não contamina Object.prototype", () => {
    const { S } = freshEnv();
    const backup = '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}},"items":[{"__proto__":{"polluted3":true},"id":"imdb:movie:tt0000001","title":"x","status":"watched","constructor":{"prototype":{"polluted4":true}}}]}';
    S.importData(backup);
    S.getBacklog();
    for (const key of ["polluted", "polluted2", "polluted3", "polluted4"]) assert.equal({}[key], undefined, key);
    assert.equal(S.getBacklog().length, 1);
  });

  it("nenhum campo extra do backup é persistido (só a lista branca de campos)", () => {
    const { S } = freshEnv();
    S.importData(JSON.stringify([{ id: "imdb:movie:tt0000001", title: "x", status: "watched", admin: true, __proto__: { a: 1 }, onclick: "alert(1)", html: "<b>" }]));
    assert.deepEqual(Object.keys(S.getBacklog()[0]).sort(), ["added_at", "category", "external_id", "id", "kind", "overview", "poster_path", "rating", "review", "score", "source", "status", "title", "updated_at", "year"]);
  });
});

describe("XSS — navegador real (scripts de verdade, com a CSP ativa)", { timeout: 90000 }, () => {
  const live = (p) => p.replaceAll("alert(1)", "window.__xss=1").replaceAll("alert('xss')", "window.__xss=2");
  const BROWSER_PAYLOADS = [
    "<script>window.__xss=3</script>",
    '<img src=x onerror="window.__xss=4">',
    '"><svg onload="window.__xss=5">',
    '<iframe srcdoc="<script>parent.__xss=6</script>"></iframe>',
    "<script>alert('xss')</script>",
  ];
  const pageIsClean = async (s) => {
    assert.equal(await s.page.evaluate(() => window.__xss), undefined, "um script injetado EXECUTOU");
    assert.deepEqual(s.dialogs.filter((d) => d.type === "alert"), [], "um alert() foi disparado");
    assert.equal(await s.page.evaluate(() => document.scripts.length), 3, "apareceu um <script> novo");
    assert.equal(await s.page.evaluate(() => document.querySelectorAll("img[onerror], iframe, object, embed, [onload], [onclick], svg:not(.scope-btn svg)").length), 0, "elemento perigoso no DOM");
    assert.deepEqual(s.errors, []);
  };

  it("títulos/sinopses maliciosos das APIs aparecem como texto e nada executa (busca, ação rápida, modal, backlog)", async (t) => {
    for (const payload of BROWSER_PAYLOADS) {
      const s = await newSession(t, { mocks: {
        movies: () => ({ body: { metas: [{ id: "tt0000001", imdb_id: "tt0000001", type: "movie", name: payload, poster: "javascript:window.__xss=7", releaseInfo: "2001", description: payload }] } }),
        series: () => ({ body: { metas: [] } }),
        anilist: () => ({ body: { data: { Page: { media: [{ id: 9, title: { english: payload }, description: payload, coverImage: { large: "https://s4.anilist.co/a.jpg" }, seasonYear: 2000 }] } } } }),
        meta: () => ({ body: { meta: { description: payload, imdbRating: "7" } } }),
      } }); if (!s) return;
      await s.goto(); await s.search("xss");
      const titles = await s.page.$$eval(".card-title", (els) => els.map((e) => e.textContent));
      assert.deepEqual(titles, [payload, payload], "o título deve ser exibido literalmente, como texto");
      await s.page.locator(".media-card").first().getByRole("button", { name: "+ Quero ver" }).click();
      await s.page.locator(".media-card").nth(0).click();           // filme salvo: sinopse literal, como TEXTO
      await s.page.waitForFunction((p) => document.getElementById("modalOverview").textContent === p, payload);
      await s.page.click("#btnCloseModal");
      await s.page.locator(".media-card").nth(1).click();           // anime: o AniList tem as tags removidas
      assert.doesNotMatch(await s.page.textContent("#modalOverview"), /<\/?(script|img|svg|iframe)/i);
      await s.page.click("#btnCloseModal");
      await s.page.click("#btnBack");
      await s.page.locator(".media-card").first().click();
      await pageIsClean(s);
    }
  });

  it("backup .json malicioso importado pelo botão: nada executa e o pôster 'javascript:' é descartado", async (t) => {
    const s = await newSession(t); if (!s) return;
    await s.goto();
    const items = BROWSER_PAYLOADS.map((p, i) => ({ id: `imdb:movie:tt00000${10 + i}`, title: p, review: p, overview: p, poster_path: "javascript:window.__xss=8", status: "watched", rating: 5 }));
    await s.page.setInputFiles("#importFile", { name: "mal.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ items })) });
    await s.page.waitForSelector(".media-card");
    assert.equal(await s.page.locator(".media-card").count(), items.length);
    for (let i = 0; i < items.length; i++) { await s.page.locator(".media-card").nth(i).click(); await s.page.click("#btnCloseModal"); }
    const srcs = await s.page.$$eval(".media-card img", (els) => els.map((e) => e.getAttribute("src")));
    srcs.forEach((src) => assert.ok(src.startsWith("data:image/svg+xml"), `src inesperado: ${src.slice(0, 60)}`));
    await pageIsClean(s);
  });

  it("payload digitado no campo de busca é tratado como texto", async (t) => {
    const s = await newSession(t); if (!s) return;
    await s.goto();
    await s.search("<img src=x onerror=window.__xss=9>");
    assert.equal(await s.page.textContent("#pageTitle"), 'Resultados para: "<img src=x onerror=window.__xss=9>"');
    await pageIsClean(s);
    assert.ok(s.log.calls.every((c) => !decodeURIComponent(c.url).includes("<img") || c.url.includes("%3C")), "o texto deve ir codificado");
  });

  it("CSP via cabeçalho bloqueia script inline injetado e uso normal não gera violações", async (t) => {
    const s = await newSession(t, { headers: true }); if (!s) return;
    await s.goto(); await s.search("batman");
    await s.page.locator(".media-card").first().click();
    await s.page.click("#btnCloseModal");
    assert.deepEqual(s.csp, [], "violações de CSP no uso normal: " + s.csp.join(" | "));
    await s.page.evaluate(() => { const el = document.createElement("script"); el.textContent = "window.__csp = 1"; document.head.appendChild(el); });
    assert.equal(await s.page.evaluate(() => window.__csp), undefined, "script inline NÃO deveria executar");
    assert.ok(s.csp.length >= 1, "o navegador deveria registrar a violação de CSP");
  });

  it("CSP também vale SEM cabeçalhos (ex.: GitHub Pages), via <meta> no HTML", async (t) => {
    const s = await newSession(t, { headers: false }); if (!s) return;
    await s.goto(); await s.search("batman");
    assert.deepEqual(s.csp, [], "violações de CSP no uso normal: " + s.csp.join(" | "));
    await s.page.evaluate(() => { const el = document.createElement("script"); el.textContent = "window.__csp = 1"; document.head.appendChild(el); });
    assert.equal(await s.page.evaluate(() => window.__csp), undefined, "sem CSP no HTML, qualquer script inline injetado executaria");
  });

  it("o app só conversa com as origens previstas (Cinemeta e AniList) e nenhuma requisição externa escapa", async (t) => {
    const s = await newSession(t); if (!s) return;
    await s.goto(); await s.search("batman");
    await s.page.locator(".media-card").first().click();
    const hosts = new Set(s.log.calls.map((c) => new URL(c.url).host));
    assert.deepEqual([...hosts].sort(), ["graphql.anilist.co", "v3-cinemeta.strem.io"]);
    assert.deepEqual(s.log.blocked, []);
  });
});

describe("Endurecimento estático", () => {
  const FILES = ["app.js", "searchService.js", "storageService.js"];
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const code = () => FILES.map((f) => stripComments(read(f))).join("\n");

  it("sem eval, new Function, document.write, innerHTML/outerHTML/insertAdjacentHTML ou setTimeout com texto", () => {
    assert.doesNotMatch(code(), /\beval\s*\(|new\s+Function\s*\(|document\.write|\.innerHTML|\.outerHTML|insertAdjacentHTML|setTimeout\s*\(\s*["'`]|setInterval\s*\(\s*["'`]/);
  });

  it("só existem URLs absolutas nas origens autorizadas", () => {
    const hosts = new Set([...code().matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]));
    const allowed = new Set(["v3-cinemeta.strem.io", "graphql.anilist.co", "www.w3.org"]);
    assert.deepEqual([...hosts].filter((h) => !allowed.has(h)), []);
  });

  it("HTML: scripts só locais, sem handlers inline, sem 'javascript:' e links externos com rel seguro", () => {
    const html = read("index.html");
    [...html.matchAll(/<script\b[^>]*>/g)].forEach((m) => assert.match(m[0], /src="[^":]+\.js"/, m[0]));
    assert.doesNotMatch(html, /\son[a-z]+\s*=|javascript:/i);
    [...html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)].forEach((m) => assert.match(m[0], /rel="[^"]*noopener/, m[0]));
  });

  const policyOf = (text) => Object.fromEntries(text.split(";").map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...values] = d.split(/\s+/); return [name, values]; }));
  const headerPolicy = () => policyOf(JSON.parse(read("vercel.json")).headers[0].headers.find((h) => h.key === "Content-Security-Policy").value);

  it("CSP do cabeçalho: sem 'unsafe-inline'/'unsafe-eval', scripts só 'self', origens de rede mínimas", () => {
    const policy = headerPolicy();
    assert.ok(!JSON.stringify(policy).includes("unsafe-"));
    assert.deepEqual(policy["script-src"], ["'self'"]);
    assert.deepEqual(policy["style-src"], ["'self'"]);
    assert.deepEqual(policy["connect-src"], ["'self'", "https://v3-cinemeta.strem.io", "https://graphql.anilist.co"]);
    assert.deepEqual(policy["frame-ancestors"], ["'none'"]);
    assert.deepEqual(policy["base-uri"], ["'none'"]);
  });

  it("o HTML também carrega a CSP (<meta>), idêntica à do cabeçalho, para hospedagens sem cabeçalhos", () => {
    const m = read("index.html").match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
    assert.ok(m, "falta <meta http-equiv=\"Content-Security-Policy\"> no index.html");
    const meta = policyOf(m[1]);
    const header = headerPolicy();
    delete header["frame-ancestors"]; // não é suportada via <meta>
    assert.deepEqual(meta, header);
  });

  it("outros cabeçalhos de segurança presentes (nosniff e Referrer-Policy)", () => {
    const headers = JSON.parse(read("vercel.json")).headers[0].headers;
    assert.equal(headers.find((h) => h.key === "X-Content-Type-Options").value, "nosniff");
    assert.match(headers.find((h) => h.key === "Referrer-Policy").value, /strict-origin|no-referrer|same-origin/);
  });

  it("nenhuma chave/token/segredo no código entregue ao navegador", () => {
    const everything = ["app.js", "searchService.js", "storageService.js", "index.html", "style.css", "vercel.json"].map(read).join("\n");
    assert.doesNotMatch(everything, /api[_-]?key|apikey|bearer\s|authorization|secret|password|eyJ[A-Za-z0-9_-]{10,}|[a-f0-9]{32,}/i);
  });
});