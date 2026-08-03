// Troque aqui quando for pra produção (ou leia de uma variável de ambiente
// injetada no build, se você adicionar um bundler no futuro).
const API_URL = "http://127.0.0.1:8000/api";

const searchInput = document.getElementById("searchInput");
const mediaGrid = document.getElementById("mediaGrid");
const pageTitle = document.getElementById("pageTitle");
const mediaModal = document.getElementById("mediaModal");
const mediaForm = document.getElementById("mediaForm");
const btnDelete = document.getElementById("btnDelete");

let currentFilter = "all"; // 'all', 'watched', ou 'plan_to_watch'

document.addEventListener("DOMContentLoaded", () => {
  loadMyBacklog();
});

// ---------------------------------------------------------------------
// Busca
// ---------------------------------------------------------------------
searchInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const query = searchInput.value.trim();
    if (query) {
      searchTMDB(query);
    }
  }
});

async function searchTMDB(query) {
  document.querySelectorAll("nav button").forEach((btn) => btn.classList.remove("active"));
  pageTitle.innerText = `Resultados para: "${query}"`;
  mediaGrid.innerHTML = "<p>Buscando no TMDB...</p>";

  try {
    const response = await fetch(`${API_URL}/search?query=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error(`Falha na resposta da API (status ${response.status})`);

    const data = await response.json();
    displaySearchResults(data.results);
  } catch (error) {
    console.error("Erro na busca:", error);
    mediaGrid.innerHTML = "<p style='color: #e91e63;'>Erro ao conectar com o servidor Python.</p>";
  }
}

function displaySearchResults(results) {
  if (!results || results.length === 0) {
    mediaGrid.innerHTML = "<p>Nenhum título encontrado.</p>";
    return;
  }

  mediaGrid.innerHTML = "";
  results.forEach((item) => {
    const poster = item.poster_path || "https://via.placeholder.com/170x255/1f232a/ffffff?text=Sem+Capa";

    const card = document.createElement("div");
    card.className = "media-card";
    card.onclick = () => openModal(item, false); // false = veio da busca, ainda não está salvo

    card.innerHTML = `
      <img src="${poster}" alt="${item.title}">
      <div class="card-info">
        <div class="card-title">${item.title}</div>
        <div class="card-meta">
          <span class="card-status" style="background:#3d4351">TMDB ★ ${item.vote_average ? item.vote_average.toFixed(1) : "N/A"}</span>
        </div>
      </div>
    `;
    mediaGrid.appendChild(card);
  });
}

// ---------------------------------------------------------------------
// Backlog: filtro e listagem
// ---------------------------------------------------------------------
function filterBacklog(filter, element) {
  currentFilter = filter;

  if (element) {
    document.querySelectorAll("nav button").forEach((btn) => btn.classList.remove("active"));
    element.classList.add("active");
  }

  loadMyBacklog();
}

async function loadMyBacklog() {
  if (currentFilter === "all") pageTitle.innerText = "Meu Backlog (Todos)";
  else if (currentFilter === "watched") pageTitle.innerText = "Meu Backlog (Assistidos)";
  else if (currentFilter === "plan_to_watch") pageTitle.innerText = "Meu Backlog (Quero Assistir)";

  mediaGrid.innerHTML = "<p>Carregando seus títulos...</p>";

  try {
    const response = await fetch(`${API_URL}/my-list`);
    if (!response.ok) throw new Error(`Status ${response.status}`);

    const data = await response.json();

    let items = data.backlog;
    if (currentFilter !== "all") {
      items = items.filter((item) => item.status === currentFilter);
    }

    displayBacklogResults(items);
  } catch (error) {
    console.error("Erro ao carregar backlog:", error);
    mediaGrid.innerHTML = "<p style='color: #e91e63;'>Erro ao carregar o banco de dados.</p>";
  }
}

function displayBacklogResults(items) {
  if (!items || items.length === 0) {
    mediaGrid.innerHTML = "<p>Nenhum título encontrado nesta categoria.</p>";
    return;
  }

  mediaGrid.innerHTML = "";
  items.forEach((item) => {
    const poster = item.poster_path || "https://via.placeholder.com/170x255/1f232a/ffffff?text=Sem+Capa";
    const isWatched = item.status === "watched";

    const card = document.createElement("div");
    card.className = "media-card";
    card.onclick = () => openModal(item, true); // true = já está salvo no backlog

    card.innerHTML = `
      <img src="${poster}" alt="${item.title}">
      <div class="card-info">
        <div class="card-title">${item.title}</div>
        <div class="card-meta">
          <span class="card-status ${isWatched ? "status-watched" : "status-plan"}">
            ${isWatched ? "Assistido" : "Quero Assistir"}
          </span>
          ${item.rating ? `<span class="rating">★ ${item.rating.toFixed(1)}</span>` : ""}
        </div>
      </div>
    `;
    mediaGrid.appendChild(card);
  });
}

// ---------------------------------------------------------------------
// Modal (única definição — a duplicada foi removida)
// ---------------------------------------------------------------------
function openModal(item, isSavedInBacklog = false) {
  document.getElementById("modalMediaTitle").innerText = item.title;
  document.getElementById("modalTmdbId").value = item.tmdb_id || item.id;
  document.getElementById("modalMediaType").value = item.type || item.media_type || "movie";
  document.getElementById("modalPosterPath").value = item.poster_path || "";

  const overview = item.overview || "Sem sinopse disponível no momento.";
  document.getElementById("modalOverview").value = overview;
  document.getElementById("modalOverviewText").innerText = overview;

  document.getElementById("modalStatus").value = item.status || "watched";
  document.getElementById("modalRating").value = item.rating || "";
  document.getElementById("modalReview").value = item.review || "";

  btnDelete.style.display = isSavedInBacklog ? "block" : "none";

  mediaModal.style.display = "flex";
}

function closeModal() {
  mediaModal.style.display = "none";
}

// ---------------------------------------------------------------------
// Salvar / Editar (agora envia JSON no corpo, alinhado ao novo backend)
// ---------------------------------------------------------------------
mediaForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const ratingVal = document.getElementById("modalRating").value;

  const payload = {
    tmdb_id: parseInt(document.getElementById("modalTmdbId").value, 10),
    title: document.getElementById("modalMediaTitle").innerText,
    media_type: document.getElementById("modalMediaType").value,
    poster_path: document.getElementById("modalPosterPath").value || null,
    overview: document.getElementById("modalOverview").value || null,
    status: document.getElementById("modalStatus").value,
    rating: ratingVal ? parseFloat(ratingVal) : null,
    review: document.getElementById("modalReview").value || null,
  };

  try {
    const response = await fetch(`${API_URL}/my-list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      closeModal();
      loadMyBacklog();
    } else {
      const errorData = await response.json().catch(() => null);
      alert(`Erro ao salvar o item.${errorData?.detail ? " " + errorData.detail : ""}`);
    }
  } catch (error) {
    console.error("Erro na requisição:", error);
    alert("Não foi possível conectar ao servidor.");
  }
});

// ---------------------------------------------------------------------
// Deletar (agora envia media_type, já que tmdb_id sozinho não é único)
// ---------------------------------------------------------------------
async function deleteMedia() {
  const tmdb_id = parseInt(document.getElementById("modalTmdbId").value, 10);
  const media_type = document.getElementById("modalMediaType").value;
  const title = document.getElementById("modalMediaTitle").innerText;

  if (!confirm(`Tem certeza que deseja remover "${title}" da sua lista?`)) return;

  try {
    const response = await fetch(
      `${API_URL}/my-list/${tmdb_id}?media_type=${encodeURIComponent(media_type)}`,
      { method: "DELETE" }
    );

    if (response.ok) {
      closeModal();
      loadMyBacklog();
    } else {
      alert("Erro ao remover o item.");
    }
  } catch (error) {
    console.error("Erro na remoção:", error);
    alert("Não foi possível conectar ao servidor.");
  }
}
