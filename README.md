# T20 Fichas de Nimb

Módulo para **Tormenta20 no Foundry VTT** que reconhece fichas exportadas do
[Fichas de Nimb](https://fichasdenimb.com.br) e troca os itens genéricos criados
pelo site pelas versões oficiais dos compêndios instalados — com automação,
ícones, descrições e efeitos.

> **Id do módulo:** `t20-fichas-de-nimb`
> **Autor:** @xx_.luis._xx
> **Licença:** MIT

---

## Instalação rápida no Foundry

Em **Add-on Modules → Install Module**, cole isto no campo **URL do Manifesto**:

```
https://github.com/Luisguilhermelr/t20-fichas-de-nimb/releases/latest/download/module.json
```

Clique em **Install** e depois ative o módulo em **Gerenciar Módulos**.
O Foundry baixa e atualiza o módulo sozinho a partir dessa URL.

> Repositório: https://github.com/Luisguilhermelr/t20-fichas-de-nimb

---

## O problema que ele resolve

O site Fichas de Nimb exporta a ficha com poderes, magias, armas, equipamentos,
raça e classe como itens “soltos”: sem ícone, sem descrição rica, sem efeitos e
sem nenhuma ligação com os compêndios do Foundry. Numa ficha importada, um poder
como *Baluarte* é só um texto — não aplica o bônus de Defesa nem rola nada.

Este módulo compara cada item da ficha com todos os compêndios de **Item** de
Tormenta20 instalados no mundo e substitui o item genérico pela versão oficial,
preservando quantidade, estado de equipado e a ordem na ficha.

---

## O que ele faz

- **Substitui itens** de compêndio: poderes, magias, armas, equipamentos,
  consumíveis, tesouros e parceiros.
- **Preserva o estado** de cada item: `qtd`, `equipado`, `equipado2`,
  `carregado`, `preparada` (magias) e a posição (`sort`) na lista.
- **Entende nomes “sujos”** do site:
  - `10x Ração de Viagem` → item `Ração de viagem` com quantidade **10**;
  - `Ferramenta agrícola (mesmas estatísticas de uma lança)` → arma
    `Ferramenta agrícola`;
  - `Solidez` → `Solidez (Cavaleiro)`, usando a classe da ficha como desempate.
- **Adiciona a raça** como item descritivo, sem conceder poderes e sem mexer nos
  atributos já calculados.
- **Adiciona a origem** quando ela existe como item de compêndio.
- **Completa a classe** com ícone, descrição, fonte e perícias do compêndio,
  sem alterar níveis, PV ou PM.
- **Explica o que não encontrou**: itens sem correspondência entram no relatório
  em vez de serem trocados por qualquer coisa parecida.
- **Publica um resumo** no chat, só para os mestres, se você quiser.

Nada é gravado nos compêndios. A troca acontece apenas na ficha do ator e pode
ser desfeita pelo histórico normal do Foundry.

---

## Como funciona por dentro

1. **Identificação da ficha.** O módulo reconhece a ficha do site pela marca
   `Fichas de Nimb` em `system.detalhes.info`. Também é possível forçar a
   análise em qualquer personagem pelo botão ou pela macro.
2. **Leitura dos compêndios.** Percorre todos os compêndios de **Item**
   registrados no mundo (sistema, módulos e packs do próprio mundo). Compêndios
   de outros sistemas são descartados automaticamente, e entradas internas
   `type: "base"` (efeitos embutidos dos poderes) não entram no índice.
3. **Normalização dos nomes.** Remove HTML, acentos, caixa e pontuação; tira
   prefixos de quantidade (`10x`) e parênteses finais usados para observações.
4. **Comparação.** Cada item é comparado com os candidatos compatíveis (arma com
   arma, poder com poder, magia com magia…). A pontuação considera nome, tipo,
   tipo de poder, subtipo (classe/raça) e origem do pacote.
5. **Decisão conservadora.** A substituição é automática **somente quando o nome
   normalizado é idêntico**. Nomes parecidos viram sugestões no diálogo de
   revisão, para você decidir.
6. **Aplicação.** O item oficial é criado na ficha, o estado do item antigo é
   restaurado e só então o genérico é removido. Raça, origem e classe seguem
   regras próprias para não duplicar bônus.
7. **Relatório.** O que foi trocado, o que ficou ambíguo, o que não existe nos
   compêndios e eventuais falhas ficam no console e, opcionalmente, no chat.

---

## Requisitos

- Foundry VTT **13 ou 14**
- Sistema **Tormenta20 1.5+** (testado em 1.6.x)
- Compêndios de Tormenta20 instalados. Quanto mais suplementos você tiver
  (Suplementos de Arton, Heróis de Arton, Bestiário de Arton, Cavaleiro da
  Redenção…), mais itens são reconhecidos.

---

## Instalação

1. Feche o Foundry (ou apenas recarregue com `F5` depois).
2. Copie a pasta `t20-fichas-de-nimb` para:
   - Windows: `%LOCALAPPDATA%\FoundryVTT\Data\modules\`
   - Linux: `~/.local/share/FoundryVTT/Data/modules/`
3. Abra o Foundry, entre no mundo de Tormenta20.
4. Em **Configurar → Gerenciar Módulos**, ative **T20 Fichas de Nimb**.
5. Recarregue o mundo (`F5`).

---

## Como usar

### Automático

Com **Normalizar automaticamente fichas do Nimb** ligado (padrão), ao criar ou
importar a ficha o mestre vê os itens serem ajustados e recebe um resumo no
chat. A ficha é marcada como processada e o módulo não fica repetindo a análise
a cada item novo.

### Pelo botão da ficha

Nas fichas identificadas como do Nimb aparece uma **varinha** no cabeçalho da
janela. Ela abre a tela de revisão com:

- as substituições automáticas (com caixa para desmarcar o que não quiser);
- os casos ambíguos, com sugestões de compêndio;
- a lista do que não foi encontrado;
- as opções de raça, origem e classe.

### Por macro

```js
// ficha do token selecionado (ou do seu personagem)
const ator = canvas.tokens.controlled[0]?.actor ?? game.user.character;
await game.t20Nimb.normalizar(ator, { interativo: true });
```

```js
// todas as fichas do Nimb no mundo, sem perguntar
await game.t20Nimb.normalizarTodos({ somenteNimb: true });
```

```js
// só diagnóstico, sem alterar nada
const plano = await game.t20Nimb.analisar(game.user.character);
console.table(plano.substituir.map((e) => ({ de: e.item.name, para: e.escolhido.nome })));
```

---

## Configurações

| Opção | Padrão | O que faz |
| --- | --- | --- |
| Normalizar automaticamente fichas do Nimb | ligado | Roda sozinho ao criar a ficha. |
| Preferir suplementos aos compêndios do sistema | desligado | Quando o mesmo item existe nos dois, usa o do suplemento. |
| Adicionar a raça como item descritivo | ligado | Cria o item de raça sem conceder poderes nem alterar atributos. |
| Adicionar a origem como item | ligado | Cria o poder de origem quando ele existe como item. |
| Publicar o relatório no chat | ligado | Resumo em whisper para os mestres. |
| Mostrar botão nas fichas do Nimb | ligado | Botão no cabeçalho da ficha. |

---

## O que esperar (limitações)

- **Origens do livro básico** (Fazendeiro, Acólito, Trabalhador…) só existem
  como texto no diário *Básico* do sistema, não como itens de compêndio. Elas
  aparecem como “não encontrada” — é uma limitação do conteúdo instalado.
- Poderes e magias de conteúdos muito novos, que ainda não estão em nenhum
  compêndio, são mantidos como estão e listados no relatório.
- Alguns poderes oficiais trazem **efeitos passivos** que o site não aplicava.
  Depois de aplicar, confira **PV, PM e Defesa** e ajuste se necessário.
- Se o sistema estiver com **atributos abertos** (`openRaces`) ligado, o módulo
  não cria o item de raça, porque o sistema abriria o diálogo de distribuição de
  atributos. Nesse caso, adicione a raça manualmente.
- O módulo não altera os compêndios e não depende de nenhum outro módulo.

---

## Perguntas frequentes

**O botão não aparece na ficha.**
Confira se o módulo está ativo, se você é o dono da ficha e se ela tem a marca
do Fichas de Nimb. A opção *Mostrar botão nas fichas do Nimb* precisa estar
ligada.

**Ele não reconheceu um poder que eu sei que existe.**
Veja no console (F12) a lista de “compêndios ignorados” e o relatório de “sem
correspondência”. O item pode estar num módulo não instalado, com nome
diferente, ou ser de um conteúdo posterior aos compêndios.

**Os PV/PM/Defesa mudaram depois de aplicar.**
É esperado em alguns casos: o item oficial tem automação que o site não tinha.
Revise a ficha; se o site já somava o bônus manualmente, remova o valor duplicado.

**Posso usar em ficha que não veio do site?**
Sim. A macro e o botão forçam a análise; ou use
`game.t20Nimb.normalizar(actor, { interativo: true, forcar: true })`.

---

## API

```js
game.t20Nimb.normalizar(actor, { interativo, forcar })
game.t20Nimb.normalizarTodos({ somenteNimb })
game.t20Nimb.analisar(actor)              // plano, sem alterar
game.t20Nimb.aplicarPlano(actor, plano, selecao)
game.t20Nimb.construirIndice(true)        // reconstrói o índice de compêndios
game.t20Nimb.esquecerIndice()
game.t20Nimb.ehFichaNimb(actor)
```

O índice é montado uma vez e reaproveitado. Ele é reconstruído sozinho quando
um compêndio muda, ou manualmente por `construirIndice(true)`.

---

## Compatibilidade

- Foundry VTT 13/14
- Tormenta20 1.5+
- Funciona ao lado de outros módulos de Tormenta20; não altera compêndios nem
  fichas que não sejam alvo de uma normalização.

---

## Licença e créditos

Distribuído sob a licença **MIT**. Você pode usar, modificar e redistribuir,
mantendo o aviso de licença.

Feito por **@xx_.luis._xx**.
Fichas de Nimb é um projeto independente de terceiros; este módulo apenas lê o
JSON exportado pelo site.
