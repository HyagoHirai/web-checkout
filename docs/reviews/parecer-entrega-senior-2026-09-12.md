# Parecer de entrega — avaliação de take-home sênior

Data: 12 de setembro de 2026. Projeto: Web Checkout.

## Veredito

**SIM. Eu entregaria o código atual neste processo seletivo. Considero a solução compatível com o nível esperado de um Senior Software Engineer em um exercício de 2–3 dias.**

Como revisor, meu parecer seria favorável à aprovação da etapa de take-home e ao avanço para a discussão técnica. Não encontrei um defeito funcional bloqueante, uma organização estrutural inadequada ou uma ausência de evidência que justifique outra rodada de refatorações antes da entrega.

Essa conclusão se refere ao conteúdo atual do diretório de trabalho, **incluindo as alterações locais ainda não commitadas**, e não apenas ao HEAD `21d4d5d1fa71e6ce128f909ee369024b9f37db30`. A versão enviada ao avaliador precisa incluir o conteúdo que foi examinado e testado.

O código não está perfeito. O foco do aviso de inatividade, a apresentação temporária do carrinho enquanto o menu é recarregado e alguns detalhes de testes/documentação ainda podem melhorar. Para o alvo declarado, esses pontos são pequenos diante das garantias já implementadas. Eu não exigiria novas funcionalidades, uma arquitetura diferente ou acabamento visual de produto comercial para aprovar este exercício.

O que fundamenta o nível sênior é o tratamento das consequências de cada decisão: quem pode executar o pagamento, o que um timeout realmente significa, quais dados precisam sobreviver e quais precisam desaparecer, quando uma resposta pode alterar a tela e o que os testes de fato comprovam. A quantidade de documentos, agentes ou camadas não faz parte dessa aprovação.

## O que foi efetivamente revisado

A revisão percorreu implementações e chamadores, contratos, testes e configuração. Houve leituras independentes de API, cliente e operação/documentação, seguidas de confronto das suspeitas com as regras atuais. O último diff foi usado para identificar mudanças locais, sem limitar o escopo da leitura. Durante a revisão entraram mais 12 arquivos alterados por trabalho externo à revisão. Foi criado um segundo snapshot, os deltas e seus chamadores foram examinados e os gates foram repetidos. A conclusão e os números finais abaixo correspondem a esse segundo snapshot, não à versão anterior.

| Área | Arquivos examinados | Conteúdo e evidência |
|---|---:|---|
| API | 46 | Todos os 21 módulos de produção, testes, helpers, migration, seed, Dockerfile e configurações |
| Cliente | 45 | Toda a máquina, transporte, storage, componentes, estilos, testes, build e configuração |
| E2E/operação | 17 | US1–US9, bfcache, helpers, fixtures, aceitação operacional e isolamento |
| Compartilhado | 2 | Constantes, unidades, enums e contratos consumidos pelos dois lados |
| Documentação | 20 | README, PROCESS, constituição, ADRs, especificações, modelo de dados, contratos e instruções |
| Configuração raiz | 6 | Compose, manifests, lockfile e arquivos de ambiente/ignore |

São **136 arquivos relevantes do produto**. Outros 29 arquivos de scaffold Spec Kit/Claude foram inventariados e tiveram a proveniência verificada; não são executados pelo produto e não receberam uma auditoria funcional da ferramenta externa. Dependências, bundles, resultados de teste e metadados Finder ficaram fora da leitura manual linha a linha. O lockfile foi conferido estruturalmente; auditar o código de todas as dependências externas não foi parte deste parecer.

Não foram encontrados `AGENTS.md` aplicáveis. A constituição e os ADRs foram considerados segundo a precedência do próprio projeto; propostas antigas não foram promovidas a requisitos atuais. Os pontos das revisões anteriores foram tratados como hipóteses a conferir.

O ambiente da demonstração permaneceu separado dos testes. Foi criada uma cópia temporária com hashes dos arquivos atuais; os testes usaram novos recursos Compose e bancos descartáveis. Nenhuma alteração de produção, teste, configuração, documentação canônica ou Git foi feita por esta revisão.

## Por que eu aprovaria a engenharia

### A API protege o efeito, não apenas o registro

O trecho mais importante é [api/src/services/orders.ts:175](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/api/src/services/orders.ts:175). `submit` primeiro normaliza a intenção e procura uma chave existente. Para uma chave nova, valida o menu, tenta inserir o registro pendente e só permite executar o simulador à requisição que recebeu a linha inserida. O concorrente observa o vencedor e retorna o resultado registrado.

