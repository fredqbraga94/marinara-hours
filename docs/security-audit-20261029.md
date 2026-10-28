# Marinara Security Audit — 29/10/2026 (Brisbane)

## Resultado e limites

Auditoria técnica com correções reais; validação integral ainda pendente. Produção não alterada. Nenhuma credencial privilegiada, acesso administrativo indevido ou vazamento público foi confirmado nos controles examinados. Isso não prova ausência dessas falhas.

Referência preservada: `4ec51c3e69cd15a1ab5bb39c2d8234c76596b536` (`main` na coleta). A Edge Function publicada, versão 57, importa exatamente esse commit. `verify_jwt=false` é compatível com a autenticação própria de PIN/sessão; não é, isoladamente, uma vulnerabilidade. Branch: `security/audit-hardening-20261029`. Nenhum dado de funcionário foi consultado ou alterado. Consultas de produção limitaram-se a metadados, código de função e configuração não secreta.

**Status: apto com ressalvas para revisão; publicação desta branch deve aguardar os testes obrigatórios pendentes.** Não há bloqueio por vulnerabilidade crítica confirmada. PR em rascunho; sem merge, deploy ou migration em produção.

## Security score

**68/100 para a produção examinada**, estimativa conservadora, não certificação. Pontos refletem controles observados e desconto por cobertura incompleta, não probabilidade estatística de invasão. As correções propostas ainda não contam como proteção em produção.

| Critério | Pontos | Evidência/limitação |
|---|---:|---|
| Autenticação e sessões | 18/25 | Dispositivos em enforce, limites PIN, tokens aleatórios/hasheados, expiração/revogação no SQL; integração SQL não executada localmente |
| Autorização e isolamento | 15/25 | Guarda central de gerente, escopo derivado da sessão, testes de fronteira; cobertura completa de escritas entre três unidades pendente |
| Banco e integridade | 14/15 | 42 tabelas RLS; nenhum grant direto público; índices únicos e exclusão de sobreposição; alerta pg_net |
| PWA e privacidade | 8/15 | Sessão em sessionStorage, logout local imediato; quatro problemas abaixo e validação real de iPhone pendente |
| Dependências e código | 8/10 | npm audit sem avisos; histórico varrido sem correspondências de padrões; importação ESM só fixa versão major |
| Operação e implantação | 5/10 | CI com contents:read; proteção de branches, permissões de deploy e ambiente Vercel não verificados |

## Descobertas confirmadas

Contagem: **4 confirmadas; 4 corrigidas na branch; 0 correções publicadas; 0 confirmadas sem correção proposta.** Há ainda **7 frentes não verificadas integralmente**, listadas abaixo. Não equivalem a sete vulnerabilidades.

| ID / gravidade | Local | Evidência e impacto | Correção e teste |
|---|---|---|---|
| SEC-01 / Baixo | `Index.ts`, função `json` | Respostas JSON não tinham Cache-Control. O teste recebeu header ausente. Risco preventivo de persistência de respostas sensíveis; nenhum cache real de dados ou vazamento foi demonstrado. | `Cache-Control: no-store` e `X-Content-Type-Options: nosniff`; teste comportamental do handler passou. |
| SEC-02 / Médio, condicionado a instalação antiga | `sw.js`, eventos fetch/activate; `push-sw.js`, activate | Worker legado interceptava qualquer GET e gravava resposta sem limitar origem ou recurso. Teste demonstrou interceptação de GET privado. O app atual registra push-sw.js, que não intercepta fetch; não foi demonstrado que algum iPhone ainda usa o legado nem que houve cache de dados reais. | Worker legado retirado do cache; ambos os workers removem apenas caches `marinara-hours-shell-*`. Testes de não interceptação e limpeza seletiva passaram. |
| SEC-03 / Baixo | `push-sw.js`, notificationclick | URL de notificação podia abrir destino externo. Teste abriu domínio fictício externo. Exploração exige influência sobre payload de push; não foi demonstrada obtenção dessa influência por usuário comum. | Restringe origem e caminho ao escopo do app; destinos externos, javascript e fora do app caem na home; destino interno preservado. |
| SEC-04 / Médio | `Index.ts`, catches e `managerDbError` | Erros completos e mensagens SQL eram enviados ao console. Falha injetada com nome e segredo fictícios apareceu nos logs. Não foram lidos logs de funcionários nem confirmado incidente real; impacto é exposição secundária a quem acessa logs. | Mensagens completas substituídas por contexto fixo e código diagnóstico limitado. Falha de sessão continua 500 e não registra os dados fictícios; teste passou. |

