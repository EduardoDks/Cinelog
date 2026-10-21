"use strict";
/**
 * 1) INTERFACE & UX — navegador real (Chromium)
 * Renderização, navegação/filtros, responsividade em várias telas, acessibilidade e contraste.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { newSession, closeBrowser, contrastReport } = require("./_support/browser");
const { record, seedItems, read } = require("./_support/env");

after(closeBrowser);

const ARTIFACTS = path.join(__dirname, "artifacts");
const LIB = [
  record("imdb:movie:tt0000001", "Filme Assistido", "watched"),
  record("imdb:movie:tt0000002", "Filme Pendente", "plan_to_watch"),
  record("imdb:tv:tt0000003", "Série Assistida", "watched"),
  record("imdb:tv:tt0000004", "Série Pendente", "plan_to_watch"),
  record("anilist:anime:5", "Anime Assistido", "watched"),
  record("anilist:anime:6", "Anime Pendente", "plan_to_watch"),
];
const visibleTitles = (page) => page.$$eval(".media-card .card-title", (els) => els.map((e) => e.textContent).sort());
const activeFilters = (page) => page.$$eval(".filter-group button.active", (els) => els.map((e) => `${e.dataset.group}:${e.dataset.value}`));

describe("Renderização (navegador real)", { timeout: 60000 }, () => {
  it("página inicial: cabeçalho, busca, filtros e backlog vazio, sem erros de script, CSP ou rede externa", async (t) => {
    const s = await newSession(t); if (!s) return;
    await s.goto();
    for (const sel of ["header", ".logo", "#searchInput", "#btnExport", "#btnImport", ".site-footer"]) {
      assert.ok(await s.page.locator(sel).isVisible(), `${sel} deveria estar visível`);
    }
    assert.equal(await s.page.locator(".filter-group button").count(), 7);
    assert.deepEqual(await activeFilters(s.page), ["status:all", "category:all"]);
    assert.match(await s.page.textContent("#mediaGrid"), /Seu backlog está vazio/);
    assert.equal(await s.page.locator("#mediaModal").isVisible(), false);
    assert.deepEqual(s.errors, []);
    assert.deepEqual(s.csp, []);
    assert.deepEqual(s.log.blocked, []);
    assert.deepEqual(s.consoleErrors, []);
  });

  it("busca: cards completos (pôster, título, tag FILME/SÉRIE/ANIME, ano, nota) e os dois botões de ação", async (t) => {
    const s = await newSession(t); if (!s) return;
    await s.goto(); await s.search("batman");
    await s.page.waitForFunction(() => [...document.images].every((img) => img.complete)); // espera as imagens terminarem
    const cards = await s.page.$$eval(".media-card", (els) => els.map((c) => ({
      title: c.querySelector(".card-title").textContent,
      badge: c.querySelector(".category-badge").textContent,
      year: (c.querySelector(".card-year") || {}).textContent || null,
      posterOk: c.querySelector("img").complete && c.querySelector("img").naturalWidth > 0,
      buttons: [...c.querySelectorAll(".btn-quick")].map((b) => b.textContent),
    })));
    assert.deepEqual(cards.map((c) => c.badge), ["Filme", "Filme", "Série", "Anime", "Anime"]);
    assert.deepEqual(cards.map((c) => c.title), ["Batman Begins", "The Dark Knight", "One Piece", "One Piece", "Só romaji"]);
    cards.forEach((c) => { assert.ok(c.title && c.year && c.posterOk, JSON.stringify(c)); assert.deepEqual(c.buttons, ["✓ Assistido", "+ Quero ver"]); });
    assert.equal(await s.page.locator("#pageTitle").textContent(), 'Resultados para: "batman"');
    assert.equal(await s.page.locator("#filters").isVisible(), false);
    assert.equal(await s.page.locator("#btnBack").isVisible(), true);
    assert.deepEqual(s.errors, []); assert.deepEqual(s.csp, []);
  });

  it("'+ Quero ver' salva como Quero Assistir e o card troca para o estado salvo", async (t) => {
    const s = await newSession(t); if (!s) return;
    await s.goto(); await s.search("batman");
    const first = s.page.locator(".media-card").first();
    await first.getByRole("button", { name: "+ Quero ver" }).click();
    await s.page.waitForSelector(".media-card:first-child .status-plan");
    assert.equal(await first.locator(".btn-quick").count(), 0);
    assert.equal((await first.locator(".status-plan").textContent()).trim(), "Quero Assistir");
    assert.match(await s.page.locator("#toast").textContent(), /adicionado em Quero Assistir/);
    const saved = JSON.parse(await s.page.evaluate(() => localStorage.getItem("cinelog:v2:items")));
    assert.equal(saved.length, 1); assert.equal(saved[0].status, "plan_to_watch"); assert.equal(saved[0].category, "filme");
  });

  it("'✓ Assistido' salva como Assistido e persiste ao recarregar a página", async (t) => {
    const s = await newSession(t); if (!s) return;
    await s.goto(); await s.search("batman");
    await s.page.locator(".media-card").nth(1).getByRole("button", { name: "✓ Assistido" }).click();
    await s.page.waitForSelector(".status-watched");
    await s.page.reload();
    assert.deepEqual(await visibleTitles(s.page), ["The Dark Knight"]);
    assert.equal((await s.page.locator(".status-watched").textContent()).trim(), "Assistido");
  });

  it("modal: abre ao clicar, carrega sinopse/nota, fecha com X, Esc e clique no fundo; trava o scroll do fundo", async (t) => {
    const s = await newSession(t); if (!s) return;
    await s.goto(); await s.search("batman");
    for (const closer of ["x", "esc", "backdrop"]) {
      await s.page.locator(".media-card").first().click();
      assert.equal(await s.page.locator("#mediaModal").isVisible(), true);
      await s.page.waitForFunction(() => document.getElementById("modalOverview").textContent.includes("Bruce Wayne"));
      assert.equal(await s.page.locator("#modalTitle").textContent(), "Batman Begins");
      assert.match(await s.page.locator("#modalMeta").textContent(), /Filme · 2005 · ★ 8\.2 \(IMDb\)/);
      assert.equal(await s.page.evaluate(() => getComputedStyle(document.body).overflow), "hidden");
      if (closer === "x") await s.page.click("#btnCloseModal");
      else if (closer === "esc") await s.page.keyboard.press("Escape");
      else await s.page.mouse.click(5, 5);
      assert.equal(await s.page.locator("#mediaModal").isVisible(), false, `fechar via ${closer}`);
      await s.page.waitForFunction(() => getComputedStyle(document.body).overflow !== "hidden", null, { timeout: 3000 })
        .catch(() => assert.fail(`o scroll do fundo continuou travado depois de fechar via ${closer}`));
    }
  });

  it("modal: salvar com nota e comentário atualiza o card; remover (confirmando) tira do backlog", async (t) => {
    const s = await newSession(t); if (!s) return;
    await s.goto(); await s.search("batman");
    await s.page.locator(".media-card").first().click();
    await s.page.selectOption("#modalStatus", "watched");
    await s.page.fill("#modalRating", "4.5");
    await s.page.fill("#modalReview", "Excelente");
    await s.page.click("#btnSubmit");
    assert.equal(await s.page.locator("#mediaModal").isVisible(), false);
    assert.equal((await s.page.locator(".media-card").first().locator(".rating").textContent()).trim(), "★ 4.5");
    await s.page.locator(".media-card").first().click();
    assert.equal(await s.page.inputValue("#modalReview"), "Excelente");
    assert.equal(await s.page.locator("#btnDelete").isVisible(), true);
    await s.page.click("#btnDelete");               // o confirm() é aceito automaticamente
    assert.equal(s.dialogs.at(-1).type, "confirm");
    assert.equal(await s.page.locator(".media-card").first().locator(".btn-quick").count(), 2);
    assert.equal(await s.page.evaluate(() => JSON.parse(localStorage.getItem("cinelog:v2:items")).length), 0);
  });

  it("modal: nota inválida (fora de 1–5) é barrada pelo formulário e nada é salvo", async (t) => {
    const s = await newSession(t); if (!s) return;
    await s.goto(); await s.search("batman");
    await s.page.locator(".media-card").first().click();
    await s.page.fill("#modalRating", "9");
    await s.page.click("#btnSubmit");
    assert.equal(await s.page.locator("#mediaModal").isVisible(), true);
    assert.equal(await s.page.evaluate(() => localStorage.getItem("cinelog:v2:items")), null);
  });

  it("teclado: cards recebem foco, Enter abre o modal e Esc fecha", async (t) => {
    const s = await newSession(t); if (!s) return;
    await s.goto(); await s.search("batman");
    await s.page.locator(".media-card").first().focus();
    await s.page.keyboard.press("Enter");
    assert.equal(await s.page.locator("#mediaModal").isVisible(), true);
    await s.page.keyboard.press("Escape");
    assert.equal(await s.page.locator("#mediaModal").isVisible(), false);
  });
});

describe("Navegação e estado visual (filtros)", { timeout: 60000 }, () => {
  it("cada filtro altera os itens exibidos no DOM e o contador do título", async (t) => {
    const s = await newSession(t, { seed: seedItems(LIB) }); if (!s) return;
    await s.goto();
    const click = (name, group) => s.page.locator(`.filter-group button[data-group="${group}"]`).filter({ hasText: name }).first().click();
    const all = ["Anime Assistido", "Anime Pendente", "Filme Assistido", "Filme Pendente", "Série Assistida", "Série Pendente"];
    assert.deepEqual(await visibleTitles(s.page), all);
    assert.equal(await s.page.locator("#pageTitle").textContent(), "Meu Backlog — Todos / Todos (6)");

    await click("Filmes", "category");  assert.deepEqual(await visibleTitles(s.page), ["Filme Assistido", "Filme Pendente"]);
    await click("Séries", "category");  assert.deepEqual(await visibleTitles(s.page), ["Série Assistida", "Série Pendente"]);
    await click("Animes", "category");  assert.deepEqual(await visibleTitles(s.page), ["Anime Assistido", "Anime Pendente"]);
    await click("Assistidos", "status"); assert.deepEqual(await visibleTitles(s.page), ["Anime Assistido"]);
    assert.equal(await s.page.locator("#pageTitle").textContent(), "Meu Backlog — Assistidos / Animes (1)");
    await click("Quero Assistir", "status"); assert.deepEqual(await visibleTitles(s.page), ["Anime Pendente"]);
    await click("Filmes", "category");  assert.deepEqual(await visibleTitles(s.page), ["Filme Pendente"]);
    await click("Todos", "category");   assert.deepEqual(await visibleTitles(s.page), ["Anime Pendente", "Filme Pendente", "Série Pendente"]);
    await click("Todos", "status");     assert.deepEqual(await visibleTitles(s.page), all);
    assert.deepEqual(s.errors, []);
  });

  it("estado visual dos botões (classe active + aria-pressed) acompanha a seleção", async (t) => {
    const s = await newSession(t, { seed: seedItems(LIB) }); if (!s) return;
    await s.goto();
    await s.page.locator('button[data-group="status"][data-value="watched"]').click();
    await s.page.locator('button[data-group="category"][data-value="anime"]').click();
    assert.deepEqual(await activeFilters(s.page), ["status:watched", "category:anime"]);
    const pressed = await s.page.$$eval(".filter-group button", (els) => els.map((e) => `${e.dataset.value}=${e.getAttribute("aria-pressed")}`));
    assert.ok(pressed.includes("watched=true") && pressed.includes("anime=true") && pressed.includes("plan_to_watch=false"));
  });

  it("filtros são lembrados após recarregar; sem itens no filtro aparece mensagem amigável", async (t) => {
    const s = await newSession(t, { seed: seedItems(LIB) }); if (!s) return;
    await s.goto();
    await s.page.locator('button[data-group="status"][data-value="plan_to_watch"]').click();
    await s.page.locator('button[data-group="category"][data-value="serie"]').click();
    await s.page.reload();
    assert.deepEqual(await activeFilters(s.page), ["status:plan_to_watch", "category:serie"]);
    assert.deepEqual(await visibleTitles(s.page), ["Série Pendente"]);
    await s.page.evaluate(() => localStorage.setItem("cinelog:v2:items", "[]")); await s.page.reload();
    assert.match(await s.page.textContent("#mediaGrid"), /Seu backlog está vazio/);
  });

  it("busca esconde os filtros e 'Voltar ao backlog' / logo restauram a lista e os filtros", async (t) => {
    const s = await newSession(t, { seed: seedItems(LIB) }); if (!s) return;
    await s.goto();
    await s.search("batman");
    assert.equal(await s.page.locator("#filters").isVisible(), false);
    await s.page.click("#btnBack");
    assert.equal(await s.page.locator("#filters").isVisible(), true);
    assert.equal(await s.page.locator(".media-card").count(), 6);
    assert.equal(await s.page.inputValue("#searchInput"), "");
    await s.search("batman"); await s.page.click(".logo");
    assert.equal(await s.page.locator(".media-card").count(), 6);
  });

  it("itens já salvos aparecem como salvos na busca (sem botões de ação) e adicionar atualiza o backlog na hora", async (t) => {
    const s = await newSession(t, { seed: seedItems([record("imdb:movie:tt0372784", "Batman Begins", "watched")]) }); if (!s) return;
    await s.goto(); await s.search("batman");
    assert.equal(await s.page.locator(".media-card").first().locator(".btn-quick").count(), 0);
    assert.equal(await s.page.locator(".media-card").first().locator(".status-watched").count(), 1);
    await s.page.locator(".media-card").nth(1).getByRole("button", { name: "+ Quero ver" }).click();
    await s.page.click("#btnBack");
    assert.deepEqual(await visibleTitles(s.page), ["Batman Begins", "The Dark Knight"]);
  });
});

describe("Responsividade (viewports reais)", { timeout: 90000 }, () => {
  const SCREENS = [
    { name: "desktop-1280", width: 1280, height: 800, minCols: 4 },
    { name: "tablet-768", width: 768, height: 1024, minCols: 3 },
    { name: "celular-390", width: 390, height: 844, minCols: 2 },
    { name: "celular-pequeno-320", width: 320, height: 568, minCols: 1 },
  ];
  const many = Array.from({ length: 12 }, (_, i) => record(`imdb:movie:tt00001${String(i).padStart(2, "0")}`, `Título de exemplo número ${i + 1} com nome comprido`, i % 2 ? "watched" : "plan_to_watch", { score: 7.5, year: 2000 + i }));

  const geometry = (page) => page.evaluate(() => {
    const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
    const cards = [...document.querySelectorAll(".media-card")].map((c) => c.getBoundingClientRect());
    return {
      vw: document.documentElement.clientWidth, vh: window.innerHeight, scrollW: document.documentElement.scrollWidth,
      logo: r(".logo"), search: r(".search-box"), input: r("#searchInput"), actions: r(".header-actions"), header: r("header"), scope: r(".scope-group"),
      cardsOutside: cards.filter((b) => b.left < -1 || b.right > document.documentElement.clientWidth + 1).length,
      firstRow: cards.filter((b) => Math.abs(b.top - cards[0].top) < 2).length, cardCount: cards.length,
    };
  });
  const overlap = (a, b) => a && b && a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;

  for (const screen of SCREENS) {
    it(`${screen.name}: sem rolagem horizontal, cabeçalho íntegro, grade com colunas, modal cabendo na tela`, async (t) => {
      const s = await newSession(t, { viewport: { width: screen.width, height: screen.height }, seed: seedItems(many) }); if (!s) return;
      await s.goto();
      fs.mkdirSync(ARTIFACTS, { recursive: true });
      const g = await geometry(s.page);

      assert.ok(g.scrollW <= g.vw + 1, `rolagem horizontal: página tem ${g.scrollW}px em tela de ${g.vw}px`);
      assert.equal(g.cardsOutside, 0, "há cards cortados fora da tela");
      assert.ok(g.firstRow >= screen.minCols, `esperava ≥${screen.minCols} colunas, veio ${g.firstRow}`);
      for (const part of ["logo", "search", "actions"]) {
        assert.ok(g[part].l >= -1 && g[part].r <= g.vw + 1, `${part} ultrapassa a tela (${g[part].l}..${g[part].r} de ${g.vw})`);
      }
      assert.ok(!overlap(g.logo, g.search) && !overlap(g.logo, g.actions) && !overlap(g.search, g.actions), "elementos do cabeçalho se sobrepõem");
      assert.ok(g.input.w >= 200, `campo de busca estreito demais (${g.input.w}px)`);
      assert.ok(g.scope.l >= g.search.l - 1 && g.scope.r <= g.search.r + 1 && g.scope.b <= g.search.b + 1, "seletor de tipos fora da barra de busca");
      assert.ok(g.scope.l >= g.input.r - 1 || g.scope.t >= g.input.b - 1, "seletor de tipos sobrepõe o campo de busca");
      await s.page.screenshot({ path: path.join(ARTIFACTS, `${screen.name}-backlog.png`), fullPage: true });

      await s.search("batman");
      const gs = await geometry(s.page);
      assert.ok(gs.scrollW <= gs.vw + 1, "rolagem horizontal na tela de busca");
      await s.page.screenshot({ path: path.join(ARTIFACTS, `${screen.name}-busca.png`), fullPage: true });

      await s.page.locator(".media-card").first().click();
      await s.page.waitForFunction(() => document.getElementById("modalOverview").textContent.includes("Bruce"));
      const box = await s.page.locator("#mediaModal").boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= screen.width + 1, `modal fora da largura: x=${box.x} w=${box.width}`);
      assert.ok(box.y >= 0 && box.y + box.height <= screen.height + 1, `modal fora da altura: y=${box.y} h=${box.height}`);
      const submit = await s.page.locator("#btnSubmit").boundingBox();
      await s.page.locator("#btnSubmit").scrollIntoViewIfNeeded();
      assert.ok(submit.width > 80, "botão de salvar muito estreito");
      await s.page.screenshot({ path: path.join(ARTIFACTS, `${screen.name}-modal.png`) });
      assert.deepEqual(s.errors, []);
    });
  }

  it("a página declara viewport e usa media query para telas pequenas", () => {
    const css = read("style.css"), html = read("index.html");
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1\.0">/);
    assert.match(css, /@media \(max-width: 720px\)[\s\S]*header[\s\S]*\.search-box[\s\S]*\.media-grid/);
    assert.match(css, /repeat\(auto-fill, minmax\(/);
  });
});

describe("Acessibilidade e contraste", { timeout: 60000 }, () => {
  it("contraste de texto ≥ 4,5:1 (3:1 para texto grande) nos elementos principais", async (t) => {
    const s = await newSession(t, { seed: seedItems([record("imdb:movie:tt0372784", "Batman Begins", "watched", { year: 2005, score: 8.2, rating: 4 })]) }); if (!s) return;
    await s.goto();
    const normal = [".header-actions button", ".filter-group button", ".card-title", ".card-year", ".card-status", ".rating", ".category-badge", ".site-footer p", "#searchInput", ".btn-link"];
    const rows = await contrastReport(s.page, [".logo", ...normal]);
    const failures = rows.filter((r) => !r.missing && r.ratio < (r.sel === ".logo" ? 3 : 4.5));
    assert.deepEqual(failures, [], "contraste insuficiente: " + JSON.stringify(failures));
  });

  it("alvos de toque/clique têm pelo menos 24px de altura (WCAG 2.5.8)", async (t) => {
    const s = await newSession(t, { seed: seedItems([record("imdb:movie:tt0372784", "Batman Begins", "watched")]) }); if (!s) return;
    await s.goto(); await s.search("batman");
    const small = await s.page.$$eval(".btn-quick, .header-actions button, .filter-group button, .btn-link, .scope-btn", (els) =>
      els.filter((e) => e.offsetParent !== null && e.getBoundingClientRect().height < 24).map((e) => `${e.className || e.textContent}:${Math.round(e.getBoundingClientRect().height)}px`));
    assert.deepEqual(small, []);
  });

  it("HTML semântico: idioma, labels ligados a campos, botões com type, imagens com alt, ids únicos, dialog nomeado", () => {
    const html = read("index.html");
    assert.match(html, /<html lang="pt-BR">/);
    for (const [, id] of html.matchAll(/<label[^>]*for="([^"]+)"/g)) assert.ok(html.includes(`id="${id}"`), `label aponta para #${id} inexistente`);
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(buttons.length >= 10); buttons.forEach((b) => assert.match(b, /type="(button|submit)"/, b));
    [...html.matchAll(/<img\b[^>]*>/g)].forEach((m) => assert.match(m[0], /\salt=/, m[0]));
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], "ids duplicados");
    const labelled = html.match(/<dialog[^>]*aria-labelledby="([^"]+)"/);
    assert.ok(labelled && html.includes(`id="${labelled[1]}"`));
    assert.match(html, /<input type="search"[^>]*aria-label=/);
  });

  it("CSS: chaves balanceadas, regra [hidden], foco visível e respeito a prefers-reduced-motion", () => {
    const css = read("style.css");
    assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
    assert.match(css, /\[hidden\]\s*{\s*display:\s*none\s*!important/);
    assert.match(css, /:focus-visible/);
    assert.match(css, /prefers-reduced-motion/);
  });
});

// =====================================================================================
// Identidade visual (nova interface): paleta, cabeçalho, filtros neon, cards e hover
// =====================================================================================
describe("Identidade visual (nova interface)", { timeout: 120000 }, () => {
  const SHOWCASE = [
    record("imdb:movie:tt0000001", "Thunderbolts*", "watched", { year: 2025, rating: 4, review: "Gostei muito!" }),
    record("imdb:movie:tt0000002", "Avengers: Endgame", "watched", { year: 2019, rating: 5, review: "Gostei muito!" }),
    record("anilist:anime:3", "Cyberpunk: Edgerunners", "watched", { year: 2022, rating: 5 }),
    record("imdb:tv:tt0000004", "New Character Drama", "watched", { year: 2024 }),
    record("anilist:anime:5", "ONE PIECE", "plan_to_watch", { year: 1999, review: "Gostei muito!" }),
  ];
  const rgb = (text) => text.match(/[\d.]+/g).slice(0, 4).map(Number);
  const rect = (page, sel) => page.locator(sel).first().evaluate((e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; });
  const style = (page, sel, prop) => page.locator(sel).first().evaluate((e, p) => getComputedStyle(e)[p], prop);
  const rootVars = () => Object.fromEntries([...read("style.css").match(/:root\s*{([\s\S]*?)\n}/)[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

  it("as variáveis de cor ficam no :root, com a paleta pedida, e as regras principais não repetem cores fixas", () => {
    const v = rootVars();
    assert.equal(v["--bg"], "#121318");
    assert.ok(["#1a1c23", "#1e2029"].includes(v["--surface"]), v["--surface"]);
    assert.equal(v["--text"], "#ffffff");
    assert.equal(v["--text-muted"], "#9ca3af");
    const radius = parseInt(v["--radius"], 10);
    assert.ok(radius >= 12 && radius <= 16, `raio do card: ${v["--radius"]}`);
    for (const name of ["--accent", "--c-watched-rgb", "--c-plan-rgb", "--c-movie-rgb", "--c-series-rgb", "--c-anime-rgb", "--brand-gradient", "--bg-glow-1", "--bg-glow-2"]) assert.ok(v[name], `${name} não definida`);
    const css = read("style.css");
    for (const selector of ["body", ".media-card", ".filter-group button", ".search-box"]) {
      const block = css.match(new RegExp(`(^|\\n)${selector.replace(/[.]/g, "\\.")}\\s*{([^}]*)}`))[2];
      assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b/i, `${selector} usa cor fixa em vez de var(--...)`);
    }
  });

  it("CSS declara grade responsiva com colunas de 200px, pôster 2:3 e hover de 4px", () => {
    const css = read("style.css");
    assert.match(css, /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(200px,\s*1fr\)\)/);
    assert.match(css, /aspect-ratio:\s*2\s*\/\s*3/);
    assert.match(css, /\.media-card:hover[^{]*{[^}]*translateY\(-4px\)/);
  });

  it("paleta aplicada no navegador: fundo, cards, textos e raio dos cantos", async (t) => {
    const s = await newSession(t, { seed: seedItems(SHOWCASE) }); if (!s) return;
    await s.goto();
    assert.deepEqual(rgb(await style(s.page, "body", "backgroundColor")), [18, 19, 24]);
    assert.deepEqual(rgb(await style(s.page, ".media-card", "backgroundColor")), [26, 28, 35]);
    const radius = parseFloat(await style(s.page, ".media-card", "borderTopLeftRadius"));
    assert.ok(radius >= 12 && radius <= 16, `raio ${radius}px`);
    assert.deepEqual(rgb(await style(s.page, ".card-title", "color")), [255, 255, 255]);
    assert.deepEqual(rgb(await style(s.page, ".card-year", "color")), [156, 163, 175]);
    assert.deepEqual(rgb(await style(s.page, ".filter-label", "color")), [156, 163, 175]);
    assert.deepEqual(rgb(await style(s.page, ".title-main", "color")), [255, 255, 255]);
    assert.deepEqual(rgb(await style(s.page, ".title-sub", "color")), [156, 163, 175]);
    assert.equal(await s.page.locator("#pageTitle").textContent(), "Meu Backlog — Todos / Todos (5)");
  });

  it("cabeçalho: logo com gradiente à esquerda, busca em pílula centralizada, Exportar/Importar em contorno à direita", async (t) => {
    const s = await newSession(t, { seed: seedItems(SHOWCASE) }); if (!s) return;
    await s.goto();
    assert.match(await style(s.page, ".logo", "backgroundImage"), /linear-gradient/);
    assert.equal(await style(s.page, ".logo", "webkitTextFillColor"), "rgba(0, 0, 0, 0)");
    const [logo, search, actions] = [await rect(s.page, ".logo"), await rect(s.page, ".search-box"), await rect(s.page, ".header-actions")];
    assert.ok(Math.abs((search.l + search.r) / 2 - 640) <= 40, `busca fora do centro (${(search.l + search.r) / 2})`);
    assert.ok(logo.r < search.l && search.r < actions.l, "ordem esperada: logo | busca | ações");
    assert.ok(parseFloat(await style(s.page, ".search-box", "borderTopLeftRadius")) >= 20, "barra de busca não é uma pílula");
    assert.match(await style(s.page, ".search-box", "backgroundColor"), /rgba\(.*,\s*0\.\d+\)/, "fundo da busca deveria ser semitransparente");
    for (const id of ["#btnExport", "#btnImport"]) {
      assert.equal(await style(s.page, id, "backgroundColor"), "rgba(0, 0, 0, 0)", `${id} deveria ser outline`);
      assert.equal(await style(s.page, id, "borderTopWidth"), "1px");
    }
    assert.equal(await s.page.locator(".scope-btn svg").count(), 3);
  });

  it("filtros: duas seções rotuladas (lado a lado no desktop, empilhadas no celular)", async (t) => {
    for (const [width, side] of [[1280, true], [390, false]]) {
      const s = await newSession(t, { viewport: { width, height: 800 }, seed: seedItems(SHOWCASE) }); if (!s) return;
      await s.goto();
      const labels = await s.page.$$eval(".filter-label", (els) => els.map((e) => e.innerText));
      assert.deepEqual(labels, ["FILTRAR POR STATUS", "FILTRAR POR CATEGORIA"]);
      const [a, b] = await s.page.$$eval(".filter-section", (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, b: r.bottom }; }));
      if (side) assert.ok(Math.abs(a.t - b.t) < 2 && b.l > a.l, "seções deveriam ficar lado a lado");
      else assert.ok(b.t >= a.b - 1, "seções deveriam ficar empilhadas");
      assert.deepEqual(await s.page.$$eval(".filter-group", (els) => els.map((e) => e.querySelectorAll("button").length)), [3, 4]);
    }
  });

  it("pílulas: borda fina colorida com brilho; ao selecionar, borda forte + fundo leve na cor certa", async (t) => {
    const s = await newSession(t, { seed: seedItems(SHOWCASE) }); if (!s) return;
    await s.goto();
    const pills = await s.page.$$eval(".filter-group button", (els) => els.map((e) => { const c = getComputedStyle(e); return { value: e.dataset.value, border: c.borderTopColor, width: c.borderTopWidth, glow: c.boxShadow, radius: parseFloat(c.borderTopLeftRadius), upper: c.textTransform }; }));
    pills.forEach((p) => { assert.equal(p.width, "1px"); assert.notEqual(p.glow, "none", `${p.value} sem brilho`); assert.ok(p.radius >= 20, `${p.value} não é pílula`); assert.equal(p.upper, "uppercase"); });
    assert.match(pills.find((p) => p.value === "watched").border, /34, 197, 94/, "borda de Assistidos deveria ser verde mesmo sem seleção");

    const DOMINANT = {            // [grupo, valor, canal dominante conferido]
      "status:watched": ([r, g, b]) => g > r && g > b,                 // verde
      "status:plan_to_watch": ([r, g, b]) => r > g && g > b,           // laranja
      "category:filme": ([r, g, b]) => b > r && b > g,                 // azul
      "category:serie": ([r, g, b]) => b > r && r > g,                 // roxo
      "category:anime": ([r, g, b]) => r > b && b > g,                 // rosa
      "category:all": ([r, g, b]) => b > g && g > r,                   // azul-céu
    };
    for (const [key, isRightColor] of Object.entries(DOMINANT)) {
      const [group, value] = key.split(":");
      const button = s.page.locator(`.filter-group button[data-group="${group}"][data-value="${value}"]`);
      await button.click();
      await s.page.waitForTimeout(400);                       // deixa a transição de 0,2 s terminar
      const active = await button.evaluate((e) => { const c = getComputedStyle(e); return { border: c.borderTopColor, bg: c.backgroundColor, glow: c.boxShadow }; });
      assert.ok(isRightColor(rgb(active.border)), `${key}: cor da borda ${active.border}`);
      assert.notEqual(active.bg, "rgba(0, 0, 0, 0)", `${key}: sem fundo leve ao selecionar`);
      assert.ok(rgb(active.bg)[3] > 0 && rgb(active.bg)[3] < 0.4, `${key}: fundo deveria ser leve (${active.bg})`);
      assert.ok(isRightColor(rgb(active.bg)), `${key}: cor do fundo ${active.bg}`);
    }
  });

  it("card: pôster 2:3 acima do título; status à esquerda e nota à direita; tipo + ano; anotação só quando existe", async (t) => {
    const s = await newSession(t, { seed: seedItems(SHOWCASE) }); if (!s) return;
    await s.goto();
    await s.page.waitForFunction(() => [...document.images].every((img) => img.complete));
    const first = s.page.locator(".media-card").first();
    const box = (sel) => first.locator(sel).first().evaluate((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; });
    const [img, title, status, rating, badge, year, note] = [await box("img"), await box(".card-title"), await box(".card-status"), await box(".rating"), await box(".category-badge"), await box(".card-year"), await box(".card-note")];
    assert.ok(Math.abs(img.w / img.h - 2 / 3) < 0.02, `proporção do pôster ${(img.w / img.h).toFixed(3)}`);
    assert.ok(img.b <= title.t + 1, "o título deve vir abaixo do pôster");
    assert.equal(await first.locator(".card-title").textContent(), "Thunderbolts*");
    assert.equal((await first.locator(".card-status").textContent()).trim(), "Assistido");
    assert.equal((await first.locator(".rating").textContent()).trim(), "★ 4.0");
    assert.ok(rating.l > status.r && Math.abs(rating.r - (img.r - 14)) < 6, "a nota deve ficar alinhada à direita da linha do status");
    assert.ok(badge.t >= status.b - 1 && year.l > badge.r, "linha de tipo + ano deve vir abaixo do status");
    assert.equal(await first.locator(".category-badge").textContent(), "Filme");
    assert.equal(await first.locator(".card-year").textContent(), "2025");
    assert.equal(await first.locator(".card-note").textContent(), "Gostei muito!");
    assert.ok(note.t >= badge.b - 1, "a anotação fica na área inferior");
    assert.equal(await style(s.page, ".card-note", "borderTopWidth"), "1px");
    const noteCounts = await s.page.$$eval(".media-card", (cards) => cards.map((c) => c.querySelectorAll(".card-note").length));
    assert.equal(noteCounts.filter(Boolean).length, 3, "só os 3 itens com comentário têm anotação");
  });

  it("hover: o card sobe 4px, ganha sombra e destaque na borda com transição suave", async (t) => {
    const s = await newSession(t, { seed: seedItems(SHOWCASE) }); if (!s) return;
    await s.goto();
    const card = s.page.locator(".media-card").first();
    const before = await card.evaluate((e) => ({ transform: getComputedStyle(e).transform, border: getComputedStyle(e).borderTopColor, shadow: getComputedStyle(e).boxShadow, transition: getComputedStyle(e).transitionDuration }));
    assert.equal(before.transform, "none");
    assert.notEqual(before.transition, "0s", "sem transição");
    await card.hover();
    await s.page.waitForTimeout(400);
    const after = await card.evaluate((e) => ({ transform: getComputedStyle(e).transform, border: getComputedStyle(e).borderTopColor, shadow: getComputedStyle(e).boxShadow }));
    assert.equal(after.transform, "matrix(1, 0, 0, 1, 0, -4)");
    assert.notEqual(after.border, before.border, "a borda deveria ser destacada");
    assert.notEqual(after.shadow, before.shadow, "a sombra deveria mudar");
  });

  it("grade: cada card tem pelo menos 200px no desktop e a vitrine é salva em tests/artifacts para conferência visual", async (t) => {
    const s = await newSession(t, { seed: seedItems(SHOWCASE) }); if (!s) return;
    await s.goto();
    await s.page.waitForFunction(() => [...document.images].every((img) => img.complete));
    const widths = await s.page.$$eval(".media-card", (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    widths.forEach((w) => assert.ok(w >= 200, `card com ${w}px`));
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    await s.page.screenshot({ path: path.join(ARTIFACTS, "vitrine-desktop.png") });
    await s.page.setViewportSize({ width: 390, height: 844 });
    await s.page.screenshot({ path: path.join(ARTIFACTS, "vitrine-celular.png"), fullPage: true });
  });
});

describe("Seletor de tipos da busca (navegador real)", { timeout: 90000 }, () => {
  const scope = (page, name) => page.locator(`.scope-btn[data-scope="${name}"]`);
  const hits = (s, part) => s.log.calls.filter((c) => c.url.includes(part)).length;
  const badges = (page) => page.$$eval(".category-badge", (els) => [...new Set(els.map((e) => e.textContent))].sort());

  it("três ícones (filme, série, anime) dentro da barra, ligados por padrão e com nome acessível", async (t) => {
    const s = await newSession(t); if (!s) return;
    await s.goto();
    assert.deepEqual(await s.page.$$eval(".search-box .scope-btn", (els) => els.map((e) => [e.dataset.scope, e.getAttribute("aria-pressed"), e.getAttribute("aria-label")])),
      [["movie", "true", "Buscar filmes"], ["series", "true", "Buscar séries"], ["anime", "true", "Buscar animes"]]);
  });

  it("desligar 'filmes' faz a busca não consultar o catálogo de filmes", async (t) => {
    const s = await newSession(t); if (!s) return;
    await s.goto();
    await scope(s.page, "movie").click();
    assert.equal(await scope(s.page, "movie").getAttribute("aria-pressed"), "false");
    await s.search("batman");
    assert.equal(hits(s, "/catalog/movie/"), 0);
    assert.ok(hits(s, "/catalog/series/") >= 1 && hits(s, "graphql.anilist.co") >= 1);
    assert.deepEqual(await badges(s.page), ["Anime", "Série"]);
  });

  it("só animes: nenhuma chamada ao Cinemeta; só filmes: nenhuma ao AniList", async (t) => {
    let s = await newSession(t); if (!s) return;
    await s.goto();
    await scope(s.page, "movie").click(); await scope(s.page, "series").click();
    await s.search("batman");
    assert.equal(hits(s, "cinemeta"), 0);
    assert.deepEqual(await badges(s.page), ["Anime"]);

    s = await newSession(t);
    await s.goto();
    await scope(s.page, "series").click(); await scope(s.page, "anime").click();
    await s.search("batman");
    assert.equal(hits(s, "graphql.anilist.co"), 0);
    assert.equal(hits(s, "/catalog/series/"), 0);
    assert.deepEqual(await badges(s.page), ["Filme"]);
  });

  it("o último tipo ligado não pode ser desligado (aviso amigável)", async (t) => {
    const s = await newSession(t); if (!s) return;
    await s.goto();
    await scope(s.page, "movie").click(); await scope(s.page, "series").click();
    await scope(s.page, "anime").click();
    assert.equal(await scope(s.page, "anime").getAttribute("aria-pressed"), "true");
    assert.match(await s.page.textContent("#toast"), /Mantenha ao menos um tipo selecionado/);
  });

  it("trocar os tipos com resultados na tela refaz a busca automaticamente", async (t) => {
    const s = await newSession(t); if (!s) return;
    await s.goto(); await s.search("batman");
    assert.deepEqual(await badges(s.page), ["Anime", "Filme", "Série"]);
    const before = s.log.calls.length;
    await scope(s.page, "anime").click();
    await s.page.waitForFunction(() => document.querySelectorAll(".media-card").length > 0 && !document.querySelector(".category-badge.category-anime"));
    assert.ok(s.log.calls.length > before, "não refez a busca");
    assert.deepEqual(await badges(s.page), ["Filme", "Série"]);
    assert.equal(await s.page.locator("#pageTitle").textContent(), 'Resultados para: "batman"');
  });

  it("no backlog (sem busca ativa) trocar os tipos não dispara nenhuma requisição", async (t) => {
    const s = await newSession(t, { seed: seedItems([record("imdb:movie:tt0372784", "Batman Begins", "watched")]) }); if (!s) return;
    await s.goto();
    await scope(s.page, "movie").click();
    assert.equal(s.log.calls.length, 0);
    assert.equal(await s.page.locator(".media-card").count(), 1);
  });
});