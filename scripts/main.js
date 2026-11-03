/**
 * t20-fichas-de-nimb — Normalizador de fichas do Fichas de Nimb
 *
 * O site fichasdenimb.com.br exporta fichas de Tormenta20 com itens
 * "genéricos": poderes, magias, armas, equipamentos, raças e classes sem
 * automação e sem ligação com os compêndios. Este módulo compara cada item
 * da ficha com os compêndios instalados (sistema Tormenta20 + módulos de
 * Tormenta20), substitui os genéricos pelas versões oficiais e avisa o que
 * não encontrou.
 *
 * Nada é gravado no LevelDB dos compêndios: a troca acontece na ficha do
 * ator e é desfeita pelo histórico normal do Foundry, se precisar.
 */

import {
  alvoDeItem,
  chaveNome,
  decidir,
  ehFichaNimb,
  jaNormalizado,
  packPareceTormenta20,
  prioridadeDoPack,
  quantidadeNoNome,
  veioDeCompendio
} from "./nucleo.js";

export const MODULE_ID = "t20-fichas-de-nimb";

const CAMPOS_INDICE = ["system.tipo", "system.subtipo"];

/* ─────────────────────────────────────────────
   Índice dos compêndios
────────────────────────────────────────────── */

/** @type {?Array} candidatos em cache */
let indice = null;
/** @type {?Promise} promessa em andamento (evita construir duas vezes) */
let construindo = null;
/** Atores sendo normalizados agora (evita reentrada pelos ganchos createItem). */
const aplicando = new Set();
/** Agendamentos da normalização automática. */
const agendados = new Map();

function declaraTormenta20(packageName) {
  if (!packageName) return false;
  if (packageName === "tormenta20") return true;
  const modulo = game.modules.get(packageName);
  if (!modulo) return false;
  if (modulo.system === "tormenta20") return true;
  return (modulo.relationships?.systems ?? []).some((r) => r.id === "tormenta20");
}

async function montarIndice() {
  const candidatos = [];
  const packs = game.packs.filter((p) => p.documentName === "Item");
  const descartados = [];
  const preferirSuplementos = game.settings.get(MODULE_ID, "preferirSuplementos");

  for (const pack of packs) {
    const meta = pack.metadata ?? {};
    const doSistema = meta.packageType === "system" && meta.packageName === "tormenta20";

    // Filtragem barata antes de abrir o índice: sistemas e módulos que
    // declaram outro sistema (CoC, D&D etc.) não têm nada a oferecer.
    if (meta.packageType === "system" && meta.packageName !== "tormenta20") {
      descartados.push(pack.collection);
      continue;
    }
    const declarado = declaraTormenta20(meta.packageName);
    if (!doSistema && !declarado) {
      const modulo = game.modules.get(meta.packageName);
      const declarouOutro = (modulo?.relationships?.systems ?? []).length > 0;
      if (declarouOutro || (meta.system && meta.system !== "tormenta20")) {
        descartados.push(pack.collection);
        continue;
      }
    }

    let colecao;
    try {
      colecao = await pack.getIndex({ fields: CAMPOS_INDICE });
    } catch (erro) {
      console.warn(`${MODULE_ID} | não foi possível ler ${pack.collection}`, erro);
      continue;
    }
    const itens = [...colecao.values()];

    if (!doSistema && !declarado && !packPareceTormenta20(itens, meta)) {
      descartados.push(pack.collection);
      continue;
    }

    const prioridadePack = prioridadeDoPack(meta, preferirSuplementos);
    for (const doc of itens) {
      // "base" são as sub-habilidades internas que o sistema cria a partir
      // de um poder — nunca são arrastadas para a ficha.
      if (doc.type === "base") continue;
      const sistema = doc.system ?? {};
      candidatos.push({
        uuid: `Compendium.${pack.collection}.Item.${doc._id}`,
        packId: pack.collection,
        packLabel: pack.metadata?.label ?? pack.collection,
        docId: doc._id,
        nome: doc.name,
        chave: chaveNome(doc.name),
        tipo: doc.type,
        tipoPoder: doc.type === "poder" ? sistema.tipo ?? null : null,
        subtipo: sistema.subtipo ?? null,
        prioridadePack
      });
    }
  }

  if (descartados.length) {
    console.log(`${MODULE_ID} | compêndios ignorados (não são de Tormenta20): ${descartados.join(", ")}`);
  }
  console.log(`${MODULE_ID} | índice com ${candidatos.length} itens de ${packs.length} compêndios`);
  return candidatos;
}

