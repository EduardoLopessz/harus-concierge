"""
Busca RAG (embedding + Qdrant) e montagem do contexto textual pro LLM.

Extraído do main.py: é a única parte do backend com alguma regra de negócio
(relevância mínima, formatação, dedupe) — separada das rotas HTTP pra poder
ser testada sem subir a aplicação FastAPI inteira.

Usado pelo endpoint /rag/buscar (main.py), chamado pelo node "Buscar Contexto"
do workflow N8N do chat antes do AI Agent (ver n8n/chat_assistente.json).
"""

from typing import List

from google import genai
from google.genai import types as genai_types
from qdrant_client import QdrantClient
from tenacity import retry, stop_after_attempt, wait_exponential

COLECAO = "harus_conhecimento"
MODELO_EMBEDDING = "gemini-embedding-001"
DIMENSAO_EMBEDDING = 768

QUANTIDADE_BUSCA = 8      # o catálogo Harus tem muitas coleções pequenas — busca um pouco mais que o padrão FirstLab (5) pra cobrir variações de linha/fragrância
SCORE_MINIMO = 0.60       # calibrar empiricamente depois que a base estiver indexada e houver perguntas reais pra testar


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, max=10))
def gerar_embedding_pergunta(genai_client: "genai.Client", texto: str) -> List[float]:
    resposta = genai_client.models.embed_content(
        model=MODELO_EMBEDDING,
        contents=texto,
        config=genai_types.EmbedContentConfig(
            task_type="retrieval_query",
            output_dimensionality=DIMENSAO_EMBEDDING,
        ),
    )
    return resposta.embeddings[0].values


def buscar_contexto(qdrant: QdrantClient, genai_client: "genai.Client", pergunta: str) -> List[dict]:
    """
    Busca itens do catálogo relevantes na base vetorial, filtra por relevância
    mínima e remove duplicatas (o mesmo item_id não deveria repetir, mas
    protege contra reindexação com dados inconsistentes).
    """
    vetor = gerar_embedding_pergunta(genai_client, pergunta)

    resultados = qdrant.query_points(
        collection_name=COLECAO,
        query=vetor,
        limit=QUANTIDADE_BUSCA,
        with_payload=True,
    ).points

    itens = []
    chaves_ja_incluidas = set()

    for ponto in resultados:
        if ponto.score < SCORE_MINIMO:
            continue

        payload = ponto.payload or {}
        chave = payload.get("item_id") or payload.get("url")
        if chave in chaves_ja_incluidas:
            continue

        chaves_ja_incluidas.add(chave)
        itens.append(payload)

    return itens


def montar_bloco_produto(item: dict, indice: int) -> str:
    volume = item.get("volume") or ""
    linha_txt = f"{item.get('linha', '')} / {item.get('categoria', '')}"

    return (
        f"{indice}. [ITEM DO CATÁLOGO] {item.get('name', '')}\n"
        f"   Linha / Coleção: {linha_txt}\n"
        f"   Sobre a coleção: {item.get('categoria_descricao', '')}\n"
        + (f"   Volume/medida: {volume}\n" if volume else "")
        + f"   Página da coleção (catálogo completo): {item.get('url', '')}\n"
        # Não é pra citar ao cliente — é o token que o Agent deve reusar na
        # linha `ITENS_SUGERIDOS:` (regra 10 do prompt), pra o node "Filtrar
        # Produtos Recomendados" (n8n/chat_assistente.json) casar de volta
        # com o card certo, já que "codigo_pagina" sozinho não é único
        # globalmente (ver docstring de scraper_produtos_harus.py).
        + f"   Código interno (não mostrar ao cliente): {item.get('item_id', '')}"
    )


def extrair_produtos(itens: List[dict]) -> List[dict]:
    """
    Devolve os itens no formato dos cards do widget (ver montarCardsProduto em
    static/widget.js).

    Diferente do FirstLab (produto = página própria), aqui o "link" do card é
    a página da COLEÇÃO (não existe página por item) — é isso que o cliente
    vê no catálogo real da Harus, com o item já visível ali.
    """
    produtos = []
    for item in itens:
        if item.get("tipo") != "produto":
            continue
        imagens = item.get("image_urls") or []
        produtos.append({
            "nome":      item.get("name") or "",
            "categoria": f"{item.get('linha', '')} · {item.get('categoria', '')}".strip(" ·"),
            # item_id (não codigo_pagina) porque é a chave globalmente única —
            # o node "Filtrar Produtos Recomendados" do N8N casa por aqui.
            "codigo":    item.get("item_id") or "",
            "link":      item.get("url") or "",
            "imagem":    imagens[0] if imagens else "",
        })
    return produtos


def montar_contexto(itens: List[dict]) -> str:
    if not itens:
        return "Nenhuma informação relevante foi encontrada na base de conhecimento para esta pergunta."

    blocos = [montar_bloco_produto(item, i) for i, item in enumerate(itens, start=1)]
    return "\n\n".join(blocos)
