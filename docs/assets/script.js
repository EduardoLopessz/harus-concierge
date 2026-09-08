// ==========================================================
// Prévia do concierge — busca REAL sobre os 707 itens do catálogo
// (docs/assets/data/catalog.json, gerado pelo scraper_produtos_harus.py).
//
// Ranking híbrido, 100% client-side, sem LLM nenhum:
//   1) TF-IDF + similaridade de cosseno sobre o "documento" de cada item
//      (nome + linha + coleção + descrição da coleção + descrição editorial
//      da linha) — termos raros (ex.: "castanha", "aromatherapy") pesam mais
//      que termos genéricos ("shampoo", "sabonete", que aparecem em quase
//      toda coleção) automaticamente, via IDF.
//   2) Reforço estruturado: match exato/por-prefixo em campos específicos
//      (linha, coleção, nome) soma pontos extras — o texto livre sozinho
//      erra fácil em catálogos com nomes curtos e repetitivos.
// A versão de produção (n8n + Gemini + Qdrant, ver README) troca isso por
// embeddings semânticos de verdade; esta prévia existe pra mostrar um
// resultado honesto sem precisar de backend/API paga rodando.
// ==========================================================

const corpo = document.getElementById("mockBody");
const chipsEl = document.getElementById("mockChips");
const formEl = document.getElementById("mockForm");
const inputEl = document.getElementById("mockInput");
const btnEnviarEl = document.getElementById("mockEnviar");
const topicosEl = document.getElementById("mockTopicos");
const heroGaleriaEl = document.getElementById("heroGallery");

let CATALOGO = [];
let TOPICOS = [];
let LINHA_DESC = {}; // linha -> descrição editorial da página-hub (ver topicos.json)
let INDICE_TFIDF = null; // { docs: [{item, vetor: Map}], idf: Map, normaConsulta(tokens) }
let respondendo = false;
let conversaIniciada = false;

const SUGESTOES = [
  "Quais coleções fazem parte da linha própria?",
  "O que a Harus Food oferece pra café da manhã?",
  "Quantos itens vocês têm em acessórios de banheiro?",
];

// ---------- normalização / busca ----------