/** Constrói (ou devolve do cache) o índice de compêndios. */
export async function construirIndice(forcar = false) {
  if (forcar) {
    indice = null;
    construindo = null;
  }
  if (indice) return indice;
  if (!construindo) {
    construindo = montarIndice()
      .then((lista) => {
        indice = lista;
        return lista;
      })
      .finally(() => {
        construindo = null;
      });
  }
  return construindo;
}

/** Esquece o índice (compêndios mudaram). */
export function esquecerIndice() {
  indice = null;
}

/* ─────────────────────────────────────────────
   Análise da ficha
────────────────────────────────────────────── */

function candidatosDoTipo(lista, tipo) {
  return tipo ? lista.filter((c) => c.tipo === tipo) : lista;
}

function acharPorNome(lista, nome, extra = {}) {
  const alvo = { nome, chave: chaveNome(nome), tipo: extra.tipo ?? null, tipoPoder: extra.tipoPoder ?? null, subtipo: extra.subtipo ?? null };
  return decidir(alvo, lista);
}

/**
 * Compara a ficha com o índice, sem alterar nada.
 * @returns {Promise<object>} plano
 */
export async function analisar(ator) {
  if (!ator) throw new Error("Ator inválido");
  const indiceItens = await construirIndice();

  const plano = {
    substituir: [],
    ambiguos: [],
    semCorrespondencia: [],
    ignorados: [],
    raca: null,
    origem: null,
    classe: null
  };

  for (const item of ator.items) {
    if (item.type === "classe" || item.type === "race") continue;
    if (veioDeCompendio(item) || jaNormalizado(item)) {
      plano.ignorados.push(item);
      continue;
    }
    const alvo = alvoDeItem(item);
    if (!alvo.chave) {
      plano.ignorados.push(item);
      continue;
    }
    const resultado = decidir(alvo, indiceItens);
    if (resultado.estado === "auto") {
      plano.substituir.push({ item, alvo, escolhido: resultado.escolhido });
    } else if (resultado.estado === "ambiguo" && resultado.sugestoes.length) {
      plano.ambiguos.push({ item, alvo, sugestoes: resultado.sugestoes });
    } else {
      plano.semCorrespondencia.push({ item, alvo });
    }
  }

  // Raça, origem e classe vêm em campos de texto/itens mínimos do site.
  const nomeRaca = String(ator.system?.detalhes?.raca ?? "").trim();
  if (nomeRaca) {
    let atributosAbertos = false;
    try {
      atributosAbertos = game.settings.get("tormenta20", "openRaces") === true;
    } catch {
      atributosAbertos = false;
    }
    const resultado = acharPorNome(candidatosDoTipo(indiceItens, "race"), nomeRaca, { tipo: "race" });
    const existente = ator.items.find((i) => i.type === "race") ?? null;
    // Com "atributos abertos" o sistema abre o diálogo de distribuição ao
    // criar qualquer raça — não queremos esse efeito colateral.
    plano.raca = {
      nome: nomeRaca,
      escolhido: !atributosAbertos && resultado.estado === "auto" ? resultado.escolhido : null,
      atributosAbertos,
      existente
    };
  }

  const nomeOrigem = String(ator.system?.detalhes?.origem ?? "").trim();
  if (nomeOrigem) {
    const origens = indiceItens.filter((c) => c.tipo === "poder" && c.tipoPoder === "origem");
    const resultado = acharPorNome(origens, nomeOrigem, { tipo: "poder", tipoPoder: "origem" });
    const existente = ator.items.find(
      (i) => i.type === "poder" && i.system?.tipo === "origem" && chaveNome(i.name) === chaveNome(nomeOrigem)
    );
    plano.origem = {
      nome: nomeOrigem,
      escolhido: resultado.estado === "auto" ? resultado.escolhido : null,
      sugestoes: resultado.sugestoes ?? [],
      existente: existente ?? null
    };
  }

  const itemClasse = ator.items.find((i) => i.type === "classe");
  if (itemClasse) {
    const resultado = acharPorNome(candidatosDoTipo(indiceItens, "classe"), itemClasse.name, { tipo: "classe" });
    plano.classe = {
      item: itemClasse,
      escolhido: resultado.estado === "auto" ? resultado.escolhido : null
    };
  }

  return plano;
}

/* ─────────────────────────────────────────────
   Cópia de item do compêndio para a ficha
────────────────────────────────────────────── */

function limparDocumento(dados) {
  delete dados._id;
  delete dados.folder;
  delete dados.ownership;
  delete dados._stats;
  delete dados.sort;
  // Efeitos embutidos do compêndio também precisam de _id novo.
  dados.effects = (dados.effects ?? [])
    .filter((efeito) => efeito && typeof efeito === "object")
    .map((efeito) => {
      const copia = { ...efeito };
      delete copia._id;
      delete copia._stats;
      delete copia.origin;
      return copia;
    });
  return dados;
}

