/**
 * t20-fichas-de-nimb — núcleo do normalizador
 *
 * Funções puras (sem dependência do Foundry) usadas pelo módulo e pelos
 * testes em Node. Toda a decisão de "esta item genérico do Fichas de Nimb
 * corresponde a qual item de compêndio?" acontece aqui.
 */

/** Tipos de Item que existem no sistema Tormenta20. */
export const TIPOS_ITEM_T20 = new Set([
  "arma",
  "equipamento",
  "consumivel",
  "tesouro",
  "poder",
  "magia",
  "classe",
  "race",
  "distincao",
  "parceiro",
  "comodo",
  "mobilia",
  "base"
]);

/** Classificações de poder usadas por `system.tipo`. */
export const TIPOS_PODER = new Set([
  "ability",
  "classe",
  "concedido",
  "geral",
  "origem",
  "racial",
  "distincao",
  "complicacao"
]);

/**
 * Quais tipos de compêndio podem substituir cada tipo vindo da ficha.
 * O site é inconsistente (ex.: "Ferramenta agrícola" vem como tesouro, mas
 * no compêndio é arma), então tesouro aceita os tipos "de inventário".
 */
const COMPATIVEIS = {
  arma: ["arma"],
  equipamento: ["equipamento", "arma"],
  consumivel: ["consumivel"],
  tesouro: ["tesouro", "arma", "equipamento", "consumivel", "parceiro"],
  poder: ["poder"],
  magia: ["magia"],
  classe: ["classe"],
  race: ["race"],
  distincao: ["distincao"],
  parceiro: ["parceiro"]
};

