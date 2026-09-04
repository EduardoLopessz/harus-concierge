/**
 * Widget de chat embutível — Concierge de Produtos Harus.
 *
 * Uso básico: incluir uma única tag de script em qualquer página do site
 * institucional da Harus:
 *   <script src="https://SEU_BACKEND/static/widget.js" data-api-base="https://SEU_BACKEND"></script>
 *
 * Diferente do site institucional (harus.ind.br), que não tem área logada
 * pra cliente comum, este widget é público — qualquer visitante (comprador
 * de hotel/pousada avaliando o portfólio) pode conversar, sem exigir login.
 * Rastreamento opcional por visitante (sem PII) via data-usuario-id, se
 * quem integrar quiser correlacionar perguntas a uma sessão/CRM externo:
 *
 *   data-usuario-id="ID_OPACO_DO_VISITANTE"
 *     Identificador anônimo/opaco (ex.: um ID de sessão, hash) — NUNCA
 *     nome, e-mail, telefone ou qualquer PII. Se fornecido, é enviado ao
 *     backend em cada pergunta e registrado no log de conversas
 *     (logs/conversas.jsonl) só pra permitir rastreabilidade sem armazenar
 *     dado pessoal nenhum.
 *
 * Usa Shadow DOM pra isolar o CSS do widget do CSS da página hospedeira.
 */
