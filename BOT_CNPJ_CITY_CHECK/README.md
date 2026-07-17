# Bot CNPJ → Cartão completo (Receita Federal)

Userscript que, para cada CNPJ de uma lista, consulta o **cartão CNPJ**
("Comprovante de Inscrição e de Situação Cadastral") no site da Receita Federal e extrai
**todos os campos do comprovante** (nome empresarial, nome fantasia, porte, atividade principal e
secundárias, natureza jurídica, endereço completo, e-mail, telefone, situação cadastral etc.).
No fim, exporta um **CSV**.

Ele roda **dentro da sua sessão real do navegador** (Microsoft Edge com Tampermonkey), então o site
vê um usuário normal — não há automação/WebDriver detectável. **Você marca o captcha**; o script faz
o resto: preenche o CNPJ, clica em *Consultar*, lê o cartão inteiro e avança para o próximo.

---

## 1. Instalar o Tampermonkey no Edge

1. Abra a **Edge Add-ons Store**: `https://microsoftedge.microsoft.com/addons`
2. Pesquise por **Tampermonkey** e clique em **Obter / Instalar**.
3. Confirme a instalação. O ícone do Tampermonkey (🐵) aparecerá na barra de extensões.

> Também é possível instalar a versão da Chrome Web Store (o Edge aceita), mas a da Edge Store é o
> caminho mais simples.

## 2. Adicionar o userscript

1. Clique no ícone do **Tampermonkey** → **Painel de controle** (Dashboard).
2. Aba **"+" (Criar novo script)**.
3. Apague o conteúdo padrão, **cole todo o conteúdo** de [`bot-cnpj-cidade.user.js`](bot-cnpj-cidade.user.js).
4. **Arquivo → Salvar** (ou `Ctrl+S`).

> Alternativa: arraste o arquivo `bot-cnpj-cidade.user.js` para a janela do Edge — o Tampermonkey
> oferece a instalação automaticamente.

## 3. Usar

1. Abra a página de solicitação da Receita:
   `https://solucoes.receita.fazenda.gov.br/Servicos/cnpjreva/Cnpjreva_Solicitacao.asp`
2. Um **painel flutuante** ("🤖 Bot CNPJ → Cartão completo") aparece no canto superior direito.
   (Se atrapalhar, arraste-o pela barra de título ou clique em **—** para minimizar.)
3. **Cole a lista de CNPJs** na caixa de texto — **um por linha**. Pode ser com ou sem máscara
   (`12.345.678/0001-90` ou `12345678000190`); o script limpa, valida os dígitos e remove duplicados.
4. Clique em **▶ Iniciar**.
5. O script **preenche o primeiro CNPJ sozinho** e mostra *"Aguardando você marcar o captcha…"*.
6. **Marque o captcha** (hCaptcha/reCAPTCHA). Assim que resolvido, o script **clica em "Consultar"
   automaticamente**, lê o comprovante (todos os campos), salva e **volta para consultar o próximo**.
7. Repita a marcação do captcha a cada CNPJ (o site exige um por consulta).
8. Ao terminar, o painel mostra **"✔ Concluído"**. Clique em **⬇ Baixar CSV**.

### Colunas do CSV

```
CNPJ;Matriz/Filial;Data de Abertura;Nome Empresarial;Nome Fantasia;Porte;
Atividade Principal;Atividades Secundárias;Natureza Jurídica;Logradouro;Número;
Complemento;CEP;Bairro/Distrito;Município;UF;Endereço Eletrônico;Telefone;EFR;
Situação Cadastral;Data Situação Cadastral;Motivo Situação Cadastral;
Situação Especial;Data Situação Especial;Status;Mensagem
```

(Tudo em uma única linha de cabeçalho — quebrado acima só para leitura.)

- **Atividades Secundárias** vêm separadas por ` | ` dentro da mesma célula.
- Campos vazios no cartão (marcados com `****` pela Receita) saem em branco.
- **Status** pode ser: `sucesso`, `invalido`, `nao_encontrado`, `captcha_falhou` ou `erro`.
- O arquivo sai com **BOM UTF-8**, então abre com acentuação correta no **Excel**
  (separador `;`, padrão brasileiro).

---

## Botões do painel

| Botão | O que faz |
|-------|-----------|
| **▶ Iniciar** | Lê a caixa de texto, monta a fila e começa a processar. |
| **⏸ Parar** | Pausa o processamento (o progresso é mantido). |
| **🗑 Limpar** | Zera fila, resultados e progresso (reset total). |
| **⬇ Baixar CSV** | Exporta os resultados coletados até o momento. |

## Retomada (o progresso persiste)

