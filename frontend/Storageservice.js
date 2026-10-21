/**
 * storageService — persistência 100% no navegador (localStorage).
 *
 * Cada registro tem um id textual único: "<fonte>:<tipo>:<id externo>"
 *   imdb:movie:tt0372784 -> filme (catálogo Cinemeta, ids do IMDb)
 *   imdb:tv:tt0944947    -> série (catálogo Cinemeta, ids do IMDb)
 *   anilist:anime:21     -> anime do AniList
 *   tmdb:movie:550       -> legado (versões antigas); continua válido
 *
 * Registro:
 * {
 *   id, source, kind, external_id (número; texto "tt…" no IMDb), category ("filme"|"serie"|"anime"),
 *   title, poster_path, overview, year, score,
 *   status ("watched"|"plan_to_watch"), rating (1..5|null), review,
 *   added_at, updated_at
 * }
 */
const storageService = (() => {
  "use strict";

  const ITEMS_KEY = "cinelog:v2:items";
  const PREFS_KEY = "cinelog:v2:prefs";
  const LEGACY_ITEMS_KEY = "cinelog:v1:items"; // formato da versão com backend

  // "tmdb:" e "jikan:" são legados (a Jikan foi desligada em 01/10/2026): continuam
  // válidos só para não descartar registros ou backups antigos.
  const ID_PATTERN = /^(imdb:(movie|tv):tt\d{7,10}|(tmdb:(movie|tv)|anilist:anime|jikan:anime):[1-9]\d*)$/;
  const STATUSES = ["watched", "plan_to_watch"];
  const FILTER_STATUSES = ["all", ...STATUSES];
  const FILTER_CATEGORIES = ["all", "filme", "serie", "anime"];

  const MAX_TITLE = 300;
  const MAX_TEXT = 2000;
  const MAX_IMPORT_ITEMS = 5000;

  // ------------------------------------------------------------------
  // Identificadores
  // ------------------------------------------------------------------
  function buildId(source, kind, externalId) {
    return `${source}:${kind}:${externalId}`;
  }

  function categoryFor(kind) {
    if (kind === "movie") return "filme";
    if (kind === "tv") return "serie";
    return "anime";
  }

  function parseId(id) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
    const [source, kind, external] = id.split(":");
    return {
      source,
      kind,
      external_id: source === "imdb" ? external : Number(external),
      category: categoryFor(kind),
    };
  }

  // ------------------------------------------------------------------
  // Acesso ao localStorage (nunca lança exceção para fora)
  // ------------------------------------------------------------------
  function readRaw(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      console.error("Falha ao ler o armazenamento local:", error);
      return null;
    }
  }

  function writeRaw(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      // Cota estourada ou armazenamento bloqueado pelo navegador.
      console.error("Falha ao gravar no armazenamento local:", error);
      return false;
    }
  }

  function isAvailable() {
    try {
      const probe = "cinelog:probe";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Validação / normalização (usada em leitura, escrita e importação)
  // ------------------------------------------------------------------
  const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000; // tolerância para relógio adiantado

  /**
   * Normaliza para ISO-8601 (comparável como texto). Datas inválidas viram `fallback`;
   * datas muito no futuro (relógio errado ou backup forjado) viram "agora", para não
   * "ganharem" todo conflito de importação.
   */
  function validDate(value, fallback) {
    if (typeof value !== "string") return fallback;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) return fallback;
    return new Date(ms > Date.now() + MAX_FUTURE_SKEW_MS ? Date.now() : ms).toISOString();
  }

  /** Só aceita número de verdade (ou texto numérico simples): nada de true, [3], {} etc. */
  function toNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) return Number(value);
    return null;
  }

  function sanitize(raw) {
    if (!raw || typeof raw !== "object") return null;

    // Compatibilidade com registros/backups do formato antigo (tmdb_id + media_type).
    let id = raw.id;
    if (id === undefined && raw.tmdb_id !== undefined && ["movie", "tv"].includes(raw.media_type)) {
      id = buildId("tmdb", raw.media_type, raw.tmdb_id);
    }

    const parsed = parseId(id);
    if (!parsed) return null;

    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!title) return null;

    const now = new Date().toISOString();

    let rating = toNumber(raw.rating);
    if (rating !== null && (rating < 1 || rating > 5)) rating = null;

    let score = toNumber(raw.score);
    if (score !== null && (score <= 0 || score > 10)) score = null;

    const year = Number.isInteger(raw.year) && raw.year >= 1800 && raw.year <= 2200 ? raw.year : null;

    // Itens antigos do TMDB marcados como anime mantêm a categoria "anime".
    const category = parsed.source === "tmdb" && raw.category === "anime" ? "anime" : parsed.category;

    return {
      id,
      source: parsed.source,
      kind: parsed.kind,
      external_id: parsed.external_id,
      category,
      title: title.slice(0, MAX_TITLE),
      // Só imagens https: bloqueia "javascript:", "data:" e afins vindos de backups editados.
      poster_path:
        typeof raw.poster_path === "string" && raw.poster_path.startsWith("https://") ? raw.poster_path : null,
      overview: typeof raw.overview === "string" && raw.overview ? raw.overview.slice(0, MAX_TEXT) : null,
      year,
      score,
      status: STATUSES.includes(raw.status) ? raw.status : "plan_to_watch",
      rating,
      review: typeof raw.review === "string" && raw.review ? raw.review.slice(0, MAX_TEXT) : null,
      added_at: validDate(raw.added_at, now),
      updated_at: validDate(raw.updated_at, now),
    };
  }

  // ------------------------------------------------------------------
  // Leitura / gravação da lista
  // ------------------------------------------------------------------
  function parseList(raw) {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(sanitize).filter(Boolean) : [];
  }

  /** Converte os dados da versão antiga (v1) na primeira execução. Não apaga o original. */
  function migrateLegacy() {
    const legacyRaw = readRaw(LEGACY_ITEMS_KEY);
    if (legacyRaw === null) return [];
    try {
      const items = parseList(legacyRaw);
      if (items.length > 0) writeRaw(ITEMS_KEY, JSON.stringify(items));
      return items;
    } catch {
      return [];
    }
  }

  /** Guarda o conteúdo original antes de qualquer descarte. Só o PRIMEIRO backup é mantido. */
  function backupOnce(raw) {
    const key = `${ITEMS_KEY}:corrupted-backup`;
    if (readRaw(key) === null) writeRaw(key, raw);
  }

  function readItems() {
    const raw = readRaw(ITEMS_KEY);
    if (raw === null) return migrateLegacy();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.error("Dados do backlog corrompidos:", error);
      backupOnce(raw);
      return [];
    }
    if (!Array.isArray(parsed)) {
      console.error("Dados do backlog em formato inesperado.");
      backupOnce(raw);
      return [];
    }

    const items = parsed.map(sanitize).filter(Boolean);
    if (items.length !== parsed.length) backupOnce(raw); // entradas inválidas serão descartadas na próxima gravação
    return items;
  }

  function writeItems(items) {
    return writeRaw(ITEMS_KEY, JSON.stringify(items));
  }

  // ------------------------------------------------------------------
  // CRUD
  // ------------------------------------------------------------------

  /** Lista o backlog, do mais recentemente alterado para o mais antigo. */
  function getBacklog() {
    return readItems().sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  function getMedia(id) {
    return readItems().find((item) => item.id === id) || null;
  }

  /**
   * Adiciona uma mídia. Se o id já existir, substitui os dados mantendo
   * a data original de inclusão. Retorna o registro salvo ou null.
   */
  function addMedia(mediaItem) {
    const clean = sanitize(mediaItem);
    if (!clean) return null;

    const items = readItems();
    const index = items.findIndex((item) => item.id === clean.id);
    const now = new Date().toISOString();

    clean.added_at = index >= 0 ? items[index].added_at : now;
    clean.updated_at = now;

    if (index >= 0) items[index] = clean;
    else items.push(clean);

    return writeItems(items) ? clean : null;
  }

  /** Atualiza apenas os campos editáveis (status, rating, review). */
  function updateMedia(id, patch) {
    const items = readItems();
    const index = items.findIndex((item) => item.id === id);
    if (index === -1 || !patch) return null;

    const merged = { ...items[index] };
    ["status", "rating", "review"].forEach((field) => {
      if (field in patch) merged[field] = patch[field];
    });

    const clean = sanitize(merged);
    if (!clean) return null;
    clean.updated_at = new Date().toISOString();
    items[index] = clean;

    return writeItems(items) ? clean : null;
  }

  function updateMediaStatus(id, newStatus) {
    if (!STATUSES.includes(newStatus)) return null;
    return updateMedia(id, { status: newStatus });
  }

  /** Retorna true se o item existia e foi removido com sucesso. */
  function removeMedia(id) {
    const items = readItems();
    const remaining = items.filter((item) => item.id !== id);
    if (remaining.length === items.length) return false;
    return writeItems(remaining);
  }

  // ------------------------------------------------------------------
  // Backup
  // ------------------------------------------------------------------
  function exportData() {
    return JSON.stringify(
      { app: "cinelog", version: 2, exported_at: new Date().toISOString(), items: readItems() },
      null,
      2
    );
  }

  /**
   * Importa um backup mesclando com os dados atuais; em conflito vence o
   * registro com updated_at mais recente. Aceita backups do formato antigo.
   * Retorna { imported, skipped } ou lança Error com mensagem para o usuário.
   */
  function importData(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("O arquivo não é um JSON válido.");
    }

    const incoming = Array.isArray(data) ? data : data && data.items;
    if (!Array.isArray(incoming)) throw new Error("Formato de backup não reconhecido.");
    if (incoming.length > MAX_IMPORT_ITEMS) throw new Error("O backup tem itens demais para importar.");

    const items = readItems();
    let imported = 0;
    let skipped = 0;

    incoming.forEach((raw) => {
      const clean = sanitize(raw);
      if (!clean) {
        skipped += 1;
        return;
      }
      const index = items.findIndex((item) => item.id === clean.id);
      if (index === -1) {
        items.push(clean);
        imported += 1;
      } else if (clean.updated_at > items[index].updated_at) {
        items[index] = clean;
        imported += 1;
      } else {
        skipped += 1;
      }
    });

    if (!writeItems(items)) throw new Error("Não foi possível gravar no armazenamento do navegador.");
    return { imported, skipped };
  }

  // ------------------------------------------------------------------
  // Preferências (filtros escolhidos)
  // ------------------------------------------------------------------
  function getPrefs() {
    const defaults = { status: "all", category: "all" };
    const raw = readRaw(PREFS_KEY);
    if (!raw) return defaults;
    try {
      const prefs = JSON.parse(raw);
      return {
        status: FILTER_STATUSES.includes(prefs.status) ? prefs.status : defaults.status,
        category: FILTER_CATEGORIES.includes(prefs.category) ? prefs.category : defaults.category,
      };
    } catch {
      return defaults;
    }
  }

  function savePrefs(partial) {
    return writeRaw(PREFS_KEY, JSON.stringify({ ...getPrefs(), ...partial }));
  }

  /** Pede ao navegador para não apagar estes dados automaticamente. */
  async function requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
    } catch (error) {
      console.warn("Armazenamento persistente indisponível:", error);
    }
    return false;
  }

  return {
    buildId,
    categoryFor,
    isAvailable,
    getBacklog,
    getMedia,
    addMedia,
    updateMedia,
    updateMediaStatus,
    removeMedia,
    exportData,
    importData,
    getPrefs,
    savePrefs,
    requestPersistence,
  };
})();