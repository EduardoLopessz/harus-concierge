import logging
import time
from collections import defaultdict, deque
from typing import List, Optional

import truststore

truststore.inject_into_ssl()  # confia na lista de certificados do Windows (necessário em redes corporativas com proxy/inspeção SSL)

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import os

import requests
from dotenv import load_dotenv
from google import genai
from qdrant_client import QdrantClient

import rag

load_dotenv()

# ==================================
# CONFIGURAÇÃO
# ==================================

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:6333")
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN")

# Token compartilhado que só o N8N conhece, pra proteger o /rag/buscar (nunca
# é chamado pelo widget/navegador — só pelo node "Buscar Contexto" do
# workflow). Sem autenticação, esse endpoint fica aberto pra qualquer um na
# internet gerar chamadas de embedding pagas (Gemini) só de conhecer a porta.
INTERNAL_API_TOKEN = os.getenv("INTERNAL_API_TOKEN")

ALLOWED_ORIGINS = [
    origem.strip()
    for origem in os.getenv("ALLOWED_ORIGINS", "http://localhost:8000").split(",")
    if origem.strip()
]

# A rotina do chat (prompt de sistema, chamada ao Gemini, histórico no Redis e
# log de conversas) mora inteira no workflow N8N "Harus - Chat do Assistente"
# (ver n8n/chat_assistente.json). Aqui só fazemos um proxy — permite ajustar
# a rotina/prompt no N8N sem redeploy do backend.
N8N_CHAT_WEBHOOK_URL = os.getenv("N8N_CHAT_WEBHOOK_URL")

# Chamado por quem incorporar o widget, se algum dia precisar encerrar uma
# sessão de conversa manualmente (ex.: painel administrativo interno).
N8N_LOGOUT_WEBHOOK_URL = os.getenv("N8N_LOGOUT_WEBHOOK_URL")

COLECAO = rag.COLECAO

MENSAGEM_ERRO_GEMINI = (
    "Estou com uma instabilidade temporária pra gerar a resposta agora. "
    "Pode tentar novamente em alguns instantes?"
)

# ==================================
# FASTAPI
# ==================================

app = FastAPI(title="Harus Concierge")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="static"), name="static")


# ==================================
# RATE LIMITING (proteção simples contra abuso de custo)
# ==================================
# Cada chamada a /chat e /rag/buscar dispara uma chamada de embedding paga
# (Gemini). Limiter simples em memória por IP — suficiente pro volume deste
# projeto, sem precisar de dependência nova.

LIMITE_JANELA_SEGUNDOS = 60
LIMITES_POR_ROTA = {
    "/chat": 20,
    "/rag/buscar": 30,
    "/logout": 10,
}
_chamadas_por_ip: dict[str, deque] = defaultdict(deque)


def _limite_excedido(ip: str, rota: str) -> bool:
    limite = LIMITES_POR_ROTA.get(rota)
    if limite is None:
        return False

    agora = time.monotonic()
    chamadas = _chamadas_por_ip[f"{ip}:{rota}"]
    while chamadas and agora - chamadas[0] > LIMITE_JANELA_SEGUNDOS:
        chamadas.popleft()

    if len(chamadas) >= limite:
        return True

    chamadas.append(agora)
    return False


@app.middleware("http")
async def limitar_taxa(request: Request, call_next):
    if request.url.path in LIMITES_POR_ROTA:
        ip_cliente = request.client.host if request.client else "desconhecido"
        if _limite_excedido(ip_cliente, request.url.path):
            return JSONResponse(
                status_code=429,
                content={"detail": "Muitas requisições — tente novamente em alguns instantes."},
            )
    return await call_next(request)

# ==================================
# CLIENTES
# ==================================

qdrant = QdrantClient(url=QDRANT_URL)

# GOOGLE_API_KEY e N8N_CHAT_WEBHOOK_URL só avisam (não derrubam o processo) —
# isso permite subir o backend localmente só pra visualizar /demo e /teste
# (estáticos, não dependem de Gemini/N8N) antes de ter as credenciais reais.
# Os endpoints que de fato precisam delas (/chat, /rag/buscar) checam de novo
# na hora da chamada e devolvem um erro claro, em vez de deixar a exceção
# genérica do requests/genai estourar sem explicação.
genai_client: Optional["genai.Client"] = None
if not GOOGLE_API_KEY:
    print(
        "AVISO: GOOGLE_API_KEY não configurada — /rag/buscar vai falhar até "
        "configurar no .env (veja .env.example). /demo e /teste funcionam normalmente."
    )
