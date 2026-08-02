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

// Evento de busca
searchInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const query = searchInput.value.trim();
    if (query) {
      searchTMDB(query);
    }
  }
});

// Busca no TMDB
async function searchTMDB(query) {
  // Desmarca os botões de filtro na busca
  document.querySelectorAll("nav button").forEach(btn => btn.classList.remove("active"));
  pageTitle.innerText = `Resultados para: "${query}"`;
  mediaGrid.innerHTML = "<p>Buscando no TMDB...</p>";

  try {
    const response = await fetch(`${API_URL}/search?query=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error("Falha na resposta da API");
    
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
    card.onclick = () => openModal(item, false); // false = veio da busca

    card.innerHTML = `
      <img src="${poster}" alt="${item.title}">
      <div class="card-info">
        <div class="card-title">${item.title}</div>
        <div class="card-meta">
          <span class="card-status" style="background:#3d4351">TMDB ★ ${item.vote_average ? item.vote_average.toFixed(1) : 'N/A'}</span>
        </div>
      </div>
    `;
    mediaGrid.appendChild(card);
  });
}

// Filtra o Backlog
function filterBacklog(filter, element) {
  currentFilter = filter;
  
  if (element) {
    document.querySelectorAll("nav button").forEach(btn => btn.classList.remove("active"));
    element.classList.add("active");
  }

  loadMyBacklog();
}

// Carrega itens salvos com base no filtro
async function loadMyBacklog() {
  if (currentFilter === "all") pageTitle.innerText = "Meu Backlog (Todos)";
  else if (currentFilter === "watched") pageTitle.innerText = "Meu Backlog (Assistidos)";
  else if (currentFilter === "plan_to_watch") pageTitle.innerText = "Meu Backlog (Quero Assistir)";

  mediaGrid.innerHTML = "<p>Carregando seus títulos...</p>";

  try {
    const response = await fetch(`${API_URL}/my-list`);
    const data = await response.json();
    
    let items = data.backlog;
    if (currentFilter !== "all") {
      items = items.filter(item => item.status === currentFilter);
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
          <span class="card-status ${isWatched ? 'status-watched' : 'status-plan'}">
            ${isWatched ? 'Assistido' : 'Quero Assistir'}
          </span>
          ${item.rating ? `<span class="rating">★ ${item.rating.toFixed(1)}</span>` : ''}
        </div>
      </div>
    `;
    mediaGrid.appendChild(card);
  });
}

// Abrir Modal
function openModal(item, isSavedInBacklog = false) {
  document.getElementById("modalMediaTitle").innerText = item.title;
  document.getElementById("modalTmdbId").value = item.tmdb_id || item.id;
  document.getElementById("modalMediaType").value = item.type || item.media_type || "movie";
  document.getElementById("modalPosterPath").value = item.poster_path || "";
  
  document.getElementById("modalStatus").value = item.status || "watched";
  document.getElementById("modalRating").value = item.rating || "";
  document.getElementById("modalReview").value = item.review || "";

  // Exibe o botão de Deletar apenas se o item já estiver no backlog
  if (isSavedInBacklog) {
    btnDelete.style.display = "block";
  } else {
    btnDelete.style.display = "none";
  }

  mediaModal.style.display = "flex";
}

function closeModal() {
  mediaModal.style.display = "none";
}

// Salvar / Editar
mediaForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const tmdb_id = parseInt(document.getElementById("modalTmdbId").value);
  const title = document.getElementById("modalMediaTitle").innerText;
  const media_type = document.getElementById("modalMediaType").value;
  const poster_path = document.getElementById("modalPosterPath").value;
  const overview = document.getElementById("modalOverview").value; // <--- NOVO
  const status = document.getElementById("modalStatus").value;
  const ratingVal = document.getElementById("modalRating").value;
  const rating = ratingVal ? parseFloat(ratingVal) : null;
  const review = document.getElementById("modalReview").value;

  const params = new URLSearchParams({
    tmdb_id: tmdb_id,
    title: title,
    media_type: media_type,
    status: status
  });

  if (poster_path) params.append("poster_path", poster_path);
  if (overview) params.append("overview", overview); // <--- ENVIA A SINOPSE
  if (rating) params.append("rating", rating);
  if (review) params.append("review", review);

  try {
    const response = await fetch(`${API_URL}/my-list?${params.toString()}`, {
      method: "POST"
    });

    if (response.ok) {
      closeModal();
      loadMyBacklog();
    } else {
      alert("Erro ao salvar o item.");
    }
  } catch (error) {
    console.error("Erro na requisição:", error);
  }
});

// Deletar Mídia
async function deleteMedia() {
  const tmdb_id = parseInt(document.getElementById("modalTmdbId").value);
  const title = document.getElementById("modalMediaTitle").innerText;

  if (confirm(`Tem certeza que deseja remover "${title}" da sua lista?`)) {
    try {
      const response = await fetch(`${API_URL}/my-list/${tmdb_id}`, {
        method: "DELETE"
      });

      if (response.ok) {
        closeModal();
        loadMyBacklog();
      } else {
        alert("Erro ao remover o item.");
      }
    } catch (error) {
      console.error("Erro na remoção:", error);
    }
  }
}

// 5. Modal
function openModal(item, isSavedInBacklog = false) {
  document.getElementById("modalMediaTitle").innerText = item.title;
  document.getElementById("modalTmdbId").value = item.tmdb_id || item.id;
  document.getElementById("modalMediaType").value = item.type || item.media_type || "movie";
  document.getElementById("modalPosterPath").value = item.poster_path || "";
  
  // PREENCHE A SINOPSE
  const overview = item.overview || "Sem sinopse disponível no momento.";
  document.getElementById("modalOverview").value = overview;
  document.getElementById("modalOverviewText").innerText = overview;

  document.getElementById("modalStatus").value = item.status || "watched";
  document.getElementById("modalRating").value = item.rating || "";
  document.getElementById("modalReview").value = item.review || "";

  if (isSavedInBacklog) {
    btnDelete.style.display = "block";
  } else {
    btnDelete.style.display = "none";
  }

  mediaModal.style.display = "flex";
}