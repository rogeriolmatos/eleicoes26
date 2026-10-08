# Clima 2º Turno – Eleições 2026

Painel independente e apartidário sobre o 2º turno da eleição presidencial de 25/10/2026: pesquisas registradas no TSE, manchetes da imprensa, mapa por estado, apuração oficial ao vivo e uma leitura editorial do momento.

Tudo roda de graça no GitHub: o **GitHub Actions** coleta os dados a cada 10 minutos e publica o site no **GitHub Pages**. Não há servidor, banco de dados, chave de API nem rastreador.

## O que tem no repositório

| Arquivo | Para que serve |
|---|---|
| `index.html` | O site inteiro (HTML, CSS e JS num arquivo só). No topo fica o bloco **CONFIGURAÇÃO** com os candidatos. |
| `coleta.js` | Robô de coleta (Node 20, sem dependências). Gera `dados.json`. |
| `dados.json` | Dados que o site lê. O que vem no repositório é **de exemplo, com números fictícios**; o robô o substitui na primeira execução. |
| `config/fontes.json` | Lista de feeds RSS (editável). |
| `config/pesquisas.json` | Tabela de pesquisas de 2º turno (editável). |
| `config/linha-do-tempo.json` | Debates, calendário do TSE e fatos de campanha (editável). |
| `config/analise.json` | Texto do painel **Leitura do momento** (editável). |
| `.github/workflows/coleta.yml` | Agenda do robô e publicação no Pages. |

## Passo a passo para publicar

1. **Crie o repositório.** No GitHub, clique em *New repository*, dê um nome (por exemplo `clima-2turno`) e marque **Public** (em repositório público o Actions e o Pages são gratuitos sem limite de minutos).
2. **Suba os arquivos.** Na página do repositório, *Add file > Upload files*, arraste todos os arquivos e pastas mantendo a estrutura (inclusive a pasta `.github/workflows`). Ou, pelo terminal:
   ```bash
   git clone https://github.com/SEU-USUARIO/clima-2turno.git
   cd clima-2turno
   # copie os arquivos para cá
   git add . && git commit -m "Primeira versão" && git push
   ```
   A branch precisa se chamar `main`.
3. **Ative o GitHub Pages.** *Settings > Pages > Build and deployment > Source*: escolha **GitHub Actions**.
4. **Dê permissão de escrita ao robô.** *Settings > Actions > General > Workflow permissions*: marque **Read and write permissions** e salve.
5. **Rode o robô pela primeira vez.** Aba *Actions > Coleta e publicação > Run workflow*. Em 1 ou 2 minutos o site estará em `https://SEU-USUARIO.github.io/clima-2turno/`. Daí em diante ele roda sozinho a cada 10 minutos (e a cada 5 minutos na noite de 25/10).

Se o passo 5 falhar no "Publicar" com erro de ambiente, abra *Settings > Environments > github-pages* e confira se a branch `main` está liberada em *Deployment branches*.

## Como editar

### Candidatos
No `index.html`, procure `CONFIG:INICIO`. Para cada candidato há `numero`, `nome`, `nomeCompleto`, `partido`, `cor`, `foto`, `padrao`, `apelidos` e `excluir`.

- Mantenha a ordem por número de urna.
- `cor` é igual para os dois, por neutralidade. A diferença nos gráficos vem de `padrao` (`liso` ou `listrado`).
- `foto`: coloque uma imagem sua no repositório (ex.: `fotos/13.jpg`) e escreva o caminho. Use só imagens que você tem direito de publicar. Vazio mostra as iniciais.
- `apelidos`: como o robô reconhece o candidato nas manchetes. `excluir`: homônimos que não devem contar (ex.: "Flávio Dino").

O robô lê esse mesmo bloco, então não é preciso editar os candidatos em outro lugar.

### Pesquisas
Edite `config/pesquisas.json`. Cada pesquisa precisa de:

```json
{
  "instituto": "Datafolha",
  "contratante": "Folha e TV Globo",
  "campoInicio": "2026-10-06",
  "campoFim": "2026-10-08",
  "amostra": 2520,
  "margem": 2,
  "confianca": 95,
  "registroTSE": "BR-02949/2026",
  "tipo": "totais",
  "13": 0,
  "22": 0,
  "naoValidos": 0,
  "fonte": "https://link-da-divulgacao"
}
```

- `tipo`: `totais` (percentual sobre todos os entrevistados) ou `validos` (já sem brancos, nulos e indecisos). A página converte totais em válidos sozinha.
- **Sem `registroTSE` no formato `BR-00000/2026`, a pesquisa não aparece.** Confira o registro no [PesqEle](https://pesqele-divulgacao.tse.jus.br) antes de publicar.
- As três pesquisas que já vêm na tabela são cenários de 2º turno testados antes do 1º turno, transcritos de reportagens. Confira os números na fonte.

### Fontes de notícias
Edite `config/fontes.json`. Para desligar uma fonte sem apagar, use `"ativo": false`. Feeds mudam de endereço: a seção *Metodologia* do site lista os que falharam na última coleta.

### Linha do tempo
Edite `config/linha-do-tempo.json`. `tipo` pode ser `tse`, `debate` ou `fato`. Registre fatos das duas campanhas com o mesmo critério.

### Leitura do momento
Edite `config/analise.json` e atualize `dataAnalise` a cada revisão. A escala vai de 0 a 4 (`0` vantagem clara do 13, `2` indefinido, `4` vantagem clara do 22). A página avisa sozinha quando:
- a análise passa de `revisarAposHoras` sem revisão;
- a média das pesquisas aponta outro candidato à frente além da margem de erro.

Toda edição em `config/` ou no `index.html`, ao ser enviada para a `main`, dispara o robô e republica o site.

### Apuração do dia 25/10
O robô descobre sozinho, no arquivo público de configuração do TSE, os códigos das eleições do 1º e do 2º turno. Se a descoberta falhar (o aviso aparece em *Metodologia*), preencha `tse.codigoTurno1` e `tse.codigoTurno2` no bloco CONFIGURAÇÃO. O endereço segue o padrão:

```
https://resultados.tse.jus.br/oficial/ele2026/CODIGO/dados-simplificados/br/br-c0001-eCODIGO6DIGITOS-r.json
```

A partir das 17h a página tenta ler esse arquivo direto do TSE. Se o navegador bloquear, usa a cópia do robô (atualizada a cada 5 minutos).

## Como testar

- **Localmente:** na pasta do projeto, rode `python3 -m http.server 8000` e abra `http://localhost:8000`. (Abrir o arquivo com duplo clique não funciona, porque o navegador bloqueia a leitura de `dados.json` por `file://`.)
- **Apuração simulada:** abra `http://localhost:8000/?simular=apuracao`.
- **Robô sem internet:** `SEM_REDE=1 node coleta.js` (gera `dados.json` só com pesquisas, linha do tempo e análise).
- **Robô completo:** `node coleta.js`.
- **Forçar a apuração fora do dia:** no GitHub, *Run workflow* com a opção *Buscar a apuração do 2º turno* marcada.

## Aspectos legais

- Só aparecem pesquisas com registro no TSE (Lei 9.504/97, art. 33).
- Manchetes mostram só título e trecho curto, sempre com link para a matéria original.
- O visual não imita o TSE nem nenhum veículo, e o rodapé informa que o site é independente.
- Sem cookies, rastreadores ou coleta de dados pessoais (LGPD).
- A **Leitura do momento** é uma análise editorial e está rotulada como tal. Por envolver a divulgação de avaliação sobre quem está à frente em período eleitoral, vale uma conversa com um advogado eleitoral antes de publicar.