else:
    genai_client = genai.Client(api_key=GOOGLE_API_KEY)

if not N8N_CHAT_WEBHOOK_URL:
    print(
        "AVISO: N8N_CHAT_WEBHOOK_URL não configurada — /chat vai responder com "
        "a mensagem de instabilidade até apontar pro webhook do workflow N8N "
        "'Harus - Chat do Assistente' (veja .env.example)."
    )

if not INTERNAL_API_TOKEN:
    print(
        "AVISO: INTERNAL_API_TOKEN não configurado — /rag/buscar vai ficar "
        "público (qualquer um pode gerar chamadas de embedding pagas). "
        "Configure no .env pra proteger esse endpoint (veja .env.example)."
    )

# ==================================
# MODELOS (schemas da API)
# ==================================


class MensagemHistorico(BaseModel):
    role: str      # "user" ou "assistant"
    content: str


MENSAGEM_TAMANHO_MAXIMO = 2000

class Pergunta(BaseModel):
    mensagem: str = Field(max_length=MENSAGEM_TAMANHO_MAXIMO)
    historico: Optional[List[MensagemHistorico]] = None
    # Identificador opaco/anônimo de quem está conversando (ex.: hash de
    # sessão do site institucional) — NUNCA nome/e-mail/telefone. Opcional.
    usuario_id: Optional[str] = None
    # Identificador da conversa (gerado pelo widget via sessionStorage — some
    # quando a aba/navegador fecha). Quando presente, o histórico é
    # gerenciado no servidor via Redis em vez de vir do campo "historico".
    session_id: Optional[str] = None
    # URL da página onde o visitante está agora (ex.: a página de uma
    # coleção específica) — ajuda o assistente a desambiguar perguntas do
    # tipo "esse produto combina com meu hotel de praia?".
    pagina_atual: Optional[str] = None


class Produto(BaseModel):
    nome: str = ""
    categoria: str = ""
    codigo: str = ""
    link: str = ""
    imagem: str = ""


class RespostaChat(BaseModel):
    resposta: str
    produtos: List[Produto]


# ==================================
# FUNÇÕES AUXILIARES
# ==================================


def gerar_resposta(pergunta: "Pergunta") -> RespostaChat:
    """
    Proxy pro workflow N8N "Harus - Chat do Assistente". Toda a rotina (busca
    RAG no Qdrant, prompt de sistema, chamada ao Gemini, histórico de sessão
    e log de conversas) roda lá — ver n8n/chat_assistente.json. O backend só
    repassa a pergunta e devolve a resposta.
    """
    if not N8N_CHAT_WEBHOOK_URL:
        return RespostaChat(
            resposta=(
                "[modo teste local] Backend rodando sem N8N_CHAT_WEBHOOK_URL configurado — "
                "esta é a interface real, mas ainda não há um workflow N8N pra gerar a resposta. "
                "Configure o .env (veja .env.example) e importe n8n/chat_assistente.json pra ativar o chat de verdade."
            ),
            produtos=[],
        )

    payload = {
        "mensagem": pergunta.mensagem.strip(),
        "usuario_id": pergunta.usuario_id,
        "session_id": pergunta.session_id,
        "historico": [h.model_dump() for h in pergunta.historico] if pergunta.historico else None,
        "pagina_atual": pergunta.pagina_atual,
    }

    try:
        resposta = requests.post(N8N_CHAT_WEBHOOK_URL, json=payload, timeout=30)
        resposta.raise_for_status()
        dados = resposta.json()
    except Exception:
        return RespostaChat(resposta=MENSAGEM_ERRO_GEMINI, produtos=[])

    try:
        produtos = [Produto(**p) for p in (dados.get("produtos") or []) if isinstance(p, dict)]
    except Exception:
        logging.warning("Payload de 'produtos' inválido vindo do N8N — cards omitidos.", exc_info=True)
        produtos = []

    return RespostaChat(
        resposta=dados.get("resposta", MENSAGEM_ERRO_GEMINI),
        produtos=produtos,
    )


# ==================================
# ROTAS
# ==================================


