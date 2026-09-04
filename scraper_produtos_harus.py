"""
Scraper de produtos do site institucional da Harus (https://harus.ind.br/site/produtos/).

Diferente do portal FirstLab (e-commerce com uma página de detalhe por produto
e um objeto `var product = {...}` completo por item), o site da Harus é um
catálogo institucional B2B: cada "linha" (Alma Brasil, House of Brands,
Amenities Harus, Kids, Harus Food, Acessórios, Saneantes, Personalizados) tem
páginas de categoria (ex.: /site/linha-harus/alma-brasil/vegano/) que listam
vários itens (nome + imagem) de uma vez, sem página própria por item, sem
SKU/preço/estoque — tudo é "sob consulta"/orçamento.

Cada página de categoria embute os itens num objeto `window.CATALOG = {...}`
simples (chave da categoria -> {name, products: [{id, name, img}]}) renderizado
depois no HTML pelo `catalog-modal.js` do próprio site. Isso é suficiente:
extraímos direto desse objeto, sem precisar de navegador (Playwright) — o site
é praticamente todo HTML estático/server-rendered.

Estrutura do catálogo (descoberta por inspeção, não documentada pela Harus):
- Páginas "hub" (ex.: /site/linha-harus/alma-brasil/) listam links
  `<a class="hub-card" href="...">` para sub-páginas — podem apontar direto
  pra uma página de categoria (folha) ou para outro hub (mais um nível).
- Páginas "folha" têm o `window.CATALOG` com os itens de fato.
- /site/house-of-brands/ é um hub especial: não usa `.hub-card`, usa links
  `/site/house-of-brands/{marca}/` no carrossel de marcas.
- /site/personalizados/ é uma página única (não é hub nem segue o padrão
  CATALOG): tem um array `const products = [{name, vol, img}, ...]` com os
  15 modelos de frasco/embalagem personalizáveis.

Cada item extraído é salvo em data/output/{item_id}/{item_id}.json + a imagem
do item, com a mesma lógica de hash/skip do padrão FirstLab (só reprocessa o
que mudou).

Cuidado observado na prática (por isso a chave de item NÃO é o `id` puro do
`window.CATALOG`): esses ids são únicos só DENTRO de uma página — várias
coleções da Harus reusam ids genéricos como "shampoo-25ml" ou "kit-dental"
pra produtos visualmente diferentes (fragrância/linha diferente). Usar só o
`id` como chave de armazenamento colidiria produtos de coleções distintas num
único arquivo/imagem. Por isso a chave real é `id_unico` = slug da página de
categoria + o `id` do item — o `id` original fica guardado em `codigo_pagina`
só como referência.
"""

import hashlib
import json
import os
import re
import time
import unicodedata
import urllib.parse

import requests
import truststore

truststore.inject_into_ssl()  # confia na lista de certificados do Windows (rede corporativa com inspeção SSL)

BASE_URL = "https://harus.ind.br"
OUTPUT_DIR = "data/output"

# Pontos de entrada do crawl: (caminho, rótulo da linha).
# Cada um pode ser folha, hub de 1 nível ou hub de N níveis — o crawler trata
# os três casos genericamente (ver `rastrear_pagina`).
SEEDS = [
    ("/site/house-of-brands/", "House of Brands"),
    ("/site/linha-harus/alma-brasil/", "Alma Brasil"),
    ("/site/linha-harus/amenities-harus/", "Amenities Harus"),
    ("/site/linha-harus/kids/", "Amenities Kids"),
    ("/site/linha-harus/harus-food/", "Harus Food"),
    ("/site/linha-harus/acessorios/", "Acessórios & Necessaires"),
    ("/site/linha-harus/saneantes/", "Saneantes by Carla Guerra"),
]

PROFUNDIDADE_MAXIMA = 6  # trava de segurança contra ciclo/estrutura inesperada

_sessao = requests.Session()
_sessao.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept-Language": "pt-BR,pt;q=0.9",
})


# ==========================================
# HTTP
# ==========================================

def buscar_html(url: str) -> str:
    resposta = _sessao.get(url, timeout=20)
    resposta.raise_for_status()
    resposta.encoding = "utf-8"  # o servidor declara utf-8 no header, mas o requests às vezes erra a detecção
    return resposta.text


# ==========================================
# EXTRAÇÃO DE DADOS EMBUTIDOS NO HTML
# ==========================================

def _slugificar(texto: str) -> str:
    """Remove acentos e normaliza pra um slug ASCII (ex.: "Beatle Biodegradável"
    -> "beatle-biodegradavel"), usado só pro id gerado da página Personalizados
    (que não tem id próprio no HTML, diferente das outras categorias)."""
    sem_acento = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "-", sem_acento.lower()).strip("-")


def extrair_meta_description(html: str) -> str:
    m = re.search(r'<meta\s+name="description"\s+content="([^"]*)"', html)
    return m.group(1).strip() if m else ""


def _objetos_planos(bloco: str) -> list[str]:
    """Divide um array JS de objetos FLATS (sem chaves aninhadas dentro de cada
    item — verdade pra `products: [...]` e pra `const products = [...]` da
    Harus) em uma lista de trechos `{...}` individuais."""
    return re.findall(r"\{[^{}]*\}", bloco)