O estado (fila, índice atual, resultados) é salvo pelo Tampermonkey e **sobrevive a recarregar a
página ou fechar/reabrir a aba**. Se você recarregar no meio do processo com o bot em execução, ele
**continua de onde parou** — inclusive extraindo o comprovante que já estava aberto.

## Como os campos são extraídos

A leitura do comprovante combina três estratégias, em ordem de confiança:

1. **Proximidade no DOM** (fonte primária): para cada rótulo do cartão ("NOME EMPRESARIAL",
   "MUNICÍPIO", "SITUAÇÃO CADASTRAL"…), acha o elemento correspondente e pega o valor adjacente.
   Usa a estrutura do DOM, então não sofre com a linearização do texto.
2. **Walker de texto** (fallback): percorre o `innerText` linha a linha, associando cada valor ao
   rótulo anterior. Cobre listas multi-linha (ex.: várias atividades secundárias).
3. **Saneamento por regex**: normaliza CNPJ, CEP, UF, MATRIZ/FILIAL, datas e a situação cadastral,
   e corta rótulos vizinhos que porventura tenham "vazado" para dentro de um valor.

## Nota técnica: o site é uma SPA (Angular)

O site da Receita hoje é uma aplicação Angular (`router-outlet`), não mais páginas `.asp`
separadas. Ao clicar em **Consultar**, a URL muda para `.../cnpjreva/comprovante`, mas **a página
não recarrega** — é navegação client-side. Por isso o script não depende de "reinjeção a cada
página"; depois do clique ele mesmo fica observando a URL/DOM até o resultado aparecer, e só então
força um recarregamento real de volta ao formulário para buscar o próximo CNPJ. Isso é transparente
para o uso — só é relevante se você for mexer no código.

Se quiser começar do zero, clique em **🗑 Limpar**.

---

## Medidas para não sobrecarregar o servidor da Receita

Além do fato de cada consulta exigir que **você** marque o captcha (o que já limita o ritmo a
velocidade humana), o script tem três proteções configuráveis no topo do arquivo
(`bot-cnpj-cidade.user.js`, seção "Medidas de contenção de volume"):

| Medida | Padrão | O que faz |
|--------|--------|-----------|
| **Intervalo aleatório entre consultas** | 3–7s | Após ler o comprovante, espera um tempo aleatório antes de voltar à página de solicitação — evita um padrão fixo/robótico de requisições. |
| **Pausa longa periódica** | 90s a cada 15 consultas | Mesmo que você marque captchas rapidamente em sequência, o bot força uma pausa maior de tempos em tempos. |
| **Backoff em falhas seguidas** | pausa após 3 falhas seguidas | Se `captcha_falhou` ou `erro` ocorrerem 3 vezes seguidas (sinal de bloqueio/instabilidade do site), o bot **para sozinho** em vez de insistir. Revise o CSV parcial e clique Iniciar para retomar. |

Para ajustar, edite as constantes `DELAY_MIN_MS`, `DELAY_MAX_MS`, `PAUSA_A_CADA_N`,
`PAUSA_LONGA_MS` e `MAX_ERROS_SEGUIDOS` no início do script. Recomenda-se **não** reduzir os
valores padrão para consultas em volume — eles já são conservadores de propósito.

## Solução de problemas

- **O painel não aparece**: confirme que o Tampermonkey está ativo e que a URL casa com
  `https://solucoes.receita.fazenda.gov.br/Servicos/cnpjreva/*`. Recarregue a página.
- **O script não clica em "Consultar"**: o layout do site pode ter mudado. O script tenta vários
  seletores (`#salvar`, botões/links com o texto "Consultar"). Se ainda assim falhar, clique você
  mesmo em Consultar — o passo do comprovante segue funcionando.
- **Não extraiu os dados**: o parsing é por rótulos do cartão, com proximidade no DOM + walker de
  texto + saneamento por regex. O registro só é considerado sucesso se ao menos nome empresarial,
  município ou nº de inscrição forem lidos; senão sai com `status = erro` e o bot **não trava** —
  segue para o próximo. Campos individuais que faltarem saem em branco no CSV.
- **Captcha recusado**: a página costuma voltar para a solicitação com mensagem de erro; o script
  registra `captcha_falhou` e avança. Você pode refiltrar esses CNPJs depois pelo CSV.
- **CNPJ inválido**: é detectado **antes** da consulta (validação dos dígitos verificadores) e
  registrado como `invalido`, sem gastar uma consulta.

## Aviso

Use de forma responsável e em conformidade com os termos de uso do site da Receita Federal. A
marcação do captcha é sempre feita **por você**; o script apenas automatiza o preenchimento e a
leitura dentro da sua própria sessão.
