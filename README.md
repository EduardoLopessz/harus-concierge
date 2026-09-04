# 🏨 Concierge Harus

> ⚠️ **Projeto independente de portfólio.** Não é um produto oficial da
> Harus, e não tem vínculo, patrocínio ou endosso da empresa — é um estudo de
> caso construído sobre a estrutura pública do catálogo institucional dela.
> A página de apresentação (GitHub Pages) não usa fotos de produto nem a
> identidade visual real da marca.

🔗 **Página de apresentação:** https://EduardoLopessz.github.io/harus-concierge/

## 📌 Sobre o projeto

Assistente conversacional com IA para o site institucional da Harus (indústria
com 30 anos de mercado em soluções para hospitalidade), que ajuda compradores
de hotéis/pousadas a explorar o portfólio de produtos — amenities, linhas
próprias, produtos personalizados, acessórios, saneantes e alimentação — e os
conduz a solicitar uma proposta comercial. Usa RAG (Retrieval-Augmented
Generation) sobre dados coletados periodicamente do próprio site
(`https://harus.ind.br/site/produtos/`).

Réplica do padrão de scraping + embedding + chat usado no projeto FirstLab,
adaptado à realidade bem diferente do site da Harus: **catálogo institucional
B2B** (sem e-commerce, sem SKU/preço/estoque, tudo "sob consulta"), estruturado
em linhas → coleções → itens, em vez de uma página própria por produto.

---

# 🚀 Tecnologias

- Python + FastAPI (backend — scraping, servir o widget/estáticos, admin do pipeline)
- N8N (**toda a rotina do chat** — RAG, prompt de sistema, chamada ao Gemini, histórico de sessão e log de conversas — e o agendamento do pipeline de scraping/reindexação)
- Qdrant (base vetorial)
- Redis (histórico de sessão do chat, TTL de inatividade — acessado pelo N8N)
- Google Gemini (`gemini-2.5-flash` para chat, `gemini-embedding-001` para embeddings)
- Docker / Docker Compose

---

# 🧭 Descoberta sobre o site (por que o scraper é diferente do FirstLab)

O site da Harus (`harus.ind.br/site/`) **não é um e-commerce** — é um catálogo
institucional server-rendered (sem API, sem JS framework pesado). A estrutura
real, descoberta por inspeção (não documentada pela Harus):

- Páginas **hub** (ex.: `/site/linha-harus/alma-brasil/`) listam links
  `<a class="hub-card" href="...">` pra sub-páginas — podem ser outro hub ou
  já a página final.
- Páginas **folha** (coleção) embutem os itens num objeto JS simples,
  `window.CATALOG = { 'slug': { name: '...', products: [{id, name, img}] } }`,
  renderizado no HTML pelo próprio `catalog-modal.js` do site. O scraper lê
  esse objeto direto — **não precisa de navegador/Playwright**, é só
  `requests` + regex.
