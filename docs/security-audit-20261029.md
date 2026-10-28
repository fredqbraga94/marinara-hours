# Marinara Security Audit — 29/10/2026 (Brisbane)

## Resultado

Auditoria com correções na branch `security/audit-hardening-20261029`, PR [#55](https://github.com/fredqbraga94/marinara-hours/pull/55). **Produção preservada: nenhum merge, deploy ou migration aplicada.** Referência funcional: `4ec51c3e69cd15a1ab5bb39c2d8234c76596b536`, main na coleta. A Edge Function publicada v57 importa esse commit por SHA.

**Status: apto com ressalvas para revisão e publicação controlada, condicionado à validação final do CI e à revisão da mudança de autenticação.** Nenhuma vulnerabilidade crítica foi confirmada. Não há evidência suficiente para certificar o aplicativo inteiro como seguro. iPhone físico/PWA instalado e a matriz completa de autorização de todos os módulos continuam pendentes.

**5 descobertas confirmadas em código/configuração; 5 com correção proposta na branch; 0 dessas correções em produção.** Duas são falhas reproduzidas com impacto de privacidade/autenticação; três são configurações preventivas ou riscos condicionais, sem exploração externa demonstrada. Sete áreas não foram verificadas integralmente; não são sete vulnerabilidades confirmadas.

## Security score

**65/100 para a produção examinada**, estimativa conservadora, não certificação nem probabilidade de invasão. A branch não recebe crédito como proteção de produção antes de ser publicada. Critérios explícitos:

| Critério | Pontos | Base |
|---|---:|---|
| Autenticação e sessões | 15/25 | Dispositivos enforce, limites PIN, token aleatório/hasheado, expiração; troca do próprio PIN conserva outras sessões na versão publicada |
| Autorização e isolamento | 15/25 | Guarda central, unidade da sessão e teste SQL das três unidades; matriz de todas as escritas ainda incompleta |
| Banco e integridade | 14/15 | 42 tabelas com RLS, sem grants públicos ou RPC pública; constraints e locks; aviso pg_net |
| PWA e privacidade | 8/15 | sessionStorage e logout local imediato; cache legado, logs e notificações exigem hardening; iPhone físico pendente |
| Dependências e código | 8/10 | npm audit sem avisos, scanner de histórico sem candidatos privilegiados; importação ESM major-only |
| Operação e implantação | 5/10 | CI contents:read; regras de branch, permissões individuais e cobertura dos logs de infraestrutura não verificadas |

## Descobertas e evidências

| ID / gravidade | Local e evidência | Impacto / limite | Correção / teste |
|---|---|---|---|
| SEC-01 / Baixo | `supabase/functions/marinara-api-v2/Index.ts`, `json`: resposta sem Cache-Control; teste falhou no original | Possível persistência de respostas privadas. Nenhum cache real/vazamento demonstrado | `no-store` e `nosniff`; testes do handler aprovados |
| SEC-02 / Médio, condicional | `sw.js`, fetch/activate; worker legado interceptava qualquer GET e armazenava resposta sem restringir origem/recurso | Exige instalação antiga do worker. App atual registra `push-sw.js`; não foi demonstrado uso do legado em iPhone nem cache de dados reais | Retira interceptação e limpa somente caches `marinara-hours-shell-*`, também ao ativar push worker; testes comportamentais aprovados |
| SEC-03 / Baixo | `push-sw.js`, notificationclick: payload podia abrir destino externo fictício | Exige influência sobre payload; acesso de usuário comum a esse controle não demonstrado | Destino limitado à origem/caminho do app; testes de URL externa, javascript e navegação interna aprovados |
| SEC-04 / Médio | `Index.ts`, catches e `managerDbError`: erro SQL fictício com informação privada aparecia no console | Exposição secundária a quem acessa logs. Nenhum incidente real comprovado; logs de funcionários não foram extraídos | Contexto fixo e código diagnóstico limitado, sem mensagens/detalhes SQL; falha continua retornando erro genérico; testes aprovados |
| SEC-05 / Alto, exige sessão anterior | `supabase/migrations/20261028030000_own_pin.sql`, `staff_change_pin`, e `Index.ts`, change_pin: segundo dispositivo continuou com HTTP 200 após troca de PIN | Uma sessão previamente comprometida, com seu segredo de dispositivo, continua utilizável até expirar/revogar. Não é um bypass inicial de login | Nova RPC server-only `staff_change_pin_secure`: troca e revogação de outras sessões em uma transação, mantendo a sessão atual. Login bloqueia a linha do funcionário e revalida o hash após esperar, fechando a corrida com troca/reset. Reprodução SQL original retornou 200 quando esperado 401; correção passou no CI. Teste adicional injeta falha na revogação e exige rollback do PIN |

A reprodução de SEC-05 está no [run 152](https://github.com/fredqbraga94/marinara-hours/actions/runs/40788326253), job security-audit: `PIN change must revoke the other device session`, `200 !== 401`. O [run 154](https://github.com/fredqbraga94/marinara-hours/actions/runs/40788646724) aprovou a correção inicial e a suíte SQL. A revisão independente identificou uma corrida adicional: login com PIN antigo podia inserir sessão depois da revogação. O [run 156](https://github.com/fredqbraga94/marinara-hours/actions/runs/40789303710) reproduziu isso deterministicamente mantendo a troca sem commit. A migration foi ampliada para serializar por linha de funcionário e revalidar o PIN; sua validação final deve constar do CI. Não se confundem esses testes isolados com acesso real a contas de funcionários.

## Supabase — evidência somente de leitura

- 42 tabelas públicas com RLS. Zero views públicas na consulta de catálogo; zero tabelas sem RLS.
- Zero grants SELECT/INSERT/UPDATE/DELETE diretos a anon/authenticated no schema public; ambos sem CREATE no schema.
- 139 rotinas públicas: zero executáveis por anon/authenticated, incluindo SECURITY DEFINER.
- Ausência de políticas públicas é negação por padrão, coerente com service role na Edge. Não foram criadas políticas permissivas para eliminar alertas.
- `auth_settings`: modo enforce; dispositivo autorizado 5 tentativas por janela de 15 minutos e 20/dia; desconhecido 5/15. Nenhuma tentativa de PIN em produção.
- `auth_pin_login` usa crypt/bcrypt; tokens de 32 bytes aleatórios, armazenados como SHA-256; Edge limita sessão a 12h. `auth_session` confere expiração, revogação, staff ativo e vínculo do dispositivo.
- Guardas de gerente executadas no servidor; unidade e ID do funcionário derivam da sessão. RPCs revisadas incluem escopo de localização/departamento.
- Constraints de integridade e locks existem para turnos/intervalos. CI existente cobre duplicação, concorrência e preservação de invariantes em dados sintéticos; não houve teste de carga em produção.
- Advisor: 42 avisos informativos de RLS sem política e um WARN de pg_net em public. Este último exige avaliação de compatibilidade com cron; não comprova exploração e não foi alterado automaticamente.
- `verify_jwt=false` observado: sistema usa PIN e sessão próprios. Não é vulnerabilidade isoladamente. A chave publicável do frontend não é uma service role.

## Repositório, hosting e navegador

- Scanner limitado ao histórico alcançável: 125 commits / 399 blobs, padrões PEM privados, tokens GitHub, sb_secret, padrões OpenAI e JWT service_role. Zero candidatos privilegiados. Não cobre refs apagados, formatos desconhecidos, Actions secrets ou logs externos. Nenhum segredo completo é publicado neste relatório.
- `npm audit --json`: zero advisories na árvore de 28 dependências. Não abrange a importação remota `https://esm.sh/@supabase/supabase-js@2`, sem pin de patch/integridade.
- GitHub Actions: `permissions: contents: read`. Não foram confirmados todos os branch rulesets, colaboradores ou acessos de deploy.
- HEAD HTTPS do alias de teste retornou 200 com HSTS (max-age 63072000, includeSubDomains, preload), sem CSP, X-Frame-Options ou nosniff na página. Isso não mede todos os domínios.
- Vercel ligado ao repositório: `marinara-hours-test`, `prj_HjsJHfxdYkEVKg8NoPBdS0oc8wml`; preview READY observado. Configuração informa SSO para all_except_custom_domains e sem password protection. Isso não comprova proteção dos aliases ou que esse projeto é a produção utilizada. Nenhum login no preview contra o Supabase real foi realizado.
- CORS `*` observado. Token vai no corpo, sem cookie automático de sessão: wildcard isolado não comprova bypass/CSRF. Origens legítimas ainda precisam de inventário.
- Sessão em sessionStorage; segredo de dispositivo em localStorage. Logout remove identidade/token local e tenta revogar no servidor; falha de rede ainda requer avaliação do cenário compartilhado.
- `escapeHtml` escapa aspas e caracteres de marcação; revisão de todos os sinks e provas de XSS persistente permanecem incompletas. Não se afirma ausência de XSS/SQL injection em todo o app.
- Não foi imposta CSP rígida: app possui scripts inline e precisa de uma política compatível validada em navegador.
- `index.html`, Time Clock, logo e arquivos de PDFs não foram modificados. PDFs de teste são reais, com pessoas fictícias; os layouts originais permanecem no código.

## Testes verificáveis

| Teste | Resultado / limite |
|---|---|
| `npm test` | 32 testes passaram; suite histórica v36/v37, não certifica o handler atual |
| Helpers atuais + contrato PDF | 28 testes passaram; visa-hours, roster-hours, invoice-reader, webpush, pdf-regression |
| `npm run test:security:edge` | 11 passaram: handler atual/workers, 79 operações gerenciais sem sessão ou com role forjada; RPC controlado, não SQL real |
| `tests/edge/audit-privacy.test.mjs` | 2 passaram; primeiro falharam no original |
| Chromium `test:pdf` + check-pdf scripts | Passaram localmente: salvar, compartilhar/cancelar, voltar, limpeza; 1 página A4 e relatório grande de 14 páginas; 7 pessoas/21 turnos/totais conferidos |
| Ativação real de workers em Chromium local | Ambos sw.js/push-sw.js ativaram, limparam apenas caches do app, preservaram cache alheio e não armazenaram GET privado fictício; não substitui instalação de PWA em iPhone |
| PostgreSQL local | Bloqueado: runtime sem PostgreSQL utilizável e sem permissão para trocar usuário Unix. Executado pelo CI isolado |
| WebKit local | Bloqueado por bibliotecas ausentes. Suites WebKit e PDFs passaram no CI inicial; não substitui iPhone físico |
| CI run 151 | api, database, integration, hardening, features e security-audit passaram; resultados finais de navegador precisam ser consultados no link |
| CI run 154 | security-audit e jobs de banco/API/hardening passaram na correção inicial; atualização final dos testes ainda requer seu próprio run |

A suíte SQL nova usa estrutura do repositório, todas as migrations e somente dados fictícios. Confere login de funcionário/gerentes, Hawthorne/Clayfield/Paddington, tentativa de mudar unidade/ID por payload, bloqueio de escrita de escala fora da unidade, clock/break, logout, sessão inválida e permissões públicas. Não prova todos os objetos/endpoints do aplicativo.

## Sete áreas ainda não verificadas integralmente

1. Matriz BOLA/IDOR de todas as escritas/leitura e demais corridas de revogação; a corrida específica login/troca de PIN tem regressão determinística. Fingerprints completos entre snapshot e banco atual permanecem pendentes.
2. Todos os sinks XSS, limites de payload/consumo por ação e CSP compatível. Sem ataques de carga.
3. Headers efetivos de todos os domínios, redirecionamentos HTTPS, allowlist CORS/CSRF conforme inventário de origens.
4. iPhone físico, PWA instalado/atualizado, cache antigo real e logout offline em dispositivo compartilhado.
5. Comparação visual de todos os PDFs, inclusive cada variante de roster; testes de timesheet não cobrem todas as combinações.
6. Rulesets GitHub, identidade/permissões de deploy e variáveis/logs externos; confirmação do domínio efetivamente usado como produção.
7. Pin/integridade de importações remotas, varredura de segredos além dos padrões pesquisados e compatibilidade do aviso pg_net.

## Implementação e liberação

Commits remotos de referência: `f7e9b7b` (logs/headers e regressão SQL), `eea2d97` (reprodução de sessão persistente), `a4bf69c` (workers e fronteiras de autorização), `d8865f4` (revogação transacional). Os commits finais de evidência/teste ficam no histórico do PR.

Código: `Index.ts`, `sw.js`, `push-sw.js`, nova migration `20261028233534_pin_session_revocation.sql` e seu rollback. Testes: `audit-privacy.test.mjs`, `security-audit.test.mjs`, `tests/integration/security-audit.mjs`, `own-pin.mjs`, `tests/edge/harness.mjs`; CI/package.json; este relatório.

**Não publicar automaticamente a alteração de autenticação.** Após CI/revisão: aplicar somente a migration aprovada; depois publicar a Edge apontando para o commit revisado; publicar os workers pelo fluxo existente. Não presumir que merge da main atualiza a função: a versão atual está presa a um SHA remoto.

Nova RPC é exclusiva de service_role. A migration também altera somente a definição de auth_pin_login para travar/revalidar a linha do funcionário; aborta se o fragmento esperado da definição divergir. Não altera PINs, horários, usuários nem sessões ao aplicar a migration: revoga outras sessões somente quando o usuário troca seu PIN com sucesso. Sem a migration, o handler novo falha de forma fechada na troca de PIN; as outras ações não usam a nova RPC. Rollback: restaurar primeiro o handler anterior e depois remover somente a RPC nova; isso reintroduz SEC-05. Sessões já revogadas não devem ser reativadas. Não há DROP de tabela nem remoção de registros.

Referências: [OWASP Top 10](https://owasp.org/www-project-top-ten/), [OWASP API Security Top 10](https://api-security.owasp.org/editions/2023/en/0x11-t10/), [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Supabase Edge authentication](https://supabase.com/docs/guides/functions/auth). Changelog markdown tentou ser consultado; o mecanismo de busca recusou o content-type.
