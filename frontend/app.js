/**
 * Interface do CineLog.
 * Tudo que vem de fora (títulos, sinopses) é inserido com textContent, nunca
 * com innerHTML — não há como injetar HTML/script por dados de API ou de backup.
 */
(() => {
  "use strict";

  const POSTER_PLACEHOLDER =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="170" height="255">' +
        '<rect width="170" height="255" fill="#1f232a"/>' +
        '<text x="50%" y="50%" fill="#5a6070" font-family="sans-serif" font-size="14" ' +
        'text-anchor="middle" dy=".3em">Sem Capa</text></svg>'
    );

  const CATEGORY_LABELS = { filme: "Filme", serie: "Série", anime: "Anime" };
  const CATEGORY_FILTER_LABELS = { all: "Todos", filme: "Filmes", serie: "Séries", anime: "Animes" };
  const STATUS_LABELS = { all: "Todos", watched: "Assistidos", plan_to_watch: "Quero Assistir" };
  const SOURCE_LABELS = { imdb: "IMDb", anilist: "AniList", tmdb: "TMDB", jikan: "MyAnimeList" };

  const $ = (id) => document.getElementById(id);
  const els = {
    logo: $("logoLink"),
    searchForm: $("searchForm"),
    searchInput: $("searchInput"),
    pageTitle: $("pageTitle"),
    btnBack: $("btnBack"),
    notice: $("notice"),
    storageWarning: $("storageWarning"),
    filters: $("filters"),
    grid: $("mediaGrid"),
    modal: $("mediaModal"),
    modalTitle: $("modalTitle"),
    modalPoster: $("modalPoster"),
    modalMeta: $("modalMeta"),
    modalOverview: $("modalOverview"),
    form: $("mediaForm"),
    modalStatus: $("modalStatus"),
    modalRating: $("modalRating"),
    modalReview: $("modalReview"),
    btnSubmit: $("btnSubmit"),
    btnDelete: $("btnDelete"),
    btnCloseModal: $("btnCloseModal"),
    btnExport: $("btnExport"),
    btnImport: $("btnImport"),
    importFile: $("importFile"),
    toast: $("toast"),
  };

  const state = {
    view: "backlog", // "backlog" | "search"
    status: "all",
    category: "all",
    scopes: new Set(["movie", "series", "anime"]), // tipos incluídos na busca
    lastQuery: "", // última busca feita (para refazer ao trocar os tipos)
    searchSeq: 0, // descarta respostas de buscas antigas
    searchCards: new Map(), // id -> elemento do card na tela de busca
    modalBase: null, // item exibido no modal
  };

  // ------------------------------------------------------------------
  // Utilitários de DOM
  // ------------------------------------------------------------------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function safePoster(url) {
    return typeof url === "string" && url.startsWith("https://") ? url : POSTER_PLACEHOLDER;
  }

  function attachPoster(img, url) {
    img.src = safePoster(url);
    img.referrerPolicy = "no-referrer";
    img.addEventListener(
      "error",
      () => {
        img.src = POSTER_PLACEHOLDER;
      },
      { once: true }
    );
  }

  /** Título da página: parte principal em destaque + complemento em cinza (o texto total é o mesmo). */
  function setTitle(main, sub) {
    const nodes = [el("span", "title-main", main)];
    if (sub) nodes.push(el("span", "title-sub", sub));
    els.pageTitle.replaceChildren(...nodes);
  }

  let toastTimer = null;
  function toast(message, type = "info") {
    els.toast.textContent = message;
    els.toast.className = `toast toast-${type}`;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 3500);
  }

  function showNotice(messages) {
    els.notice.replaceChildren();
    if (!messages || messages.length === 0) {
      els.notice.hidden = true;
      return;
    }
    messages.forEach((text) => els.notice.appendChild(el("p", null, text)));
    els.notice.hidden = false;
  }

  function showGridMessage(text, className) {
    els.grid.replaceChildren(el("p", className || "grid-message", text));
  }

  // ------------------------------------------------------------------
  // Cards
  // ------------------------------------------------------------------
  function buildCard(item, saved) {
    const card = el("article", "media-card");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Abrir detalhes de ${item.title}`);

    const img = el("img");
    img.alt = "";
    img.loading = "lazy";
    attachPoster(img, item.poster_path);

    const info = el("div", "card-info");
    info.appendChild(el("div", "card-title", item.title));

    const meta = el("div", "card-meta");
    if (saved) {
      const watched = item.status === "watched";
      meta.appendChild(
        el("span", `card-status ${watched ? "status-watched" : "status-plan"}`, watched ? "Assistido" : "Quero Assistir")
      );
      if (item.rating) meta.appendChild(el("span", "rating", `★ ${Number(item.rating).toFixed(1)}`));
    } else if (item.score) {
      meta.appendChild(el("span", "card-status status-score", `★ ${item.score.toFixed(1)}`));
    }
    info.appendChild(meta);

    const tags = el("div", "card-tags");
    tags.appendChild(el("span", `category-badge category-${item.category}`, CATEGORY_LABELS[item.category] || ""));
    if (item.year) tags.appendChild(el("span", "card-year", String(item.year)));
    info.appendChild(tags);

    // Anotação rápida do usuário (só em itens salvos que tenham comentário).
    if (saved && item.review) info.appendChild(el("div", "card-note", item.review));

    // Ação rápida: adicionar direto da busca, sem abrir o modal.
    if (!saved && state.view === "search") {
      const actions = el("div", "quick-actions");
      [
        ["watched", "✓ Assistido"],
        ["plan_to_watch", "+ Quero ver"],
      ].forEach(([status, label]) => {
        const button = el("button", "btn-quick", label);
        button.type = "button";
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          quickAdd(item, status, card);
        });
        actions.appendChild(button);
      });
      info.appendChild(actions);
    }

    card.append(img, info);
    card.addEventListener("click", () => openModal(item));
    card.addEventListener("keydown", (event) => {
      if (event.target === card && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        openModal(item);
      }
    });
    return card;
  }

  function quickAdd(item, status, card) {
    const saved = storageService.addMedia({ ...item, status });
    if (!saved) {
      toast("Não foi possível salvar. O armazenamento do navegador pode estar cheio ou bloqueado.", "error");
      return;
    }
    toast(`"${saved.title}" adicionado em ${STATUS_LABELS[status]}.`, "success");
    const fresh = buildCard(saved, true);
    card.replaceWith(fresh);
    state.searchCards.set(saved.id, fresh);
  }

  // ------------------------------------------------------------------
  // Backlog
  // ------------------------------------------------------------------
  function applyFilterButtons() {
    document.querySelectorAll(".filter-group button").forEach((button) => {
      const active = state[button.dataset.group] === button.dataset.value;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function renderBacklog() {
    state.view = "backlog";
    state.searchCards.clear();
    els.filters.hidden = false;
    els.btnBack.hidden = true;
    showNotice(null);

    const all = storageService.getBacklog();
    const items = all.filter(
      (item) =>
        (state.status === "all" || item.status === state.status) &&
        (state.category === "all" || item.category === state.category)
    );

    setTitle(
      "Meu Backlog",
      ` — ${STATUS_LABELS[state.status]} / ${CATEGORY_FILTER_LABELS[state.category]} (${items.length})`
    );

    if (items.length === 0) {
      showGridMessage(
        all.length === 0
          ? "Seu backlog está vazio. Use a busca acima para adicionar filmes, séries e animes."
          : "Nenhum título encontrado com esses filtros."
      );
      return;
    }

    const fragment = document.createDocumentFragment();
    items.forEach((item) => fragment.appendChild(buildCard(item, true)));
    els.grid.replaceChildren(fragment);
  }

  function goHome() {
    state.searchSeq += 1; // cancela qualquer busca em andamento
    state.lastQuery = "";
    els.searchInput.value = "";
    renderBacklog();
  }

  // ------------------------------------------------------------------
  // Busca
  // ------------------------------------------------------------------
  function describeSearchError(kind, error) {
    const label = kind === "movies" ? "filmes e séries" : "animes";
    if (error && error.partial) {
      return "Parte dos resultados de filmes e séries não pôde ser carregada. Tente buscar de novo.";
    }
    if (error && error.status === 429) {
      return `Muitas buscas em pouco tempo (${label}). Aguarde um instante e tente de novo.`;
    }
    if (error && error.name === "AbortError") {
      return `A busca de ${label} demorou demais para responder.`;
    }
    return `Não foi possível buscar ${label} agora. Verifique sua conexão e tente de novo.`;
  }

  async function runSearch(query) {
    const seq = ++state.searchSeq;
    state.lastQuery = query;
    state.view = "search";
    state.searchCards.clear();
    els.filters.hidden = true;
    els.btnBack.hidden = false;
    setTitle(`Resultados para: "${query}"`);
    showNotice(null);
    showGridMessage("Buscando...");

    const { items, errors } = await searchService.search(query, { scopes: [...state.scopes] });
    if (seq !== state.searchSeq) return; // uma busca mais nova assumiu a tela

    // Ajuda a diagnosticar (ex.: bloqueio de CORS) sem expor nada na tela.
    if (errors.movies) console.warn("Busca de filmes/séries falhou:", errors.movies);
    if (errors.anime) console.warn("Busca de animes falhou:", errors.anime);

    const notes = [];
    if (errors.movies) notes.push(describeSearchError("movies", errors.movies));
    if (errors.anime) notes.push(describeSearchError("anime", errors.anime));
    showNotice(notes);

    if (items.length === 0) {
      showGridMessage(
        errors.movies && errors.anime ? "Não foi possível concluir a busca." : "Nenhum título encontrado.",
        errors.movies && errors.anime ? "msg-error" : "grid-message"
      );
      return;
    }

    // Uma única leitura do armazenamento para toda a lista (não uma por card).
    const savedById = new Map(storageService.getBacklog().map((entry) => [entry.id, entry]));
    const fragment = document.createDocumentFragment();
    items.forEach((item) => {
      const saved = savedById.get(item.id);
      const card = buildCard(saved || item, Boolean(saved));
      state.searchCards.set(item.id, card);
      fragment.appendChild(card);
    });
    els.grid.replaceChildren(fragment);
  }

  // ------------------------------------------------------------------
  // Modal de detalhes
  // ------------------------------------------------------------------
  function renderModalInfo(data) {
    const meta = [CATEGORY_LABELS[data.category], data.year];
    if (data.score) meta.push(`★ ${data.score.toFixed(1)} (${SOURCE_LABELS[data.source] || data.source})`);
    els.modalMeta.textContent = meta.filter(Boolean).join(" · ");
    els.modalOverview.textContent = data.overview || "Sem sinopse disponível.";
  }

  // Resultados do IMDb vêm sem sinopse/nota: busca os detalhes ao abrir o card.
  function loadMissingDetails(data) {
    if (data.source !== "imdb" || (data.overview && data.score)) return;
    if (!data.overview) els.modalOverview.textContent = "Carregando sinopse...";

    const stillOpen = () => els.modal.open && state.modalBase && state.modalBase.id === data.id;

    searchService
      .getDetails(data)
      .then((details) => {
        if (!stillOpen()) return;
        if (details) {
          state.modalBase = {
            ...state.modalBase,
            overview: state.modalBase.overview || details.overview,
            score: state.modalBase.score || details.score,
            year: state.modalBase.year || details.year,
          };
        }
        renderModalInfo(state.modalBase);
      })
      .catch(() => {
        if (stillOpen()) renderModalInfo(state.modalBase); // sem sinopse, mas o card continua usável
      });
  }

  function openModal(item) {
    const saved = storageService.getMedia(item.id);
    const data = saved || item;
    state.modalBase = data;

    els.modalTitle.textContent = data.title;
    attachPoster(els.modalPoster, data.poster_path);
    renderModalInfo(data);

    els.modalStatus.value = saved ? saved.status : "watched";
    els.modalRating.value = saved && saved.rating ? saved.rating : "";
    els.modalReview.value = saved && saved.review ? saved.review : "";

    els.btnSubmit.textContent = saved ? "Salvar alterações" : "Adicionar ao backlog";
    els.btnDelete.hidden = !saved;

    document.body.classList.add("modal-open");
    els.modal.showModal();
    loadMissingDetails(data);
  }

  function closeModal() {
    if (els.modal.open) els.modal.close();
  }

  // Atualiza a tela depois de salvar/remover.
  function afterChange(id, record, fallbackItem) {
    if (state.view === "backlog") {
      renderBacklog();
      return;
    }
    const old = state.searchCards.get(id);
    if (!old) return;
    const fresh = buildCard(record || fallbackItem, Boolean(record));
    old.replaceWith(fresh);
    state.searchCards.set(id, fresh);
  }

  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    const base = state.modalBase;
    if (!base) return;

    const rating = els.modalRating.value === "" ? null : Number(els.modalRating.value);
    const fields = {
      status: els.modalStatus.value,
      rating,
      review: els.modalReview.value.trim() || null,
    };

    const exists = storageService.getMedia(base.id);
    const saved = exists
      ? storageService.updateMedia(base.id, fields)
      : storageService.addMedia({ ...base, ...fields });

    if (!saved) {
      toast("Não foi possível salvar. O armazenamento do navegador pode estar cheio ou bloqueado.", "error");
      return;
    }

    closeModal();
    toast(exists ? "Alterações salvas." : `"${saved.title}" adicionado ao backlog.`, "success");
    afterChange(saved.id, saved, base);
  });

  els.btnDelete.addEventListener("click", () => {
    const base = state.modalBase;
    if (!base) return;
    if (!window.confirm(`Tem certeza que deseja remover "${base.title}" da sua lista?`)) return;

    if (storageService.removeMedia(base.id)) {
      closeModal();
      toast("Item removido.", "success");
      afterChange(base.id, null, base);
    } else {
      toast("Não foi possível remover o item.", "error");
    }
  });

  els.btnCloseModal.addEventListener("click", closeModal);
  // Clique no fundo escurecido (o próprio <dialog>) fecha o modal.
  els.modal.addEventListener("click", (event) => {
    if (event.target === els.modal) closeModal();
  });
  els.modal.addEventListener("close", () => {
    document.body.classList.remove("modal-open");
  });

  // ------------------------------------------------------------------
  // Eventos gerais
  // ------------------------------------------------------------------
  els.logo.addEventListener("click", (event) => {
    event.preventDefault();
    goHome();
  });
  els.btnBack.addEventListener("click", goHome);

  els.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = els.searchInput.value.trim();
    if (query) runSearch(query);
    else if (state.view === "search") goHome();
  });

  // Tipos incluídos na busca: pelo menos um fica sempre ligado.
  const scopeButtons = document.querySelectorAll(".scope-btn");
  function applyScopeButtons() {
    scopeButtons.forEach((button) => {
      const active = state.scopes.has(button.dataset.scope);
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }
  scopeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const scope = button.dataset.scope;
      if (state.scopes.has(scope)) {
        if (state.scopes.size === 1) {
          toast("Mantenha ao menos um tipo selecionado na busca.");
          return;
        }
        state.scopes.delete(scope);
      } else {
        state.scopes.add(scope);
      }
      applyScopeButtons();
      if (state.view === "search" && state.lastQuery) runSearch(state.lastQuery); // refaz com os novos tipos
    });
  });

  document.querySelectorAll(".filter-group button").forEach((button) => {
    button.addEventListener("click", () => {
      state[button.dataset.group] = button.dataset.value;
      storageService.savePrefs({ status: state.status, category: state.category });
      applyFilterButtons();
      renderBacklog();
    });
  });

  // Alteração feita em outra aba do mesmo navegador: mantém esta aba atualizada.
  window.addEventListener("storage", (event) => {
    if (event.key && event.key.startsWith("cinelog:v2:") && state.view === "backlog") renderBacklog();
  });

  // ------------------------------------------------------------------
  // Backup
  // ------------------------------------------------------------------
  els.btnExport.addEventListener("click", () => {
    const blob = new Blob([storageService.exportData()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `cinelog-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Adiado: revogar na hora pode cancelar o download em alguns navegadores.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  els.btnImport.addEventListener("click", () => els.importFile.click());

  els.importFile.addEventListener("change", async () => {
    const file = els.importFile.files[0];
    els.importFile.value = "";
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      toast("Arquivo grande demais para ser um backup do CineLog.", "error");
      return;
    }

    try {
      const { imported, skipped } = storageService.importData(await file.text());
      toast(`Backup importado: ${imported} adicionado(s)/atualizado(s), ${skipped} ignorado(s).`, "success");
      if (state.view === "backlog") renderBacklog();
    } catch (error) {
      toast(error.message, "error");
    }
  });

  // ------------------------------------------------------------------
  // Inicialização
  // ------------------------------------------------------------------
  const prefs = storageService.getPrefs();
  state.status = prefs.status;
  state.category = prefs.category;
  applyFilterButtons();
  applyScopeButtons();

  if (!storageService.isAvailable()) els.storageWarning.hidden = false;

  renderBacklog();
  storageService.requestPersistence();
})();