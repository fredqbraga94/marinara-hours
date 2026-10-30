# Marinara Hours — auditoria de segurança, 29/10/2026; atualização em 30/10/2026

## Resultado e limite da conclusão

**Sete achados confirmados, incluindo configurações preventivas; sete corrigidos na branch; nenhuma correção publicada por esta missão.** Três achados são de gravidade alta. Não foi comprovada vulnerabilidade crítica. Isso não demonstra ausência de outras falhas.

Branch: `security/audit-hardening-20261029`, [PR #55](https://github.com/fredqbraga94/marinara-hours/pull/55). A primeira coleta usou `4ec51c3` / API v57. Na retomada, a main avançou para `ac241d0679c0b8d09a5952bc55efded9a80abbe9`; essas mudanças aprovadas de unidades e PDFs foram incorporadas. A produção observada agora é API **v58**, importando `faa239efff92d10143910c12e10b3dcea0eea553`. Projeto Supabase: `nnchgomdnnqsaovfivob`.

O trabalho de segurança já existente no PR foi preservado, inclusive a proteção de troca de PIN e de navegação de notificações. Relatório anterior arquivado em `docs/security-audit-initial-pr55-20261029.md`. Commit consolidado de implementação: `6de08e8f8963cf149355c2bdaf470c1b759dc577`; inclui como pais o PR anterior `70a5149` e a main atual `ac241d0`. Nenhum histórico remoto foi sobrescrito.

**Status: apto com ressalvas para revisão; publicação suspensa.** A proposta altera autorizações administrativas e precisa de implantação coordenada, CI e validação no Safari/PWA instalado. A produção continua com os achados abaixo. Não há aprovação de segurança para utilização multiunidade sem essas correções e validações.

Consultas de produção foram somente de metadados, configurações de segurança, definições SQL e contagens agregadas. Nenhum registro real de ponto, nome, PIN, token ou endereço de dispositivo foi extraído para reproduzir falhas. Nenhum teste de força bruta, carga ou escrita foi executado em produção. Nenhuma variável secreta foi alterada.

## Security score — estimativa, não certificação

Os pontos representam controles examinados e evidências disponíveis; verificações ausentes não recebem pontuação integral. O score da proposta pressupõe aplicação de **todo** o conjunto SQL + API + Service Workers; não descreve a produção atual.

| Critério | Máximo | Produção observada | Proposta testada |
|---|---:|---:|---:|
| Autenticação: PIN, limites, vínculo do dispositivo, expiração/revogação | 25 | 20 | 21 |
| Autorização: funcionário, departamento, unidade, dispositivo e pareamento | 25 | 13 | 22 |
| Dados/API: RLS, privilégios, respostas e privacidade de logs | 20 | 17 | 19 |
| Navegador/PWA: cache, logout e validação de navegador | 15 | 7 | 10 |
| Cadeia de fornecimento/infraestrutura: histórico, dependências, CI e deploy | 15 | 8 | 8 |
| **Total** | **100** | **65** | **80** |

Não se atribuiu nota máxima porque não houve validação em iPhone físico, cobertura completa de corridas de todas as operações em PostgreSQL com várias conexões, auditoria completa de configuração do provedor de hospedagem nem cobertura dinâmica de todos os endpoints possíveis.

## Achados confirmados

### AUDIT-01 — administração e pareamento de dispositivos sem isolamento por unidade — ALTO

- **Localização anterior:** `supabase/migrations/20261013020000_device_auth_pin_limits.sql`, funções `auth_list_devices`, `auth_revoke_device`, `auth_unlock_device`, `auth_rename_device`, `auth_set_mode` e `auth_redeem_pairing_code`; `Index.ts`, ação `manager_devices` e seu histórico `used_by`.
- **Evidência:** com a API real e SQL real isolados, um gerente fictício de Hawthorne recebeu dispositivo e nome do gerente de Clayfield. A revogação cruzada retornou HTTP 200, e a sessão de Clayfield passou a HTTP 401. O modo global também podia ser alterado por um gerente de unidade. Revisão independente encontrou uma segunda rota: código de pareamento de Clayfield reativava e renomeava dispositivo revogado de Hawthorne. Um código emitido por gerente posteriormente inativo também continuava utilizável.
- **Impacto:** exposição de identidade e histórico de uso de outras unidades, alterações indevidas de dispositivos e interrupção de acesso; alteração de política global de autenticação. Não foi demonstrada leitura de todos os registros de ponto por essa rota.
- **Correção:** migration `20261030020000_audit_device_scope.sql` introduz `auth_devices.management_location`, restringe listagem/mutação/pareamento por unidade e valida se o emissor do código continua ativo. O histórico de usuários no servidor filtra a unidade. Com várias unidades ativas, alteração do modo global exige administração pelo proprietário no Supabase; a API retorna 403 e a lista informa `can_change_mode=false`.
- **Compatibilidade:** titularidade administrativa não altera PINs, modo de login nem sessões existentes. O backfill atribui unidade somente quando as associações históricas concordam. Dispositivos ambíguos ficam sem atribuição para revisão do proprietário. Novos dispositivos herdam a unidade de quem os autoriza ou do primeiro usuário em recuperação. A titularidade não muda silenciosamente a cada login.
- **Limite importante:** a revogação de um dispositivo legitimamente administrado pela unidade encerra **todas** as sessões daquele dispositivo, inclusive de alguém de outra unidade que o tenha usado. A autorização de dispositivos continua global para login com PIN válido; esta mudança isola sua administração. Dispositivos realmente compartilhados entre unidades precisam de proprietário administrativo explícito.
- **Status:** corrigido na branch; implantação pendente.
- **Testes:** nove testes de administração/pareamento passaram. Incluem recusa cruzada, nomes ocultos, sessão estrangeira preservada, operação local, repetição da migration, rollback/reaplicação, histórico compartilhado, código rejeitado não consumido, rótulo preservado e recuperação do proprietário. A reprodução anterior permanece em `device-scope-observation.mjs`; com `AUDIT_BASELINE=1`, retorna exit 2 quando reproduz a falha.

### AUDIT-02 — desligamento de notificações em outra unidade — ALTO

- **Localização anterior:** `20261021040000_push.sql`, `manager_push_unsubscribe`, predicado do UPDATE.
- **Evidência:** o SQL em produção verificava o papel de gerente geral, mas não a unidade. Na reprodução isolada, o gerente de Hawthorne desativou uma inscrição fictícia de Clayfield informando seu endpoint. O resultado era `turned_off=1`.
- **Impacto:** alteração não autorizada de registros de notificação entre unidades. Exige sessão de gerente geral e conhecimento do endpoint; não permite ler esse endpoint pela listagem normal, que já era restrita.
- **Correção:** migration `20261030010000_audit_push_scope.sql` acrescenta o predicado de unidade ao UPDATE e preserva os privilégios exclusivos do servidor. A revisão encontrou e reproduziu um bypass por `ON CONFLICT(endpoint)`: uma inscrição estrangeira podia ter dono/unidade/chaves sobrescritos antes de ser removida. O upsert agora recusa conflito de outra unidade; teste compara a linha inteira antes/depois. Cadastro, listagem, remoção e unsubscribe usam a unidade de origem, mesmo com o Administrador visualizando outra unidade.
- **Status/teste:** corrigido na branch. Quatro testes passaram: Clayfield/Paddington permanecem ativos; operações locais e do próprio usuário funcionam; funcionário é recusado; `anon`/`authenticated` não executam a função.

### AUDIT-03 — Service Worker antigo armazenava respostas arbitrárias — MÉDIO

- **Localização:** `sw.js`, handlers `fetch` e `activate`.
- **Evidência:** execução isolada do arquivo anterior gravou no Cache Storage respostas GET de outro domínio, relatório privado e URL com query string. A ativação ainda excluía caches não pertencentes ao aplicativo.
- **Impacto:** persistência desnecessária de respostas potencialmente privadas se o worker antigo estiver instalado e interceptar essas requisições. **Não foi demonstrado vazamento de funcionários em produção.** A interface atual registra `push-sw.js`, sem cache; o risco é de versões antigas e caches residuais.
- **Correção:** worker antigo passa a usar somente rede. Ambos os workers removem apenas caches com prefixo `marinara-hours-shell-` na ativação, preservando caches de outros aplicativos.
- **Status/teste:** corrigido na branch. Testes executam os handlers e verificam não persistência/limpeza seletiva. Navegador real também validou ativação do worker e remoção de cache privado fictício.

### AUDIT-04 — respostas JSON sem política explícita de não armazenamento — BAIXO

- **Localização:** `Index.ts`, helper `json`.
- **Evidência:** antes da mudança, resposta produzida pelo handler não continha `Cache-Control`; o teste encontrou `null` em vez de `no-store`. Não se mediram políticas adicionais do gateway de produção.
- **Impacto:** controle preventivo ausente na aplicação; não comprova que caches intermediários armazenaram respostas.
- **Correção/status:** helper adiciona `Cache-Control: no-store` e `X-Content-Type-Options: nosniff`. Corrigido na branch; teste de resposta passou.

### AUDIT-05 — objetos/mensagens internos de erro enviados aos logs — MÉDIO

- **Localização:** `Index.ts`, `managerDbError` e catches de sessão, horas, ponto e ações administrativas.
- **Evidência:** injeção de erro fictício contendo `SYNTHETIC_PRIVATE_EMPLOYEE_DETAIL` fez o código anterior registrar o conteúdo em logs internos. As respostas ao cliente já eram genéricas nesses cenários. Não foram extraídos logs privados reais.
- **Impacto:** mensagens e detalhes SQL podem conter dados de registros, aumentando exposição a operadores e retenção em logs. Não foi comprovado acesso público aos logs.
- **Correção/status:** pontos examinados registram contexto e código de erro, sem objeto completo nem mensagem interna. Corrigido na branch; dois testes de falha injetada passaram, preservando resposta genérica e identificação da falha.

### AUDIT-06 — navegação de notificações aceitava destinos externos — BAIXO

- **Localização:** `push-sw.js`, `notificationclick`, código original anterior ao PR #55.
- **Evidência/impacto:** teste do payload fictício mostrou navegação externa. Depende de controle do payload; não se demonstrou acesso de um funcionário comum a esse controle, nem incidente real.
- **Correção/status/teste:** correção já presente no PR foi preservada: aceita somente origem/caminho do aplicativo. Testes de destino externo, `javascript:` e navegação interna passaram na suite consolidada. Implantação pendente.

### AUDIT-07 — troca de PIN não encerrava outras sessões — ALTO

- **Localização:** `staff_change_pin` em `20261028030000_own_pin.sql` e ação `change_pin` de `Index.ts` anteriores ao PR #55.
- **Evidência/impacto:** o PR anterior reproduziu que uma segunda sessão continuava válida após trocar o PIN. Exige uma sessão anterior e seu segredo de dispositivo; não é bypass inicial de login. A reprodução e evidências dos runs estão no relatório inicial preservado.
- **Correção:** migration `20261028233534_pin_session_revocation.sql`, já do PR, cria `staff_change_pin_secure`: troca o PIN e revoga outras sessões na mesma transação, preservando a sessão atual. Serializa login com a linha do funcionário e revalida o hash após espera, evitando a corrida com o PIN antigo. A API usa a RPC segura.
- **Status/teste:** preservado e retestado nesta integração. Teste com SQL real comprova PIN incorreto sem revogação, troca correta mantendo a sessão atual e recusando a segunda com HTTP 401. Os testes nativos de rollback e concorrência permanecem em `tests/integration/security-audit.mjs`; o job security-audit do CI 171 confirmou esses testes no SHA bc746a8, incluindo a corrida com conexões independentes. Não se afirma que PostgreSQL/WASM serializado valide concorrência.

## Compatibilidade com as mudanças atuais da main

O Administrador recebeu na main permissão explícita para selecionar Hawthorne, Clayfield ou Paddington. Essa seleção autorizada **não é classificada como ataque**. Foi preservada e testada: o Administrador vê a equipe da unidade selecionada; Kitchen/Floor Manager não consegue trocar unidade. A proteção administrativa de dispositivos/notificações continua usando a unidade de origem, conforme a separação documentada no recurso de unit switch. O histórico de usuários de dispositivo usa `homeLocation`.

O relatório distingue acesso explícito à unidade selecionada de mutações globais por ID/endpoint fora desse contexto. O código não remove o recurso aprovado de seleção de unidade.

## Verificações de produção e análise estática

- Primeira coleta: 42 tabelas em `public`, todas com RLS habilitado. Consulta de 30/10: **43 tabelas / 43 com RLS**, após a mudança de unidades; nenhuma view pública encontrada nessa consulta. Zero políticas em `public`/`storage`. Neste modelo, acesso direto fica bloqueado e o servidor privilegiado executa as regras; criar políticas públicas genéricas seria incorreto.
- Zero funções em `public` executáveis por `anon` ou `authenticated`, conforme catálogo consultado. `anon` não pode criar objetos no schema público. A Edge Function usa service role somente no servidor; a autorização de cada ação continua essencial porque esse papel ignora RLS.
- Modo de dispositivos em produção: `enforce`. Limites por dispositivo: 5 tentativas curtas / 20 diárias; desconhecidos: 5 / 15. A suite testou bloqueio em ambiente isolado, sem tentativas de PIN em produção.
- PINs usam bcrypt (`extensions.crypt`); tokens de sessão são aleatórios, armazenados por hash, expiram em 12 horas e têm revogação e vínculo ao dispositivo. Não se alterou custo do hash nem política de expiração nesta entrega.
- Constraints de produção impedem sobreposição de turnos e intervalos; índices únicos impedem mais de um turno/intervalo aberto. Também existem checks de ordem temporal. Funções transacionais e locks foram lidos; corridas reais com conexões independentes não foram reexecutadas neste ambiente.
- Cálculos de Queensland usam UTC+10 / `Australia/Brisbane`; a suite de horas/roster foi executada. Não se adicionou horário de verão para Queensland.
- As outras três Edge Functions foram inspecionadas: `smart-responder`, `marinara-api-v2-staging` e `marinara-api-v2-preview` estão aposentadas e devolvem 410, sem acesso ao banco. Não foram tratadas como bypasses apenas por existirem.
- Scan por assinaturas em 779 blobs alcançáveis do histórico integrado: zero correspondências de JWT service role, prefixos selecionados de tokens privilegiados ou private keys. Isso é um scan limitado, não prova de ausência de qualquer segredo. Nenhum valor completo de segredo foi exibido.
- `npm audit`: zero vulnerabilidades conhecidas reportadas para as 29 dependências contabilizadas após incluir a dependência de testes PGlite. Esse resultado não cobre automaticamente o import Deno flutuante `supabase-js@2`, scripts externos ou todas as bibliotecas vendorizadas.
- GitHub Actions têm `contents: read`; não se encontrou `pull_request_target` nem gravação de secrets na configuração examinada. A consulta de rulesets retornou lista vazia, mas a leitura da proteção clássica da main retornou 403: **não é possível concluir que a branch esteja desprotegida**.
- O repositório descreve o frontend como GitHub Pages. Não foi identificado/validado um deployment Vercel deste projeto. Não se presumiu que outros projetos Vercel do usuário fossem este aplicativo.
- Escape HTML, consultas parametrizadas/RPC, validações e allowlist de destinos de Web Push foram revisados. Não se confirmou SQL injection, XSS, CSRF ou SSRF. Não houve fuzzing completo. CORS `*` permanece: as ações protegidas exigem token explícito, sem autenticação por cookie; CORS não substitui autorização.

## Testes executados e limites

| Comando/verificação | Resultado observado |
|---|---|
| `npm run test:security` | **43/43**; inclui os testes previamente existentes no PR e os novos testes; SQL real em PostgreSQL/WASM e API real; dados fictícios |
| `npm test` | **32/32**; suite histórica diferencial, usa versões congeladas; não substitui a suite nova |
| `npm run test:visa` | **24/24**; horas, roster e parser |
| `npm run test:security:browser` | Passou em Chromium com viewport iPhone; UI → API → PostgreSQL, login funcionário/gerente, ponto, intervalos, sessão, logout e ativação do worker |
| `npm run test:pdf` | Passou: teste de regressão + download/share/retorno/erros e relatórios fictícios de 7 funcionários / 21 turnos e relatório longo |
| `python tests/e2e/check-pdf.py` e `check-pdf-seven.py` | Conteúdo/totais verificados: A4 landscape, 1 página no exemplo de 7 funcionários, 14 páginas no exemplo longo |
| `npm run test:e2e` | Primeira tentativa bloqueada por socket do Chromium completo; repetição com `CHROME_PATH` apontando ao headless shell passou todos os cenários históricos |
| `npm run test:e2e:update` / `test:e2e:own-pin` | Passaram em Chromium |
| `npm run test:integration` | **Não executou os testes**: PostgreSQL nativo/usuário pgtest indisponíveis. Substituído para esta auditoria pela suite isolada; não se afirma equivalência de concorrência |
| PDF em WebKit | **Não iniciou**: bibliotecas GTK/GStreamer/WebKit ausentes. Nenhuma aprovação de Safari/iPhone físico |
| `git diff --check` | Passou |
| Comparação com a referência funcional | `index.html` e os quatro módulos de PDF permanecem byte a byte iguais à **main ac241d0**; sem alteração visual do Time Clock |

O PostgreSQL/WASM executou snapshot, funções e cadeia completa de migrations. É uma conexão serializada; não valida corridas entre conexões, PostgREST real, cron real ou entrega a provedores de push.

## Contagens e pendências

| Categoria | Quantidade |
|---|---:|
| Achados confirmados, incluindo configurações preventivas | 7 |
| Corrigidos e testados na branch | 7 |
| Correções publicadas | 0 |
| Correções de achados aguardando implantação coordenada | 7 |
| Vulnerabilidades críticas comprovadas | 0 |

Seis frentes permanecem **não verificadas integralmente**, sem serem classificadas como vulnerabilidades confirmadas: (1) Safari/iPhone físico/PWA instalado; (2) concorrência de várias conexões; (3) headers/CSP/HTTPS/configuração do host final e eventual Vercel; (4) proteção clássica da main e permissões externas de deploy; (5) advisories exatos dos imports Deno, arquivos vendorizados e demais recursos remotos; (6) cobertura dinâmica completa de todos os endpoints, armazenamento e acesso/retensão aos logs. O aviso `pg_net` em `public` foi registrado, não alterado por risco de afetar cron.

## Implantação e reversão — não executadas

1. Revisar o PR e confirmar checks. Manter a main atual `ac241d0` e a API v58 como referências; a versão 57 é a referência histórica da primeira coleta. Não há merge/deploy automático nesta entrega.
2. Revisar o backfill e ownership dos dispositivos. Consulta agregada somente leitura encontrou **8 dispositivos, 8 com unidade inequívoca, 0 mistos e 0 sem evidência** naquele momento. Isso não substitui revisão operacional nem garante que o estado não mude.
3. Em janela coordenada, aplicar também a migration pendente de revogação de sessões por PIN, seguida das migrations de push e dispositivos e publicar a API fixada no SHA aprovado. A API antiga não filtra `used_by` por unidade: aplicar apenas SQL não completa a correção. Não mudar `device_mode`, PINs ou sessões existentes durante esse procedimento.
4. Publicar os Service Workers aprovados; validar logout/cache, pareamento, modo global, todos os fluxos obrigatórios e PDFs no Safari e no PWA instalado. Confirmar login dos gerentes legítimos antes de encerrar a janela.
5. Se necessário, os arquivos `.down.sql` restauram as funções anteriores, mas reintroduzem os riscos conhecidos. A reversão de dispositivos preserva a coluna de titularidade e os dados. Não usar rollback como rotina.

Um dispositivo sem titularidade não fica bloqueado para login; fica indisponível para administração por gerentes de unidade até atribuição explícita pelo proprietário. Códigos de recuperação do proprietário continuam exclusivos do console SQL. Não se deve publicar um código de recuperação ou executar atribuições por nomes presumidos.

## Implementação e evidências

- Mudanças de servidor: `supabase/functions/marinara-api-v2/Index.ts`.
- Banco: migrations `20261030010000_audit_push_scope.sql`, `20261030020000_audit_device_scope.sql` e rollbacks correspondentes.
- PWA: `sw.js`, `push-sw.js`.
- Testes e ferramentas de reprodução: `tests/security/`; novo job `security-audit` no GitHub Actions; PGlite é dependência **de desenvolvimento**, sem inclusão no frontend.
- Evidências resumidas: `docs/security-audit-evidence-20261029.json`.
- Revisão independente encontrou o bypass de pareamento; ele foi reproduzido, corrigido e retestado. A revisão seguinte não apontou falhas críticas/importantes adicionais; isso não é certificação.
- PR: [#55](https://github.com/fredqbraga94/marinara-hours/pull/55). Implementação consolidada: `6de08e8f8963cf149355c2bdaf470c1b759dc577`; relatórios/evidências seguem em commit separado. Checks do novo SHA precisam ser lidos antes de promover.
- Consulta de 30/10 confirmou que `staff_change_pin_secure` e `management_location` **ainda não existem em produção**. Isso confirma que as migrations desta proposta continuam pendentes.

Referências: [OWASP Top 10:2025](https://owasp.org/Top10/2025/), [OWASP API Security Top 10:2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/), [Supabase — autenticação de Edge Functions](https://supabase.com/docs/guides/functions/auth). Os achados AUDIT-01/02 correspondem a controle de acesso/BOLA/BFLA; AUDIT-03/04 a configuração e privacidade; AUDIT-05 a tratamento/registro de falhas.


## Retomada e validação — 30/10/2026

Referência revalidada: `bc746a84947f3839c26fe5e9f9df72e0f2fc0302`, comparada à main `ac241d0679c0b8d09a5952bc55efded9a80abbe9`. Checkout isolado preservou os arquivos locais da execução anterior.

Reexecução local: segurança **43/43**, suite histórica **32/32**, horas/roster/parser **24/24**, fluxo de PIN em Chromium e teste integrado UI → Edge → PostgreSQL/WASM aprovados. `npm audit` retornou zero advisories em 29 dependências. O scanner de assinaturas examinou 764 blobs alcançáveis neste clone e não encontrou candidatos; o número depende dos refs disponíveis e não é certificação de ausência de segredos.

CI [171](https://github.com/fredqbraga94/marinara-hours/actions/runs/40967366656) testou o SHA bc746a8. Seu job security-audit confirmou, com PostgreSQL nativo e conexões independentes: isolamento das três unidades, bloqueio de escalonamento e IDs manipulados, logout, PIN incorreto sem revogar sessões, rollback do PIN se a revogação falhar e login concorrente com PIN antigo bloqueado até a troca concluir e recusado após revalidação. O teste integrado de navegador também passou no CI.

Consulta somente leitura nesta retomada: API de produção permanece **v58**, fixada em `faa239e`; **43/43** tabelas públicas com RLS; zero funções públicas executáveis por anon/authenticated; RPC `staff_change_pin_secure` e coluna `management_location` ainda ausentes. A migration de login encontrou o fragmento de código esperado. Nenhuma migration, troca de PIN, atribuição de dispositivo ou deploy foi executado em produção.

A comparação dos arquivos protegidos com a main atual não mostrou diferenças em `index.html`, `timesheet-pdf.js`, `roster-pdf.js`, `stock-pdf.js` e `temp-pdf.js`. As referências da primeira coleta eram anteriores às mudanças de unidades/PDFs aprovadas na main; esta comparação usa a referência atual correta.

Resultado final do CI 171: **8/8 jobs concluídos com success** — api, database, integration, hardening, features, security-audit, browser (Chromium) e browser-webkit. O fluxo de PIN que falhou em uma execução anterior passou no WebKit do commit atual. PDFs, verificações de conteúdo/totais, atualização do app e suites de interface concluíram com sucesso. Evidência estruturada em `docs/security-validation-20261030.json`.

Este fechamento atualiza apenas documentação/evidências. O SHA de código testado permanece bc746a8; qualquer commit posterior exclusivamente documental não altera essa referência. Produção não foi promovida.