/** Normaliza texto: sem HTML, sem acento, minúsculo, só letras/números. */
export function normalizarTexto(valor) {
  return String(valor ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, " e ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Chave de comparação de um nome.
 * - Remove prefixo de quantidade ("10x Ração de Viagem" → "ração de viagem").
 * - Remove parênteses finais, que o site usa para observações e o sistema
 *   usa para desambiguar poderes ("Solidez (Cavaleiro)" → "solidez").
 */
export function chaveNome(nome) {
  let texto = String(nome ?? "");
  texto = texto.replace(/<[^>]*>/g, " ");
  texto = texto.replace(/^\s*\d+\s*[x×]\s*/i, "");
  let anterior;
  do {
    anterior = texto;
    texto = texto.replace(/\s*\([^()]*\)\s*$/, "");
  } while (texto !== anterior);
  return normalizarTexto(texto);
}

/** Quantidade embutida no nome ("10x Ração de Viagem" → 10) ou null. */
export function quantidadeNoNome(nome) {
  const achado = /^\s*(\d+)\s*[x×]\s*/i.exec(String(nome ?? ""));
  if (!achado) return null;
  const n = Number(achado[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* ── Similaridade ─────────────────────────────────────────────── */

function bigramas(texto) {
  const t = ` ${texto} `;
  const saida = [];
  for (let i = 0; i < t.length - 1; i++) saida.push(t.slice(i, i + 2));
  return saida;
}

/** Coeficiente de Dice sobre bigramas (0 a 1). */
export function similaridade(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const A = bigramas(a);
  const B = bigramas(b);
  const contagem = new Map();
  for (const g of A) contagem.set(g, (contagem.get(g) ?? 0) + 1);
  let inter = 0;
  for (const g of B) {
    const n = contagem.get(g) ?? 0;
    if (n > 0) {
      inter++;
      contagem.set(g, n - 1);
    }
  }
  return (2 * inter) / (A.length + B.length);
}

/**
 * Um nome "contém" o outro em limites de palavra, com pelo menos duas
 * palavras (evita casar "Lança" com "Lança montada").
 */
function contido(a, b) {
  const [curto, longo] = a.length <= b.length ? [a, b] : [b, a];
  if (curto.length < 8 || curto.split(" ").length < 2) return false;
  return ` ${longo} `.includes(` ${curto} `);
}

const PALAVRAS_VAZIAS = new Set([
  "de", "do", "da", "dos", "das", "a", "o", "as", "os", "e", "em",
  "com", "para", "por", "no", "na", "nos", "nas", "um", "uma", "ao"
]);

/** Primeira palavra significativa ("Caminho do Cavaleiro" → "caminho"). */
function primeiraPalavra(chave) {
  return chave.split(" ").find((p) => p && !PALAVRAS_VAZIAS.has(p)) ?? "";
}

/* ── Compatibilidade e pontuação ──────────────────────────────── */

export function compativel(tipoAlvo, tipoCandidato) {
  const lista = COMPATIVEIS[tipoAlvo];
  return Array.isArray(lista) && lista.includes(tipoCandidato);
}

/**
 * @typedef {object} Alvo
 * @property {string} nome
 * @property {string} chave
 * @property {string} tipo         tipo de Item na ficha
 * @property {?string} tipoPoder   `system.tipo` quando é poder
 * @property {?string} subtipo     `system.subtipo` quando é poder
 */

/** Monta o "alvo" de comparação a partir de um Item da ficha. */
export function alvoDeItem(item) {
  return {
    nome: item.name,
    chave: chaveNome(item.name),
    tipo: item.type,
    tipoPoder: item.type === "poder" ? item.system?.tipo ?? null : null,
    subtipo: item.system?.subtipo ?? null
  };
}

/**
 * @typedef {object} Candidato
 * @property {string} uuid
 * @property {string} packId
 * @property {string} packLabel
 * @property {string} docId
 * @property {string} nome
 * @property {string} chave
 * @property {string} tipo
 * @property {?string} tipoPoder
 * @property {?string} subtipo
 * @property {string} [img]
 * @property {number} [prioridadePack] 0 = compêndio do sistema, -1 = módulo
 */

/**
 * Pontua um candidato contra um alvo.
 * @returns {?{pontos:number, base:number, motivos:string[]}}
 */
export function pontuar(alvo, candidato, opcoes = {}) {
  if (!compativel(alvo.tipo, candidato.tipo)) return null;

  let base;
  if (alvo.chave && alvo.chave === candidato.chave) base = 100;
  else if (contido(alvo.chave, candidato.chave)) base = 86;
  else base = Math.round(100 * similaridade(alvo.chave, candidato.chave) ** 1.2);

  if (base < 65) return null;

  // Nomes parecidos precisam começar pela mesma palavra significativa:
  // "Caminho do Cavaleiro" não é "Cavaleiro do Reino".
  if (base < 100 && primeiraPalavra(alvo.chave) !== primeiraPalavra(candidato.chave)) return null;

  let pontos = base;
  const motivos = [];

  if (candidato.tipo === alvo.tipo) {
    pontos += 6;
    motivos.push("mesmo tipo");
  } else if (alvo.tipo === "tesouro") {
    pontos += 1;
  }

  if (candidato.tipoPoder && alvo.tipoPoder) {
    if (candidato.tipoPoder === alvo.tipoPoder) {
      pontos += 5;
      motivos.push("mesmo tipo de poder");
    } else if (TIPOS_PODER.has(candidato.tipoPoder) && TIPOS_PODER.has(alvo.tipoPoder)) {
      // "ability" é a classificação atual das habilidades de classe.
      const equivalente =
        (candidato.tipoPoder === "ability" && ["classe", "ability"].includes(alvo.tipoPoder)) ||
        (alvo.tipoPoder === "ability" && ["classe", "ability"].includes(candidato.tipoPoder));
      pontos += equivalente ? 3 : -8;
      motivos.push(equivalente ? "habilidade de classe" : "tipo de poder diferente");
    }
  }

  if (candidato.subtipo && alvo.subtipo) {
    if (normalizarTexto(candidato.subtipo) === normalizarTexto(alvo.subtipo)) {
      pontos += 5;
      motivos.push("mesmo subtipo");
    }
  }

  const parenteses = /\(([^()]*)\)\s*$/.exec(candidato.nome);
  if (parenteses && !normalizarTexto(alvo.nome).includes(normalizarTexto(parenteses[1]))) {
    pontos -= 5;
  }

  pontos += opcoes.prioridade ?? 0;

  return { pontos, base, motivos };
}

/**
 * Decide o melhor candidato para um alvo.
 *
 * Candidatos com a mesma chave/tipo/subtipo são agrupados (o mesmo poder
 * repetido no compêndio do sistema e num suplemento). Só há substituição
 * automática quando o nome normalizado é idêntico e não existe outro grupo
 * empatado — ou quando o subtipo (classe/raça) desempata sem dúvida.
 *
 * @returns {{estado:'auto'|'ambiguo'|'nenhum', escolhido:?object, sugestoes:object[], motivo:string}}
 */
export function decidir(alvo, candidatos, opcoes = {}) {
  const avaliados = [];
  for (const candidato of candidatos) {
    const nota = pontuar(alvo, candidato, opcoes);
    if (!nota) continue;
    avaliados.push({ ...candidato, ...nota });
  }

  avaliados.sort(
    (a, b) =>
      b.pontos - a.pontos ||
      (b.prioridadePack ?? 0) - (a.prioridadePack ?? 0) ||
      a.nome.localeCompare(b.nome, "pt-BR")
  );

  if (!avaliados.length) {
    return { estado: "nenhum", escolhido: null, sugestoes: [], motivo: "sem candidato" };
  }

  const grupos = [];
  for (const c of avaliados) {
    const subtipo = normalizarTexto(c.subtipo ?? "");
    const grupo = grupos.find(
      (g) => g.chave === c.chave && g.tipo === c.tipo && g.subtipo === subtipo
    );
    if (grupo) grupo.membros.push(c);
    else grupos.push({ chave: c.chave, tipo: c.tipo, subtipo, membros: [c], pontos: c.pontos });
  }
  for (const g of grupos) g.pontos = g.membros[0].pontos;

  const melhor = grupos[0];
  const segundo = grupos[1];
  const escolhido = melhor.membros[0];

  if (melhor.membros[0].base < 100) {
    return {
      estado: "ambiguo",
      escolhido: null,
      sugestoes: grupos.slice(0, 5).map((g) => g.membros[0]),
      motivo: "nome parecido, não idêntico"
    };
  }

  if (!segundo) {
    return { estado: "auto", escolhido, sugestoes: [], motivo: "nome idêntico" };
  }

  if (melhor.pontos - segundo.pontos >= 6) {
    return { estado: "auto", escolhido, sugestoes: [], motivo: "nome idêntico e mais específico" };
  }

  const subtipoAlvo = normalizarTexto(alvo.subtipo ?? "");
  if (subtipoAlvo) {
    const bateNoMelhor = melhor.membros.some((m) => normalizarTexto(m.subtipo ?? "") === subtipoAlvo);
    const bateNoSegundo = segundo.membros.some((m) => normalizarTexto(m.subtipo ?? "") === subtipoAlvo);
    if (bateNoMelhor && !bateNoSegundo) {
      return { estado: "auto", escolhido, sugestoes: [], motivo: "subtipo desempata" };
    }
  }

  return {
    estado: "ambiguo",
    escolhido: null,
    sugestoes: grupos.slice(0, 5).map((g) => g.membros[0]),
    motivo: "mais de um candidato plausível"
  };
}

/* ── Ficha do site ────────────────────────────────────────────── */

/** Detecta ficha importada do fichasdenimb.com.br. */
export function ehFichaNimb(ator) {
  const info = String(ator?.system?.detalhes?.info ?? "");
  return /fichas?\s*de\s*nimb/i.test(info);
}

/** Um item já veio de compêndio (não deve ser tocado). */
export function veioDeCompendio(item) {
  return String(item?.flags?.core?.sourceId ?? "").startsWith("Compendium.");
}

/** O item já foi processado por este módulo. */
export function jaNormalizado(item) {
  return Boolean(item?.flags?.["t20-fichas-de-nimb"]?.uuid);
}

/** Prioridade de um pacote: compêndios do sistema valem mais. */
export function prioridadeDoPack(metadata, preferirSuplementos = false) {
  const doSistema = metadata?.packageType === "system";
  if (preferirSuplementos) return doSistema ? -1 : 0;
  return doSistema ? 0 : -1;
}

/** Tipos que podem aparecer num compêndio T20 (usado na filtragem de packs). */
export function packPareceTormenta20(itens, metadata) {
  if (metadata?.packageName === "tormenta20") return true;
  if (metadata?.system === "tormenta20") return true;
  const amostra = (itens ?? []).slice(0, 40);
  if (!amostra.length) return false;
  const t20 = amostra.filter((i) => TIPOS_ITEM_T20.has(i.type)).length;
  return t20 / amostra.length >= 0.8;
}