@app.get("/")
def home():
    return RedirectResponse(url="/demo")


@app.get("/demo")
def demo_widget_no_site():
    """Demonstração do widget (static/widget.js) embutido numa simulação do
    site institucional da Harus."""
    return FileResponse("templates/demo_widget_no_portal.html")


@app.get("/teste")
def teste_chat_completo():
    """Ferramenta de teste em tela cheia — só pra validar o backend rápido
    durante o desenvolvimento, sem precisar do widget."""
    return FileResponse("templates/teste_chat_completo.html")


@app.get("/health")
def health():
    try:
        itens_indexados = qdrant.get_collection(COLECAO).points_count
        qdrant_status = "ok"
    except Exception:
        itens_indexados = None
        qdrant_status = "indisponível (Qdrant não está rodando ou a coleção ainda não existe)"

    return {
        "status": "ok",
        "qdrant": qdrant_status,
        "itens_indexados": itens_indexados,
        "google_api_key": "configurada" if genai_client else "ausente",
        "n8n_chat_webhook": "configurado" if N8N_CHAT_WEBHOOK_URL else "ausente",
    }


@app.post("/admin/executar-pipeline")
def executar_pipeline(teste: bool = False, x_admin_token: Optional[str] = Header(default=None)):
    """
    Roda o pipeline de ingestão (scraper de produtos + reindexação
    condicional no Qdrant). Pensado pra ser chamado pelo N8N num agendamento
    diário — ver n8n/pipeline_diario.json.

    Protegido por token: exige o header X-Admin-Token igual ao ADMIN_TOKEN
    configurado no .env. Use "?teste=true" pra validar rápido (poucos itens,
    sem reindexar).
    """
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=500, detail="ADMIN_TOKEN não configurado no servidor.")
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="Token inválido.")

    import executar_scrapers  # importado aqui pra não carregar dependências pesadas no processo web sempre

    return executar_scrapers.executar(produtos=True, teste=teste)


class PerguntaBusca(BaseModel):
    pergunta: str = Field(max_length=MENSAGEM_TAMANHO_MAXIMO)


@app.post("/rag/buscar")
def rag_buscar(dados: PerguntaBusca, x_internal_token: Optional[str] = Header(default=None)):
    """
    Chamado pelo node "Buscar Contexto" do workflow N8N do chat, antes do AI
    Agent (ver n8n/chat_assistente.json). Existe porque o node nativo de
    Embeddings do N8N não permite fixar a dimensão do vetor (768), a mesma
    usada pra indexar os itens no Qdrant. Só o N8N chama esse endpoint.
    """
    if INTERNAL_API_TOKEN and x_internal_token != INTERNAL_API_TOKEN:
        raise HTTPException(status_code=403, detail="Token inválido.")
    if genai_client is None:
        raise HTTPException(status_code=503, detail="GOOGLE_API_KEY não configurada no servidor.")

    itens = rag.buscar_contexto(qdrant, genai_client, dados.pergunta.strip())
    return {
        "contexto": rag.montar_contexto(itens),
        "produtos": rag.extrair_produtos(itens),
    }


class Logout(BaseModel):
    session_id: str


@app.post("/logout")
def logout(dados: Logout):
    """Apaga o histórico de sessão da conversa (Redis) na hora, se o
    integrador do widget quiser oferecer esse gatilho — ver
    n8n/chat_assistente.json, node "Webhook Logout"."""
    if not N8N_LOGOUT_WEBHOOK_URL:
        raise HTTPException(status_code=500, detail="N8N_LOGOUT_WEBHOOK_URL não configurada no servidor.")

    try:
        requests.post(N8N_LOGOUT_WEBHOOK_URL, json={"session_id": dados.session_id}, timeout=10)
    except Exception:
        pass  # limpeza de histórico é best-effort — nunca deve travar o fluxo de quem chamou

    return {"status": "ok"}


@app.post("/chat", response_model=RespostaChat)
def chat(pergunta: Pergunta):
    mensagem = pergunta.mensagem.strip()

    if not mensagem:
        return RespostaChat(resposta="Pode repetir sua pergunta? Não recebi nenhum texto.", produtos=[])

    return gerar_resposta(pergunta)


# ==================================
# EXECUÇÃO LOCAL
# ==================================

if __name__ == "__main__":
    import uvicorn

    porta = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=porta, reload=True)
