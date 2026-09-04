// ==========================================================
// Harus Concierge — Frontend de teste
// Consome /chat (a rotina completa roda no workflow N8N) e monta bolhas de
// conversa + cards de produto. Histórico persistido em LocalStorage
// (sidebar estilo ChatGPT).
// ==========================================================

const chatEl = document.getElementById("chat");
const emptyStateEl = document.getElementById("empty-state");
const formEl = document.getElementById("form-chat");
const inputEl = document.getElementById("input-mensagem");
const btnEnviar = document.getElementById("btn-enviar");
const btnNovaConversa = document.getElementById("btn-nova-conversa");
const tituloConversaAtualEl = document.getElementById("titulo-conversa-atual");

const sidebarEl = document.getElementById("sidebar");
const sidebarOverlayEl = document.getElementById("sidebar-overlay");
const btnAbrirSidebar = document.getElementById("btn-abrir-sidebar");
const btnFecharSidebar = document.getElementById("btn-fechar-sidebar");
const listaConversasEl = document.getElementById("lista-conversas");
const inputBuscaEl = document.getElementById("input-busca-conversas");

const CHAVE_STORAGE_CONVERSAS = "harus_conversas";
const CHAVE_STORAGE_ATIVA = "harus_conversa_ativa";

let historico = [];
let conversationId = null;

// ---------- persistência local (localStorage) ----------

function gerarId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "conv-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

function carregarConversas() {
    try {
        return JSON.parse(localStorage.getItem(CHAVE_STORAGE_CONVERSAS)) || [];
    } catch (e) {
        return [];
    }
}

function salvarConversas(lista) {
    localStorage.setItem(CHAVE_STORAGE_CONVERSAS, JSON.stringify(lista));
}

function obterConversa(id) {
    return carregarConversas().find(c => c.id === id) || null;
}

function criarTituloAPartirDaMensagem(texto) {
    const limpo = texto.trim();
    return limpo.length > 48 ? limpo.slice(0, 48) + "…" : limpo;
}

function criarConversa() {
    const conversas = carregarConversas();
    const nova = {
        id: gerarId(),
        titulo: "Nova conversa",
        mensagens: [],
        criada_em: new Date().toISOString(),
        atualizada_em: new Date().toISOString(),
    };
    conversas.unshift(nova);
    salvarConversas(conversas);
    return nova;
}

function registrarMensagens(conversationIdAlvo, textoUsuario, textoAssistente) {
    const conversas = carregarConversas();
    let conversa = conversas.find(c => c.id === conversationIdAlvo);

    if (!conversa) {
        conversa = {
            id: conversationIdAlvo,
            titulo: criarTituloAPartirDaMensagem(textoUsuario),
            mensagens: [],
            criada_em: new Date().toISOString(),
            atualizada_em: new Date().toISOString(),
        };
        conversas.unshift(conversa);
    }

    conversa.mensagens.push({ role: "user", content: textoUsuario });
    conversa.mensagens.push({ role: "assistant", content: textoAssistente });
    conversa.atualizada_em = new Date().toISOString();

    if (!conversa.titulo || conversa.titulo === "Nova conversa") {
        conversa.titulo = criarTituloAPartirDaMensagem(textoUsuario);
    }

    salvarConversas(conversas);
    renderizarSidebar(inputBuscaEl.value);
}

function excluirConversaStorage(id) {
    const conversas = carregarConversas().filter(c => c.id !== id);
    salvarConversas(conversas);

    if (conversationId === id) {
        iniciarNovaConversa();
    }
    renderizarSidebar(inputBuscaEl.value);
}

function renomearConversaStorage(id, novoTitulo) {
    const conversas = carregarConversas();
    const conversa = conversas.find(c => c.id === id);
    if (conversa && novoTitulo.trim()) {
        conversa.titulo = novoTitulo.trim();
        salvarConversas(conversas);
    }
    renderizarSidebar(inputBuscaEl.value);
}

// ---------- agrupamento por data (Hoje / Ontem / Últimos 7 dias / Mais antigos) ----------

function grupoDaData(isoString) {
    const data = new Date(isoString);
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

    const diaData = new Date(data);
    diaData.setHours(0, 0, 0, 0);

    const diffDias = Math.round((hoje - diaData) / (1000 * 60 * 60 * 24));

    if (diffDias <= 0) return "Hoje";
    if (diffDias === 1) return "Ontem";
    if (diffDias <= 7) return "Últimos 7 dias";
    return "Mais antigos";
}

// ---------- renderização da sidebar ----------