function marcarOrigem(dados, uuid, extra = {}) {
  dados.flags = foundry.utils.mergeObject(
    dados.flags ?? {},
    {
      core: { sourceId: uuid },
      [MODULE_ID]: { uuid, em: Date.now(), ...extra }
    },
    { inplace: false }
  );
  return dados;
}

/**
 * Remove referências `@EMBED` para compêndios que não estão instalados
 * (o compêndio de raças do sistema aponta para um pacote de desenvolvimento).
 * Mantém o rótulo entre chaves e preserva embeds válidos.
 */
function limparEmbeds(html) {
  return String(html ?? "").replace(/@EMBED\[([^\]]+)\](?:\{([^}]*)\})?/g, (original, uuid, rotulo) => {
    const partes = String(uuid).split(".");
    const colecao = `${partes[1] ?? ""}.${partes[2] ?? ""}`;
    if (game.packs.get(colecao)) return original;
    return rotulo || "";
  });
}

/** Prepara a cópia de um item que será colocado na ficha. */
function prepararCopia(doc, original) {
  const dados = limparDocumento(doc.toObject());
  marcarOrigem(dados, doc.uuid, { de: original.name });
  if (original.sort !== undefined) dados.sort = original.sort;
  const qtd = quantidadeNoNome(original.name);
  if (qtd !== null && foundry.utils.getProperty(dados, "system.qtd") !== undefined) {
    dados.system.qtd = qtd;
  }
  return dados;
}

/** Depois do create o sistema zera `equipado`; restauramos o estado do site. */
async function restaurarEstado(criado, original) {
  const atualizacao = {};
  if (criado.system !== undefined) {
    const qtdNome = quantidadeNoNome(original.name);
    if (qtdNome !== null && criado.system.qtd !== undefined) {
      atualizacao["system.qtd"] = qtdNome;
    } else if (original.system?.qtd !== undefined && criado.system.qtd !== undefined) {
      atualizacao["system.qtd"] = foundry.utils.deepClone(original.system.qtd);
    }
  }
  for (const chave of ["equipado", "equipado2", "carregado", "preparada"]) {
    const valor = original.system?.[chave];
    if (valor !== undefined && criado.system?.[chave] !== undefined) {
      atualizacao[`system.${chave}`] = foundry.utils.deepClone(valor);
    }
  }
  if (Object.keys(atualizacao).length) await criado.update(atualizacao, { render: false });
}

/** Cópia descritiva de uma raça: sem conceder poderes nem mexer nos atributos. */
function prepararRaca(doc, ator) {
  const dados = limparDocumento(doc.toObject());
  marcarOrigem(dados, doc.uuid, { descritivo: true });

  const atributos = {};
  for (const chave of Object.keys(dados.system?.atributos ?? {})) {
    atributos[chave] = Number(ator.system?.atributos?.[chave]?.racial ?? 0);
  }
  dados.system.atributos = atributos;
  dados.system.atributosDinamicos = { ...(dados.system.atributosDinamicos ?? {}), value: [] };
  dados.system.grants = [];
  dados.system.skills = [];
  if (dados.system.description?.value) {
    dados.system.description.value = limparEmbeds(dados.system.description.value);
  }
  return dados;
}

/** Cópia descritiva de uma origem (poder tipo "origem"). */
function prepararOrigem(doc) {
  const dados = limparDocumento(doc.toObject());
  marcarOrigem(dados, doc.uuid, { descritivo: true });
  if (dados.system.description?.value) {
    dados.system.description.value = limparEmbeds(dados.system.description.value);
  }
  return dados;
}

/* ─────────────────────────────────────────────
   Aplicação do plano
────────────────────────────────────────────── */

/**
 * Executa o plano na ficha.
 * @param {Actor} ator
 * @param {object} plano
 * @param {object} [selecao] o que aplicar (default: tudo o que é automático)
 */
