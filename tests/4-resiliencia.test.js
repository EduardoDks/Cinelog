"use strict";
/**
 * 4) RESILIÊNCIA
 * Dados corrompidos no localStorage (sem "tela branca") e falhas de API (HTTP 500/404/429, rede, timeout, resposta inválida).
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { newSession, closeBrowser } = require("./_support/browser");
const { freshEnv, record, seedItems, mockFetch, netError, fixtures, flush, cards, doSearch, titlesOf } = require("./_support/env");

after(closeBrowser);

const GOOD = record("imdb:movie:tt0372784", "Batman Begins", "watched");
const ITEMS = "cinelog:v2:items";
const PREFS = "cinelog:v2:prefs";

const CORRUPTED = [
  ["JSON quebrado", { [ITEMS]: "{{{ isto não é json" }],
  ["JSON válido, mas null", { [ITEMS]: "null" }],
  ["número no lugar da lista", { [ITEMS]: "123" }],
  ["texto no lugar da lista", { [ITEMS]: '"texto"' }],
  ["objeto no lugar da lista", { [ITEMS]: "{}" }],
  ["booleano", { [ITEMS]: "true" }],
  ["lista com lixo misturado", { [ITEMS]: JSON.stringify([null, 1, "x", [], {}, { id: 5 }]) }],
  ["campos com tipos errados", { [ITEMS]: JSON.stringify([{ id: "imdb:movie:tt0000001", title: 123, status: {}, rating: "abc", updated_at: "lixo", poster_path: ["x"] }]) }],
  ["registro bom + registro ruim", { [ITEMS]: JSON.stringify([GOOD, { id: "lixo", title: "x" }]) }],
  ["caracteres de controle", { [ITEMS]: "\u0000\u0001\u0002\uFFFF" }],
  ["string gigante (1 MB)", { [ITEMS]: "x".repeat(1_000_000) }],
  ["preferências quebradas", { [ITEMS]: JSON.stringify([GOOD]), [PREFS]: "}{ quebrado" }],
  ["preferências null", { [ITEMS]: JSON.stringify([GOOD]), [PREFS]: "null" }],
  ["preferências com tipos errados", { [ITEMS]: JSON.stringify([GOOD]), [PREFS]: JSON.stringify({ status: ["x"], category: { a: 1 } }) }],
  ["formato antigo (v1) corrompido", { "cinelog:v1:items": "[[[" }],
  ["v1 com itens inválidos", { "cinelog:v1:items": JSON.stringify([{ tmdb_id: "abc" }, null, 7]) }],
];

describe("Dados corrompidos no localStorage (DOM simulado)", () => {
  for (const [name, seed] of CORRUPTED) {
    it(`não quebra a tela: ${name}`, async () => {
      global.fetch = mockFetch(fixtures.OK);
      let env;
      assert.doesNotThrow(() => { env = freshEnv({ app: true, seed }); }, "o app lançou exceção ao iniciar (tela branca)");
      assert.ok(env.grid.children.length > 0, "a grade ficou vazia, sem nem uma mensagem");
      const backlog = env.S.getBacklog();
      assert.ok(Array.isArray(backlog));
      backlog.forEach((i) => { assert.equal(typeof i.title, "string"); assert.ok(["watched", "plan_to_watch"].includes(i.status)); });
      assert.deepEqual(env.S.getPrefs().status && ["all", "watched", "plan_to_watch"].includes(env.S.getPrefs().status), true);
      // continua utilizável: dá para buscar e salvar normalmente
      await doSearch(env, "batman");
      assert.ok(cards(env.grid).length >= 3);
      assert.ok(env.S.addMedia(record("imdb:movie:tt0000777", "Novo item", "watched")));
      assert.ok(env.S.getMedia("imdb:movie:tt0000777"));
    });
  }

  it("dados ilegíveis são preservados numa cópia de segurança antes de qualquer gravação", () => {
    for (const raw of ["{{{ quebrado", "null", "123", '"texto"', "{}", "true"]) {
      const { S, store } = freshEnv({ seed: { [ITEMS]: raw } });
      S.getBacklog();
      S.addMedia(record("imdb:movie:tt0000777", "Novo", "watched"));
      assert.equal(store[`${ITEMS}:corrupted-backup`], raw, `perdeu o conteúdo original: ${raw}`);
    }
  });

  it("itens inválidos descartados não somem sem rastro: o conteúdo original fica em backup", () => {
    const raw = JSON.stringify([GOOD, { id: "lixo", title: "talvez recuperável" }]);
    const { S, store } = freshEnv({ seed: { [ITEMS]: raw } });
    assert.equal(S.getBacklog().length, 1);
    S.addMedia(record("imdb:movie:tt0000777", "Novo", "watched"));
    assert.equal(store[`${ITEMS}:corrupted-backup`], raw);
  });

  it("o primeiro backup é mantido (um segundo dado corrompido não o sobrescreve)", () => {
    const { S, store } = freshEnv({ seed: { [ITEMS]: "primeiro-lixo" } });
    S.getBacklog();
    store[ITEMS] = "segundo-lixo";
    S.getBacklog();
    assert.equal(store[`${ITEMS}:corrupted-backup`], "primeiro-lixo");
  });

  it("localStorage que lança erro em TODA chamada: o app abre, avisa e não quebra ao tentar salvar", async () => {
    global.fetch = mockFetch(fixtures.OK);
    const boom = () => { throw new Error("SecurityError"); };
    const env = freshEnv({ app: true, storage: { getItem: boom, setItem: boom, removeItem: boom } });
    assert.equal(env.D.storageWarning.hidden, false);
    await doSearch(env, "batman");
    assert.ok(cards(env.grid).length >= 3);
    env.grid.children[0].children[1].children.at(-1).children[0]?.dispatch("click");
    assert.doesNotThrow(() => env.S.addMedia(record("imdb:movie:tt0000777", "x", "watched")));
  });

  it("o próprio acesso a `localStorage` lança SecurityError (cookies/privacidade bloqueados): app abre normalmente", () => {
    global.fetch = mockFetch(fixtures.OK);
    let env;
    assert.doesNotThrow(() => { env = freshEnv({ app: true, storageGetterThrows: true }); });
    assert.equal(env.D.storageWarning.hidden, false);
    assert.ok(env.grid.children.length > 0);
    assert.equal(env.S.addMedia(record("imdb:movie:tt0000777", "x", "watched")), null);
  });
});

describe("Dados corrompidos no navegador real", { timeout: 90000 }, () => {
  for (const [name, seed] of CORRUPTED.filter((_, i) => [0, 1, 4, 6, 7, 8, 10, 11, 14].includes(i))) {
    it(`sem tela branca nem erro de script: ${name}`, async (t) => {
      const s = await newSession(t, { seed }); if (!s) return;
      await s.goto();
      assert.deepEqual(s.errors, [], "erro de script não tratado: " + s.errors.join(" | "));
      assert.ok(await s.page.locator("header").isVisible());
      assert.ok((await s.page.textContent("#mediaGrid")).trim().length > 0, "grade em branco");
      await s.search("batman");
      await s.page.locator(".media-card").filter({ has: s.page.locator(".btn-quick") }).first().getByRole("button", { name: "✓ Assistido" }).click();
      await s.page.reload();
      assert.ok((await s.page.locator(".media-card").count()) >= 1, "não conseguiu salvar depois da corrupção");
      assert.deepEqual(s.errors, []);
    });
  }
});

// ---------------------------------------------------------------------------------------------
const MESSY = /HTTP \d|undefined|\bnull\b|\[object|TypeError|SyntaxError|Failed to fetch|NetworkError|at \w+ \(/;
const FAILURES = {
  "HTTP 500": { status: 500, body: { error: "boom" } },
  "HTTP 503": { status: 503, body: {} },
  "HTTP 404": { status: 404, body: {} },
  "HTTP 429 (limite)": { status: 429, body: {} },
  "rede caiu": new TypeError("Failed to fetch"),
  "resposta não é JSON (página HTML)": { notJson: true },
  "200 com objeto vazio": { body: {} },
  "200 com null": { body: null },
  "200 com 'metas' que não é lista": { body: { metas: "quebrado" } },
};

describe("Falhas de API — serviço de busca", () => {
  for (const [name, failure] of Object.entries(FAILURES)) {
    it(`Cinemeta com ${name}: não lança, sinaliza o erro e os animes continuam`, async () => {
      const { Q } = freshEnv();
      global.fetch = mockFetch({ "catalog/": failure, "graphql.anilist.co": { body: fixtures.anilist } });
      const { items, errors } = await Q.search("x");
      assert.ok(errors.movies, "o erro de filmes/séries foi engolido (a interface mostraria 'Nenhum título encontrado')");
      assert.equal(errors.anime, null);
      assert.ok(items.some((i) => i.category === "anime"));
    });
  }

  for (const [name, failure] of Object.entries(FAILURES)) {
    it(`AniList com ${name}: não lança, sinaliza o erro e filmes/séries continuam`, async () => {
      const { Q } = freshEnv();
      global.fetch = mockFetch({ "catalog/movie/top": { body: fixtures.cineMovies }, "catalog/series/top": { body: fixtures.cineSeries }, "graphql.anilist.co": failure });
      const { items, errors } = await Q.search("x");
      assert.ok(errors.anime, "o erro do AniList foi engolido (a interface mostraria 'Nenhum título encontrado')");
      assert.equal(errors.movies, null);
      assert.ok(items.some((i) => i.category === "filme"));
    });
  }

  it("só um catálogo falha (ex.: filmes em 500): devolve os demais resultados E sinaliza a falha parcial", async () => {
    const { Q } = freshEnv();
    global.fetch = mockFetch({ "catalog/movie/top": { status: 500, body: {} }, "catalog/series/top": { body: fixtures.cineSeries }, "graphql.anilist.co": { body: fixtures.anilist } });
    const { items, errors } = await Q.search("x");
    assert.ok(items.some((i) => i.category === "serie"));
    assert.ok(!items.some((i) => i.category === "filme"));
    assert.equal(errors.movies && errors.movies.partial, true, "o usuário nunca saberia que os filmes não carregaram");
  });

  it("AniList responde 200 com erros GraphQL (data nulo): vira erro, não 'nenhum resultado'", async () => {
    const { Q } = freshEnv();
    global.fetch = mockFetch({ "catalog/": { body: { metas: [] } }, "graphql.anilist.co": { body: { errors: [{ message: "Validation error" }], data: null } } });
    assert.ok((await Q.search("x")).errors.anime);
  });

  it("timeout: a busca é abortada e vira erro (AbortError) em vez de ficar pendurada", async () => {
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 10000 ? 5 : ms, ...rest);
    try {
      const { Q } = freshEnv();
      global.fetch = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      const { items, errors } = await Q.search("x");
      assert.equal(items.length, 0);
      assert.equal(errors.movies.name, "AbortError");
      assert.equal(errors.anime.name, "AbortError");
    } finally { global.setTimeout = realSetTimeout; }
  });

  it("detalhes do título com falha (500/rede/JSON ruim) rejeitam sem derrubar nada e não ficam em cache", async () => {
    const { Q } = freshEnv();
    const item = { id: "imdb:movie:tt0372784", source: "imdb", kind: "movie", external_id: "tt0372784" };
    for (const failure of [{ status: 500, body: {} }, netError(), { notJson: true }]) {
      global.fetch = mockFetch({ "meta/movie": failure });
      await assert.rejects(() => Q.getDetails(item));
    }
    global.fetch = mockFetch({ "meta/movie": { body: fixtures.meta } });
    assert.equal((await Q.getDetails(item)).score, 8.2);
  });
});

describe("Falhas de API — interface (DOM simulado)", () => {
  for (const [name, failure] of Object.entries(FAILURES)) {
    it(`Cinemeta com ${name}: aviso amigável, animes visíveis, nada de 'Buscando...' preso`, async () => {
      global.fetch = mockFetch({ "catalog/": failure, "graphql.anilist.co": { body: fixtures.anilist } });
      const env = freshEnv({ app: true });
      await doSearch(env, "one piece");
      assert.equal(env.D.notice.hidden, false, "nenhum aviso foi mostrado ao usuário");
      assert.match(env.D.notice.textContent, /Não foi possível buscar|Muitas buscas|demorou demais/);
      assert.doesNotMatch(env.D.notice.textContent, MESSY);
      assert.ok(cards(env.grid).length >= 1);
      assert.doesNotMatch(env.grid.textContent, /Buscando/);
    });
  }

  it("falha parcial (filmes 500, séries ok): avisa o usuário e mantém os resultados que vieram", async () => {
    global.fetch = mockFetch({ "catalog/movie/top": { status: 500, body: {} }, "catalog/series/top": { body: fixtures.cineSeries }, "graphql.anilist.co": { body: fixtures.anilist } });
    const env = freshEnv({ app: true });
    await doSearch(env, "one piece");
    assert.equal(env.D.notice.hidden, false);
    assert.match(env.D.notice.textContent, /Parte dos resultados de filmes e séries/);
    assert.ok(cards(env.grid).length >= 3);
  });

  it("tudo fora do ar: mensagem final clara, nenhum card e a interface continua utilizável", async () => {
    global.fetch = mockFetch({ "catalog/": netError(), "graphql.anilist.co": netError() });
    const env = freshEnv({ app: true });
    await doSearch(env, "x");
    assert.match(env.grid.textContent, /Não foi possível concluir a busca/);
    assert.doesNotMatch(env.grid.textContent + env.D.notice.textContent, MESSY);
    env.D.btnBack.dispatch("click");
    assert.equal(env.D.filters.hidden, false);
  });

  it("recuperação: depois de uma falha, a próxima busca funciona normalmente", async () => {
    const env = freshEnv({ app: true });
    global.fetch = mockFetch({ "catalog/": netError(), "graphql.anilist.co": netError() });
    await doSearch(env, "x");
    global.fetch = mockFetch(fixtures.OK);
    await doSearch(env, "batman");
    assert.equal(env.D.notice.hidden, true);
    assert.ok(cards(env.grid).length >= 5);
  });

  it("timeout na interface: mostra 'demorou demais' e libera a tela", async () => {
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 10000 ? 5 : ms, ...rest);
    try {
      global.fetch = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      const env = freshEnv({ app: true });
      await doSearch(env, "x");
      assert.match(env.D.notice.textContent, /demorou demais/);
      assert.doesNotMatch(env.grid.textContent, /Buscando/);
    } finally { global.setTimeout = realSetTimeout; }
  });

  it("detalhes falhando ao abrir um card: modal continua usável e mostra 'Sem sinopse disponível.'", async () => {
    global.fetch = mockFetch({ ...fixtures.OK, "meta/movie/tt0372784.json": { status: 500, body: {} } });
    const env = freshEnv({ app: true });
    await doSearch(env, "batman");
    cards(env.grid)[0].dispatch("click"); await flush();
    assert.equal(env.D.modalOverview.textContent, "Sem sinopse disponível.");
    env.D.mediaForm.dispatch("submit");
    assert.ok(env.S.getMedia("imdb:movie:tt0372784"));
  });
});

describe("Falhas de API — navegador real", { timeout: 120000 }, () => {
  const friendly = /Não foi possível buscar|Parte dos resultados|Muitas buscas|demorou demais/;
  const notice = (page) => page.locator("#notice");

  const REAL = [
    ["HTTP 500", { status: 500, body: { error: "x" } }],
    ["HTTP 404", { status: 404, body: {} }],
    ["HTTP 429", { status: 429, body: {} }],
    ["conexão recusada", { abort: "connectionrefused" }],
    ["rede caiu", { abort: "failed" }],
    ["resposta HTML no lugar de JSON", { rawBody: "<html><body>Bad gateway</body></html>", contentType: "text/html" }],
    ["JSON truncado", { rawBody: '{"metas":[{"id":"tt00', contentType: "application/json" }],
    ["200 vazio", { body: {} }],
  ];

  for (const [name, spec] of REAL) {
    it(`Cinemeta com ${name}: aviso amigável, animes aparecem e a página não quebra`, async (t) => {
      const s = await newSession(t, { mocks: { movies: () => spec, series: () => spec } }); if (!s) return;
      await s.goto(); await s.search("one piece");
      await notice(s.page).waitFor({ state: "visible" });
      const text = await notice(s.page).textContent();
      assert.match(text, friendly);
      assert.doesNotMatch(text, MESSY);
      assert.ok((await s.page.locator(".media-card").count()) >= 1, "os animes deveriam aparecer");
      assert.doesNotMatch(await s.page.textContent("#mediaGrid"), /Buscando/);
      assert.deepEqual(s.errors, []);
    });
  }

  it("AniList fora do ar: aviso específico de animes e filmes/séries aparecem", async (t) => {
    const s = await newSession(t, { mocks: { anilist: () => ({ status: 500, body: {} }) } }); if (!s) return;
    await s.goto(); await s.search("batman");
    assert.match(await notice(s.page).textContent(), /Não foi possível buscar animes/);
    assert.ok((await s.page.locator(".media-card").count()) >= 3);
  });

  it("tudo fora do ar: mensagem final e o botão 'Voltar' devolve o backlog", async (t) => {
    const s = await newSession(t, { seed: seedItems([GOOD]), mocks: { movies: () => ({ abort: "failed" }), series: () => ({ abort: "failed" }), anilist: () => ({ abort: "failed" }) } }); if (!s) return;
    await s.goto(); await s.search("batman");
    assert.match(await s.page.textContent("#mediaGrid"), /Não foi possível concluir a busca/);
    await s.page.click("#btnBack");
    assert.deepEqual(await s.page.$$eval(".card-title", (els) => els.map((e) => e.textContent)), ["Batman Begins"]);
  });

  it("timeout real (10 s): servidor que nunca responde vira aviso 'demorou demais'", async (t) => {
    const s = await newSession(t, { mocks: { movies: () => ({ hang: true }), series: () => ({ hang: true }) } }); if (!s) return;
    await s.goto();
    await s.page.fill("#searchInput", "batman");
    await s.page.press("#searchInput", "Enter");
    assert.match(await s.page.textContent("#mediaGrid"), /Buscando/);
    await s.page.waitForFunction(() => document.getElementById("notice").textContent.includes("demorou demais"), null, { timeout: 20000 });
    assert.ok((await s.page.locator(".media-card").count()) >= 1, "os animes deveriam aparecer apesar do timeout");
  });

  it("sem internet: a busca avisa, mas o backlog salvo continua acessível e editável", async (t) => {
    const s = await newSession(t, { seed: seedItems([GOOD]) }); if (!s) return;
    await s.goto();
    s.mocks.movies = () => ({ abort: "internetdisconnected" }); s.mocks.series = () => ({ abort: "internetdisconnected" }); s.mocks.anilist = () => ({ abort: "internetdisconnected" });
    await s.search("batman");
    assert.match(await s.page.textContent("#mediaGrid"), /Não foi possível concluir a busca/);
    await s.page.click("#btnBack");
    await s.page.locator(".media-card").first().click();
    await s.page.fill("#modalReview", "Revisto offline");
    await s.page.click("#btnSubmit");
    assert.equal(await s.page.evaluate(() => JSON.parse(localStorage.getItem("cinelog:v2:items"))[0].review), "Revisto offline");
  });

  it("recuperação: depois da falha, a próxima busca com a API de volta funciona", async (t) => {
    const s = await newSession(t, { mocks: { movies: () => ({ status: 500, body: {} }) } }); if (!s) return;
    await s.goto(); await s.search("batman");
    await notice(s.page).waitFor({ state: "visible" });
    s.mocks.movies = () => ({ body: fixtures.cineMovies });
    await s.search("batman");
    assert.equal(await notice(s.page).isVisible(), false);
    assert.ok((await s.page.locator(".media-card").count()) >= 5);
  });

  it("detalhes do título falhando: o modal abre, mostra 'Sem sinopse' e dá para salvar", async (t) => {
    const s = await newSession(t, { mocks: { meta: () => ({ status: 500, body: {} }) } }); if (!s) return;
    await s.goto(); await s.search("batman");
    await s.page.locator(".media-card").first().click();
    await s.page.waitForFunction(() => document.getElementById("modalOverview").textContent === "Sem sinopse disponível.");
    await s.page.click("#btnSubmit");
    assert.equal(await s.page.evaluate(() => JSON.parse(localStorage.getItem("cinelog:v2:items")).length), 1);
  });

  it("imagens que não carregam viram o placeholder 'Sem Capa' (sem ícone quebrado)", async (t) => {
    const s = await newSession(t); if (!s) return;
    await s.context.route(/m\.media-amazon\.com/, (route) => route.abort("failed"));
    await s.goto(); await s.search("batman");
    await s.page.waitForFunction(() => [...document.images].every((i) => i.complete));
    const srcs = await s.page.$$eval(".media-card img", (els) => els.map((e) => e.src.slice(0, 22)));
    assert.ok(srcs.some((src) => src.startsWith("data:image/svg+xml")), "nenhum placeholder foi aplicado: " + srcs.join(","));
    const broken = await s.page.$$eval(".media-card img", (els) => els.filter((e) => e.complete && e.naturalWidth === 0).length);
    assert.equal(broken, 0, "há imagens quebradas na tela");
  });
});