function renderizarSidebar(filtro = "") {
    const conversas = carregarConversas()
        .filter(c => c.titulo.toLowerCase().includes(filtro.trim().toLowerCase()))
        .sort((a, b) => new Date(b.atualizada_em) - new Date(a.atualizada_em));

    const ordemGrupos = ["Hoje", "Ontem", "Últimos 7 dias", "Mais antigos"];
    const grupos = {};
    conversas.forEach(c => {
        const g = grupoDaData(c.atualizada_em);
        if (!grupos[g]) grupos[g] = [];
        grupos[g].push(c);
    });

    listaConversasEl.innerHTML = "";

    if (conversas.length === 0) {
        const vazio = document.createElement("div");
        vazio.className = "sidebar-vazio";
        vazio.textContent = filtro ? "Nenhuma conversa encontrada." : "Suas conversas vão aparecer aqui.";
        listaConversasEl.appendChild(vazio);
        return;
    }

    ordemGrupos.forEach(nomeGrupo => {
        if (!grupos[nomeGrupo]) return;

        const secao = document.createElement("div");
        secao.className = "sidebar-grupo";

        const titulo = document.createElement("div");
        titulo.className = "sidebar-grupo-titulo";
        titulo.textContent = nomeGrupo;
        secao.appendChild(titulo);

        grupos[nomeGrupo].forEach(conversa => {
            secao.appendChild(criarItemConversa(conversa));
        });

        listaConversasEl.appendChild(secao);
    });
}