def _valor_string(chave: str, objeto: str) -> str:
    m = re.search(rf"{chave}\s*:\s*'((?:[^'\\]|\\.)*)'", objeto)
    if not m:
        return ""
    return m.group(1).replace("\\'", "'")


def extrair_catalog_js(html: str) -> tuple[str, list[dict]] | None:
    """Extrai (nome_da_categoria, [{id, name, img}, ...]) de `window.CATALOG =
    {...};`. Retorna None se a página não tiver esse objeto (não é uma página
    de categoria/folha)."""
    inicio = html.find("window.CATALOG")
    if inicio == -1:
        return None

    fim = html.find("};", inicio)
    if fim == -1:
        return None
    bloco = html[inicio:fim + 1]

    m_nome = re.search(r"name\s*:\s*'((?:[^'\\]|\\.)*)'", bloco)
    nome_categoria = m_nome.group(1).replace("\\'", "'") if m_nome else ""

    idx_products = bloco.find("products")
    if idx_products == -1:
        return nome_categoria, []
    bloco_produtos = bloco[idx_products:]

    itens = []
    for objeto in _objetos_planos(bloco_produtos):
        item_id = _valor_string("id", objeto)
        nome = _valor_string("name", objeto)
        img = _valor_string("img", objeto)
        if item_id and nome:
            itens.append({"id": item_id, "name": nome, "img": img})

    return nome_categoria, itens


def extrair_personalizados(html: str) -> list[dict]:
    """Extrai o array `const products = [{name, vol, img}, ...]` da página
    /site/personalizados/ (modelos de frasco/embalagem personalizáveis)."""
    m = re.search(r"const\s+products\s*=\s*\[", html)
    if not m:
        return []
    inicio = m.end() - 1
    fim = html.find("];", inicio)
    if fim == -1:
        return []
    bloco = html[inicio:fim + 1]

    itens = []
    for objeto in _objetos_planos(bloco):
        nome = _valor_string("name", objeto)
        vol = _valor_string("vol", objeto)
        img = _valor_string("img", objeto)
        if nome:
            itens.append({"name": nome, "vol": vol, "img": img})
    return itens


def extrair_hub_links(html: str, url_atual: str) -> list[str]:
    """Links `<a class="hub-card" href="...">` — sub-páginas de um hub
    (ex.: as coleções dentro de Alma Brasil, as marcas dentro de Harus Food)."""
    hrefs = re.findall(r'<a\s+class="hub-card"\s+href="([^"]+)"', html)
    return sorted({urllib.parse.urljoin(url_atual, h) for h in hrefs})


def extrair_house_of_brands_links(html: str) -> list[str]:
    """Caso especial: /site/house-of-brands/ não usa `.hub-card`, usa os links
    do carrossel de marcas (`/site/house-of-brands/{marca}/`)."""
    hrefs = re.findall(r'href="(/site/house-of-brands/[a-z0-9\-]+/)"', html)
    return sorted({urllib.parse.urljoin(BASE_URL, h) for h in hrefs})


# ==========================================
# DOWNLOAD DE IMAGEM
# ==========================================

def baixar_imagem(url: str, destino: str) -> bool:
    try:
        resposta = _sessao.get(url, timeout=20)
        resposta.raise_for_status()
        with open(destino, "wb") as f:
            f.write(resposta.content)
        return True
    except Exception as erro:
        print(f"    Erro ao baixar imagem {url}: {erro}")
        return False


# ==========================================
# HASH E SKIP LOGIC (idêntico ao padrão FirstLab)
# ==========================================

def calcular_hash(produto: dict) -> str:
    campos_para_hash = {k: v for k, v in produto.items() if k != "hash"}
    bruto = json.dumps(campos_para_hash, sort_keys=True, ensure_ascii=False)
    return hashlib.md5(bruto.encode("utf-8")).hexdigest()


