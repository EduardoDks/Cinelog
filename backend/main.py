import os
import logging
from typing import Optional

import requests
from fastapi import FastAPI, HTTPException, Query, Depends
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from pydantic import BaseModel, Field

from sqlalchemy import (
    create_engine, Column, Integer, String, Float, Text, UniqueConstraint
)
from sqlalchemy.orm import declarative_base, sessionmaker, Session

# --------------------------------------------------------------------------
# Configuração
# --------------------------------------------------------------------------
load_dotenv()
TMDB_TOKEN = os.getenv("TMDB_TOKEN")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("cinelog")

if not TMDB_TOKEN:
    logger.warning(
        "TMDB_TOKEN não encontrado no .env. As buscas no TMDB vão falhar."
    )

REQUEST_TIMEOUT = 10  # segundos

# --------------------------------------------------------------------------
# Banco de Dados
# --------------------------------------------------------------------------
DATABASE_URL = "sqlite:///./cinelog.db"
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class MediaModel(Base):
    __tablename__ = "my_backlog"

    id = Column(Integer, primary_key=True, index=True)
    tmdb_id = Column(Integer, nullable=False, index=True)
    title = Column(String, nullable=False)
    media_type = Column(String, nullable=False)  # "movie" ou "tv"
    poster_path = Column(String, nullable=True)
    overview = Column(Text, nullable=True)
    status = Column(String, nullable=False)  # "watched" ou "plan_to_watch"
    rating = Column(Float, nullable=True)
    review = Column(Text, nullable=True)

    # Um filme e uma série podem compartilhar o mesmo tmdb_id no TMDB,
    # então a unicidade precisa considerar os dois campos juntos.
    __table_args__ = (
        UniqueConstraint("tmdb_id", "media_type", name="uq_tmdb_media_type"),
    )


Base.metadata.create_all(bind=engine)

app = FastAPI(title="CineLog API")

# Em produção, troque "*" pela URL real do seu front-end.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


HEADERS = {
    "Authorization": f"Bearer {TMDB_TOKEN}",
    "accept": "application/json",
}


# --------------------------------------------------------------------------
# Schemas (Pydantic) — validação de entrada
# --------------------------------------------------------------------------
class MediaCreate(BaseModel):
    tmdb_id: int
    title: str
    media_type: str = Field(pattern="^(movie|tv)$")
    status: str = Field(pattern="^(watched|plan_to_watch)$")
    poster_path: Optional[str] = None
    overview: Optional[str] = None
    rating: Optional[float] = Field(default=None, ge=0, le=5)
    review: Optional[str] = None


# --------------------------------------------------------------------------
# Rotas
# --------------------------------------------------------------------------
@app.get("/")
def home():
    return {"message": "API do CineLog está rodando com sucesso!"}


@app.get("/api/search")
def search_media(query: str = Query(..., min_length=1)):
    """Busca filmes e séries no TMDB."""
    url = "https://api.themoviedb.org/3/search/multi"
    params = {
        "query": query,
        "include_adult": "false",
        "language": "pt-BR",
        "page": 1,
    }

    try:
        response = requests.get(
            url, headers=HEADERS, params=params, timeout=REQUEST_TIMEOUT
        )
        response.raise_for_status()
    except requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="TMDB demorou demais para responder.")
    except requests.exceptions.RequestException as exc:
        logger.error("Erro ao chamar o TMDB: %s", exc)
        raise HTTPException(status_code=502, detail="Erro ao comunicar com o TMDB.")

    data = response.json()
    results = []

    for item in data.get("results", []):
        media_type = item.get("media_type")
        if media_type not in ("movie", "tv"):
            continue

        raw_poster = item.get("poster_path")
        poster_url = (
            f"https://image.tmdb.org/t/p/w500{raw_poster}" if raw_poster else None
        )

        results.append({
            "tmdb_id": item.get("id"),
            "title": item.get("title") or item.get("name"),
            "type": media_type,
            "release_date": item.get("release_date") or item.get("first_air_date"),
            "overview": item.get("overview"),
            "poster_path": poster_url,
            "vote_average": item.get("vote_average"),
        })

    return {"results": results}


@app.post("/api/my-list")
def save_to_backlog(payload: MediaCreate, db: Session = Depends(get_db)):
    """Cria ou atualiza um item no backlog (upsert por tmdb_id + media_type)."""
    existing_item = (
        db.query(MediaModel)
        .filter(
            MediaModel.tmdb_id == payload.tmdb_id,
            MediaModel.media_type == payload.media_type,
        )
        .first()
    )

    if existing_item:
        existing_item.status = payload.status
        existing_item.rating = payload.rating
        existing_item.review = payload.review
        if payload.poster_path:
            existing_item.poster_path = payload.poster_path
        if payload.overview:
            existing_item.overview = payload.overview
        db.commit()
        db.refresh(existing_item)
        return {"message": "Item atualizado com sucesso!", "data": existing_item}

    new_item = MediaModel(
        tmdb_id=payload.tmdb_id,
        title=payload.title,
        media_type=payload.media_type,
        poster_path=payload.poster_path,
        overview=payload.overview,
        status=payload.status,
        rating=payload.rating,
        review=payload.review,
    )
    db.add(new_item)
    db.commit()
    db.refresh(new_item)
    return {"message": "Item salvo no backlog!", "data": new_item}


@app.get("/api/my-list")
def get_my_backlog(db: Session = Depends(get_db)):
    items = db.query(MediaModel).all()
    return {"backlog": items}


@app.delete("/api/my-list/{tmdb_id}")
def delete_from_backlog(
    tmdb_id: int,
    media_type: str = Query(..., pattern="^(movie|tv)$"),
    db: Session = Depends(get_db),
):
    """
    Remove um item do backlog.
    media_type é obrigatório porque tmdb_id sozinho não é mais único
    (filme e série podem compartilhar o mesmo id no TMDB).
    """
    item = (
        db.query(MediaModel)
        .filter(MediaModel.tmdb_id == tmdb_id, MediaModel.media_type == media_type)
        .first()
    )

    if not item:
        raise HTTPException(status_code=404, detail="Item não encontrado no backlog.")

    db.delete(item)
    db.commit()
    return {"message": "Item removido com sucesso!"}