function criarItemConversa(conversa) {
    const item = document.createElement("div");
    item.className = "sidebar-item" + (conversa.id === conversationId ? " ativo" : "");
    item.dataset.id = conversa.id;

    const textoTitulo = document.createElement("span");
    textoTitulo.className = "sidebar-item-titulo";
    textoTitulo.textContent = conversa.titulo;
    item.appendChild(textoTitulo);

    const acoes = document.createElement("div");
    acoes.className = "sidebar-item-acoes";

    const btnRenomear = document.createElement("button");
    btnRenomear.className = "sidebar-item-btn";
    btnRenomear.title = "Renomear";
    btnRenomear.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
    btnRenomear.addEventListener("click", (e) => {
        e.stopPropagation();
        const novoTitulo = prompt("Renomear conversa:", conversa.titulo);
        if (novoTitulo !== null) renomearConversaStorage(conversa.id, novoTitulo);
    });

    const btnExcluir = document.createElement("button");
    btnExcluir.className = "sidebar-item-btn";
    btnExcluir.title = "Excluir";
    btnExcluir.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>`;
    btnExcluir.addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm(`Excluir a conversa "${conversa.titulo}"? Essa ação não pode ser desfeita.`)) {
            excluirConversaStorage(conversa.id);
        }
    });

    acoes.appendChild(btnRenomear);
    acoes.appendChild(btnExcluir);
    item.appendChild(acoes);

    item.addEventListener("click", () => abrirConversa(conversa.id));

    return item;
}

// ---------- abrir / iniciar conversa ----------

function abrirConversa(id) {
    const conversa = obterConversa(id);
    if (!conversa) return;

    conversationId = conversa.id;
    historico = conversa.mensagens.map(m => ({ role: m.role, content: m.content }));
    tituloConversaAtualEl.textContent = conversa.titulo;

    chatEl.innerHTML = "";
    esconderEstadoVazio();

    conversa.mensagens.forEach(m => {
        if (m.role === "user") {
            criarBolhaUsuario(m.content);
        } else {
            const bubbleEl = criarBolhaAssistente();
            const container = document.createElement("div");
            bubbleEl.innerHTML = "";
            bubbleEl.appendChild(container);
            renderizarMarkdown(container, m.content);
        }
    });

    rolarParaFinal();
    renderizarSidebar(inputBuscaEl.value);
    fecharSidebarMobile();
}

function iniciarNovaConversa() {
    conversationId = null;
    historico = [];
    tituloConversaAtualEl.textContent = "Como posso ajudar?";
    chatEl.innerHTML = "";
    chatEl.appendChild(emptyStateEl);
    mostrarEstadoVazio();
    inputEl.value = "";
    ajustarAlturaTextarea();
    inputEl.focus();
    renderizarSidebar(inputBuscaEl.value);
}

// ---------- helpers de UI ----------

function esconderEstadoVazio() {
    if (emptyStateEl) emptyStateEl.style.display = "none";
}

function mostrarEstadoVazio() {
    if (emptyStateEl) emptyStateEl.style.display = "flex";
}

function rolarParaFinal() {
    chatEl.scrollTop = chatEl.scrollHeight;
}

function iniciaisAssistente() {
    return "HR";
}

function criarBolhaUsuario(texto) {
    const row = document.createElement("div");
    row.className = "message-row user";
    row.innerHTML = `<div class="bubble"></div>`;
    row.querySelector(".bubble").textContent = texto;
    chatEl.appendChild(row);
    rolarParaFinal();
}

function criarBolhaAssistente() {
    const row = document.createElement("div");
    row.className = "message-row assistant";
    row.innerHTML = `
        <div class="avatar">${iniciaisAssistente()}</div>
        <div class="bubble">
            <div class="typing-indicator">
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
            </div>
        </div>
    `;
    chatEl.appendChild(row);
    rolarParaFinal();
    return row.querySelector(".bubble");
}

function renderizarMarkdown(bubbleEl, textoAcumulado) {
    try {
        bubbleEl.innerHTML = marked.parse(textoAcumulado);
    } catch (e) {
        bubbleEl.textContent = textoAcumulado;
    }
}

function montarCardsProduto(produtos) {
    if (!produtos || produtos.length === 0) return null;

    const wrapper = document.createElement("div");
    wrapper.className = "product-cards";

    produtos.forEach(p => {
        const card = document.createElement("a");
        card.className = "product-card";
        card.href = p.link || "#";
        card.target = "_blank";
        card.rel = "noopener noreferrer";

        card.innerHTML = `
            <img class="product-card-img" src="${p.imagem || ''}" alt="${escaparHtml(p.nome)}" loading="lazy"
                 onerror="this.style.opacity=0">
            <div class="product-card-body">
                <span class="product-card-cat">${escaparHtml(p.categoria || '')}</span>
                <span class="product-card-nome">${escaparHtml(p.nome || '')}</span>
            </div>
        `;
        wrapper.appendChild(card);
    });

    return wrapper;
}

function escaparHtml(texto) {
    const div = document.createElement("div");
    div.textContent = texto || "";
    return div.innerHTML;
}

// ---------- envio da mensagem ----------

async function enviarMensagem(mensagem) {
    esconderEstadoVazio();
    criarBolhaUsuario(mensagem);

    inputEl.value = "";
    ajustarAlturaTextarea();
    btnEnviar.disabled = true;

    const bubbleEl = criarBolhaAssistente();
    let textoResposta = "";

    try {
        const resp = await fetch("/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mensagem, historico })
        });

        if (!resp.ok) {
            throw new Error("Falha na resposta do servidor");
        }

        const dados = await resp.json();
        textoResposta = dados.resposta || "";

        bubbleEl.innerHTML = "";
        const cardsEl = montarCardsProduto(dados.produtos);
        if (cardsEl) bubbleEl.appendChild(cardsEl);

        const textoContainer = document.createElement("div");
        textoContainer.className = "texto-resposta";
        bubbleEl.appendChild(textoContainer);
        renderizarMarkdown(textoContainer, textoResposta);
        rolarParaFinal();

        historico.push({ role: "user", content: mensagem });
        historico.push({ role: "assistant", content: textoResposta });

        if (!conversationId) conversationId = gerarId();

        registrarMensagens(conversationId, mensagem, textoResposta);
        tituloConversaAtualEl.textContent = obterConversa(conversationId)?.titulo || "Conversa";

    } catch (erro) {
        bubbleEl.innerHTML = `<p>Não consegui me conectar ao servidor. Verifique se o backend está rodando e tente novamente.</p>`;
        console.error(erro);
    } finally {
        btnEnviar.disabled = false;
        inputEl.focus();
    }
}

// ---------- sidebar: abrir/fechar no mobile ----------

function abrirSidebarMobile() {
    sidebarEl.classList.add("aberta");
    sidebarOverlayEl.classList.add("visivel");
}

function fecharSidebarMobile() {
    sidebarEl.classList.remove("aberta");
    sidebarOverlayEl.classList.remove("visivel");
}

btnAbrirSidebar.addEventListener("click", abrirSidebarMobile);
btnFecharSidebar.addEventListener("click", fecharSidebarMobile);
sidebarOverlayEl.addEventListener("click", fecharSidebarMobile);

// ---------- eventos ----------

formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const texto = inputEl.value.trim();
    if (!texto) return;
    enviarMensagem(texto);
});

inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        formEl.requestSubmit();
    }
});

inputEl.addEventListener("input", ajustarAlturaTextarea);

function ajustarAlturaTextarea() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
}

document.querySelectorAll(".suggestion-chip").forEach(chip => {
    chip.addEventListener("click", () => {
        enviarMensagem(chip.dataset.q);
    });
});

btnNovaConversa.addEventListener("click", iniciarNovaConversa);

inputBuscaEl.addEventListener("input", () => renderizarSidebar(inputBuscaEl.value));

// ---------- inicialização ----------

renderizarSidebar();