function normalizar(texto) {
  return (texto || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// Palavras genéricas demais pra carregar sinal — descrições de coleção
// repetem "hotel"/"hóspede"/"pousada" à exaustão (é o vocabulário natural
// do catálogo B2B), então sem filtrar isso qualquer pergunta "puxa" itens
// aleatórios só porque a descrição da coleção deles também menciona hotel.
const STOPWORDS = new Set([
  "que", "quais", "qual", "para", "pra", "com", "sem", "uma", "um", "dos",
  "das", "voce", "voces", "tem", "tem", "vocês", "the", "and", "sao", "ser",
  "esta", "este", "essa", "esse", "como", "mais", "tambem", "onde", "hotel",
  "hoteis", "hospede", "hospedes", "pousada", "pousadas", "produto",
  "produtos", "harus", "catalogo", "linha", "linhas", "colecao", "colecoes",
]);

function tokenizar(texto) {
  return normalizar(texto)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

// Casamento por prefixo (não substring cru) — resolve plural/singular sem
// precisar de um stemmer de verdade ("veganos" ~ "vegano", "biodegradáveis"
// ~ "biodegradável"): palavras de 4+ letras casam se os 4 primeiros
// caracteres batem; palavras curtas exigem que uma seja prefixo da outra.
function casam(palavraCampo, token) {
  if (palavraCampo.length < 4 || token.length < 4) {
    return palavraCampo.startsWith(token) || token.startsWith(palavraCampo);
  }
  return palavraCampo.slice(0, 4) === token.slice(0, 4);
}

function contemToken(textoCampo, token) {
  const palavras = textoCampo.split(/[^a-z0-9]+/).filter(Boolean);
  return palavras.some((p) => casam(p, token));
}

function pontuarEstrutura(item, tokens, linhaDesc) {
  const campos = {
    linha: normalizar(item.linha),
    categoria: normalizar(item.categoria),
    name: normalizar(item.name),
    desc: normalizar(item.desc),
    linhaDesc: normalizar(linhaDesc || ""),
  };
  let pontosFortes = 0;
  let pontosDesc = 0;
  for (const t of tokens) {
    if (contemToken(campos.linha, t)) pontosFortes += 4;
    if (contemToken(campos.categoria, t)) pontosFortes += 4;
    if (contemToken(campos.name, t)) pontosFortes += 2;
    // a descrição da linha (ex.: "café da manhã, minibar..." da Harus Food)
    // é texto editorial específico por linha — vale como sinal forte, ao
    // contrário da descrição de coleção (repetida em dezenas de itens).
    if (contemToken(campos.linhaDesc, t)) pontosFortes += 3;
    if (contemToken(campos.desc, t)) pontosDesc += 1;
  }
  // a descrição da coleção só reforça um item que já bateu em outro campo —
  // sozinha ela não é específica o suficiente pra qualificar nada.
  return pontosFortes + (pontosFortes > 0 ? pontosDesc * 0.5 : 0);
}

// ---------- índice TF-IDF (construído uma vez, no carregamento) ----------

function montarDocumento(item) {
  // a descrição da LINHA fica de fora de propósito: ela é idêntica pra
  // todo item da mesma linha (ex.: os ~90 itens de Harus Food têm o mesmo
  // texto "café da manhã, minibar..."), então no TF-IDF ela só distorcia a
  // norma do vetor sem diferenciar item nenhum — favorecia itens com nome
  // curto por acidente. Fica só no reforço estrutural (pontuarEstrutura),
  // que soma um bônus parelho pra linha inteira sem afetar a similaridade
  // relativa entre os itens dela. O nome entra 2x pra pesar mais.
  return [item.name, item.name, item.linha, item.categoria, item.desc].join(" ");
}

function construirIndiceTfIdf() {
  const documentos = CATALOGO.map((item) => tokenizar(montarDocumento(item)));
  const N = documentos.length;

  const df = new Map(); // em quantos documentos cada termo aparece
  documentos.forEach((tokens) => {
    new Set(tokens).forEach((t) => df.set(t, (df.get(t) || 0) + 1));
  });

  const idf = new Map();
  df.forEach((contagem, termo) => idf.set(termo, Math.log((N + 1) / (contagem + 1)) + 1));

  const docs = CATALOGO.map((item, i) => {
    const tokens = documentos[i];
    const tf = new Map();
    tokens.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));

    const vetor = new Map();
    tf.forEach((freq, termo) => vetor.set(termo, freq * (idf.get(termo) || 0)));

    let normaSq = 0;
    vetor.forEach((peso) => (normaSq += peso * peso));

    return { item, vetor, norma: Math.sqrt(normaSq) || 1 };
  });

  return { docs, idf };
}

function vetorConsulta(tokens, idf) {
  const tf = new Map();
  tokens.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
  const vetor = new Map();
  tf.forEach((freq, termo) => {
    if (idf.has(termo)) vetor.set(termo, freq * idf.get(termo));
  });
  let normaSq = 0;
  vetor.forEach((peso) => (normaSq += peso * peso));
  return { vetor, norma: Math.sqrt(normaSq) || 1 };
}

function cosseno(vetorA, normaA, vetorB, normaB) {
  // itera sobre o menor dos dois vetores — mais rápido, mesmo resultado
  const [menor, maior] = vetorA.size < vetorB.size ? [vetorA, vetorB] : [vetorB, vetorA];
  let produto = 0;
  menor.forEach((peso, termo) => {
    if (maior.has(termo)) produto += peso * maior.get(termo);
  });
  return produto / (normaA * normaB);
}

function buscar(pergunta, limite = 6) {
  const tokens = tokenizar(pergunta);
  if (tokens.length === 0) return [];

  const consulta = vetorConsulta(tokens, INDICE_TFIDF.idf);

  const pontuados = INDICE_TFIDF.docs
    .map(({ item, vetor, norma }) => {
      const simCosseno = cosseno(consulta.vetor, consulta.norma, vetor, norma);
      const estrutura = pontuarEstrutura(item, tokens, LINHA_DESC[item.linha]);
      // cosseno vai de 0 a ~1 — escalado pra ficar na mesma ordem de
      // grandeza do reforço estrutural (que soma pontos inteiros por campo)
      return { item, pontos: simCosseno * 14 + estrutura };
    })
    .filter((r) => r.pontos > 0.15)
    .sort((a, b) => b.pontos - a.pontos);

  // dedupe por categoria — não faz sentido mostrar 6 cards da mesma coleção
  const vistas = new Set();
  const resultado = [];
  for (const r of pontuados) {
    const chave = r.item.linha + "|" + r.item.categoria;
    if (vistas.has(chave) && resultado.length > 1) continue;
    vistas.add(chave);
    resultado.push(r.item);
    if (resultado.length >= limite) break;
  }
  return resultado;
}

function montarResposta(pergunta, itens) {
  if (itens.length === 0) {
    const linhasDisponiveis = TOPICOS.map((t) => t.linha).join(", ");
    return `Não encontrei nada no catálogo indexado pra isso. Posso falar sobre: ${linhasDisponiveis}. Tenta reformular citando uma dessas linhas ou uma coleção específica.`;
  }

  const linhasEnvolvidas = [...new Set(itens.map((i) => i.linha))];
  const categoriasEnvolvidas = [...new Set(itens.map((i) => i.categoria))];

  let intro;
  if (linhasEnvolvidas.length === 1) {
    intro = `Na linha ${linhasEnvolvidas[0]}, encontrei ${itens.length} item(ns) relacionado(s)`;
    if (categoriasEnvolvidas.length > 1) {
      intro += `, nas coleções ${categoriasEnvolvidas.slice(0, 3).join(", ")}`;
    }
    intro += ".";
  } else {
    intro = `Encontrei itens em ${linhasEnvolvidas.length} linhas diferentes: ${linhasEnvolvidas.join(", ")}.`;
  }

  // prioriza a descrição editorial da linha (mais informativa) sobre a
  // descrição da coleção específica (mais repetitiva entre itens)
  const complementoTexto =
    (linhasEnvolvidas.length === 1 && LINHA_DESC[linhasEnvolvidas[0]]) ||
    itens.find((i) => i.desc)?.desc ||
    "";
  const complemento = complementoTexto ? ` ${complementoTexto}` : "";

  return intro + complemento;
}

// ---------- UI ----------

function criarBolha(tipo) {
  const bolha = document.createElement("div");
  bolha.className = `mock-bubble ${tipo}`;
  corpo.appendChild(bolha);
  corpo.scrollTop = corpo.scrollHeight;
  return bolha;
}

function montarCardsItem(itens) {
  if (itens.length === 0) return null;
  const wrapper = document.createElement("div");
  wrapper.className = "mock-cards";
  itens.slice(0, 4).forEach((item) => {
    const card = document.createElement("a");
    card.className = "mock-card";
    card.href = item.url || "#";
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    img.src = item.img || "";
    img.onerror = () => (img.style.visibility = "hidden");
    const info = document.createElement("div");
    info.innerHTML = `<span class="mock-card-nome"></span><span class="mock-card-cat"></span>`;
    info.querySelector(".mock-card-nome").textContent = item.name;
    info.querySelector(".mock-card-cat").textContent = `${item.linha} · ${item.categoria}`;
    card.appendChild(img);
    card.appendChild(info);
    wrapper.appendChild(card);
  });
  return wrapper;
}

function bloquearEntrada(bloquear) {
  inputEl.disabled = bloquear;
  btnEnviarEl.disabled = bloquear;
  chipsEl.querySelectorAll(".mock-chip").forEach((c) => (c.disabled = bloquear));
}

async function perguntar(pergunta) {
  pergunta = pergunta.trim();
  if (!pergunta || respondendo) return;

  if (!conversaIniciada) {
    corpo.innerHTML = "";
    conversaIniciada = true;
  }

  respondendo = true;
  bloquearEntrada(true);

  criarBolha("user").textContent = pergunta;
  inputEl.value = "";

  const bolhaResposta = criarBolha("bot");
  bolhaResposta.innerHTML = '<div class="mock-digitando"><span></span><span></span><span></span></div>';
  await new Promise((r) => setTimeout(r, 320)); // pausa curta só pra simular "pensando" — a busca em si é instantânea

  const itens = buscar(pergunta);
  const resposta = montarResposta(pergunta, itens);

  bolhaResposta.innerHTML = "";
  const cardsEl = montarCardsItem(itens);
  if (cardsEl) bolhaResposta.appendChild(cardsEl);
  const textoEl = document.createElement("div");
  textoEl.className = "mock-texto";
  bolhaResposta.appendChild(textoEl);
  await digitar(textoEl, resposta);

  respondendo = false;
  bloquearEntrada(false);
  inputEl.focus();
}

function digitar(elemento, texto) {
  const respeitaReduzMovimento = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (respeitaReduzMovimento) {
    elemento.textContent = texto;
    return Promise.resolve();
  }
  // setTimeout (não requestAnimationFrame) de propósito: rAF pausa por
  // completo numa aba em segundo plano/oculta, deixando a resposta "presa"
  // vazia se o visitante trocar de aba no meio da animação.
  return new Promise((resolve) => {
    let i = 0;
    const passo = () => {
      i += 3;
      elemento.textContent = texto.slice(0, i);
      corpo.scrollTop = corpo.scrollHeight;
      if (i < texto.length) {
        setTimeout(passo, 14);
      } else {
        elemento.textContent = texto;
        resolve();
      }
    };
    passo();
  });
}

// ---------- tópicos (do que ela sabe falar) ----------

function renderizarTopicos() {
  if (!topicosEl) return;
  topicosEl.innerHTML = "";
  TOPICOS.forEach((t) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "topico-card";
    card.innerHTML = `
      <div class="topico-capa"><img loading="lazy" alt=""></div>
      <span class="topico-linha"></span>
      <span class="topico-count"></span>
      <span class="topico-colecoes"></span>
    `;
    const img = card.querySelector("img");
    img.src = t.img || "";
    img.onerror = () => (card.querySelector(".topico-capa").style.display = "none");
    card.querySelector(".topico-linha").textContent = t.linha;
    card.querySelector(".topico-count").textContent = `${t.count} itens`;
    card.querySelector(".topico-colecoes").textContent = t.categorias.slice(0, 4).join(" · ") + (t.categorias.length > 4 ? "…" : "");
    card.addEventListener("click", () => {
      document.getElementById("previa").scrollIntoView({ behavior: "smooth", block: "start" });
      inputEl.value = `O que tem na linha ${t.linha}?`;
      setTimeout(() => formEl.requestSubmit(), 350);
    });
    topicosEl.appendChild(card);
  });
}