Todos os testes de descoberta falharam antes da respectiva correção. Reproduções usaram somente código local e dados fictícios. SEC-01 e SEC-03 são defesas preventivas, sem cadeia de exploração externa confirmada.

## Supabase: evidências de produção

- Projeto correto: `nnchgomdnnqsaovfivob`, região Sydney, PostgreSQL 17.
- Catálogo `pg_class`: todas as 42 tabelas públicas com `relrowsecurity=true`; sem views públicas retornadas.
- `pg_policies`: nenhuma política pública. Isso mantém negação por padrão; a aplicação usa service role no servidor. Não foram criadas políticas permissivas para eliminar avisos.
- `information_schema.role_table_grants`: nenhum grant público para anon/authenticated.
- `has_function_privilege` em todas as funções públicas: nenhuma executável por anon/authenticated, incluindo SECURITY DEFINER.
- Sem buckets nem políticas de Storage retornados.
- `auth_settings`: device_mode=enforce; desconhecidos 5/15 tentativas por janela/dia; autorizados 5/20. Nenhuma tentativa de PIN foi feita em produção.
- Código de `auth_session(text,text)` consultado: token_hash, expiração, revoked_at, staff ativo e vínculo do dispositivo conferidos; leitura da configuração não inclui segredos.
- Índices únicos impedem mais de um turno aberto por funcionário e mais de um intervalo aberto por turno. Constraints EXCLUDE impedem sobreposições; CHECK impede término anterior ao início. Presença confirmada; corridas reais não reproduzidas localmente.
- Advisor: 42 avisos informativos de RLS sem política e um WARN de `pg_net` em public. O WARN não demonstra exploração. Migração de extensão não aplicada para evitar impacto no cron.

## Código, GitHub, PWA e dependências

- Comparação da referência da Edge e HEAD confirma que a análise estática incide sobre o backend publicado.
- Service role vem de variável de ambiente da Edge; nenhum valor privilegiado encontrado pela varredura de padrões do histórico alcançável. Scanner cobriu blobs de todos os refs obtidos no clone: chaves privadas PEM, tokens GitHub, sb_secret, padrões OpenAI e JWTs com classificação de role. Nenhuma correspondência; isso não cobre commits apagados, segredos com formato desconhecido, Actions secrets ou logs externos.
- `npm ci --ignore-scripts` e `npm audit --json`: 0 vulnerabilidades reportadas nas 28 dependências enumeradas. Isso não abrange importação remota ESM nem garante segurança dos pacotes.
- Importação Supabase ESM usa `@2`, sem pin de patch/integridade. Pendente avaliar pin com compatibilidade e cadeia de dependências.
- Workflow tem `permissions: contents: read`; segredo de deploy e proteção de branch não foram verificados.
- Sessão no navegador usa sessionStorage; dispositivo usa segredo em localStorage. Logout apaga token/identidade localmente e tenta revogar no servidor. Falha de rede pode impedir revogação remota; dispositivo compartilhado e dados em memória/DOM precisam de validação completa.
- CORS `*` observado. Requisições usam token no corpo, sem cookie de sessão automático; wildcard isolado não demonstra bypass ou CSRF. Não foi imposta allowlist sem inventário completo das origens legítimas.
- Não foi introduzida CSP rígida: há scripts inline e a mudança precisa de teste de navegador para não bloquear o aplicativo.
- PDFs, index.html, layout e comportamento do Time Clock permanecem byte a byte inalterados nesta branch.

## Testes e cobertura

