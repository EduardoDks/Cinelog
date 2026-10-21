"use strict";
/**
 * Ambiente de teste rápido (sem navegador e sem dependências):
 * carrega storageService.js + searchService.js (+ app.js) exatamente como o
 * navegador faria (mesmo escopo global) sobre um DOM simulado que REGISTRA
 * qualquer escrita insegura (innerHTML, atributos on*, scripts criados...).
 */
const fs = require("node:fs");
const path = require("node:path");

function resolveFrontendDir() {
  if (process.env.CINELOG_DIR) return path.resolve(process.env.CINELOG_DIR);
  const root = path.resolve(__dirname, "..", "..");
  const candidates = [path.join(root, "frontend"), root];
  return candidates.find((dir) => fs.existsSync(path.join(dir, "index.html"))) || candidates[0];
}

const FRONTEND_DIR = resolveFrontendDir();
const read = (file) => fs.readFileSync(path.join(FRONTEND_DIR, file), "utf8");

// ---------------------------------------------------------------------------
// DOM simulado
// ---------------------------------------------------------------------------
function makeDom() {
  const rec = { unsafe: [], images: [], attributes: [], createdTags: [], links: [] };

  class El {
    constructor(tag = "div") {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parent = null;
      this.listeners = {};
      this.attrs = {};
      this.dataset = {};
      this.className = "";
      this.hidden = false;
      this.value = "";
      this.open = false;
      this.style = {};
      this.files = [];
      this._text = "";
      this._src = "";
      this.isFragment = false;
    }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
    set textContent(v) { this._text = String(v); this.children = []; }
    get innerHTML() { return ""; }
    set innerHTML(v) { rec.unsafe.push({ prop: "innerHTML", value: String(v) }); }
    set outerHTML(v) { rec.unsafe.push({ prop: "outerHTML", value: String(v) }); }
    insertAdjacentHTML(pos, html) { rec.unsafe.push({ prop: "insertAdjacentHTML", value: String(html) }); }
    get src() { return this._src; }
    set src(v) { this._src = String(v); if (this.tagName === "IMG") rec.images.push(this._src); }
    set href(v) { this._href = String(v); rec.links.push(this._href); }
    get href() { return this._href || ""; }
    get classList() {
      const self = this;
      const tokens = () => self.className.split(/\s+/).filter(Boolean);
      return {
        add: (c) => { if (!tokens().includes(c)) self.className = [...tokens(), c].join(" "); },
        remove: (c) => { self.className = tokens().filter((t) => t !== c).join(" "); },
        toggle: (c, force) => {
          const has = tokens().includes(c);
          const want = force === undefined ? !has : !!force;
          if (want && !has) self.classList.add(c);
          if (!want && has) self.classList.remove(c);
          return want;
        },
        contains: (c) => tokens().includes(c),
      };
    }
    appendChild(c) {
      if (c.isFragment) { c.children.slice().forEach((x) => this.appendChild(x)); c.children = []; return c; }
      c.parent = this; this.children.push(c); return c;
    }
    append(...cs) { cs.forEach((c) => this.appendChild(c)); }
    replaceChildren(...cs) { this.children = []; this._text = ""; cs.forEach((c) => this.appendChild(c)); }
    replaceWith(n) { const p = this.parent; const i = p.children.indexOf(this); p.children[i] = n; n.parent = p; this.parent = null; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
    setAttribute(k, v) { rec.attributes.push([k, String(v)]); this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k]; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    dispatch(type, ev = {}) {
      const e = { target: this, preventDefault() {}, stopPropagation() {}, ...ev };
      (this.listeners[type] || []).forEach((fn) => fn(e));
    }
    showModal() { this.open = true; }
    close() { if (this.open) { this.open = false; this.dispatch("close"); } }
    click() { this.dispatch("click"); }
    focus() {}
  }

  const byId = {};
  const filterButtons = [
    ["status", "all"], ["status", "watched"], ["status", "plan_to_watch"],
    ["category", "all"], ["category", "filme"], ["category", "serie"], ["category", "anime"],
  ].map(([group, value]) => { const b = new El("button"); b.dataset.group = group; b.dataset.value = value; return b; });

  const scopeButtons = ["movie", "series", "anime"].map((scope) => { const b = new El("button"); b.dataset.scope = scope; return b; });

  const dom = {
    byId, filterButtons, scopeButtons, rec, El, confirmResult: true,
    document: {
      body: new El("body"),
      getElementById: (id) => (byId[id] = byId[id] || new El()),
      createElement: (tag) => { rec.createdTags.push(String(tag).toLowerCase()); return new El(tag); },
      createDocumentFragment: () => { const f = new El("fragment"); f.isFragment = true; return f; },
      querySelectorAll: (sel) => (sel === ".filter-group button" ? filterButtons : sel === ".scope-btn" ? scopeButtons : []),
      addEventListener() {},
      write: (html) => rec.unsafe.push({ prop: "document.write", value: String(html) }),
    },
  };
  dom.window = { addEventListener() {}, confirm: () => dom.confirmResult };
  return dom;
}

const findAll = (el, pred, out = []) => { if (pred(el)) out.push(el); el.children.forEach((c) => findAll(c, pred, out)); return out; };
const hasClass = (el, c) => el.classList.contains(c);

function makeLocalStorage(store) {
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}

/**
 * Carrega os scripts do site.
 *  - app:     também executa o app.js (monta a interface)
 *  - seed:    conteúdo inicial do localStorage (ex.: dados corrompidos)
 *  - storage: objeto localStorage alternativo (ex.: um que sempre lança erro)
 *  - storageGetterThrows: o próprio acesso a `localStorage` lança SecurityError (cookies bloqueados)
 */
/** Define um global mesmo quando o Node o declara só-leitura (ex.: `navigator` no Node 21+). */
function setGlobal(name, value) {
  Object.defineProperty(global, name, { configurable: true, writable: true, value });
}

function freshEnv({ app = false, seed = {}, storage = null, storageGetterThrows = false } = {}) {
  const store = { ...seed };
  if (storageGetterThrows) {
    Object.defineProperty(global, "localStorage", { configurable: true, get() { throw new Error("SecurityError: acesso ao armazenamento bloqueado"); } });
  } else {
    setGlobal("localStorage", storage || makeLocalStorage(store));
  }
  setGlobal("navigator", {});
  const dom = makeDom();
  setGlobal("window", dom.window);
  setGlobal("document", dom.document);
  const ctx = { store, dom };
  const code = [read("storageService.js"), read("searchService.js"), app ? read("app.js") : "", "ctx.S = storageService; ctx.Q = searchService;"].join(";\n");
  eval(code); // eslint-disable-line no-eval
  ctx.D = dom.byId;
  ctx.grid = dom.byId.mediaGrid;
  return ctx;
}

// ---------------------------------------------------------------------------
// Fixtures e mock de fetch
// ---------------------------------------------------------------------------
const fixtures = {
  cineMovies: { metas: [
    { id: "tt0372784", imdb_id: "tt0372784", type: "movie", name: "Batman Begins", poster: "https://m.media-amazon.com/a.jpg", releaseInfo: "2005" },
    { id: "tt0468569", imdb_id: "tt0468569", type: "movie", name: "The Dark Knight", poster: "http://inseguro/x.jpg", releaseInfo: "2008", imdbRating: "9.0", description: "Gotham." },
    { id: "xx1", type: "movie", name: "Id inválido" },
    { id: "tt1234567", imdb_id: "tt1234567", type: "series", name: "Tipo trocado" },
    { id: "tt7654321", imdb_id: "tt7654321", type: "movie", name: "   " },
    null,
  ] },
  cineSeries: { metas: [
    { id: "tt0388629", imdb_id: "tt0388629", type: "series", name: "One Piece", poster: "https://m.media-amazon.com/op.jpg", releaseInfo: "1999–" },
    { id: "tt11737520", imdb_id: "tt11737520", type: "series", name: "One Piece", poster: "https://m.media-amazon.com/lo.jpg", releaseInfo: "2023–" },
  ] },
  anilist: { data: { Page: { media: [
    { id: 21, title: { romaji: "One Piece", english: "One Piece" }, seasonYear: 1999, averageScore: 87, description: "Piratas.<br><br>Tem <i>aventura</i> &amp; humor &quot;muito&quot;.", coverImage: { large: "https://s4.anilist.co/a.jpg" } },
    { id: 22, title: { romaji: "Só romaji", english: null }, startDate: { year: 2010 }, averageScore: null, description: null, coverImage: { large: "http://inseguro/b.jpg" } },
    { id: 21, title: { romaji: "Duplicado" } },
    { title: { romaji: "sem id" } },
    { id: 23, title: { romaji: "", english: null } },
  ] } } },
  meta: { meta: { imdb_id: "tt0372784", description: "  Bruce Wayne vira Batman.  ", imdbRating: "8.2", releaseInfo: "2005", year: "2005" } },
};
fixtures.OK = {
  "catalog/movie/top": { body: fixtures.cineMovies },
  "catalog/series/top": { body: fixtures.cineSeries },
  "graphql.anilist.co": { body: fixtures.anilist },
  "meta/movie/tt0372784.json": { body: fixtures.meta },
};

const mockFetch = (map, calls = []) => async (url, opts = {}) => {
  calls.push({ url: String(url), opts });
  const key = Object.keys(map).find((k) => String(url).includes(k));
  const v = map[key];
  if (v instanceof Error) throw v;
  if (!v) throw new Error("URL inesperada no teste: " + url);
  if (v.gate) await v.gate;
  return {
    ok: v.status === undefined,
    status: v.status || 200,
    json: async () => { if (v.notJson) throw new SyntaxError("Unexpected token <"); return v.body; },
  };
};
const netError = () => new TypeError("Failed to fetch");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const flush = async () => { for (let i = 0; i < 8; i++) await tick(); };

// atalhos de interface
const cards = (grid) => grid.children.filter((c) => hasClass(c, "media-card"));
const quickButtons = (card) => findAll(card, (e) => hasClass(e, "btn-quick"));
const doSearch = async (ctx, q) => { ctx.D.searchInput.value = q; ctx.D.searchForm.dispatch("submit"); await flush(); };
const titlesOf = (grid) => findAll(grid, (e) => hasClass(e, "card-title")).map((e) => e.textContent);

/** Registro mínimo válido; o app completa o resto (fonte, tipo, categoria) a partir do id. */
const record = (id, title, status = "watched", extra = {}) => ({
  id, title, status, poster_path: null, added_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", ...extra,
});
/** Conteúdo de localStorage pronto para semear o app com uma lista de registros. */
const seedItems = (list) => ({ "cinelog:v2:items": JSON.stringify(list) });

module.exports = {
  record, seedItems,
  FRONTEND_DIR, read, freshEnv, makeDom, findAll, hasClass, fixtures, mockFetch, netError, tick, flush,
  cards, quickButtons, doSearch, titlesOf,
};