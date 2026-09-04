"""
Indexador RAG: lê os JSONs gerados por scraper_produtos_harus.py (data/output/),
gera embeddings via Gemini e indexa tudo no Qdrant, coleção `harus_conhecimento`.

Uso:
    python rag_indexer.py            # indexa produtos
    python rag_indexer.py --recriar  # apaga e recria a coleção do zero

Skip logic: cada ponto no Qdrant guarda o campo "hash" do JSON de origem. Se o
hash não mudou desde a última indexação, o item é pulado (sem gastar chamada
de embedding).

Só existe o scraper de produtos por enquanto (site institucional da Harus não
tem blog/documentos técnicos como o portal FirstLab tinha) — mas a coleção já
guarda um campo "tipo" ("produto") pra caber outra fonte no futuro sem
precisar recriar nada.
"""

import argparse
import glob
import json
import os
import uuid

import truststore

truststore.inject_into_ssl()  # confia na lista de certificados do Windows (necessário em redes corporativas com proxy/inspeção SSL)

from dotenv import load_dotenv
from google import genai
from google.genai import types as genai_types
from qdrant_client import QdrantClient
from qdrant_client.http import models as qmodels
from tenacity import retry, stop_after_attempt, wait_exponential

load_dotenv()

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:6333")
COLECAO = "harus_conhecimento"
MODELO_EMBEDDING = "gemini-embedding-001"
DIMENSAO_EMBEDDING = 768

_cliente_genai: genai.Client | None = None

NAMESPACE_ID = uuid.UUID("7c6a9e0b-3d5f-4e9b-8a2c-5b6d7e8f9a0b")


# ==========================================
# TEXTO PARA EMBEDDING
# ==========================================

def montar_texto_produto(produto: dict) -> str:
    partes = [
        produto.get("name", ""),
        f"Linha: {produto.get('linha', '')}",
        f"Categoria/coleção: {produto.get('categoria', '')}",
        f"Sobre a coleção: {produto.get('categoria_descricao', '')}",
    ]
    if produto.get("volume"):
        partes.append(f"Volume/medida: {produto['volume']}")
    return "\n".join(p for p in partes if p.strip())


# ==========================================
# EMBEDDING (Gemini)
# ==========================================

# Falha transitória de rede não deveria derrubar o restante de uma reindexação
# — 3 tentativas com backoff exponencial (1s, 2s, 4s).
@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, max=10))
def gerar_embedding(texto: str) -> list[float]:
    resposta = _cliente_genai.models.embed_content(
        model=MODELO_EMBEDDING,
        contents=texto,
        config=genai_types.EmbedContentConfig(
            task_type="retrieval_document",
            output_dimensionality=DIMENSAO_EMBEDDING,
        ),
    )
    return resposta.embeddings[0].values


# ==========================================
# LEITURA DOS JSONS GERADOS PELO SCRAPER
# ==========================================

def carregar_produtos() -> list[dict]:
    caminhos = glob.glob(os.path.join("data", "output", "*", "*.json"))
    produtos = []
    for caminho in caminhos:
        with open(caminho, "r", encoding="utf-8") as f:
            produtos.append(json.load(f))
    return produtos


# ==========================================
# QDRANT
# ==========================================

def garantir_colecao(client: QdrantClient, recriar: bool) -> None:
    existe = client.collection_exists(COLECAO)
    if existe and not recriar:
        return
    if existe and recriar:
        client.delete_collection(COLECAO)
    client.create_collection(
        collection_name=COLECAO,
        vectors_config=qmodels.VectorParams(
            size=DIMENSAO_EMBEDDING,
            distance=qmodels.Distance.COSINE,
        ),
    )


def ponto_id(tipo: str, chave: str) -> str:
    return str(uuid.uuid5(NAMESPACE_ID, f"{tipo}:{chave}"))


def hash_existente(client: QdrantClient, point_id: str) -> str | None:
    pontos = client.retrieve(collection_name=COLECAO, ids=[point_id], with_payload=True)
    if pontos:
        return pontos[0].payload.get("hash")
    return None


# ==========================================
# INDEXAÇÃO
# ==========================================

def indexar_produtos(client: QdrantClient, stats: dict) -> None:
    for produto in carregar_produtos():
        chave = produto.get("item_id") or produto.get("url")
        pid = ponto_id("produto", chave)

        if hash_existente(client, pid) == produto.get("hash"):
            stats["produtos_sem_alteracao"] += 1
            continue

        texto = montar_texto_produto(produto)
        vetor = gerar_embedding(texto)

        client.upsert(
            collection_name=COLECAO,
            points=[
                qmodels.PointStruct(
                    id=pid,
                    vector=vetor,
                    payload={"tipo": "produto", **produto},
                )
            ],
        )
        stats["produtos_indexados"] += 1
        print(f"  [produto] {chave} indexado")


# ==========================================
# EXECUÇÃO PRINCIPAL
# ==========================================

def reindexar(produtos: bool = True, recriar: bool = False) -> dict:
    """Reindexa produtos no Qdrant. Usada tanto pela CLI quanto pelo
    orquestrador de scrapers (executar_scrapers.py)."""
    if not GOOGLE_API_KEY:
        raise SystemExit(
            "GOOGLE_API_KEY não configurada. Defina no arquivo .env "
            "(veja .env.example) antes de rodar o indexador."
        )
    global _cliente_genai
    if _cliente_genai is None:
        _cliente_genai = genai.Client(api_key=GOOGLE_API_KEY)

    client = QdrantClient(url=QDRANT_URL)
    garantir_colecao(client, recriar=recriar)

    stats = {
        "produtos_indexados": 0,
        "produtos_sem_alteracao": 0,
    }

    if produtos:
        print("Indexando produtos...")
        indexar_produtos(client, stats)

    print(
        f"\nResumo: {stats['produtos_indexados']} produtos indexados, "
        f"{stats['produtos_sem_alteracao']} sem alteração"
    )
    return stats


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--recriar", action="store_true", help="apaga e recria a coleção antes de indexar")
    args = parser.parse_args()

    reindexar(produtos=True, recriar=args.recriar)


if __name__ == "__main__":
    main()