(function () {
    const scriptAtual = document.currentScript;
    const API_BASE = (scriptAtual && scriptAtual.dataset.apiBase) || "";
    const USUARIO_ID = (scriptAtual && scriptAtual.dataset.usuarioId) || null;

    // session_id: identifica a conversa pro histórico ficar guardado no
    // servidor (Redis, com TTL). Usa sessionStorage de propósito — some
    // quando a aba/navegador fecha.
    const CHAVE_SESSION_STORAGE = "harus_session_id";
    let SESSION_ID = sessionStorage.getItem(CHAVE_SESSION_STORAGE);
    if (!SESSION_ID) {
        SESSION_ID = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : `sessao-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        sessionStorage.setItem(CHAVE_SESSION_STORAGE, SESSION_ID);
    }

    // Destino do "Fale com um consultor" no rodapé — orçamento/WhatsApp são o
    // objetivo final da conversa (catálogo B2B, sem e-commerce). O site pode
    // sobrescrever via data-url-contato.
    const URL_CONTATO =
        (scriptAtual && scriptAtual.dataset.urlContato) || "https://harus.ind.br/site/contato/";

    const CORES = {
        gold: "#B89A57",
        goldEscuro: "#9A7E45",
        dark: "#162330",
        light: "#F7F5F2",
        borda: "#E7E1D6",
    };

    const host = document.createElement("div");
    host.id = "harus-widget-host";
    document.body.appendChild(host);
    const raiz = host.attachShadow({ mode: "open" });

    raiz.innerHTML = `
        <style>
            :host { all: initial; }
            * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }

            @keyframes flutuar {
                0%, 100% { transform: translateY(0); }
                50% { transform: translateY(-6px); }
            }
            @keyframes pulso-anel {
                0% { box-shadow: 0 4px 14px rgba(184,154,87,0.45), 0 0 0 0 rgba(184,154,87,0.45); }
                70% { box-shadow: 0 4px 14px rgba(184,154,87,0.45), 0 0 0 14px rgba(184,154,87,0); }
                100% { box-shadow: 0 4px 14px rgba(184,154,87,0.45), 0 0 0 0 rgba(184,154,87,0); }
            }

            .lancador {
                position: fixed;
                bottom: 24px;
                right: 24px;
                width: 60px;
                height: 60px;
                border-radius: 50%;
                background: ${CORES.dark};
                box-shadow: 0 4px 14px rgba(22,35,48,0.4);
                border: 1.5px solid ${CORES.gold};
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 999999;
                transition: transform 0.2s ease, opacity 0.2s ease;
                animation: flutuar 2.8s ease-in-out infinite, pulso-anel 2.8s ease-out infinite;
            }
            .lancador:hover {
                transform: scale(1.08);
                animation-play-state: paused;
            }
            .lancador.escondido {
                opacity: 0;
                transform: scale(0.5);
                pointer-events: none;
                animation: none;
            }
            .lancador svg { width: 26px; height: 26px; }

            .painel {
                position: fixed;
                bottom: 96px;
                right: 24px;
                width: 380px;
                max-width: calc(100vw - 32px);
                height: 560px;
                max-height: calc(100vh - 140px);
                background: #fff;
                border-radius: 16px;
                box-shadow: 0 12px 40px rgba(0,0,0,0.18);
                display: flex;
                flex-direction: column;
                overflow: hidden;
                z-index: 999999;
                transform-origin: bottom right;
                opacity: 0;
                visibility: hidden;
                transform: scale(0.9) translateY(16px);
                pointer-events: none;
                transition: opacity 0.22s ease, transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1), visibility 0.22s;
            }
            .painel.aberto {
                opacity: 1;
                visibility: visible;
                transform: scale(1) translateY(0);
                pointer-events: auto;
            }

            .cabecalho {
                background: ${CORES.dark};
                color: #fff;
                padding: 14px 16px;
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .cabecalho-titulo { font-weight: 600; font-size: 15px; flex: 1; }
            .cabecalho-sub { font-size: 12px; opacity: 0.7; display: block; color: ${CORES.gold}; }
            .btn-fechar {
                background: none; border: none; color: #fff; cursor: pointer;
                opacity: 0.85; padding: 4px;
            }
            .btn-fechar:hover { opacity: 1; }

            .corpo {
                flex: 1;
                overflow-y: auto;
                padding: 16px;
                display: flex;
                flex-direction: column;
                gap: 12px;
                background: ${CORES.light};
            }

            .boas-vindas { font-size: 13px; color: #55606b; line-height: 1.5; }
            .selo-escopo { display: block; width: fit-content; background: #fff; border-left: 3px solid ${CORES.gold}; border-radius: 4px; padding: 5px 9px; margin-bottom: 10px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: ${CORES.dark}; }
            .boas-vindas-limite { margin-top: 8px; font-size: 12.5px; color: #6b7480; }
            .sugestoes { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
            .chip-sugestao {
                text-align: left;
                background: #fff;
                border: 1px solid ${CORES.borda};
                border-radius: 10px;
                padding: 8px 10px;
                font-size: 12.5px;
                color: ${CORES.dark};
                cursor: pointer;
            }
            .chip-sugestao:hover { border-color: ${CORES.gold}; }

            .bolha {
                max-width: 85%;
                padding: 10px 13px;
                border-radius: 14px;
                font-size: 13.5px;
                line-height: 1.5;
                white-space: pre-wrap;
                word-wrap: break-word;
            }
            .bolha p { margin: 0 0 6px; }
            .bolha p:last-child { margin-bottom: 0; }
            .bolha ul { margin: 0 0 6px; padding-left: 18px; }
            .bolha li { margin-bottom: 2px; }
            .bolha a { color: ${CORES.goldEscuro}; font-weight: 600; }
            .bolha-usuario a { color: #fff; text-decoration: underline; }
            .bolha-usuario {
                align-self: flex-end;
                background: ${CORES.dark};
                color: #fff;
                border-bottom-right-radius: 4px;
            }
            .bolha-assistente {
                align-self: flex-start;
                background: #fff;
                color: #1f2933;
                border: 1px solid ${CORES.borda};
                border-bottom-left-radius: 4px;
            }
            .bolha-assistente.erro {
                border-color: #f0b3a0;
                border-left: 3px solid #d9502a;
                background: #fdf5f2;
            }

            .digitando { display: flex; gap: 4px; padding: 4px 2px; }
            .digitando span {
                width: 6px; height: 6px; border-radius: 50%;
                background: #9aa5b1;
                animation: pulso-ponto 1.1s ease-in-out infinite;
            }
            .digitando span:nth-child(2) { animation-delay: 0.15s; }
            .digitando span:nth-child(3) { animation-delay: 0.3s; }
            @keyframes pulso-ponto {
                0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
                30% { opacity: 1; transform: translateY(-3px); }
            }

            .cards-produto { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
            .card-produto {
                display: flex;
                gap: 8px;
                align-items: center;
                background: #fff;
                border: 1px solid ${CORES.borda};
                border-radius: 10px;
                padding: 8px;
                text-decoration: none;
                color: inherit;
            }
            .card-produto img { width: 40px; height: 40px; object-fit: contain; border-radius: 6px; flex-shrink: 0; background: ${CORES.light}; }
            .card-produto-nome { font-size: 12px; font-weight: 600; color: ${CORES.dark}; line-height: 1.3; }
            .card-produto-cat { font-size: 10.5px; color: #8a97a3; }

            .rodape {
                border-top: 1px solid ${CORES.borda};
                padding: 10px;
                display: flex;
                gap: 8px;
                background: #fff;
            }
            .campo-mensagem {
                flex: 1;
                border: 1px solid ${CORES.borda};
                border-radius: 20px;
                padding: 9px 14px;
                font-size: 13px;
                resize: none;
                max-height: 80px;
                outline: none;
            }
            .campo-mensagem:focus { border-color: ${CORES.gold}; }
            .btn-enviar {
                width: 38px; height: 38px; border-radius: 50%;
                background: ${CORES.dark};
                border: 1.5px solid ${CORES.gold};
                color: #fff; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                flex-shrink: 0;
            }
            .btn-enviar:hover { background: #0d1620; }
            .btn-enviar:disabled { opacity: 0.5; cursor: default; }

            .aviso {
                font-size: 10px;
                color: #9aa5b1;
                text-align: center;
                padding: 4px 10px 8px;
                background: #fff;
            }
            .aviso a { color: ${CORES.goldEscuro}; font-weight: 600; text-decoration: underline; }
        </style>

        <button class="lancador" aria-label="Abrir concierge Harus" title="Fale com o Concierge Harus">
            <svg viewBox="0 0 24 24" fill="none" stroke="#B89A57" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
            </svg>
        </button>

        <div class="painel">
            <div class="cabecalho">
                <span class="cabecalho-titulo">Concierge de Produtos Harus
                    <span class="cabecalho-sub">Amenities, personalizados e mais</span>
                </span>
                <button class="btn-fechar" aria-label="Fechar">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                </button>
            </div>
            <div class="corpo" id="corpo"></div>
            <form class="rodape" id="form">
                <textarea class="campo-mensagem" id="campo" placeholder="Pergunte sobre uma linha ou produto..." rows="1"></textarea>
                <button type="submit" class="btn-enviar" id="btnEnviar" aria-label="Enviar">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
                </button>
            </form>
            <div class="aviso">O assistente pode cometer erros. Para orçamentos e condições, fale com um <a href="${URL_CONTATO}" target="_blank" rel="noopener noreferrer">consultor Harus</a>.</div>
        </div>
    `;

    const lancador = raiz.querySelector(".lancador");
    const painel = raiz.querySelector(".painel");
    const btnFechar = raiz.querySelector(".btn-fechar");
    const corpo = raiz.querySelector("#corpo");
    const form = raiz.querySelector("#form");
    const campo = raiz.querySelector("#campo");
    const btnEnviar = raiz.querySelector("#btnEnviar");

    const SUGESTOES = [
        "Quais linhas de amenities vocês têm pra um hotel de praia?",
        "Qual a diferença entre a Alma Brasil e a House of Brands?",
        "Como funciona a personalização de frascos com a marca do meu hotel?",
    ];

    let conversaIniciada = false;

    function escaparHtml(texto) {
        const div = document.createElement("div");
        div.textContent = texto || "";
        return div.innerHTML;
    }

    function renderizarTextoSimples(texto) {
        const linhas = texto.split("\n");
        let html = "";
        let dentroDeLista = false;

        const linkarUrlPelada = (html) =>
            html.replace(/(?<!href=")(https?:\/\/[^\s<]+)/g, (match) => {
                const pontuacaoFinal = match.match(/[.,;:!?)]+$/);
                const url = pontuacaoFinal ? match.slice(0, -pontuacaoFinal[0].length) : match;
                const sufixo = pontuacaoFinal ? pontuacaoFinal[0] : "";
                return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${sufixo}`;
            });

        const formatarInline = (linha) =>
            linkarUrlPelada(
                escaparHtml(linha).replace(
                    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
                    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
                )
            ).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

        for (const linhaBruta of linhas) {
            const item = linhaBruta.match(/^\s*[*-]\s+(.*)/);
            if (item) {
                if (!dentroDeLista) {
                    html += "<ul>";
                    dentroDeLista = true;
                }
                html += `<li>${formatarInline(item[1])}</li>`;
                continue;
            }
            if (dentroDeLista) {
                html += "</ul>";
                dentroDeLista = false;
            }
            if (linhaBruta.trim() === "") continue;
            html += `<p>${formatarInline(linhaBruta)}</p>`;
        }
        if (dentroDeLista) html += "</ul>";

        return html;
    }

    function mostrarBoasVindas() {
        if (corpo.querySelector(".boas-vindas")) return;

        const bloco = document.createElement("div");
        bloco.className = "boas-vindas";
        bloco.innerHTML = `
            <div class="selo-escopo">Concierge do portfólio Harus</div>
            <strong>Olá! 👋</strong> Posso ajudar você a explorar as linhas e coleções
            da Harus — amenities, personalizados, acessórios e mais — e indicar o
            que combina melhor com o seu hotel ou pousada.
            <div class="boas-vindas-limite">
                Não tenho acesso a preço, estoque ou prazo em tempo real — tudo aqui
                é sob consulta. Quando quiser avançar, te direciono pro nosso time comercial.
            </div>
            <div class="sugestoes"></div>
        `;
        const sugestoesEl = bloco.querySelector(".sugestoes");
        SUGESTOES.forEach((s) => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "chip-sugestao";
            chip.textContent = s;
            chip.addEventListener("click", () => enviarMensagem(s));
            sugestoesEl.appendChild(chip);
        });
        corpo.appendChild(bloco);
    }

    function criarBolha(tipo) {
        const bolha = document.createElement("div");
        bolha.className = `bolha bolha-${tipo}`;
        corpo.appendChild(bolha);
        corpo.scrollTop = corpo.scrollHeight;
        return bolha;
    }

    function montarCardsProduto(produtos) {
        if (!produtos || produtos.length === 0) return null;
        const wrapper = document.createElement("div");
        wrapper.className = "cards-produto";
        produtos.forEach((p) => {
            const card = document.createElement("a");
            card.className = "card-produto";
            card.href = p.link || "#";
            card.target = "_blank";
            card.rel = "noopener noreferrer";
            card.innerHTML = `
                <img src="${escaparHtml(p.imagem || "")}" alt="" onerror="this.style.visibility='hidden'">
                <div>
                    <div class="card-produto-nome">${escaparHtml(p.nome || "")}</div>
                    <div class="card-produto-cat">${escaparHtml(p.categoria || "")}</div>
                </div>
            `;
            wrapper.appendChild(card);
        });
        return wrapper;
    }

    async function enviarMensagem(mensagem) {
        mensagem = mensagem.trim();
        if (!mensagem) return;

        if (!conversaIniciada) {
            corpo.innerHTML = "";
            conversaIniciada = true;
        }

        criarBolha("usuario").textContent = mensagem;
        campo.value = "";
        btnEnviar.disabled = true;

        const bolhaResposta = criarBolha("assistente");
        bolhaResposta.innerHTML = '<div class="digitando"><span></span><span></span><span></span></div>';

        try {
            const resp = await fetch(`${API_BASE}/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    mensagem,
                    usuario_id: USUARIO_ID,
                    session_id: SESSION_ID,
                    pagina_atual: window.location.href,
                }),
            });

            if (!resp.ok) throw new Error("Falha na resposta do servidor");

            const dados = await resp.json();

            bolhaResposta.innerHTML = "";
            const cardsEl = montarCardsProduto(dados.produtos);
            if (cardsEl) bolhaResposta.appendChild(cardsEl);

            const textoContainer = document.createElement("div");
            textoContainer.className = "texto-resposta";
            textoContainer.innerHTML = renderizarTextoSimples(dados.resposta || "");
            bolhaResposta.appendChild(textoContainer);
            corpo.scrollTop = corpo.scrollHeight;
        } catch (erro) {
            bolhaResposta.classList.add("erro");
            bolhaResposta.innerHTML = renderizarTextoSimples("Não consegui falar com o assistente agora. Tente novamente em instantes.");
        } finally {
            btnEnviar.disabled = false;
            campo.focus();
        }
    }

    function fecharPainel() {
        painel.classList.remove("aberto");
        lancador.classList.remove("escondido");
    }

    lancador.addEventListener("click", () => {
        painel.classList.add("aberto");
        lancador.classList.add("escondido");
        if (!conversaIniciada) mostrarBoasVindas();
        setTimeout(() => campo.focus(), 150);
    });

    btnFechar.addEventListener("click", fecharPainel);

    raiz.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && painel.classList.contains("aberto")) {
            fecharPainel();
        }
    });

    form.addEventListener("submit", (e) => {
        e.preventDefault();
        enviarMensagem(campo.value);
    });

    campo.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            form.requestSubmit();
        }
    });

    // API pra encerrar o histórico de sessão manualmente, se necessário:
    //   window.HarusWidget.logout();
    window.HarusWidget = window.HarusWidget || {};
    window.HarusWidget.logout = async function () {
        try {
            await fetch(`${API_BASE}/logout`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ session_id: SESSION_ID }),
            });
        } catch (erro) {
            // limpeza é best-effort
        } finally {
            sessionStorage.removeItem(CHAVE_SESSION_STORAGE);
        }
    };
})();
