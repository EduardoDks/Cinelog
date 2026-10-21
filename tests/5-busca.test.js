"use strict";
/**
 * 5) BUSCA — serviço (Cinemeta + AniList), seletor de tipos, título e anotações (DOM simulado)
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { freshEnv, record, seedItems, mockFetch, netError, fixtures, flush, cards, doSearch, findAll, hasClass } = require("./_support/env");

const OK = fixtures.OK;
const ids = (items) => items.map((i) => i.id);
const onlyAnime = { "catalog/": { body: { metas: [] } }, "graphql.anilist.co": { body: fixtures.anilist } };

describe("Serviço de busca — mapeamento e regras", () => {
  it("URLs corretas, sem chave/Authorization, categorias FILME/SÉRIE/ANIME", async () => {
    const { Q } = freshEnv(); const calls = [];
    global.fetch = mockFetch(OK, calls);
    const { items, errors } = await Q.search("batman");
    assert.deepEqual([errors.movies, errors.anime], [null, null]);
    assert.ok(calls.some((c) => c.url === "https://v3-cinemeta.strem.io/catalog/movie/top/search=batman.json"));
    assert.ok(calls.some((c) => c.url === "https://v3-cinemeta.strem.io/catalog/series/top/search=batman.json"));
    assert.doesNotMatch(JSON.stringify(calls), /api_key|Authorization|Bearer|themoviedb/i);
    assert.deepEqual(items.map((i) => i.category), ["filme", "filme", "serie", "anime", "anime"]);
  });

  it("Cinemeta: normaliza campos; pôster http, ids inválidos, tipo trocado e título vazio são descartados", async () => {
    const { Q } = freshEnv(); global.fetch = mockFetch(OK);
    const { items } = await Q.search("x");
    const a = items.find((i) => i.id === "imdb:movie:tt0372784"), b = items.find((i) => i.id === "imdb:movie:tt0468569");
    assert.deepEqual([a.year, a.poster_path, a.score, a.overview], [2005, "https://m.media-amazon.com/a.jpg", null, null]);
    assert.deepEqual([b.poster_path, b.score, b.overview], [null, 9, "Gotham."]);
    assert.ok(!items.some((i) => ["imdb:tv:tt1234567", "imdb:movie:tt7654321"].includes(i.id)));
  });

  it("o texto é codificado, '/' vira espaço e busca só com símbolos não consulta o Cinemeta", async () => {
    let env = freshEnv(); let calls = []; global.fetch = mockFetch(OK, calls);
    await env.Q.search("a&b c/d?e");
    assert.ok(calls.some((c) => c.url === "https://v3-cinemeta.strem.io/catalog/movie/top/search=a%26b%20c%20d%3Fe.json"));
    env = freshEnv(); calls = []; global.fetch = mockFetch(OK, calls);
    const r = await env.Q.search("///", { scopes: ["movie", "series"] });
    assert.equal(calls.length, 0);
    assert.equal(r.errors.movies, null);
  });

  it("não duplica anime: mesmo título + ano do AniList some do IMDb; 'One Piece' live-action (outro ano) fica", async () => {
    const { Q } = freshEnv(); global.fetch = mockFetch(OK);
    const { items } = await Q.search("one piece");
    assert.ok(!items.some((i) => i.id === "imdb:tv:tt0388629"));
    assert.ok(items.some((i) => i.id === "imdb:tv:tt11737520") && items.some((i) => i.id === "anilist:anime:21"));
  });

  it("dedupe ignora acentos/pontuação e não remove itens sem ano", async () => {
    const { Q } = freshEnv();
    const ani = { data: { Page: { media: [{ id: 1, title: { english: "Pokémon: The Movie!" }, seasonYear: 1998 }] } } };
    const cm = { metas: [{ id: "tt0190641", imdb_id: "tt0190641", type: "movie", name: "Pokemon the movie", releaseInfo: "1998" }, { id: "tt0000001", imdb_id: "tt0000001", type: "movie", name: "Pokemon the movie" }] };
    global.fetch = mockFetch({ "catalog/movie/top": { body: cm }, "catalog/series/top": { body: { metas: [] } }, "graphql.anilist.co": { body: ani } });
    assert.deepEqual(ids((await Q.search("pokemon")).items), ["imdb:movie:tt0000001", "anilist:anime:1"]);
  });

  it("AniList: nota 0-100 vira 0-10, título cai para romaji, ano alternativo, pôster http descartado, sinopse sem HTML", async () => {
    const { Q } = freshEnv(); const calls = []; global.fetch = mockFetch(onlyAnime, calls);
    const { items } = await Q.search("one piece"); const [a, b] = items;
    assert.deepEqual([a.score, a.year, a.overview], [8.7, 1999, 'Piratas.\n\nTem aventura & humor "muito".']);
    assert.deepEqual([b.title, b.year, b.score, b.poster_path, b.overview], ["Só romaji", 2010, null, null, null]);
    const sent = calls.find((c) => c.url.includes("anilist"));
    const body = JSON.parse(sent.opts.body);
    assert.equal(sent.opts.method, "POST");
    assert.deepEqual(body.variables, { search: "one piece", perPage: 12 });
    assert.ok(body.query.includes("isAdult: false") && body.query.includes("type: ANIME"));
  });

  it("detalhes do IMDb: /meta/<tipo>/<id>.json mapeia sinopse, nota e ano; usa cache; ids inválidos não geram requisição", async () => {
    const { Q } = freshEnv(); const calls = [];
    global.fetch = mockFetch({ "meta/movie/tt0372784.json": { body: fixtures.meta }, "meta/series/tt0944947.json": { body: { meta: { description: "Dragões", imdbRating: "9.2", year: "2011–2019" } } } }, calls);
    const movie = { id: "imdb:movie:tt0372784", source: "imdb", kind: "movie", external_id: "tt0372784" };
    assert.deepEqual(await Q.getDetails(movie), { overview: "Bruce Wayne vira Batman.", score: 8.2, year: 2005 });
    await Q.getDetails(movie);
    assert.equal((await Q.getDetails({ id: "imdb:tv:tt0944947", source: "imdb", kind: "tv", external_id: "tt0944947" })).year, 2011);
    for (const bad of [null, { source: "anilist" }, { id: "x", source: "imdb", kind: "movie", external_id: "../../x" }]) assert.equal(await Q.getDetails(bad), null);
    assert.equal(calls.length, 2);
  });
});

describe("Serviço de busca — tipos escolhidos (scopes)", () => {
  const run = async (scopes) => {
    const { Q } = freshEnv(); const calls = []; global.fetch = mockFetch(OK, calls);
    const result = await Q.search("batman", scopes === undefined ? undefined : { scopes });
    return { ...result, calls, kinds: [...new Set(result.items.map((i) => i.category))].sort() };
  };

  it("sem opções: busca os três tipos", async () => {
    const r = await run(undefined);
    assert.deepEqual(r.kinds, ["anime", "filme", "serie"]);
    assert.equal(r.calls.length, 3);
  });
  it("['movie']: só o catálogo de filmes", async () => {
    const r = await run(["movie"]);
    assert.ok(r.calls.every((c) => c.url.includes("/catalog/movie/")) && r.calls.length === 1);
    assert.deepEqual(r.kinds, ["filme"]);
  });
  it("['series']: só o catálogo de séries", async () => {
    const r = await run(["series"]);
    assert.ok(r.calls.every((c) => c.url.includes("/catalog/series/")) && r.calls.length === 1);
    assert.deepEqual(r.kinds, ["serie"]);
  });
  it("['anime']: só o AniList (nenhuma chamada ao Cinemeta)", async () => {
    const r = await run(["anime"]);
    assert.ok(r.calls.every((c) => c.url.includes("graphql.anilist.co")) && r.calls.length === 1);
    assert.deepEqual(r.kinds, ["anime"]);
  });
  it("['series','anime']: combina só esses dois", async () => {
    const r = await run(["series", "anime"]);
    assert.ok(!r.calls.some((c) => c.url.includes("/catalog/movie/")));
    assert.deepEqual(r.kinds, ["anime", "serie"]);
  });
  it("lista vazia ou tipos desconhecidos: nenhuma requisição e nenhum erro", async () => {
    for (const scopes of [[], ["bogus"], ["__proto__", "constructor"]]) {
      const r = await run(scopes);
      assert.equal(r.calls.length, 0);
      assert.deepEqual([r.items.length, r.errors.movies, r.errors.anime], [0, null, null]);
    }
  });
  it("tipos desconhecidos misturados com válidos são ignorados", async () => {
    const r = await run(["movie", "bogus"]);
    assert.deepEqual(r.kinds, ["filme"]);
  });
  it("falha com um único catálogo escolhido é erro total (não 'parcial'); com dois, parcial", async () => {
    let env = freshEnv();
    global.fetch = mockFetch({ "catalog/movie/top": { status: 500, body: {} }, "catalog/series/top": { body: fixtures.cineSeries } });
    let r = await env.Q.search("x", { scopes: ["movie"] });
    assert.ok(r.errors.movies && !r.errors.movies.partial);
    env = freshEnv();
    global.fetch = mockFetch({ "catalog/movie/top": { status: 500, body: {} }, "catalog/series/top": { body: fixtures.cineSeries } });
    r = await env.Q.search("x", { scopes: ["movie", "series"] });
    assert.equal(r.errors.movies.partial, true);
  });
  it("o AniList desligado não gera erro mesmo se estivesse fora do ar", async () => {
    const { Q } = freshEnv(); global.fetch = mockFetch({ ...OK, "graphql.anilist.co": netError() });
    const r = await Q.search("x", { scopes: ["movie", "series"] });
    assert.equal(r.errors.anime, null);
  });
});

describe("Interface — seletor de tipos, título e anotações (DOM simulado)", () => {
  const pressed = (env) => env.dom.scopeButtons.map((b) => b.getAttribute("aria-pressed"));
  const click = (env, scope) => env.dom.scopeButtons.find((b) => b.dataset.scope === scope).dispatch("click");

  it("o título tem parte em destaque e complemento em cinza, mas o texto total não mudou", async () => {
    global.fetch = mockFetch(OK);
    const env = freshEnv({ app: true });
    assert.deepEqual(env.D.pageTitle.children.map((c) => c.className), ["title-main", "title-sub"]);
    assert.equal(env.D.pageTitle.textContent, "Meu Backlog — Todos / Todos (0)");
    await doSearch(env, "batman");
    assert.deepEqual(env.D.pageTitle.children.map((c) => c.className), ["title-main"]);
    assert.equal(env.D.pageTitle.textContent, 'Resultados para: "batman"');
  });

  it("anotação do usuário aparece no card salvo e só quando existe; o texto é inserido como texto puro", () => {
    global.fetch = mockFetch(OK);
    const evil = "<img src=x onerror=alert(1)>";
    const env = freshEnv({ app: true, seed: seedItems([record("imdb:movie:tt0000001", "Com nota", "watched", { review: "Gostei muito!" }), record("imdb:movie:tt0000002", "Sem nota", "watched"), record("imdb:movie:tt0000003", "Maliciosa", "watched", { review: evil })]) });
    const notes = findAll(env.grid, (e) => hasClass(e, "card-note")).map((e) => e.textContent).sort();
    assert.deepEqual(notes, [evil, "Gostei muito!"].sort());
    assert.deepEqual(env.dom.rec.unsafe, []);
    assert.equal(cards(env.grid).length, 3);
  });

  it("começa com os três tipos ligados e atualiza aria-pressed/classe ao alternar", () => {
    global.fetch = mockFetch(OK);
    const env = freshEnv({ app: true });
    assert.deepEqual(pressed(env), ["true", "true", "true"]);
    click(env, "movie");
    assert.deepEqual(pressed(env), ["false", "true", "true"]);
    assert.equal(hasClass(env.dom.scopeButtons[0], "active"), false);
    click(env, "movie");
    assert.deepEqual(pressed(env), ["true", "true", "true"]);
  });

  it("a busca só consulta os tipos ligados", async () => {
    const calls = []; global.fetch = mockFetch(OK, calls);
    const env = freshEnv({ app: true });
    click(env, "movie"); click(env, "anime");
    await doSearch(env, "batman");
    assert.ok(calls.every((c) => c.url.includes("/catalog/series/")) && calls.length === 1);
    assert.deepEqual([...new Set(findAll(env.grid, (e) => hasClass(e, "category-badge")).map((e) => e.textContent))], ["Série"]);
  });

  it("o último tipo não desliga: avisa com toast e mantém ligado", () => {
    global.fetch = mockFetch(OK);
    const env = freshEnv({ app: true });
    click(env, "movie"); click(env, "series"); click(env, "anime");
    assert.deepEqual(pressed(env), ["false", "false", "true"]);
    assert.match(env.D.toast.textContent, /Mantenha ao menos um tipo selecionado/);
  });

  it("trocar os tipos com resultados na tela refaz a busca; no backlog não faz requisição", async () => {
    const calls = []; global.fetch = mockFetch(OK, calls);
    const env = freshEnv({ app: true });
    click(env, "series");
    assert.equal(calls.length, 0);
    click(env, "series");
    await doSearch(env, "batman");
    const before = calls.length;
    click(env, "anime"); await flush();
    assert.ok(calls.length > before);
    assert.ok(!findAll(env.grid, (e) => hasClass(e, "category-anime")).length);
    env.D.btnBack.dispatch("click");
    const afterBack = calls.length;
    click(env, "anime"); await flush();
    assert.equal(calls.length, afterBack);
  });
});