function renderizarHeroGaleria(fotos) {
  if (!heroGaleriaEl) return;
  heroGaleriaEl.innerHTML = "";
  fotos.slice(0, 9).forEach((f) => {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    img.src = `assets/hero/${f.file}`;
    heroGaleriaEl.appendChild(img);
  });
}

// ---------- inicialização ----------

async function iniciar() {
  try {
    const [catalogoResp, topicosResp, heroResp] = await Promise.all([
      fetch("assets/data/catalog.json"),
      fetch("assets/data/topicos.json"),
      fetch("assets/hero/manifest.json"),
    ]);
    CATALOGO = await catalogoResp.json();
    TOPICOS = await topicosResp.json();
    LINHA_DESC = Object.fromEntries(TOPICOS.map((t) => [t.linha, t.desc || ""]));
    renderizarHeroGaleria(await heroResp.json());
  } catch (erro) {
    corpo.innerHTML = '<p class="mock-erro">Não consegui carregar o catálogo indexado (assets/data/catalog.json). Rodando fora de um servidor local? Sirva a pasta docs/ com um servidor HTTP — abrir o arquivo direto (file://) bloqueia o fetch.</p>';
    return;
  }

  INDICE_TFIDF = construirIndiceTfIdf();
  renderizarTopicos();

  SUGESTOES.forEach((s) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "mock-chip";
    chip.textContent = s;
    chip.addEventListener("click", () => perguntar(s));
    chipsEl.appendChild(chip);
  });

  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    perguntar(inputEl.value);
  });
}

iniciar();
