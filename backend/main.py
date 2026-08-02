import os
import requests
from typing import Optional
from fastapi import FastAPI, HTTPException, Query, Depends
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

from sqlalchemy import create_engine, Column, Integer, String, Float, Text
from sqlalchemy.orm import declarative_base, sessionmaker, Session

load_dotenv()
TMDB_TOKEN = os.getenv("TMDB_TOKEN")

# Banco de Dados
DATABASE_URL = "sqlite:///./cinelog.db"
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class MediaModel(Base):
    __tablename__ = "my_backlog"

    id = Column(Integer, primary_key=True, index=True)
    tmdb_id = Column(Integer, unique=True, nullable=False)
    title = Column(String, nullable=False)
    media_type = Column(String, nullable=False)
    poster_path = Column(String, nullable=True)
    overview = Column(Text, nullable=True)
    status = Column(String, nullable=False)
    rating = Column(Float, nullable=True)
    review = Column(Text, nullable=True)

Base.metadata.create_all(bind=engine)

app = FastAPI(title="CineLog API")

# Habilita CORS total para requisições de arquivos HTML locais
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
    "accept": "application/json"
}

@app.get("/")
def home():
    return {"message": "API do CineLog está rodando com sucesso!"}

# 1. Rota de Busca no TMDB
# 1. Rota de Busca no TMDB
@app.get("/api/search")
def search_media(query: str = Query(..., min_length=1)):
    url = f"https://api.themoviedb.org/3/search/multi?query={query}&include_adult=false&language=pt-BR&page=1"
    response = requests.get(url, headers=HEADERS)
    
    if response.status_code != 200:
        raise HTTPException(status_code=response.status_code, detail="Erro ao comunicar com o TMDB")
    
    data = response.json()
    results = []
    
    for item in data.get("results", []):
        media_type = item.get("media_type")
        if media_type in ["movie", "tv"]:
            raw_poster = item.get("poster_path")
            
            # --- CORREÇÃO DA URL DO POSTER ---
            if raw_poster:
                # Garante a formação correta da URL da imagem
                poster_url = f"https://image.tmdb.org/t/p/w500{raw_poster}"
            else:
                poster_url = None
                
            results.append({
                "tmdb_id": item.get("id"),
                "title": item.get("title") or item.get("name"),
                "type": media_type,
                "release_date": item.get("release_date") or item.get("first_air_date"),
                "overview": item.get("overview"),
                "poster_path": poster_url,
                "vote_average": item.get("vote_average")
            })
            
    return {"results": results}

# 2. Rota para Salvar no Backlog (Com Overview)
@app.post("/api/my-list")
def save_to_backlog(
    tmdb_id: int,
    title: str,
    media_type: str,
    status: str,
    poster_path: Optional[str] = None,
    overview: Optional[str] = None, # <--- PARÂMETRO NOVO
    rating: Optional[float] = None,
    review: Optional[str] = None,
    db: Session = Depends(get_db)
):
    existing_item = db.query(MediaModel).filter(MediaModel.tmdb_id == tmdb_id).first()
    
    if existing_item:
        existing_item.status = status
        existing_item.rating = rating
        existing_item.review = review
        if poster_path: existing_item.poster_path = poster_path
        if overview: existing_item.overview = overview
        db.commit()
        return {"message": "Item atualizado com sucesso!", "data": existing_item}
    else:
        new_item = MediaModel(
            tmdb_id=tmdb_id,
            title=title,
            media_type=media_type,
            poster_path=poster_path,
            overview=overview, # <--- SALVA A SINOPSE
            status=status,
            rating=rating,
            review=review
        )
        db.add(new_item)
        db.commit()
        db.refresh(new_item)
        return {"message": "Item salvo no backlog!", "data": new_item}

# 3. Rota para Listar
@app.get("/api/my-list")
def get_my_backlog(db: Session = Depends(get_db)):
    items = db.query(MediaModel).all()
    return {"backlog": items}

# 4. Rota para Deletar um item do Backlog pelo TMDB ID
@app.delete("/api/my-list/{tmdb_id}")
def delete_from_backlog(tmdb_id: int, db: Session = Depends(get_db)):
    item = db.query(MediaModel).filter(MediaModel.tmdb_id == tmdb_id).first()
    
    if not item:
        raise HTTPException(status_code=404, detail="Item não encontrado no backlog.")
    
    db.delete(item)
    db.commit()
    return {"message": "Item removido com sucesso!"}