// ==========================================================
// Prévia estática do concierge — SEM backend, SEM API real.
// As perguntas/respostas abaixo são pré-escritas só pra demonstrar a
// interface visual (mesma linguagem do widget de produção, static/widget.js
// no repositório) sem depender de Gemini/Qdrant/N8N rodando em algum lugar.
// ==========================================================

const RESPOSTAS = [
  {
    pergunta: "Qual a diferença entre uma linha própria e marcas licenciadas?",
    resposta: "A linha própria reúne fórmulas veganas e biodegradáveis, organizadas em " +
      "coleções temáticas (spa, aromaterapia, cítricos). As marcas licenciadas trazem " +
      "grifes internacionais de cosmético pro hotel que quer o reconhecimento de uma " +
      "marca que o hóspede já confia.",
  },
  {
    pergunta: "Como funciona a personalização de frascos com a marca do hotel?",
    resposta: "Existem 15 modelos de frasco disponíveis pra personalização — você escolhe " +
      "o modelo, envia a logo do hotel e recebe um mockup antes de fechar o pedido. É sob " +
      "consulta: o próximo passo é falar com um consultor comercial.",
  },
  {
    pergunta: "Vocês têm produtos pra café da manhã?",
    resposta: "Sim — há uma linha dedicada à alimentação hoteleira, com parcerias do " +
      "mercado alimentício pra minibar, café da manhã e serviços de A&B. As combinações " +
      "variam por proposta; um consultor confirma o que está disponível pro seu hotel.",
  },
];

const corpo = document.getElementById("mockBody");
const chipsEl = document.getElementById("mockChips");
let respondendo = false;

RESPOSTAS.forEach((item, indice) => {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "mock-chip";
  chip.textContent = item.pergunta;
  chip.addEventListener("click", () => responder(indice, chip));
  chipsEl.appendChild(chip);
});

function bloquearChips() {
  chipsEl.querySelectorAll(".mock-chip").forEach((c) => (c.disabled = true));
}

function criarBolha(tipo, texto) {
  const bolha = document.createElement("div");
  bolha.className = `mock-bubble ${tipo}`;
  bolha.textContent = texto;
  corpo.appendChild(bolha);
  corpo.scrollTop = corpo.scrollHeight;
  return bolha;
}

async function responder(indice, chipEl) {
  if (respondendo) return;
  respondendo = true;
  bloquearChips();

  const item = RESPOSTAS[indice];
  criarBolha("user", item.pergunta);

  const bolhaResposta = criarBolha("bot", "");
  await digitar(bolhaResposta, item.resposta);

  respondendo = false;
}

function digitar(elemento, texto) {
  const respeitaReduzMovimento = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (respeitaReduzMovimento) {
    elemento.textContent = texto;
    return Promise.resolve();
  }
  // setTimeout (não requestAnimationFrame) de propósito: rAF pausa por
  // completo numa aba em segundo plano/oculta, deixando a resposta "presa"
  // vazia se o visitante trocar de aba no meio da animação. setTimeout só
  // desacelera nesse cenário, nunca trava de vez.
  return new Promise((resolve) => {
    let i = 0;
    const passo = () => {
      i += 3;
      elemento.textContent = texto.slice(0, i);
      corpo.scrollTop = corpo.scrollHeight;
      if (i < texto.length) {
        setTimeout(passo, 16);
      } else {
        elemento.textContent = texto;
        resolve();
      }
    };
    passo();
  });
}
