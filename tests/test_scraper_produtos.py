"""
Testes das funções de extração do scraper_produtos_harus.py — a parte mais
frágil (regex sobre HTML/JS embutido no site da Harus, sem API oficial).
Não fazem requisição de rede: usam trechos de HTML fixos e, quando preciso
simular o crawl, mockam buscar_html.
"""

from unittest.mock import patch

import scraper_produtos_harus as scraper

HTML_FOLHA = """
<html><head>
<meta name="description" content="Fórmulas veganas, sem ingrediente animal.">
</head><body>
<script>
window.CATALOG = {
  'vegano': { name: 'Vegano', products: [
    { id: 'vegano-shampoo-30ml', name: 'Shampoo 30ml', img: '../../../assets/produtos/alma-brasil/vegano/vegano-shampoo-30ml.jpg' },
    { id: 'vegano-sabao', name: 'Sabão d\\'Aleppo 20g', img: '../assets/sabao.jpg' }
  ] }
};
</script>
</body></html>
"""

HTML_HUB = """
<html><body>
<a class="hub-card" href="vegano/">Vegano</a>
<a class="hub-card" href="spa/">Spa</a>
</body></html>
"""

HTML_HOUSE_OF_BRANDS_INDEX = """
<html><body>
<a class="marquee-item" href="/site/house-of-brands/costa-brazil/">Costa Brazil</a>
<a class="marquee-item" href="/site/house-of-brands/natura/">Natura</a>
<a class="marquee-item" href="/site/house-of-brands/costa-brazil/">Costa Brazil (repetido no carrossel)</a>
</body></html>
"""

HTML_PERSONALIZADOS = """
<html><head>
<meta name="description" content="Frascos e embalagens personalizáveis com a marca do seu hotel.">
</head><body>
<script>
    const products = [
      { name: 'Frasco Oval Cristal', vol: '30ml', img: '../assets/personalizados/frasco-oval-30ml-cristal.png' },
      { name: 'Beatle Biodegradável', vol: '25ml', img: '../assets/personalizados/Beatle.jpg' }
    ];
</script>
</body></html>
"""


def test_extrair_catalog_js_retorna_categoria_e_itens():
    categoria, itens = scraper.extrair_catalog_js(HTML_FOLHA)

    assert categoria == "Vegano"
    assert len(itens) == 2
    assert itens[0] == {
        "id": "vegano-shampoo-30ml",
        "name": "Shampoo 30ml",
        "img": "../../../assets/produtos/alma-brasil/vegano/vegano-shampoo-30ml.jpg",
    }
    # aspas escapadas (\') dentro do nome do item precisam ser decodificadas
    assert itens[1]["name"] == "Sabão d'Aleppo 20g"


def test_extrair_catalog_js_retorna_none_quando_nao_ha_catalog():
    assert scraper.extrair_catalog_js(HTML_HUB) is None


def test_extrair_meta_description():
    assert scraper.extrair_meta_description(HTML_FOLHA) == "Fórmulas veganas, sem ingrediente animal."
    assert scraper.extrair_meta_description(HTML_HUB) == ""


def test_extrair_hub_links_resolve_urls_relativas():
    links = scraper.extrair_hub_links(HTML_HUB, "https://harus.ind.br/site/linha-harus/alma-brasil/")

    assert links == [
        "https://harus.ind.br/site/linha-harus/alma-brasil/spa/",
        "https://harus.ind.br/site/linha-harus/alma-brasil/vegano/",
    ]


def test_extrair_house_of_brands_links_dedup():
    links = scraper.extrair_house_of_brands_links(HTML_HOUSE_OF_BRANDS_INDEX)

    assert links == [
        "https://harus.ind.br/site/house-of-brands/costa-brazil/",
        "https://harus.ind.br/site/house-of-brands/natura/",
    ]


def test_extrair_personalizados():
    itens = scraper.extrair_personalizados(HTML_PERSONALIZADOS)

    assert itens == [
        {"name": "Frasco Oval Cristal", "vol": "30ml", "img": "../assets/personalizados/frasco-oval-30ml-cristal.png"},
        {"name": "Beatle Biodegradável", "vol": "25ml", "img": "../assets/personalizados/Beatle.jpg"},
    ]


def test_slugificar_remove_acentos():
    assert scraper._slugificar("Beatle Biodegradável") == "beatle-biodegradavel"
    assert scraper._slugificar("25ml") == "25ml"


def test_rastrear_pagina_folha_namespaceia_item_id_pela_pagina():
    """
    Bug real encontrado em produção: o `id` do window.CATALOG só é único
    DENTRO da página — duas coleções diferentes podem reusar o mesmo id
    (ex.: "shampoo-25ml"). A chave de armazenamento (item_id) tem que
    incluir a página de origem pra não colidir.
    """
    with patch.object(scraper, "buscar_html", return_value=HTML_FOLHA):
        produtos = scraper.rastrear_pagina(
            "https://harus.ind.br/site/linha-harus/alma-brasil/vegano/",
            "Alma Brasil",
            visitados=set(),
        )

    assert len(produtos) == 2
    assert produtos[0]["item_id"] == "site-linha-harus-alma-brasil-vegano__vegano-shampoo-30ml"
    assert produtos[0]["codigo_pagina"] == "vegano-shampoo-30ml"
    assert produtos[0]["linha"] == "Alma Brasil"
    assert produtos[0]["categoria"] == "Vegano"
    assert produtos[0]["image_urls"] == [
        "https://harus.ind.br/site/assets/produtos/alma-brasil/vegano/vegano-shampoo-30ml.jpg"
    ]


def test_rastrear_pagina_nao_revisita_url_ja_visitada():
    visitados = {"https://harus.ind.br/site/linha-harus/alma-brasil/vegano/"}
    with patch.object(scraper, "buscar_html") as mock_buscar:
        produtos = scraper.rastrear_pagina(
            "https://harus.ind.br/site/linha-harus/alma-brasil/vegano/",
            "Alma Brasil",
            visitados=visitados,
        )

    assert produtos == []
    mock_buscar.assert_not_called()


def test_rastrear_pagina_hub_recursa_nas_sub_paginas():
    respostas = {
        "https://harus.ind.br/site/linha-harus/alma-brasil/": HTML_HUB,
        "https://harus.ind.br/site/linha-harus/alma-brasil/vegano/": HTML_FOLHA,
        "https://harus.ind.br/site/linha-harus/alma-brasil/spa/": "<html><body>sem catalog nem hub-card</body></html>",
    }

    with patch.object(scraper, "buscar_html", side_effect=lambda url: respostas[url]):
        produtos = scraper.rastrear_pagina(
            "https://harus.ind.br/site/linha-harus/alma-brasil/",
            "Alma Brasil",
            visitados=set(),
        )

    # só a folha "vegano/" tem CATALOG — "spa/" não é folha nem hub, é ignorada
    assert len(produtos) == 2
    assert all(p["linha"] == "Alma Brasil" for p in produtos)


def test_rastrear_personalizados_gera_id_unico_e_slugificado():
    with patch.object(scraper, "buscar_html", return_value=HTML_PERSONALIZADOS):
        produtos = scraper.rastrear_personalizados()

    assert len(produtos) == 2
    assert produtos[1]["item_id"] == "personalizado-beatle-biodegradavel-25ml"
    assert produtos[1]["linha"] == "Personalizados"
    assert produtos[1]["volume"] == "25ml"
