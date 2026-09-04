"""
Testes da montagem de contexto (rag.py) — parte de "regra de negócio" isolada
do FastAPI justamente pra poder testar sem precisar de Qdrant/Gemini reais.
"""

from unittest.mock import MagicMock

import rag


def test_montar_bloco_produto_inclui_campos_principais():
    item = {
        "name": "Shampoo 30ml",
        "linha": "Alma Brasil",
        "categoria": "Vegano",
        "categoria_descricao": "Fórmulas veganas, livres de ingrediente animal.",
        "url": "https://harus.ind.br/site/linha-harus/alma-brasil/vegano/",
        "item_id": "site-linha-harus-alma-brasil-vegano__vegano-shampoo-30ml",
    }
    bloco = rag.montar_bloco_produto(item, 1)

    assert "[ITEM DO CATÁLOGO] Shampoo 30ml" in bloco
    assert "Alma Brasil / Vegano" in bloco
    assert "Fórmulas veganas" in bloco
    assert "https://harus.ind.br/site/linha-harus/alma-brasil/vegano/" in bloco
    assert "site-linha-harus-alma-brasil-vegano__vegano-shampoo-30ml" in bloco


def test_montar_bloco_produto_omite_volume_quando_vazio():
    bloco_sem_volume = rag.montar_bloco_produto({"name": "X", "volume": ""}, 1)
    bloco_com_volume = rag.montar_bloco_produto({"name": "X", "volume": "30ml"}, 1)

    assert "Volume/medida" not in bloco_sem_volume
    assert "Volume/medida: 30ml" in bloco_com_volume


def test_extrair_produtos_usa_item_id_como_codigo_nao_codigo_pagina():
    """
    item_id (globalmente único) tem que ser o "codigo" do card, não
    codigo_pagina — vários catálogos da Harus reusam ids genéricos como
    "shampoo-25ml" pra produtos de coleções diferentes (ver docstring de
    scraper_produtos_harus.py). O node "Filtrar Produtos Recomendados" do
    N8N casa por esse campo.
    """
    itens = [
        {
            "tipo": "produto",
            "name": "Shampoo 25ml",
            "linha": "Amenities Harus",
            "categoria": "BPL",
            "item_id": "site-linha-harus-amenities-harus-bpl__shampoo-25ml",
            "codigo_pagina": "shampoo-25ml",
            "url": "https://harus.ind.br/site/linha-harus/amenities-harus/bpl/",
            "image_urls": ["https://exemplo/a.jpg", "https://exemplo/b.jpg"],
        },
        {"tipo": "outra-coisa", "name": "Não deveria aparecer"},
    ]
    produtos = rag.extrair_produtos(itens)

    assert len(produtos) == 1
    assert produtos[0]["codigo"] == "site-linha-harus-amenities-harus-bpl__shampoo-25ml"
    assert produtos[0]["link"] == itens[0]["url"]
    assert produtos[0]["categoria"] == "Amenities Harus · BPL"
    assert produtos[0]["imagem"] == "https://exemplo/a.jpg"


def test_extrair_produtos_tolera_campos_ausentes():
    produtos = rag.extrair_produtos([{"tipo": "produto", "name": "Item sem imagem"}])

    assert produtos == [
        {"nome": "Item sem imagem", "categoria": "", "codigo": "", "link": "", "imagem": ""}
    ]


def test_montar_contexto_sem_itens_retorna_mensagem_padrao():
    assert "Nenhuma informação relevante" in rag.montar_contexto([])


def test_montar_contexto_monta_um_bloco_por_item():
    itens = [
        {"name": "Item A", "item_id": "a"},
        {"name": "Item B", "item_id": "b"},
    ]
    contexto = rag.montar_contexto(itens)

    assert "1. [ITEM DO CATÁLOGO] Item A" in contexto
    assert "2. [ITEM DO CATÁLOGO] Item B" in contexto


def test_buscar_contexto_filtra_por_score_minimo_e_dedup():
    ponto_relevante = MagicMock(score=0.9, payload={"item_id": "a", "tipo": "produto"})
    ponto_pouco_relevante = MagicMock(score=0.1, payload={"item_id": "b", "tipo": "produto"})
    ponto_duplicado = MagicMock(score=0.8, payload={"item_id": "a", "tipo": "produto"})

    qdrant = MagicMock()
    qdrant.query_points.return_value.points = [ponto_relevante, ponto_pouco_relevante, ponto_duplicado]

    genai_client = MagicMock()
    genai_client.models.embed_content.return_value.embeddings = [MagicMock(values=[0.1] * 768)]

    itens = rag.buscar_contexto(qdrant, genai_client, "pergunta qualquer")

    assert len(itens) == 1
    assert itens[0]["item_id"] == "a"