def carregar_json_existente(pasta_item: str, item_id: str) -> dict | None:
    caminho = os.path.join(pasta_item, f"{item_id}.json")
    if os.path.exists(caminho):
        try:
            with open(caminho, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None
    return None


# ==========================================
# CRAWL
# ==========================================

def rastrear_pagina(url: str, linha: str, visitados: set[str], profundidade: int = 0) -> list[dict]:
    """Visita uma página e devolve a lista de produtos encontrados nela e em
    tudo que ela referenciar (hubs recursivos). `linha` é fixo pro ramo inteiro
    (ex.: tudo sob Alma Brasil continua rotulado "Alma Brasil"), mesmo quando
    a página é folha vários níveis abaixo do ponto de entrada."""
    if url in visitados or profundidade > PROFUNDIDADE_MAXIMA:
        return []
    visitados.add(url)

    try:
        html = buscar_html(url)
    except Exception as erro:
        print(f"  Erro ao acessar {url}: {erro}")
        return []

    resultado_catalog = extrair_catalog_js(html)
    if resultado_catalog is not None:
        categoria, itens_brutos = resultado_catalog
        descricao = extrair_meta_description(html)
        pagina_slug = urllib.parse.urlparse(url).path.strip("/").replace("/", "-")
        produtos = []
        for item in itens_brutos:
            produtos.append({
                "item_id": f"{pagina_slug}__{item['id']}",
                "codigo_pagina": item["id"],
                "name": item["name"],
                "linha": linha,
                "categoria": categoria,
                "categoria_descricao": descricao,
                "url": url,
                "volume": "",
                "image_urls": [urllib.parse.urljoin(url, item["img"])] if item["img"] else [],
            })
        print(f"  [folha] {url} -> categoria '{categoria}', {len(produtos)} itens")
        return produtos

    # Não é folha — tenta como hub genérico, e como caso especial House of Brands.
    links = extrair_hub_links(html, url)
    if not links and "/house-of-brands/" in url and url.rstrip("/").endswith("house-of-brands"):
        links = extrair_house_of_brands_links(html)

    if not links:
        print(f"  Aviso: {url} não é folha (sem window.CATALOG) nem hub (sem .hub-card) — ignorando")
        return []

    print(f"  [hub] {url} -> {len(links)} sub-página(s)")
    produtos = []
    for link in links:
        time.sleep(0.3)
        produtos.extend(rastrear_pagina(link, linha, visitados, profundidade + 1))
    return produtos


def rastrear_personalizados() -> list[dict]:
    url = BASE_URL + "/site/personalizados/"
    try:
        html = buscar_html(url)
    except Exception as erro:
        print(f"  Erro ao acessar {url}: {erro}")
        return []

    descricao = extrair_meta_description(html)
    itens_brutos = extrair_personalizados(html)
    print(f"  [folha] {url} -> categoria 'Frascos e Embalagens Personalizáveis', {len(itens_brutos)} itens")

    produtos = []
    for item in itens_brutos:
        item_id = f"personalizado-{_slugificar(item['name'])}-{_slugificar(item['vol'])}".strip("-")
        produtos.append({
            "item_id": item_id,
            "codigo_pagina": item_id,
            "name": item["name"],
            "linha": "Personalizados",
            "categoria": "Frascos e Embalagens Personalizáveis",
            "categoria_descricao": descricao,
            "url": url,
            "volume": item["vol"],
            "image_urls": [urllib.parse.urljoin(url, item["img"])] if item["img"] else [],
        })
    return produtos


# ==========================================
# PROCESSAMENTO / PERSISTÊNCIA
# ==========================================

def processar_produto(produto_bruto: dict, stats: dict) -> None:
    item_id = produto_bruto["item_id"]
    produto = dict(produto_bruto)
    produto["image_files"] = []
    produto["hash"] = calcular_hash(produto)

    pasta_item = os.path.join(OUTPUT_DIR, item_id)
    existente = carregar_json_existente(pasta_item, item_id)
    if existente and existente.get("hash") == produto["hash"]:
        stats["sem_alteracao"] += 1
        return

    os.makedirs(pasta_item, exist_ok=True)

    image_files = []
    for i, img_url in enumerate(produto["image_urls"]):
        ext = os.path.splitext(img_url.split("?")[0])[1] or ".jpg"
        nome_arquivo = f"{item_id}_{i}{ext}" if i > 0 else f"{item_id}{ext}"
        destino = os.path.join(pasta_item, nome_arquivo)
        if baixar_imagem(img_url, destino):
            image_files.append(destino)
    produto["image_files"] = image_files

    caminho_json = os.path.join(pasta_item, f"{item_id}.json")
    with open(caminho_json, "w", encoding="utf-8") as f:
        json.dump(produto, f, ensure_ascii=False, indent=2)

    if existente:
        print(f"  [{item_id}] atualizado")
        stats["atualizados"] += 1
    else:
        print(f"  [{item_id}] novo")
        stats["novos"] += 1


def main(limite: int | None = None) -> dict:
    """Roda o scraper completo. `limite` restringe a quantos itens processar
    (usado pelo --teste), aplicado depois de coletar tudo (o crawl em si
    sempre percorre a estrutura inteira do site — é rápido, é só HTML)."""
    stats = {"novos": 0, "atualizados": 0, "sem_alteracao": 0}

    todos_produtos: list[dict] = []
    visitados: set[str] = set()

    for caminho, linha in SEEDS:
        url = BASE_URL + caminho
        print(f"\n=== {linha} ({url}) ===")
        todos_produtos.extend(rastrear_pagina(url, linha, visitados))
        time.sleep(0.3)

    print(f"\n=== Personalizados ===")
    todos_produtos.extend(rastrear_personalizados())

    print(f"\nTotal de itens encontrados no site: {len(todos_produtos)}")

    if limite:
        todos_produtos = todos_produtos[:limite]

    for produto_bruto in todos_produtos:
        try:
            processar_produto(produto_bruto, stats)
        except Exception as erro:
            print(f"  Erro ao processar {produto_bruto.get('item_id')}: {erro}")

    print(
        f"\nResumo: {stats['novos']} novos | "
        f"{stats['atualizados']} atualizados | "
        f"{stats['sem_alteracao']} sem alteração"
    )
    return stats


if __name__ == "__main__":
    main()
