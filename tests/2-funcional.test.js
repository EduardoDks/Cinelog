"use strict";
/**
 * 2) FUNCIONALIDADES CORE & PERSISTÊNCIA LOCAL
 * CRUD no localStorage, integridade do backup (exportar/importar) e fluxo real no navegador.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { newSession, closeBrowser } = require("./_support/browser");
const { freshEnv, record, seedItems, read, mockFetch, fixtures, cards, doSearch } = require("./_support/env");

after(closeBrowser);

const ITEM_KEYS = ["added_at", "category", "external_id", "id", "kind", "overview", "poster_path", "rating", "review", "score", "source", "status", "title", "updated_at", "year"];
const movie = (over = {}) => record("imdb:movie:tt0372784", "Batman Begins", "plan_to_watch", { poster_path: "https://m.media-amazon.com/a.jpg", year: 2005, score: 8.2, ...over });
const byId = (list) => [...list].sort((a, b) => a.id.localeCompare(b.id));

describe("Armazenamento local (CRUD)", () => {
  it("backlog começa vazio; addMedia grava e getMedia lê; categoria vem do tipo", () => {
    const { S } = freshEnv();
    assert.deepEqual(S.getBacklog(), []);
    assert.equal(S.addMedia(movie()).category, "filme");
    assert.equal(S.addMedia(movie({ id: "imdb:tv:tt0944947", title: "GoT" })).category, "serie");
    assert.equal(S.addMedia(movie({ id: "anilist:anime:21", title: "One Piece" })).category, "anime");
    assert.equal(S.getMedia("imdb:movie:tt0372784").title, "Batman Begins");
    assert.equal(S.getBacklog().length, 3);
  });

  it("addMedia repetido não duplica e preserva a data de inclusão", () => {
    const { S } = freshEnv();
    const a = S.addMedia(movie());
    const b = S.addMedia(movie({ status: "watched" }));
    assert.equal(S.getBacklog().length, 1);
    assert.equal(b.added_at, a.added_at);
    assert.equal(b.status, "watched");
  });

  it("updateMediaStatus/updateMedia mudam só status, nota e review (não título nem id)", () => {
    const { S } = freshEnv();
    S.addMedia(movie({ rating: 4, review: "bom" }));
    const r = S.updateMediaStatus("imdb:movie:tt0372784", "watched");
    assert.deepEqual([r.status, r.rating, r.review], ["watched", 4, "bom"]);
    assert.equal(S.updateMediaStatus("imdb:movie:tt0372784", "invalido"), null);
    assert.equal(S.updateMediaStatus("imdb:movie:tt9999999", "watched"), null);
    const hacked = S.updateMedia("imdb:movie:tt0372784", { title: "HACK", id: "imdb:movie:tt1", rating: 5 });
    assert.deepEqual([hacked.title, hacked.id, hacked.rating], ["Batman Begins", "imdb:movie:tt0372784", 5]);
  });

  it("removeMedia remove; remover inexistente devolve false", () => {
    const { S } = freshEnv();
    S.addMedia(movie());
    assert.equal(S.removeMedia("imdb:movie:tt0372784"), true);
    assert.equal(S.removeMedia("imdb:movie:tt0372784"), false);
    assert.deepEqual(S.getBacklog(), []);
  });

  it("os dados persistem ao 'reabrir o site' (novo carregamento sobre o mesmo localStorage)", () => {
    const first = freshEnv();
    first.S.addMedia(movie({ rating: 3.5, review: "ok" }));
    first.S.savePrefs({ status: "watched", category: "anime" });
    const second = freshEnv({ seed: first.store });
    assert.equal(second.S.getBacklog()[0].review, "ok");
    assert.deepEqual(second.S.getPrefs(), { status: "watched", category: "anime" });
  });

  it("migra os dados do formato antigo (v1) sem apagar o original", () => {
    const { S, store } = freshEnv({ seed: { "cinelog:v1:items": JSON.stringify([
      { tmdb_id: 155, media_type: "movie", title: "Batman", status: "watched", rating: 4.5, poster_path: "https://image.tmdb.org/a.jpg" },
      { tmdb_id: 7, media_type: "tv", title: "Naruto", status: "plan_to_watch", category: "anime" },
    ]) } });
    assert.equal(S.getBacklog().length, 2);
    assert.equal(S.getMedia("tmdb:movie:155").rating, 4.5);
    assert.equal(S.getMedia("tmdb:tv:7").category, "anime");
    assert.ok(store["cinelog:v1:items"]);
  });

  it("falha de gravação (cota cheia) devolve null sem lançar exceção", () => {
    const { S } = freshEnv();
    localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
    assert.equal(S.addMedia(movie()), null);
    assert.equal(S.isAvailable(), false);
  });

  it("limites e normalização: título 300, review 2000, nota 1–5, pôster só https", () => {
    const { S } = freshEnv();
    const r = S.addMedia(movie({ title: "x".repeat(999), review: "y".repeat(9999), rating: 9, poster_path: "http://inseguro/x.jpg" }));
    assert.equal(r.title.length, 300);
    assert.equal(r.review.length, 2000);
    assert.equal(r.rating, null);
    assert.equal(r.poster_path, null);
  });
});

describe("Normalização estrita de campos e desempenho", () => {
  it("nota e score só aceitam números de verdade (nada de true, [3], {} ou texto)", () => {
    const { S } = freshEnv();
    const notNumbers = [true, false, [3], {}, "abc", "", NaN, Infinity, -1, 0];
    for (const bad of [...notNumbers, 5.1, 11]) assert.equal(S.addMedia(movie({ rating: bad })).rating, null, `rating ${JSON.stringify(bad)} foi aceito`); // nota do usuário: 1 a 5
    for (const bad of [...notNumbers, 11]) assert.equal(S.addMedia(movie({ score: bad })).score, null, `score ${JSON.stringify(bad)} foi aceito`);   // nota do IMDb/AniList: 0 a 10
    const ok = S.addMedia(movie({ rating: 4.5, score: 8.2 }));
    assert.deepEqual([ok.rating, ok.score], [4.5, 8.2]);
    assert.equal(S.addMedia(movie({ rating: "4.5", score: "8.2" })).rating, 4.5, "texto numérico simples deve ser aceito");
  });

  it("a busca lê o armazenamento uma única vez, não uma vez por card (escala com backlog grande)", async () => {
    global.fetch = mockFetch(fixtures.OK);
    const seed = seedItems(Array.from({ length: 300 }, (_, i) => movie({ id: `imdb:movie:tt${String(2000000 + i)}`, title: `Item ${i}` })));
    const c = freshEnv({ app: true, seed });
    let reads = 0; const realGet = localStorage.getItem;
    localStorage.getItem = (k) => { if (k === "cinelog:v2:items") reads += 1; return realGet(k); };
    await doSearch(c, "batman");
    assert.ok(cards(c.grid).length >= 5);
    assert.ok(reads <= 3, `a busca leu a lista salva ${reads}x (uma por card)`);
  });

  it("o download do backup não revoga a URL do arquivo antes do navegador iniciar a transferência", () => {
    const src = read("app.js").replace(/\/\*[\s\S]*?\*\//g, "");
    const at = src.indexOf("revokeObjectURL");
    assert.ok(at > 0);
    assert.match(src.slice(Math.max(0, at - 80), at), /setTimeout\s*\(/, "revokeObjectURL deveria ser adiado com setTimeout");
  });
});

describe("Exportação e importação — integridade do JSON", () => {
  const library = () => [
    movie(),
    movie({ id: "imdb:tv:tt0944947", title: "Game of Thrones", status: "watched", rating: 5, review: "Épico", year: 2011, score: 9.2 }),
    movie({ id: "anilist:anime:21", title: 'One "Piece"\nlinha 2 ★ 日本語 🏴‍☠️ \u2028', status: "watched", rating: 4.5, overview: "Piratas & <b>aventura</b>" }),
  ];
  const withLibrary = () => { const env = freshEnv(); library().forEach((i) => env.S.addMedia(i)); return env; };

  it("estrutura do backup: app, versão, data ISO e itens com exatamente os campos esperados", () => {
    const { S } = withLibrary();
    const data = JSON.parse(S.exportData());
    assert.deepEqual(Object.keys(data).sort(), ["app", "exported_at", "items", "version"]);
    assert.equal(data.app, "cinelog");
    assert.equal(data.version, 2);
    assert.equal(new Date(data.exported_at).toISOString(), data.exported_at);
    assert.equal(data.items.length, 3);
    data.items.forEach((item) => assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS));
  });

  it("ida e volta: exportar → apagar → importar reproduz exatamente os mesmos registros", () => {
    const { S } = withLibrary();
    const before = byId(S.getBacklog());
    const backup = S.exportData();
    before.forEach((i) => S.removeMedia(i.id));
    assert.equal(S.getBacklog().length, 0);
    assert.deepEqual(S.importData(backup), { imported: 3, skipped: 0 });
    assert.deepEqual(byId(S.getBacklog()), before);
  });

  it("caracteres especiais (aspas, quebras de linha, emoji, U+2028, HTML) sobrevivem ao backup", () => {
    const { S } = withLibrary();
    const original = S.getMedia("anilist:anime:21");
    const backup = S.exportData();
    S.removeMedia("anilist:anime:21");
    S.importData(backup);
    assert.deepEqual(S.getMedia("anilist:anime:21"), original);
  });

  it("importar duas vezes o mesmo backup é idempotente", () => {
    const { S } = withLibrary();
    const backup = S.exportData();
    const snapshot = byId(S.getBacklog());
    assert.deepEqual(S.importData(backup), { imported: 0, skipped: 3 });
    assert.deepEqual(byId(S.getBacklog()), snapshot);
  });

  it("importar mescla: não apaga itens que não estão no arquivo", () => {
    const other = withLibrary().S.exportData();            // o backup é criado ANTES do ambiente principal
    const { S } = freshEnv();
    S.addMedia(movie({ id: "imdb:movie:tt0000042", title: "Só local" }));
    assert.deepEqual(S.importData(other), { imported: 3, skipped: 0 });
    assert.equal(S.getBacklog().length, 4);
    assert.ok(S.getMedia("imdb:movie:tt0000042"));
  });

  it("conflito: vence o registro mais recente; o mais antigo é ignorado", () => {
    const { S } = freshEnv();
    S.addMedia(movie({ status: "watched" }));
    const antigo = { ...movie({ status: "plan_to_watch" }), updated_at: "2000-01-01T00:00:00.000Z" };
    assert.deepEqual(S.importData(JSON.stringify([antigo])), { imported: 0, skipped: 1 });
    assert.equal(S.getMedia("imdb:movie:tt0372784").status, "watched");
    const novo = { ...movie({ status: "plan_to_watch" }), updated_at: new Date(Date.now() + 5000).toISOString() };
    assert.deepEqual(S.importData(JSON.stringify([novo])), { imported: 1, skipped: 0 });
    assert.equal(S.getMedia("imdb:movie:tt0372784").status, "plan_to_watch");
  });

  it("conflito: datas em formatos diferentes são comparadas pelo INSTANTE, não como texto", () => {
    const { S } = freshEnv();
    S.addMedia(movie({ status: "watched" }));                                   // atualizado "agora"
    const antigoOutroFormato = { ...movie({ status: "plan_to_watch" }), updated_at: "Jan 1 2000" };
    assert.deepEqual(S.importData(JSON.stringify([antigoOutroFormato])), { imported: 0, skipped: 1 });
    assert.equal(S.getMedia("imdb:movie:tt0372784").status, "watched");
  });

  it("datas absurdas no futuro não permitem que um arquivo sobrescreva sempre os dados locais", () => {
    const { S } = freshEnv();
    S.addMedia(movie({ status: "watched" }));
    const futuro = { ...movie({ status: "plan_to_watch" }), updated_at: "9999-12-31T00:00:00.000Z" };
    S.importData(JSON.stringify([futuro]));
    const saved = S.getMedia("imdb:movie:tt0372784");
    assert.ok(Date.parse(saved.updated_at) <= Date.now() + 1000, "updated_at no futuro foi aceito: " + saved.updated_at);
  });

  it("aceita backup no formato antigo (tmdb_id/media_type) e lista simples na raiz", () => {
    const { S } = freshEnv();
    assert.deepEqual(S.importData(JSON.stringify({ items: [{ tmdb_id: 5, media_type: "movie", title: "Antigo", status: "watched" }] })), { imported: 1, skipped: 0 });
    assert.deepEqual(S.importData(JSON.stringify([movie()])), { imported: 1, skipped: 0 });
  });

  it("arquivos inválidos são recusados com mensagem clara e nada é alterado", () => {
    const { S } = withLibrary();
    const snapshot = byId(S.getBacklog());
    assert.throws(() => S.importData("isto não é json"), /JSON válido/);
    assert.throws(() => S.importData('{"x":1}'), /não reconhecido/);
    assert.throws(() => S.importData("null"), /não reconhecido/);
    assert.throws(() => S.importData(JSON.stringify({ items: new Array(5001).fill(movie()) })), /itens demais/);
    assert.deepEqual(byId(S.getBacklog()), snapshot);
  });

  it("itens inválidos dentro de um backup bom são contados como ignorados", () => {
    const { S } = freshEnv();
    const r = S.importData(JSON.stringify([movie(), { id: "x" }, null, "texto", 42, { id: "imdb:movie:tt1111111", title: " " }]));
    assert.deepEqual(r, { imported: 1, skipped: 5 });
  });

  it("falha ao gravar durante a importação lança erro e preserva o que já existia", () => {
    const backup = freshEnv(); backup.S.addMedia(movie({ id: "imdb:movie:tt0000099", title: "Novo" }));
    const payload = backup.S.exportData();
    const { S } = withLibrary();
    const snapshot = byId(S.getBacklog());
    const realSet = localStorage.setItem;
    localStorage.setItem = () => { throw new Error("Quota"); };
    assert.throws(() => S.importData(payload), /gravar/);
    localStorage.setItem = realSet;
    assert.deepEqual(byId(S.getBacklog()), snapshot);
  });

  it("backup vazio e exportações repetidas são consistentes", () => {
    const empty = freshEnv();
    assert.deepEqual(JSON.parse(empty.S.exportData()).items, []);
    const { S } = withLibrary();
    assert.deepEqual(JSON.parse(S.exportData()).items, JSON.parse(S.exportData()).items);
  });

  it("coleção grande (2000 itens) faz a ida e volta sem perda e em tempo razoável", () => {
    const { S } = freshEnv();
    const list = Array.from({ length: 2000 }, (_, i) => movie({ id: `imdb:movie:tt${String(1000000 + i)}`, title: `Filme ${i}` }));
    const t0 = Date.now();
    S.importData(JSON.stringify(list));
    const backup = S.exportData();
    assert.equal(JSON.parse(backup).items.length, 2000);
    assert.ok(Date.now() - t0 < 3000, `demorou ${Date.now() - t0}ms`);
  });
});

describe("Backup no navegador real (download e upload)", { timeout: 60000 }, () => {
  const LIB = [movie(), movie({ id: "anilist:anime:21", title: "One Piece", status: "watched", rating: 4.5, review: "Clássico" })];

  it("Exportar baixa um .json válido e Importar restaura tudo depois de limpar os dados", async (t) => {
    const s = await newSession(t, { seed: seedItems(LIB) }); if (!s) return;
    await s.goto();
    const [download] = await Promise.all([s.page.waitForEvent("download"), s.page.click("#btnExport")]);
    assert.match(download.suggestedFilename(), /^cinelog-backup-\d{4}-\d{2}-\d{2}\.json$/);
    const text = fs.readFileSync(await download.path(), "utf8");
    const data = JSON.parse(text);
    assert.equal(data.app, "cinelog");
    assert.equal(data.items.length, 2);

    await s.page.evaluate(() => localStorage.clear());
    await s.page.reload();
    assert.match(await s.page.textContent("#mediaGrid"), /vazio/);

    await s.page.setInputFiles("#importFile", { name: "backup.json", mimeType: "application/json", buffer: Buffer.from(text) });
    await s.page.waitForSelector(".media-card");
    assert.match(await s.page.textContent("#toast"), /Backup importado: 2 adicionado\(s\)\/atualizado\(s\), 0 ignorado\(s\)/);
    const titles = await s.page.$$eval(".card-title", (els) => els.map((e) => e.textContent).sort());
    assert.deepEqual(titles, ["Batman Begins", "One Piece"]);
    assert.deepEqual(s.errors, []);
  });

  it("importar arquivo inválido mostra erro amigável e mantém os dados", async (t) => {
    const s = await newSession(t, { seed: seedItems(LIB) }); if (!s) return;
    await s.goto();
    await s.page.setInputFiles("#importFile", { name: "lixo.json", mimeType: "application/json", buffer: Buffer.from("{ isto não é json") });
    await s.page.waitForFunction(() => document.getElementById("toast").textContent.includes("JSON válido"));
    assert.equal(await s.page.locator(".media-card").count(), 2);
  });

  it("importar arquivo grande demais (>5 MB) é recusado antes de ler", async (t) => {
    const s = await newSession(t, { seed: seedItems(LIB) }); if (!s) return;
    await s.goto();
    await s.page.setInputFiles("#importFile", { name: "enorme.json", mimeType: "application/json", buffer: Buffer.alloc(5 * 1024 * 1024 + 10, 32) });
    await s.page.waitForFunction(() => document.getElementById("toast").textContent.includes("grande demais"));
    assert.equal(await s.page.locator(".media-card").count(), 2);
  });

  it("alteração numa aba aparece automaticamente em outra aba aberta do mesmo navegador", async (t) => {
    const s = await newSession(t); if (!s) return;
    await s.goto();
    const second = await s.context.newPage();
    await second.goto(s.server.url + "/");
    assert.match(await second.textContent("#mediaGrid"), /vazio/);
    await s.search("batman");
    await s.page.locator(".media-card").first().getByRole("button", { name: "✓ Assistido" }).click();
    await second.waitForSelector(".media-card");
    assert.deepEqual(await second.$$eval(".card-title", (els) => els.map((e) => e.textContent)), ["Batman Begins"]);
  });
});