Isso demonstra entendimento de concorrência. Uma unique constraint sozinha impediria duas linhas, mas não impediria que duas requisições chamassem um pagamento antes de descobrir o conflito. Aqui a restrição de unicidade participa da aquisição do direito de executar o efeito, e a execução vem depois da persistência.

O `SELECT` após `ON CONFLICT ... DO NOTHING` é outra instrução, permitindo observar o concorrente que confirmou seu registro. O mecanismo foi confrontado com a documentação do PostgreSQL 18 e com a integração executada em PostgreSQL 18.6. [PostgreSQL 18: INSERT](https://www.postgresql.org/docs/18/sql-insert.html), [isolamento Read Committed](https://www.postgresql.org/docs/18/transaction-iso.html).

Os testes verificam tanto a quantidade de registros quanto as chamadas ao simulador, inclusive com oito requisições sobrepostas em [api/test/integration/concurrency.test.ts:19](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/api/test/integration/concurrency.test.ts:19). Essa distinção pesa mais na avaliação de senioridade do que adotar um padrão de classes ou separar SQL em mais arquivos.

### Incerteza e falha definitiva têm consequências diferentes

Em [api/src/services/orders.ts:148](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/api/src/services/orders.ts:148), uma exceção depois do commit não é convertida em recusa. O registro pode permanecer pendente e ser consultado; o replay não executa o efeito novamente. Os testes de [api/test/integration/post-commit-windows.test.ts](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/api/test/integration/post-commit-windows.test.ts) cobrem exceção antes do simulador, depois do simulador e falha na gravação do resultado.

No cliente, `declined`, `unresolved`, rejeição de validação e serviço inacessível não são tratados como um único estado de erro. As telas e as ações disponíveis refletem o que foi confirmado. Nova chave após recusa é permitida; resultado desconhecido não vira convite automático para pagar outra vez.

A ausência de reconciliação automática de pendências é uma limitação explícita e coerente com o simulador. Acrescentar retomada sem um protocolo seguro com um provedor real introduziria risco e escopo, não qualidade gratuita.

### Dinheiro é validado na fronteira correta

O cliente envia identificadores, quantidades e total esperado. O servidor consulta seus próprios preços, valida disponibilidade e limites e produz o snapshot aceito. O schema HTTP é estrito e não corrige silenciosamente entradas; a validação de domínio e as constraints do banco acrescentam defesas em pontos diferentes.

[api/src/domain/validate.ts:46](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/api/src/domain/validate.ts:46), [api/src/domain/money.ts](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/api/src/domain/money.ts) e [api/migrations/0001_initial.sql](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/api/migrations/0001_initial.sql) mostram essa sequência de forma direta. Os cálculos são em centavos; não há dependência de arredondamentos de ponto flutuante para estabelecer o valor aceito. Replays preservam o pedido registrado mesmo que o menu tenha mudado.

Também conferi a hipótese de overflow em valores intermediários: os limites estruturais de quantidade/linhas e o tipo `integer` do PostgreSQL mantêm os intermediários abaixo do limite de precisão inteira do JavaScript; em seguida o domínio rejeita o que ultrapassa o teto do pedido. Não encontrei um erro monetário nessa combinação.

### O cliente modela tempo e identidade de maneira deliberada

[client/src/machine/admission.ts:22](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/client/src/machine/admission.ts:22) verifica validade temporal, interação, chave e fase antes de aceitar uma resposta. [client/src/machine/reducer.ts:90](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/client/src/machine/reducer.ts:90) protege a progressão do conhecimento sobre o pedido e preserva o deadline de uma recusa tardia.

O envio do POST está ligado a PAY em [client/src/machine/runtime.ts:112](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/client/src/machine/runtime.ts:112), não à renderização nem simplesmente à entrada na fase `submitted`. Portanto, renderizar novamente ou restaurar uma submissão não implica reenviá-la. React assina um estado externo que é atualizado pela máquina; a API usada para essa integração é apropriada ao desenho. [React: useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore).

Os testes e probes verificaram duplo PAY, reload, late result de uma chave anterior, recusa depois de unresolved e alteração de preço enquanto a próxima intenção ainda não foi enviada. Em particular: envio em 0, recusa tardia em 100 s e prazo vigente de 128 s não apagam prematuramente a interação; retry cria K2, e uma resposta de K1 não altera K2.

Essa é a parte do frontend que mais sustenta a avaliação sênior. Não depende de o layout ser sofisticado.

### A operação é reproduzível e útil para o avaliador

O Compose subiu uma aplicação utilizável. Conexão, migration e seed precedem o listen da API. O seed converge sem atualizar todas as linhas apenas porque o timestamp mudou. Os testes operacionais comprovaram persistência entre down/up e restart.

O nginx separado tem uma utilidade concreta: a interface pode continuar carregando e explicar indisponibilidade da API. Logs e contadores ajudam a investigar as falhas sem impor infraestrutura de observabilidade adicional. O runtime da API utiliza dependências de produção e usuário não root.

O experimento adicional de replay depois de reiniciar a API confirmou o mesmo pedido e a mesma referência, com zero novas execuções do simulador após o restart. Ele foi realizado no primeiro snapshot; o código da API e da persistência não mudou no segundo. Isso complementa a aceitação operacional, que consulta o registro preservado.

## Clean Code, funções e diretórios

**A estrutura atual faz sentido. Eu não reorganizaria as pastas antes de entregar.**

Na API, `routes` trata a fronteira HTTP; `services/orders` coordena o caso de uso; `domain` concentra decisões puras; `db` cuida dos recursos e operações comuns do banco; `payment` isola o efeito simulado. O serviço não acumula vários domínios independentes. Manter seu SQL específico perto da sequência de aceitação facilita auditar a garantia principal.

No cliente, `machine/` agrupa regras e coordenação; `api/` trata transporte e classificação; `screens/` recebe dados e callbacks. `screens/menu/` agrupa partes que pertencem à mesma tela. `shared/` contém apenas vocabulário e constantes realmente compartilhados. As análises de imports não identificaram ciclos de runtime; a dependência circular de tipos da composição Fastify não é um ciclo de inicialização.

As funções maiores foram avaliadas pelo que fazem e por quem as chama:

| Símbolo | Responsabilidade atual | Parecer |
|---|---|---|
| `createOrdersService`, [api/src/services/orders.ts:59](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/api/src/services/orders.ts:59) | Fábrica com dependências e helpers privados para uma submissão idempotente | Manter. O tamanho inclui definições internas; não é uma sequência monolítica |
| `submit`, [api/src/services/orders.ts:175](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/api/src/services/orders.ts:175) | Cerca de 58 linhas com a ordem de consulta, validação, insert, execução e registro | Já delega operações relevantes. Fragmentar mais esconderia a ordem crítica |
| `validateSubmission`, [api/src/domain/validate.ts:46](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/api/src/domain/validate.ts:46) | Cerca de 66 linhas acumulando motivos, itens afetados e snapshot numa passagem | Coeso; extrair cada condição aumentaria passagem de contexto |
| `createRuntime`, [client/src/machine/runtime.ts:30](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/client/src/machine/runtime.ts:30) | Fábrica com estado privado, recursos, helpers de efeitos e ações | Tamanho justificável pelo ownership; não precisa virar uma coleção de hooks |
| `reduce`, [client/src/machine/reducer.ts:165](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/client/src/machine/reducer.ts:165) | Cerca de 130 linhas de transições, apoiadas por regras puras separadas | Manter a tabela de eventos visível facilita revisar legalidade e efeitos |
| `App`, [client/src/App.tsx:19](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/client/src/App.tsx:19) | Mapeia fase/tela para componentes | Não mistura rede ou cálculo financeiro com renderização |
| `CartPanel`, [client/src/screens/menu/CartPanel.tsx:16](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/client/src/screens/menu/CartPanel.tsx:16) | Linhas, controles, total e ação do mesmo painel | Extração atual suficiente; não precisa atomizar cada trecho de JSX |

Os nomes ficaram mais claros depois da passagem de legibilidade. `interaction`, `submission`, `fingerprint`, `menuRequested` e `interactionEnded` reduzem a necessidade de voltar a declarações para interpretar abreviações. As extrações `executePayment`, `applyOutcome`, `applyRejection` e `emitTransitionTelemetry` nomeiam etapas reais; não são wrappers arbitrários.

| Eixo solicitado | Avaliação de entrega |
|---|---|
| Clean Code | Adequado, com pequenos comentários a atualizar; funções principais compreensíveis pelos seus fluxos |
| Modularização | Adequada; fronteiras úteis e ausência de acoplamento amplo que exija reorganização |
| YAGNI | Adequado ao escopo aprovado; não encontrei necessidade de remover um mecanismo central ou acrescentar camadas |
| Backend/React/tipos/persistência/concorrência/testes/operação | Adequado, com evidência de execução positiva e limitações explícitas |

Não exigiria ORM, repository genérico, container de injeção, Redux/XState, outbox, worker, autenticação ou plataforma de observabilidade. Nenhuma dessas adições resolve um bloqueante encontrado nesta revisão.

## Interface e adequação ao prazo

Percorri a interface atual em Chromium a 1024×768 com toque. Observei a tela inicial, menu vazio, carrinho com três produtos, revisão e pagamento; os demais estados foram exercitados pela suíte de navegador. Nas cinco telas inspecionadas não houve erro de JavaScript, rolagem horizontal ou controle abaixo dos 56×56 px definidos pelo projeto.

O visual é simples, mas possui hierarquia consistente, preços legíveis, ações grandes e total próximo da ação principal. O carrinho atual não apresenta a compressão dos nomes/controles vista nas capturas antigas. O retry após recusa vai diretamente ao pagamento com nova chave; não é apenas a remoção de um aviso na tela de resumo.

**Para uma vaga de engenharia de software sênior e este prazo, eu não reprovaria pelo design atual.** Não o apresentaria como demonstração de design visual avançado ou como solução para todos os formatos de tela: o alvo é o kiosk explicitamente definido. Fotos e uma identidade visual mais elaborada poderiam melhorar a experiência comercial, mas não são o melhor uso do tempo restante do exercício.

O ponto de proporcionalidade que merece atenção é a quantidade de processo e documentação. Há material suficiente para consumir mais tempo do leitor do que o fluxo principal exige. Isso não torna a implementação ruim; eu facilitaria a primeira leitura, deixando execução, demonstração e decisões essenciais fáceis de encontrar. Não criaria mais documentação arquitetural nem abriria outra rodada ampla de revisão apenas para perseguir perfeição.

## Melhorias que eu mencionaria, sem bloquear a entrega

Nenhum item abaixo muda o veredito para “não”. São ajustes de acabamento ou próximos passos delimitados.

| Local | Melhoria e motivo | Prioridade prática |
|---|---|---|
| [client/src/screens/menu/CartPanel.tsx:17](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/client/src/screens/menu/CartPanel.tsx:17) e [client/src/machine/reducer.ts:239](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/client/src/machine/reducer.ts:239) | Na sequência reload durante pagamento → recusa chega antes do menu → Edit order, o carrinho temporariamente pode mostrar Item/$0.00 e Review habilitado. O reducer recusa a ação e não permite pagar; o menu resolve ou falha em até 8 s. Exibir carregamento/preço indisponível e desabilitar Review enquanto `menu === null` alinharia a apresentação à guarda já correta | Pequeno refinamento de estado de carregamento; reproduzido em probe de lógica/renderização, sem falha financeira |
| [package.json:13](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/package.json:13) e [package-lock.json:16](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/package-lock.json:16) | Sincronizar a metadata `engines`: o manifest exclui Node 25, mas o registro raiz do lock ainda o inclui. Dependências/versões coincidem e Node 24.20 passa. Não atualizar pacotes por isso | Pequena higiene de entrega |
| [specs/001-web-checkout/contracts/openapi.yaml:143](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/specs/001-web-checkout/contracts/openapi.yaml:143) | Retirar a afirmação de que um pedido existente depois de um 500 necessariamente está pendente. O resultado pode já ter sido gravado; a classificação implementada de desconhecido/lookup está correta | Precisão documental, sem mudança de produto |
| [client/src/machine/runtime.ts:218](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/client/src/machine/runtime.ts:218) | O JSDoc diz que uma página viva só recebe TICK, mas o código também hidrata via RESUME quando a memória foi superada pelo registro da aba | Correção textual pequena |
| [api/test/integration/replay.test.ts:91](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/api/test/integration/replay.test.ts:91) | Garantir liberação do gate em `finally` se uma asserção falhar antes de `releaseA()`. A barreira normal já foi corrigida e não depende mais do sleep de 50 ms | Melhoria no diagnóstico de falhas de teste |
| [e2e/tests/kiosk.ts:64](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/e2e/tests/kiosk.ts:64) | Correlacionar eventos observados também por interação/chave quando o cenário pretende provar essa identidade. O helper atual filtra apenas pelo nome | Reforço da evidência numa futura alteração da área |
| [client/src/screens/InactivityWarning.tsx:1](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/client/src/screens/InactivityWarning.tsx:1) | Mover/restringir foco no diálogo modal. O overlay bloqueia toque, mas o teclado pode continuar em um controle de fundo | Melhoria de acessibilidade; não bloqueia o alvo por toque |

Há ainda uma recomendação de apresentação específica para a candidatura: **eu retiraria de [PROCESS.md:361](/Users/hyago.hirai/Documents/Personal/Mushgin/web-checkout/PROCESS.md:361) a classificação “senior/staff” atribuída por outros agentes**. Como avaliador, eu daria valor aos problemas encontrados, às correções e aos limites assumidos; a votação de agentes sobre senioridade não é evidência independente de capacidade profissional. É mais convincente deixar as decisões técnicas sustentarem essa conclusão.

Também colocaria a seção de execução mais cedo no README, se houver tempo para um ajuste editorial. Esses pontos de apresentação são sugestões, não uma condição técnica oculta de aprovação.

Não adicionei como bloqueantes hipóteses sem caminho real no produto: adulteração manual de sessionStorage, respostas arbitrárias que o servidor não produz, cenários de escala não solicitados ou necessidades de um provedor de pagamento real.

## Correções anteriores e riscos que continuam aceitos

Foram conferidas as correções de limites mistos, observação da emissão de telemetria nos testes de navegador, helpers monetários sem uso, sincronização do teste de replay, título de retry e classificação de polls pendentes repetidos. Elas estão presentes no conteúdo atual; não reapresento esses problemas como pendências.

As alterações que chegaram durante a revisão também foram avaliadas: `setLine` mantém a posição da linha alterada sem mutar o carrinho anterior; GO_REVIEW recusa transição sem menu carregado; o carregamento do menu passa a ter espera limitada a 8 s e o proxy limita a conexão à API a 5 s. Resposta de menu que chega depois do timeout não substitui o resultado de um retry, e timeout do menu não desfaz um pagamento já confirmado. São ajustes focados, com testes, sem ampliação indevida de arquitetura. A corrida com timeout não aborta a conexão subjacente; isso é uma oportunidade de melhorar o uso de recursos, não um defeito financeiro demonstrado.

A nova `restatesKnownState` não regrediu a admissão: um pending idêntico admitido é apenas repetição normal; um pending depois de resultado terminal continua sendo descartado e observado como stale. O caso de resultado de chave retida é tratado antes dessa comparação. O total registrado por chave é imutável, portanto não há atualização legítima de preço sendo perdida nesse atalho.

A janela residual de validação concorrente permanece documentada no ADR-002: uma rejeição por requisição pode coexistir com a aceitação de outra requisição da mesma chave. A segunda consulta reduz essa janela, sem eliminá-la. A recuperação restrita por `not_found` reconhecido foi aprovada nos documentos atuais. Não exigi lock novo para substituir uma decisão aceita no exercício.

Pedidos pendentes após exceção/reinício não são retomados automaticamente; telemetria é best-effort; não há autenticação de clientes, reserva de estoque, administração ou reconciliação de produção. Essas ausências são limites do exercício. A revisão não as usa para aprovar uma implantação com pagamentos reais.

## Verificação executada

Os gates foram executados com **Node 24.20.0**, obtido da distribuição oficial e verificado contra seu SHA-256, sem trocar a instalação do usuário ou atualizar as dependências do repositório. A API também foi executada na imagem Node 24.20.0. O banco utilizado foi PostgreSQL 18.6; o navegador foi Chromium 153.0.8010.12. Versões de teste: Vitest 4.1.11 e Playwright 1.63.0. React 19.2.8, Vite 8.2.2 e TypeScript 6.0.3 efetivos foram conferidos no ambiente.

| Gate | Resultado válido desta revisão |
|---|---|
| Compose build/up e readiness | Passou; aplicação utilizável em recursos novos |
| Type-check API e cliente | Passou |
| Testes da API com PostgreSQL real | **63 passaram**, 16 arquivos |
| Testes do cliente | **120 passaram**, 8 arquivos |
| Type-check E2E | Passou |
| Build de produção do cliente | Passou |
| E2E de kiosk e bfcache | **36 passaram**, execução completa isolada |
| Aceitação operacional e isolamento | **4 passaram** |

São **223 testes aprovados nas execuções válidas**, além do build, type-checks e experimentos complementares. A quantidade não é usada como métrica de senioridade; o peso vem dos comportamentos e invariantes que as asserções exercitam.

As principais invocações foram `npm test`, `npm run typecheck -w e2e`, `npm run build -w client`, `npm run test:e2e -w e2e` e `npm run test:ops`. Foram fornecidas variáveis para apontar exclusivamente ao ambiente descartável: projeto `webcheckout-final-0912`, HTTP 18182, PostgreSQL 55541, banco de integração `review_0912_test`; operação em `webcheckout-accept`, HTTP 18183 e PostgreSQL 55542. Credenciais não são reproduzidas neste relatório.

**Falha de preparação investigada:** na primeira execução, o wrapper npm ignorou o parâmetro adicional `--output`. As suítes de navegador e operação estavam paralelas e compartilharam a pasta de artefatos; o fechamento de um trace falhou com `ENOENT` depois do cenário de recarga. Foram 35 cenários aprovados e um erro de artefato, sem falha de asserção do checkout. Essa execução não foi usada para acusar uma regressão do produto. A suíte de navegador foi executada novamente, inteira, com saída separada e sem concorrência com a suite operacional: **36/36**, sem alterar teste, implementação, timeout ou asserção.

### Experimentos complementares e alcance

- Replay após reiniciar a API: pedido aprovado antes do restart; repetição da mesma chave/payload retorna o mesmo pedido/referência, sem executar o simulador novamente após o reinício.
- Probe de lógica do cliente: duplo PAY, prazo de recusa tardia, chave nova após recusa, descarte de resultado da chave anterior e invalidação de intenção não enviada por preço novo. Na versão final, também foram verificados timeout do menu em 8 s, retry com menu novo, descarte do fetch antigo e timeout de menu depois de pagamento confirmado sem regressão da confirmação. Usa API/armazenamento controlados em memória; não é apresentado como prova da unicidade do PostgreSQL.
- Inspeção de cinco telas reais com viewport e toque do alvo: sem erros de JavaScript, overflow horizontal ou controles pequenos no percurso observado. O probe não enviou pedidos.
- Revisão de imports, consumidores e manifests: sem ciclo de runtime relevante; versões de dependências coerentes, com a pequena divergência de metadata `engines` já descrita.

### Limitações da conclusão

Os testes de hooks verificam janelas e exceções específicas; não simulam queda de energia nem um provedor real. Os testes de bfcache verificam restauração e expiração, mas não comprovam uma garantia visual frame a frame sobre a primeira pintura de qualquer documento congelado. Não foram executadas certificação de acessibilidade, testes em dispositivos físicos, todos os navegadores ou testes de carga de produção. O build Docker pôde utilizar cache; não se declara uma instalação inteiramente nova de todas as dependências fora de cache.

Esses limites não impedem um parecer favorável para o exercício especificado. Seriam insuficientes para certificar um produto financeiro em produção, que não é o objeto desta avaliação.

## Como eu encerraria a avaliação de seleção

Eu marcaria a etapa como **aprovada** e usaria a entrevista para confirmar domínio das decisões, com perguntas como:

1. Por que impedir duas linhas no banco não basta para impedir dois efeitos de pagamento?
2. Quem executa o efeito quando oito requests usam a mesma chave e por quê?
3. O que permanece possível antes e depois de registrar o resultado do simulador?
4. Por que uma recusa permite chave nova, enquanto um timeout não autoriza essa conclusão?
5. Como interação, intenção e estado terminal impedem uma resposta antiga de alterar o pedido atual?
6. Qual foi o custo de escolher PostgreSQL e o que você deliberadamente deixou fora destes 2–3 dias?

O código atual oferece respostas consistentes a essas perguntas. O registro de decisões não substitui a capacidade de explicá-las e modificar o código, mas a implementação fornece evidência favorável.

**Não identifiquei uma lista obrigatória de mudanças para tornar a entrega aceitável.** Eu faria, no máximo, a pequena higiene de metadata/texto indicada, garantiria que as alterações locais avaliadas estejam na versão enviada e encerraria o exercício. Outra reorganização ampla consumiria prazo e introduziria risco sem resolver um problema impeditivo demonstrado.


## Registro de preservação

A conferência final comparou os hashes dos 165 arquivos do segundo snapshot com o diretório de trabalho: nenhum foi modificado pela revisão. O HEAD, o índice e as alterações locais preexistentes foram preservados. Os recursos Compose criados para a revisão foram encerrados após conferência de suas labels; o ambiente operacional descartável também foi removido. Somente este parecer foi escrito no repositório.