| Execução local | Resultado | Limite |
|---|---|---|
| `npm test` | 32/32 passaram | Suite diferencial histórica v36/v37, não certifica backend atual |
| `npm run test:security:edge` | 11/11 passaram | Handler atual e workers; banco simulado nos testes de fronteira |
| Testes atuais visa-hours, roster-hours, invoice-reader, webpush e pdf-regression | 28/28 passaram | Helpers/contratos, não geração visual de todos os PDFs |
| `node tests/e2e/request-timeout.e2e.mjs` | Passou | Clock Out interrompido termina e não repete escrita incerta; sem navegador |
| `npm audit --json` | 0 avisos | Apenas árvore npm |
| `git diff --check` | Passou | Formatação do diff |
| `npm run test:integration` | Bloqueado antes das assertions | PostgreSQL/user pgtest indisponíveis; instalação local falhou por permissões |
| `npm run test:e2e` | Bloqueado no launch | Chromium: socket() Operation not permitted |
| `npm run test:pdf:webkit` | Bloqueado no launch | Bibliotecas WebKit ausentes |

Os testes novos verificam: todas as operações registradas de gerente rejeitam ausência de sessão e privilégios forjados de funcionário; ações de ponto usam ID da sessão; listagem de equipe usa unidade da sessão. O RPC de autenticação é controlado nesses testes: isso valida a autorização da Edge, não o login SQL real, nem todas as escritas por objeto.

## Sete frentes pendentes (não são vulnerabilidades confirmadas)

1. Login real SQL de funcionário/gerente, limites, expiração/revogação, reset PIN, concorrência e rollback em PostgreSQL isolado atualizado com todas as migrations.
2. Matriz completa de BOLA/IDOR e autorização de leitura/escrita, inclusive aprovação, roster e todos os módulos para Hawthorne, Clayfield e Paddington.
3. XSS persistente/refletido em todos os sinks DOM, validação de payloads/limites e CSP compatível com a UI.
4. Headers efetivos de hospedagem, HTTPS/redirecionamentos, CORS por origem, análise completa de CSRF e limites de consumo por ação. Não foram feitos testes de carga.
5. Safari em iPhone físico, instalação/atualização PWA, logout em dispositivo compartilhado e comparação visual/funcional dos PDFs originais.
6. Proteção de branch, regras de merge, identidade/permissões de deploy, variáveis e logs de infraestrutura. Hospedagem atual deve ser identificada antes de assumir Vercel.
7. Importações remotas sem pin completo, varredura adicional de segredos com outros formatos e aplicabilidade/remediação do WARN pg_net.

## Arquivos e publicação

Mudanças de produção propostas: `supabase/functions/marinara-api-v2/Index.ts`, `sw.js`, `push-sw.js`. Testes/CI: `tests/edge/security-audit.test.mjs`, `tests/edge/harness.mjs`, `package.json`, `.github/workflows/tests.yml`. Documentação: este arquivo.

A aplicação de headers/logs da Edge requer deploy explícito: a função publicada permanece presa ao commit antigo mesmo após merge. Não reimplantar automaticamente. Rollback dos arquivos pode ser feito revertendo o commit; caches legados eliminados não são recriados. Sem alteração de schema/dados/credenciais/permissões de usuários.

Próxima validação: CI do PR com PostgreSQL e navegadores. Até haver resultados verificáveis, nenhuma integração ou execução em Safari/PWA deve ser marcada como aprovada.

Referências: https://owasp.org/www-project-top-ten/ ; https://api-security.owasp.org/editions/2023/en/0x11-t10/ ; https://supabase.com/docs/guides/database/postgres/row-level-security . A coleta de changelog markdown foi tentada, mas a ferramenta de busca recusou o content-type.

## Continuidade do PR existente

O PR #55 já continha os commits de privacidade e uma reprodução SQL de sessões persistentes após mudança de PIN. Essas alterações foram preservadas. A redação de logs e headers desta entrega reutiliza a implementação `safeErrorCode` existente no PR. Os testes `tests/edge/audit-privacy.test.mjs` e `tests/integration/security-audit.mjs` foram mantidos. A reprodução de revogação após mudança de PIN precisa ser avaliada no CI; ainda não foi validada localmente por esta execução. Não há alteração dessa regra de autenticação nesta entrega.