export async function aplicarPlano(ator, plano, selecao = null) {
  const escolha = selecao ?? {
    substituir: new Set(plano.substituir.map((e) => e.item.id)),
    ambiguos: new Map(),
    raca: Boolean(plano.raca?.escolhido),
    origem: Boolean(plano.origem?.escolhido),
    classe: Boolean(plano.classe?.escolhido)
  };

  const relatorio = {
    substituidos: [],
    falhas: [],
    raca: null,
    origem: null,
    classe: null,
    semCorrespondencia: plano.semCorrespondencia.map((e) => e.item.name)
  };

  const trocas = [];
  for (const entrada of plano.substituir) {
    if (escolha.substituir.has(entrada.item.id)) trocas.push(entrada);
  }
  for (const entrada of plano.ambiguos) {
    const uuid = escolha.ambiguos.get(entrada.item.id);
    if (!uuid) continue;
    const escolhido = entrada.sugestoes.find((s) => s.uuid === uuid);
    if (escolhido) trocas.push({ ...entrada, escolhido });
  }

  for (const { item, escolhido } of trocas) {
    try {
      const pack = game.packs.get(escolhido.packId);
      const doc = pack ? await pack.getDocument(escolhido.docId) : null;
      if (!doc) throw new Error("item não encontrado no compêndio");
      const dados = prepararCopia(doc, item);
      const [criado] = await ator.createEmbeddedDocuments("Item", [dados], { render: false });
      if (!criado) throw new Error("o Foundry não criou o item");
      await restaurarEstado(criado, item);
      await ator.deleteEmbeddedDocuments("Item", [item.id], { render: false });
      relatorio.substituidos.push({ de: item.name, para: doc.name, pack: escolhido.packLabel });
    } catch (erro) {
      console.error(`${MODULE_ID} | falha ao substituir "${item.name}"`, erro);
      relatorio.falhas.push({ item: item.name, erro: erro?.message ?? String(erro) });
    }
  }

  // Raça (item descritivo)
  if (escolha.raca && plano.raca?.escolhido && !plano.raca.existente) {
    try {
      const pack = game.packs.get(plano.raca.escolhido.packId);
      const doc = await pack?.getDocument(plano.raca.escolhido.docId);
      if (doc) {
        const [criado] = await ator.createEmbeddedDocuments("Item", [prepararRaca(doc, ator)], { render: false });
        relatorio.raca = criado ? doc.name : null;
      }
    } catch (erro) {
      console.error(`${MODULE_ID} | falha ao adicionar a raça`, erro);
      relatorio.falhas.push({ item: plano.raca.nome, erro: erro?.message ?? String(erro) });
    }
  }

  // Origem (poder tipo origem)
  if (escolha.origem && plano.origem?.escolhido && !plano.origem.existente) {
    try {
      const pack = game.packs.get(plano.origem.escolhido.packId);
      const doc = await pack?.getDocument(plano.origem.escolhido.docId);
      if (doc) {
        const [criado] = await ator.createEmbeddedDocuments("Item", [prepararOrigem(doc)], { render: false });
        relatorio.origem = criado ? doc.name : null;
      }
    } catch (erro) {
      console.error(`${MODULE_ID} | falha ao adicionar a origem`, erro);
      relatorio.falhas.push({ item: plano.origem.nome, erro: erro?.message ?? String(erro) });
    }
  }

  // Classe: mescla descrição/ícone sem tocar em níveis, PV e PM.
  if (escolha.classe && plano.classe?.escolhido) {
    try {
      const pack = game.packs.get(plano.classe.escolhido.packId);
      const doc = await pack?.getDocument(plano.classe.escolhido.docId);
      if (doc) {
        const atualizacao = { img: doc.img };
        const mapa = ["source", "origin", "pericias", "tags", "rolltags", "automationtags", "chatFlavor"];
        for (const campo of mapa) {
          if (doc.system?.[campo] !== undefined) atualizacao[`system.${campo}`] = doc.system[campo];
        }
        // Só sobrescreve a descrição se o compêndio tiver uma de verdade.
        if (doc.system?.description?.value) {
          atualizacao["system.description"] = {
            ...doc.system.description,
            value: limparEmbeds(doc.system.description.value)
          };
        }
        await plano.classe.item.update(atualizacao, { render: false });
        await plano.classe.item.setFlag(MODULE_ID, "classe", { uuid: doc.uuid, em: Date.now() });
        relatorio.classe = doc.name;
      }
    } catch (erro) {
      console.error(`${MODULE_ID} | falha ao mesclar a classe`, erro);
      relatorio.falhas.push({ item: plano.classe?.item?.name ?? "classe", erro: erro?.message ?? String(erro) });
    }
  }

  ator.sheet?.rendered && ator.sheet.render(false);
  return relatorio;
}

/* ─────────────────────────────────────────────
   Interface de revisão
────────────────────────────────────────────── */

