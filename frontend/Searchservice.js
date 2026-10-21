/**
 * searchService — busca de títulos, 100% no navegador e SEM nenhuma chave de API.
 *
 *   - Filmes e séries: Cinemeta (catálogo público do Stremio, com ids do IMDb)
 *       busca:    GET {base}/catalog/{movie|series}/top/search=<texto>.json
 *       detalhes: GET {base}/meta/{movie|series}/<id do IMDb>.json  (sinopse e nota)
 *   - Animes: AniList (GraphQL público)
 *
 * search(consulta, { scopes }) aceita ["movie", "series", "anime"] (padrão: todos) e só consulta
 * as fontes dos tipos escolhidos.
 * As fontes são consultadas em paralelo. Se uma falhar, a outra continua.
 * Depende de storageService (carregar antes).
 */
const searchService = (() => {
  "use strict";

  const CINEMETA_BASE = "https://v3-cinemeta.strem.io";
  const ANILIST_ENDPOINT = "https://graphql.anilist.co";
  const TIMEOUT_MS = 10000;
  const MAX_PER_CATALOG = 12; // por catálogo (filmes / séries)
  const ANIME_LIMIT = 12;
  const IMDB_ID = /^tt\d{7,10}$/;
  const ALL_SCOPES = ["movie", "series", "anime"]; // tipos que a busca pode incluir

  const ANILIST_QUERY = `
    query ($search: String, $perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(search: $search, type: ANIME, sort: SEARCH_MATCH, isAdult: false) {
          id
          title { romaji english }
          coverImage { large }
          description(asHtml: false)
          seasonYear
          startDate { year }
          averageScore
        }
      }
    }`;

  async function fetchJSON(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: { accept: "application/json", ...(options.headers || {}) },
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------
  // Utilitários
  // ------------------------------------------------------------------
  /** Resposta 200 com formato inesperado: é um erro, não "nenhum resultado". */
  function invalidResponse() {
    const error = new Error("Resposta inválida da API.");
    error.code = "INVALID_RESPONSE";
    return error;
  }

  function yearFrom(value) {
    return typeof value === "string" && /^\d{4}/.test(value) ? Number(value.slice(0, 4)) : null;
  }

  function parseRating(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= 10 ? number : null;
  }

  function normalizeTitle(title) {
    return String(title)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  /** Converte qualquer resultado externo no formato único usado pela interface. */
  function toSearchItem({ source, kind, externalId, title, poster, overview, year, score }) {
    const validExternal =
      source === "imdb"
        ? typeof externalId === "string" && IMDB_ID.test(externalId)
        : Number.isInteger(externalId) && externalId > 0;
    if (!validExternal) return null;
    if (typeof title !== "string" || !title.trim()) return null;

    return {
      id: storageService.buildId(source, kind, externalId),
      source,
      kind,
      external_id: externalId,
      category: storageService.categoryFor(kind),
      title: title.trim().slice(0, 300),
      poster_path: typeof poster === "string" && poster.startsWith("https://") ? poster : null,
      overview: typeof overview === "string" && overview.trim() ? overview.trim().slice(0, 2000) : null,
      year: Number.isInteger(year) ? year : null,
      score: typeof score === "number" && score > 0 ? Math.round(score * 10) / 10 : null,
    };
  }

  // ------------------------------------------------------------------
  // Filmes e séries (Cinemeta)
  // ------------------------------------------------------------------
  function cinemetaType(kind) {
    return kind === "movie" ? "movie" : "series";
  }

  async function searchCatalog(type, query) {
    // "/" e "\" quebrariam o caminho da URL; o restante é codificado normalmente.
    const text = query.replace(/[/\\]/g, " ").trim();
    if (!text) return [];

    const data = await fetchJSON(`${CINEMETA_BASE}/catalog/${type}/top/search=${encodeURIComponent(text)}.json`);
    if (!data || !Array.isArray(data.metas)) throw invalidResponse();
    const metas = data.metas;

    return metas
      .map((meta) => {
        if (!meta || meta.type !== type) return null;
        return toSearchItem({
          source: "imdb",
          kind: type === "movie" ? "movie" : "tv",
          externalId: meta.imdb_id || meta.id,
          title: meta.name,
          poster: meta.poster,
          overview: meta.description, // a busca costuma vir sem sinopse (veja getDetails)
          year: yearFrom(meta.releaseInfo),
          score: parseRating(meta.imdbRating),
        });
      })
      .filter(Boolean)
      .slice(0, MAX_PER_CATALOG);
  }

  /**
   * Retorna { items, failure }. Se SÓ um dos catálogos falhar, devolve os resultados do outro
   * e marca `failure.partial` para a interface avisar que a lista pode estar incompleta.
   */
  async function searchMoviesAndSeries(query, catalogs) {
    const results = await Promise.allSettled(catalogs.map((type) => searchCatalog(type, query)));
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length === results.length) throw failed[0].reason;

    const failure = failed.length
      ? Object.assign(new Error("Parte da busca de filmes e séries falhou."), { partial: true, cause: failed[0].reason })
      : null;
    return { items: results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])), failure };
  }

  const detailsCache = new Map();

  /**
   * Sinopse e nota de um título do IMDb (a busca não traz esses campos).
   * Retorna { overview, score, year } ou null; lança erro se a rede falhar.
   */
  async function getDetails(item) {
    if (!item || item.source !== "imdb" || !IMDB_ID.test(item.external_id)) return null;
    if (detailsCache.has(item.id)) return detailsCache.get(item.id);

    const data = await fetchJSON(`${CINEMETA_BASE}/meta/${cinemetaType(item.kind)}/${item.external_id}.json`);
    const meta = data && data.meta;
    if (!meta) return null;

    const details = {
      overview: typeof meta.description === "string" && meta.description.trim() ? meta.description.trim().slice(0, 2000) : null,
      score: parseRating(meta.imdbRating),
      year: yearFrom(meta.releaseInfo) || yearFrom(meta.year),
    };
    detailsCache.set(item.id, details);
    return details;
  }

  // ------------------------------------------------------------------
  // Animes (AniList)
  // ------------------------------------------------------------------
  const HTML_ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#039;": "'", "&#39;": "'" };

  /** A sinopse do AniList pode trazer <br>, <i> etc. Como exibimos texto puro, limpamos. */
  function cleanDescription(text) {
    if (typeof text !== "string") return null;
    const clean = text
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&(?:amp|lt|gt|quot|#0?39);/g, (entity) => HTML_ENTITIES[entity] || entity)
      .trim();
    return clean || null;
  }

  async function searchAnime(query) {
    const data = await fetchJSON(ANILIST_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: ANILIST_QUERY, variables: { search: query, perPage: ANIME_LIMIT } }),
    });
    const media = data && data.data && data.data.Page && data.data.Page.media;
    if (!Array.isArray(media)) throw invalidResponse(); // inclui erros GraphQL com HTTP 200 (data nulo)

    return media
      .map((entry) =>
        toSearchItem({
          source: "anilist",
          kind: "anime",
          externalId: entry.id,
          title: (entry.title && (entry.title.english || entry.title.romaji)) || "",
          poster: entry.coverImage && entry.coverImage.large,
          overview: cleanDescription(entry.description),
          year: entry.seasonYear || (entry.startDate && entry.startDate.year),
          // AniList usa nota de 0 a 100; o app usa 0 a 10.
          score: typeof entry.averageScore === "number" ? entry.averageScore / 10 : null,
        })
      )
      .filter(Boolean);
  }

  // ------------------------------------------------------------------
  // Busca unificada
  // ------------------------------------------------------------------
  /**
   * Busca nas duas fontes. Nunca lança erro: devolve os itens que vieram
   * e, em "errors", o erro de cada fonte que falhou (ou null).
   */
  async function search(query, { scopes = ALL_SCOPES } = {}) {
    const wanted = new Set(scopes.filter((scope) => ALL_SCOPES.includes(scope)));
    const catalogs = ["movie", "series"].filter((type) => wanted.has(type));

    const [moviesResult, animeResult] = await Promise.allSettled([
      catalogs.length ? searchMoviesAndSeries(query, catalogs) : Promise.resolve({ items: [], failure: null }),
      wanted.has("anime") ? searchAnime(query) : Promise.resolve([]),
    ]);

    const anime = animeResult.status === "fulfilled" ? animeResult.value : [];
    const movieOutcome = moviesResult.status === "fulfilled" ? moviesResult.value : { items: [], failure: moviesResult.reason };
    let movies = movieOutcome.items;

    // O IMDb também lista animes como "série"/"filme". Para não aparecer em dobro,
    // some o item do IMDb que tenha o mesmo título E o mesmo ano de um anime do AniList.
    // (Mesmo título com ano diferente, como "One Piece" live-action, continua aparecendo.)
    const animeKeys = new Set(anime.filter((item) => item.year).map((item) => `${normalizeTitle(item.title)}|${item.year}`));
    movies = movies.filter((item) => !(item.year && animeKeys.has(`${normalizeTitle(item.title)}|${item.year}`)));

    const items = [];
    const seen = new Set();
    [...movies, ...anime].forEach((item) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      items.push(item);
    });

    return {
      items,
      errors: {
        movies: movieOutcome.failure,
        anime: animeResult.status === "rejected" ? animeResult.reason : null,
      },
    };
  }

  return { search, getDetails };
})();