- `/site/house-of-brands/` é um hub especial (marcas licenciadas como
  L'Occitane, Natura, Costa Brazil), com um formato de link diferente
  (carrossel de marcas em vez de `.hub-card`).
- `/site/personalizados/` é uma página única, fora do padrão CATALOG: tem um
  array `const products = [{name, vol, img}]` com os modelos de frasco/
  embalagem personalizáveis.

**Achado importante (bug real, corrigido):** o `id` de cada item no
`window.CATALOG` só é único **dentro da página** — várias coleções reusam ids
genéricos como `"shampoo-25ml"` ou `"kit-dental"` pra produtos visualmente
diferentes (fragrância/linha diferente). Por isso a chave de armazenamento
real (`item_id`) é `{slug-da-página}__{id-do-item}`, não o `id` puro — sem
isso, produtos de coleções diferentes se sobrescreviam silenciosamente. Ver
docstring de `scraper_produtos_harus.py` e `tests/test_scraper_produtos.py`.

O site também não tem blog nem documentos técnicos como o portal FirstLab
tinha — por isso só existe o scraper de produtos por enquanto.

---

# 🧩 Arquitetura: o que é código vs. o que é N8N

A rotina do chat roda **inteira no N8N**, no workflow
`n8n/chat_assistente.json` — o prompt e a lógica de atendimento ficam
editáveis sem redeploy do backend.

| Fica em código (`main.py` e scripts) | Por quê |
|---|---|
| `scraper_produtos_harus.py` | Crawl + extração do HTML/JS do site |
| `rag_indexer.py` (embeddings + upsert no Qdrant) | Processa lote de JSONs com diff/hash — mais simples como script Python |
| `executar_scrapers.py` / `/admin/executar-pipeline` | Orquestra o item acima; N8N só **dispara** isso num agendamento (`n8n/pipeline_diario.json`) |
| Servir `static/widget.js`, `/demo`, `/teste` | N8N não serve arquivos estáticos/HTML de um site |
| `/chat` no `main.py` | Proxy fino: repassa a pergunta pro webhook do N8N e devolve a resposta |

Foi pro N8N (`n8n/chat_assistente.json`):

- Busca de contexto (embedding da pergunta + busca no Qdrant + montagem dos blocos de item do catálogo)
- Prompt de sistema (editável direto no node **"Concierge Harus (AI Agent)"**, sem precisar editar código)
- Chamada ao Gemini (com tratamento de erro em ramo separado)
- Histórico de sessão no Redis (TTL de 30min)
- Log de conversas (`logs/conversas.jsonl`, sem PII)

---

# 📂 Estrutura do Projeto

```
harus/
│
├── main.py                      # backend FastAPI (proxy do chat pro N8N + scraping/admin + estáticos)
├── rag.py                       # busca vetorial + montagem de contexto (usado pelo /rag/buscar)
├── scraper_produtos_harus.py    # scraper do catálogo institucional (linhas → coleções → itens)
├── executar_scrapers.py         # orquestrador: roda o scraper + reindexa se algo mudou
├── rag_indexer.py               # gera embeddings e indexa os itens no Qdrant
├── prompt.txt                   # cópia de referência do prompt — fonte de verdade é o node "Concierge Harus (AI Agent)" em n8n/chat_assistente.json
│
├── static/
│   ├── widget.js                 # ⭐ widget embutível (Shadow DOM)
│   └── teste_app.js/teste_style.css   # ferramenta de teste (/teste)
├── templates/
│   ├── demo_widget_no_portal.html    # demonstração do widget embutido (rota /demo, e /)
│   └── teste_chat_completo.html      # ferramenta de teste em tela cheia (rota /teste)
├── n8n/
│   ├── chat_assistente.json     # ⭐ rotina completa do chat (RAG + prompt + Gemini + histórico + log)
│   └── pipeline_diario.json     # agendamento diário do scraping/reindexação
│
├── tests/                        # suite de testes automatizados (pytest) — 18 testes, sem rede/API real
│
├── data/output/                  # um JSON + imagem por item, gerado pelo scraper (não é código)
│
├── Dockerfile
├── docker-compose.yml             # qdrant + redis + n8n + backend
├── requirements.txt               # dependências completas (= requirements-docker.txt + pytest)
├── requirements-docker.txt        # dependências usadas na imagem Docker
├── .env.example                   # modelo de variáveis de ambiente (copiar para .env)
└── corporate-ca.crt               # certificado da rede corporativa (ver nota abaixo)
```

---

# ▶ Como executar

## Localmente (sem Docker)

```bash
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
# edite o .env e preencha GOOGLE_API_KEY, ADMIN_TOKEN e N8N_CHAT_WEBHOOK_URL
python main.py
```

Acesse `http://localhost:8000` (chat de teste) ou `http://localhost:8000/demo`
(demonstração do widget embutido). **O `/chat` só funciona depois de importar
e ativar `n8n/chat_assistente.json` numa instância N8N** — ver seção abaixo.

## Com Docker (recomendado)

```bash
copy .env.example .env
# edite o .env
docker compose up -d --build
```

Isso sobe o Qdrant, o Redis, o N8N e o backend juntos. O backend fica em
`http://localhost:8000`, o N8N em `http://localhost:5678`.

### Ativar o workflow do chat no N8N

1. Abra `http://localhost:5678`, crie a conta/admin inicial.
2. Crie uma credencial **Redis** apontando pra `redis` / porta `6379` (sem senha) e nomeie **"Harus Redis"**.
3. Importe `n8n/chat_assistente.json` (menu → Import from File). Nos dois nodes Redis, reselecione a credencial "Harus Redis" (o import não traz credenciais).
4. Ative o workflow (toggle "Active"). O webhook fica em `http://n8n:5678/webhook/harus-chat` (dentro da rede Docker — já configurado em `N8N_CHAT_WEBHOOK_URL` no `docker-compose.yml`).
5. Importe também `n8n/pipeline_diario.json` e ative-o (agendamento diário do scraping).
6. Pra editar o prompt de sistema sem tocar em código, abra o node **"Concierge Harus (AI Agent)"** dentro do workflow do chat.

## Rodar o pipeline de scraping + indexação

```bash
python scraper_produtos_harus.py     # só o scraper (gera data/output/)
python executar_scrapers.py          # scraper + reindexação automática se algo mudou
python executar_scrapers.py --teste  # roda rápido, poucos itens, sem reindexar (validação)
```

Isso também pode ser acionado remotamente via `POST /admin/executar-pipeline`
(protegido por header `X-Admin-Token`) — é isso que o workflow do N8N em
`n8n/pipeline_diario.json` chama todo dia às 02h.

**Validado nesta sessão:** o scraper rodou de ponta a ponta contra o site real
e coletou **707 itens únicos** (imagens incluídas) em todas as linhas —
Alma Brasil, House of Brands, Amenities Harus, Kids, Harus Food, Acessórios
& Necessaires, Saneantes e Personalizados — sem colisão de chave.

## Rodar os testes

```bash
python -m pytest tests/ -v
```

---

# 🔌 Integração do widget no site institucional

```html
<script src="https://SEU_BACKEND/static/widget.js"
        data-api-base="https://SEU_BACKEND"></script>
```

Rastreamento opcional por visitante (sem PII), se quiser correlacionar
perguntas a uma sessão/CRM externo:

```html
<script src="https://SEU_BACKEND/static/widget.js"
        data-api-base="https://SEU_BACKEND"
        data-usuario-id="{{ id_de_sessao_opaco }}"></script>
```

- `data-usuario-id`: identificador opaco/anônimo (nunca nome/e-mail/telefone). Fica vazio pra visitante anônimo — isso não impede o widget de aparecer (não há conceito de "cliente logado" no site institucional).
- `data-url-contato`: sobrescreve o link do rodapé "fale com um consultor" (padrão: `https://harus.ind.br/site/contato/`).

---

# 🔒 Nota sobre o `corporate-ca.crt` (opcional, não versionado)

Se você roda isso atrás de uma rede corporativa com inspeção de HTTPS (proxy
que faz MITM em TLS), chamadas HTTPS de dentro do Docker podem falhar com
"self-signed certificate in certificate chain". Solução: coloque o
certificado raiz da sua rede em `corporate-ca.crt` na raiz do projeto (não
está no repositório — é específico de cada rede, por isso está no
`.gitignore`) antes de buildar a imagem. O `Dockerfile` detecta o arquivo
automaticamente (`COPY corporate-ca.cr[t] ...` — um glob, não quebra o build
se o arquivo não existir). Na maioria das redes isso não é necessário.

---

# 🌐 Página de apresentação (GitHub Pages)

`docs/` é uma página estática independente do backend — mostra a arquitetura,
o pipeline e uma prévia visual do widget com respostas pré-escritas (sem
depender de Gemini/Qdrant/N8N rodando). **Não usa fotos de produto nem
identidade visual real da Harus** — só ilustrações originais (line-art de
embalagens genéricas) e a paleta de cores. Publicada em
https://EduardoLopessz.github.io/harus-concierge/ via GitHub Pages
(branch `main`, pasta `/docs`).

---

# 📄 Licença

Código sob [licença MIT](LICENSE) — cobre o código original deste
repositório (scrapers, backend, pipeline, prompts, widget, workflows e a
página de apresentação). Não concede nenhum direito sobre a marca, produtos
ou conteúdo de catálogo da Harus.

---

# 📅 Status

## Concluído

- ✅ Scraper de produtos (`scraper_produtos_harus.py`) — crawl recursivo hub→folha do catálogo institucional, sem navegador, com skip logic por hash. **707 itens únicos coletados e validados contra o site real.**
- ✅ Bug de colisão de `item_id` entre coleções encontrado e corrigido (namespacing por página) — cobertura de teste dedicada.
- ✅ Orquestrador (`executar_scrapers.py`) com resumo consolidado
- ✅ Indexação no Qdrant via embeddings Gemini (`rag_indexer.py`), coleção `harus_conhecimento`
- ✅ Prompt do concierge adaptado ao modelo B2B/orçamento da Harus (sem SKU/preço/estoque, foco em linhas/coleções e roteamento pra "Solicitar orçamento")
- ✅ Rotina completa do chat no N8N (`n8n/chat_assistente.json`): busca RAG, prompt de sistema, chamada ao Gemini, histórico de sessão (Redis) e log de conversas
- ✅ Backend reduzido a proxy fino do `/chat` + scraping/admin + estáticos
- ✅ Widget de chat embutível (`static/widget.js`) com identidade visual Harus (dourado/grafite/creme)
- ✅ Endpoint admin para disparo remoto do pipeline (`/admin/executar-pipeline`)
- ✅ Workflow N8N do pipeline diário (`n8n/pipeline_diario.json`)
- ✅ Docker Compose (Qdrant + Redis + N8N + backend)
- ✅ 18 testes automatizados (extração do scraper + regras de negócio do rag.py), sem depender de rede/API real

## Pendente / próximos passos

- Preencher `GOOGLE_API_KEY`, `ADMIN_TOKEN` e demais segredos no `.env` real
- Rodar `python executar_scrapers.py` (sem `--teste`) contra uma instância Qdrant real pra popular a base pela primeira vez
- Calibrar `rag.SCORE_MINIMO` (0.60, valor inicial) depois que houver perguntas reais pra testar a qualidade da busca
- Importar e ativar os dois workflows N8N, criar a credencial Redis e a credencial Google Gemini
- Decidir onde o widget será embutido de fato no site (harus.ind.br é hospedado por terceiros? precisa de acesso ao template do site pra colar a tag `<script>`)
- Hospedagem definitiva do backend e do N8N (hoje só validado localmente/Docker Compose local)
- Considerar reindexar periodicamente (o site pode adicionar novas coleções/linhas — a lista `SEEDS` em `scraper_produtos_harus.py` cobre as linhas conhecidas hoje; uma nova linha no menu principal do site precisaria ser adicionada lá)

---

# 👨‍💻 Desenvolvedor

Eduardo Elias Lopes