function escapar(texto) {
  return String(texto ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function rotuloTipo(candidato) {
  const partes = [candidato.tipo];
  if (candidato.tipoPoder) partes.push(candidato.tipoPoder);
  if (candidato.subtipo) partes.push(candidato.subtipo);
  return partes.join(" · ");
}

function montarRevisao(plano) {
  const totalAuto = plano.substituir.length;
  const totalAmb = plano.ambiguos.length;
  const totalSem = plano.semCorrespondencia.length;

  const linhasAuto = plano.substituir
    .map(
      ({ item, escolhido }) => `
      <tr>
        <td><input type="checkbox" data-acao="sub" data-id="${item.id}" checked></td>
        <td><strong>${escapar(item.name)}</strong><br><small>${escapar(item.type)}</small></td>
        <td>${escapar(escolhido.nome)}<br><small>${escapar(rotuloTipo(escolhido))}</small></td>
        <td><small>${escapar(escolhido.packLabel)}</small></td>
      </tr>`
    )
    .join("");

  const linhasAmb = plano.ambiguos
    .map(
      ({ item, sugestoes }) => `
      <tr>
        <td><strong>${escapar(item.name)}</strong><br><small>${escapar(item.type)}</small></td>
        <td>
          <select data-acao="amb" data-id="${item.id}">
            <option value="">— manter como está —</option>
            ${sugestoes
              .map(
                (s) =>
                  `<option value="${s.uuid}">${escapar(s.nome)} — ${escapar(rotuloTipo(s))} (${escapar(s.packLabel)})</option>`
              )
              .join("")}
          </select>
        </td>
      </tr>`
    )
    .join("");

  const sem = plano.semCorrespondencia.length
    ? `<ul class="t20-nimb-lista">${plano.semCorrespondencia
        .map(({ item }) => `<li><strong>${escapar(item.name)}</strong> <small>(${escapar(item.type)})</small></li>`)
        .join("")}</ul>`
    : `<p class="t20-nimb-ok">Todos os itens têm correspondência.</p>`;

  const extras = [];
  const podeRaca = game.settings.get(MODULE_ID, "adicionarRaca");
  const podeOrigem = game.settings.get(MODULE_ID, "adicionarOrigem");

  if (plano.raca) {
    const ativo = Boolean(plano.raca.escolhido) && !plano.raca.existente && podeRaca;
    const motivo = plano.raca.existente
      ? "já existe na ficha"
      : plano.raca.atributosAbertos
        ? "o sistema está com atributos abertos; adicione a raça pela ficha"
        : !plano.raca.escolhido
          ? "não encontrada nos compêndios"
          : !podeRaca
            ? "desativado nas configurações"
            : "adicionar item descritivo do compêndio";
    extras.push(
      `<label class="t20-nimb-extra">
        <input type="checkbox" data-acao="raca" ${ativo ? "checked" : ""} ${ativo ? "" : "disabled"}>
        <span>Raça: <strong>${escapar(plano.raca.nome)}</strong> — ${escapar(motivo)}</span>
      </label>`
    );
  }
  if (plano.origem) {
    const ativo = Boolean(plano.origem.escolhido) && !plano.origem.existente && podeOrigem;
    const motivo = plano.origem.existente
      ? "já existe na ficha"
      : !plano.origem.escolhido
        ? "não encontrada nos compêndios"
        : !podeOrigem
          ? "desativado nas configurações"
          : "adicionar do compêndio";
    extras.push(
      `<label class="t20-nimb-extra">
        <input type="checkbox" data-acao="origem" ${ativo ? "checked" : ""} ${ativo ? "" : "disabled"}>
        <span>Origem: <strong>${escapar(plano.origem.nome)}</strong> — ${escapar(motivo)}</span>
      </label>`
    );
  }
  if (plano.classe) {
    extras.push(
      `<label class="t20-nimb-extra">
        <input type="checkbox" data-acao="classe" ${plano.classe.escolhido ? "checked" : ""} ${!plano.classe.escolhido ? "disabled" : ""}>
        <span>Classe: <strong>${escapar(plano.classe.item.name)}</strong> — ${
          plano.classe.escolhido ? "mesclar ícone, descrição e perícias do compêndio" : "não encontrada nos compêndios"
        }</span>
      </label>`
    );
  }

  return `
  <div class="t20-nimb-revisao">
    <p class="t20-nimb-resumo">
      <strong>${totalAuto}</strong> substituição(ões) automática(s),
      <strong>${totalAmb}</strong> para revisar e
      <strong>${totalSem}</strong> sem correspondência.
    </p>
    ${extras.length ? `<div class="t20-nimb-extras">${extras.join("")}</div>` : ""}
    ${
      totalAuto
        ? `<h3>Substituir automaticamente</h3>
           <table class="t20-nimb-tabela">
             <thead><tr><th></th><th>Na ficha</th><th>Por</th><th>Compêndio</th></tr></thead>
             <tbody>${linhasAuto}</tbody>
           </table>`
        : ""
    }
    ${
      totalAmb
        ? `<h3>Revisar (nome parecido)</h3>
           <table class="t20-nimb-tabela">
             <thead><tr><th>Na ficha</th><th>Substituir por</th></tr></thead>
             <tbody>${linhasAmb}</tbody>
           </table>`
        : ""
    }
    <h3>Sem correspondência</h3>
    ${sem}
    <p class="t20-nimb-nota">
      As versões dos compêndios trazem a automação (usos, efeitos, resistências).
      Revise PV, PM e Defesa depois de aplicar, pois alguns poderes passam a
      conceder bônus que o site não aplicava.
    </p>
  </div>`;
}

function lerSelecao(form) {
  const selecao = { substituir: new Set(), ambiguos: new Map(), raca: false, origem: false, classe: false };
  if (!form) return selecao;
  for (const el of form.querySelectorAll('input[type="checkbox"][data-acao="sub"]')) {
    if (el.checked) selecao.substituir.add(el.dataset.id);
  }
  for (const el of form.querySelectorAll('select[data-acao="amb"]')) {
    if (el.value) selecao.ambiguos.set(el.dataset.id, el.value);
  }
  selecao.raca = Boolean(form.querySelector('input[data-acao="raca"]')?.checked);
  selecao.origem = Boolean(form.querySelector('input[data-acao="origem"]')?.checked);
  selecao.classe = Boolean(form.querySelector('input[data-acao="classe"]')?.checked);
  return selecao;
}

/** Abre o diálogo de revisão e devolve a seleção (ou null se cancelar). */
async function perguntar(plano) {
  const conteudo = montarRevisao(plano);
  const titulo = `Reconhecer itens — ${plano.nomeAtor ?? "ficha"}`;

  if (foundry.applications?.api?.DialogV2?.wait) {
    const resultado = await foundry.applications.api.DialogV2.wait({
      window: { title: titulo },
      content: conteudo,
      modal: true,
      rejectClose: false,
      buttons: [
        {
          action: "aplicar",
          label: "Aplicar",
          icon: "fas fa-check",
          default: true,
          callback: (_evento, botao) => lerSelecao(botao?.form ?? null)
        },
        { action: "cancelar", label: "Cancelar", icon: "fas fa-times", type: "button", callback: () => null }
      ]
    });
    return resultado && typeof resultado === "object" ? resultado : null;
  }

  return new Promise((resolve) => {
    new Dialog({
      title: titulo,
      content: conteudo,
      buttons: {
        aplicar: {
          icon: '<i class="fas fa-check"></i>',
          label: "Aplicar",
          callback: (html) => resolve(lerSelecao(html?.[0] ?? null))
        },
        cancelar: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancelar",
          callback: () => resolve(null)
        }
      },
      default: "aplicar",
      close: () => resolve(null)
    }).render(true);
  });
}

/* ─────────────────────────────────────────────
   Relatório
────────────────────────────────────────────── */

function publicarRelatorio(ator, relatorio) {
  const substituidos = relatorio.substituidos.length;
  const falhas = relatorio.falhas.length;
  const sem = relatorio.semCorrespondencia.length;

  const partes = [`${substituidos} item(ns) reconhecido(s)`];
  if (relatorio.raca) partes.push(`raça ${relatorio.raca}`);
  if (relatorio.origem) partes.push(`origem ${relatorio.origem}`);
  if (relatorio.classe) partes.push(`classe ${relatorio.classe}`);
  if (sem) partes.push(`${sem} sem correspondência`);
  if (falhas) partes.push(`${falhas} falha(s)`);

  ui.notifications.info(`Fichas de Nimb: ${partes.join(", ")}.`, { console: false });

  console.groupCollapsed(`${MODULE_ID} | ${ator.name}`);
  if (relatorio.substituidos.length) console.table(relatorio.substituidos);
  if (relatorio.falhas.length) console.table(relatorio.falhas);
  if (relatorio.semCorrespondencia.length) console.log("Sem correspondência:", relatorio.semCorrespondencia);
  console.groupEnd();

  if (!game.settings.get(MODULE_ID, "avisarChat")) return;
  if (!substituidos && !sem && !falhas) return;

  const lista = (titulo, itens, classe = "") =>
    itens.length
      ? `<p><strong>${titulo} (${itens.length})</strong></p><ul>${itens.slice(0, 20).map((t) => `<li>${escapar(t)}</li>`).join("")}${
          itens.length > 20 ? `<li>… e mais ${itens.length - 20}</li>` : ""
        }</ul>`
      : "";

  const conteudo = `
    <div class="t20-nimb-card">
      <h3><i class="fas fa-wand-magic-sparkles"></i> Fichas de Nimb — ${escapar(ator.name)}</h3>
      <p>${escapar(partes.join(" · "))}</p>
      ${lista(
        "Reconhecidos",
        relatorio.substituidos.map((t) => `${t.de} → ${t.para}`),
        "t20-nimb-ok"
      )}
      ${lista("Sem correspondência", relatorio.semCorrespondencia)}
      ${lista(
        "Falhas",
        relatorio.falhas.map((f) => `${f.item}: ${f.erro}`)
      )}
    </div>`;

  ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: ator }),
    content: conteudo,
    whisper: game.users.filter((u) => u.isGM).map((u) => u.id)
  });
}

/* ─────────────────────────────────────────────
   API pública
────────────────────────────────────────────── */

/**
 * Normaliza um ator.
 * @param {Actor} ator
 * @param {{interativo?:boolean, forcar?:boolean}} [opcoes]
 */
export async function normalizar(ator, opcoes = {}) {
  const { interativo = true, forcar = false } = opcoes;
  if (!ator) {
    ui.notifications.warn("Selecione um token ou abra a ficha de um personagem.");
    return null;
  }
  if (!ator.isOwner) {
    ui.notifications.warn("Você não tem permissão para alterar esta ficha.");
    return null;
  }
  if (aplicando.has(ator.id)) return null;

  if (!forcar && !ehFichaNimb(ator) && !ator.items.some((i) => jaNormalizado(i))) {
    const confirmar = interativo
      ? await (foundry.applications?.api?.DialogV2?.confirm?.({
          window: { title: "Ficha não identificada" },
          content:
            "<p>Esta ficha não parece ter sido importada do <strong>Fichas de Nimb</strong>.</p><p>Deseja procurar itens genéricos de qualquer forma?</p>"
        }) ?? true)
      : false;
    if (!confirmar) return null;
  }

  aplicando.add(ator.id);
  const aviso = ui.notifications.info("Comparando a ficha com os compêndios…", { permanent: true });
  try {
    const plano = await analisar(ator);
    plano.nomeAtor = ator.name;

    const temAlgo =
      plano.substituir.length || plano.ambiguos.length || plano.raca?.escolhido || plano.origem?.escolhido || plano.classe?.escolhido;
    if (!temAlgo) {
      if (interativo) ui.notifications.warn(`Nada para normalizar em ${ator.name}.`);
      await ator.setFlag(MODULE_ID, "normalizadoEm", Date.now());
      return null;
    }

    let selecao = null;
    if (interativo) {
      selecao = await perguntar(plano);
      if (!selecao) return null;
    } else {
      selecao = {
        substituir: new Set(plano.substituir.map((e) => e.item.id)),
        ambiguos: new Map(),
        raca: Boolean(plano.raca?.escolhido) && game.settings.get(MODULE_ID, "adicionarRaca"),
        origem: Boolean(plano.origem?.escolhido) && game.settings.get(MODULE_ID, "adicionarOrigem"),
        classe: Boolean(plano.classe?.escolhido)
      };
    }

    const relatorio = await aplicarPlano(ator, plano, selecao);
    // Guarda o que ficou pendente para uma revisão posterior.
    await ator.setFlag(MODULE_ID, "pendencias", {
      em: Date.now(),
      ambiguos: plano.ambiguos.map((e) => e.item.name),
      semCorrespondencia: plano.semCorrespondencia.map((e) => e.item.name)
    });
    // Marca a ficha como já processada: os ganchos de createItem criados
    // durante a substituição não devem agendar outra rodada.
    await ator.setFlag(MODULE_ID, "normalizadoEm", Date.now());
    publicarRelatorio(ator, relatorio);
    return relatorio;
  } catch (erro) {
    console.error(`${MODULE_ID} | erro ao normalizar`, erro);
    ui.notifications.error(`Falha ao normalizar a ficha: ${erro?.message ?? erro}`);
    return null;
  } finally {
    aplicando.delete(ator.id);
    aviso?.remove?.();
  }
}

/** Normaliza todos os atores do mundo (ou os selecionados). */
export async function normalizarTodos(opcoes = {}) {
  const atores = game.actors.filter((a) => a.isOwner && ["character", "npc"].includes(a.type));
  const alvos = opcoes.somenteNimb ? atores.filter((a) => ehFichaNimb(a)) : atores;
  for (const ator of alvos) {
    await normalizar(ator, { ...opcoes, interativo: false, forcar: true });
  }
  ui.notifications.info(`Fichas de Nimb: ${alvos.length} ficha(s) verificada(s).`);
}

/* ─────────────────────────────────────────────
   Ganchos
────────────────────────────────────────────── */

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | inicializando`);

  game.settings.register(MODULE_ID, "autoNormalizar", {
    name: "Normalizar automaticamente fichas do Nimb",
    hint: "Ao criar um ator com a marca do Fichas de Nimb, substitui os itens genéricos pelos dos compêndios.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "preferirSuplementos", {
    name: "Preferir suplementos aos compêndios do sistema",
    hint: "Quando o mesmo item existe no sistema e num suplemento, usa a versão do suplemento.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => esquecerIndice()
  });

  game.settings.register(MODULE_ID, "adicionarRaca", {
    name: "Adicionar a raça como item descritivo",
    hint: "Cria o item de raça do compêndio sem conceder poderes nem alterar atributos já calculados na ficha.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "adicionarOrigem", {
    name: "Adicionar a origem como item",
    hint: "Cria o poder de origem do compêndio, quando ele existir como item (as origens do livro básico só existem como texto).",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "avisarChat", {
    name: "Publicar o relatório no chat",
    hint: "Envia um resumo (só para o mestre) do que foi reconhecido.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "mostrarBotaoFicha", {
    name: "Mostrar botão nas fichas do Nimb",
    hint: "Adiciona o botão de reconhecimento no cabeçalho das fichas importadas do site.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
});

Hooks.once("ready", () => {
  // Deixa o índice pronto em segundo plano; não bloqueia o carregamento.
  construirIndice().catch((erro) => console.warn(`${MODULE_ID} | falha ao montar o índice`, erro));

  const api = {
    normalizar,
    normalizarTodos,
    analisar,
    aplicarPlano,
    construirIndice,
    esquecerIndice,
    ehFichaNimb,
    versao: "1.0.0"
  };
  const modulo = game.modules.get(MODULE_ID);
  if (modulo) modulo.api = api;
  game.t20Nimb = api;
  console.log(`${MODULE_ID} | pronto. Use game.t20Nimb.normalizar(actor)`);
});

// Compêndios alterados → reconstrói na próxima vez.
Hooks.on("updateCompendium", () => esquecerIndice());
Hooks.on("createCompendium", () => esquecerIndice());
Hooks.on("deleteCompendium", () => esquecerIndice());

// Ficha criada pelo importador do site (ou itens adicionados logo depois).
function agendarNormalizacao(ator) {
  if (!game.user.isGM) return;
  if (!game.settings.get(MODULE_ID, "autoNormalizar")) return;
  if (!ator || !["character", "npc"].includes(ator.type)) return;
  if (aplicando.has(ator.id)) return;
  if (!ehFichaNimb(ator)) return;
  if (ator.getFlag(MODULE_ID, "normalizadoEm")) return;
  clearTimeout(agendados.get(ator.id));
  agendados.set(
    ator.id,
    setTimeout(async () => {
      agendados.delete(ator.id);
      const atual = game.actors.get(ator.id);
      if (!atual || aplicando.has(atual.id)) return;
      if (atual.getFlag(MODULE_ID, "normalizadoEm")) return;
      // `normalizar` grava a flag normalizadoEm ao concluir.
      await normalizar(atual, { interativo: false });
    }, 1500)
  );
}

Hooks.on("createActor", (ator) => agendarNormalizacao(ator));
Hooks.on("createItem", (item) => {
  if (!item?.isEmbedded) return;
  if (item.parent?.documentName !== "Actor") return;
  agendarNormalizacao(item.parent);
});

// Botão no cabeçalho da ficha.
Hooks.on("renderActorSheet", (app, html) => {
  const ator = app?.actor;
  if (!ator?.isOwner) return;
  if (!["character", "npc"].includes(ator.type)) return;
  if (!game.settings.get(MODULE_ID, "mostrarBotaoFicha")) return;
  const doNimb = ehFichaNimb(ator) || ator.items.some((i) => jaNormalizado(i));
  if (!doNimb) return;

  const raiz = html?.[0] ?? html;
  const janela = raiz?.closest?.(".app") ?? raiz;
  if (!janela || janela.querySelector(".t20-nimb-btn")) return;

  const botao = document.createElement("a");
  botao.className = "header-button control t20-nimb-btn";
  botao.dataset.tooltip = "Reconhecer itens do Fichas de Nimb";
  botao.setAttribute("aria-label", "Reconhecer itens do Fichas de Nimb");
  botao.setAttribute("role", "button");
  botao.tabIndex = 0;
  botao.innerHTML = '<i class="fas fa-wand-magic-sparkles" inert></i>';
  botao.addEventListener("click", (evento) => {
    evento.preventDefault();
    evento.stopPropagation();
    normalizar(ator, { interativo: true });
  });
  botao.addEventListener("keydown", (evento) => {
    if (evento.key !== "Enter" && evento.key !== " ") return;
    evento.preventDefault();
    normalizar(ator, { interativo: true });
  });

  // Longe do "fechar": um clique errado no botão não pode fechar a ficha.
  const cabecalho = janela.querySelector(".window-header");
  if (!cabecalho) return;
  const primeiro = cabecalho.querySelector(".header-button");
  const fechar = cabecalho.querySelector(".close");
  if (primeiro) primeiro.before(botao);
  else if (fechar) fechar.before(botao);
  else cabecalho.append(botao);
});
