# Marinara Hours v38 — roteiro de publicação

**Nada aqui foi executado em produção.** Cada passo exige autorização explícita do proprietário.
PR: #6 (`hardening/v38`). Substitui os rascunhos #3 e #4 e contém o PR #5 (que é a v37 já em produção).

## 1. O que será publicado

| Parte | Arquivo | sha256 (16) | Onde |
|---|---|---|---|
| Migração A: integridade, auditoria, permissões | `supabase/migrations/20261013010000_integrity_audit_privileges.sql` | `d88a0337f35f8fe9` | banco |
| Migração B: aparelhos, limites de PIN | `supabase/migrations/20261013020000_device_auth_pin_limits.sql` | `1da5dd3b92b0c559` | banco |
| Edge Function v38 | `supabase/functions/marinara-api-v2/Index.ts` | `9bc6537616fa3af0` | `marinara-api-v2` |
| App | `index.html` | `150f7afb8f2cf655` | GitHub Pages (merge do PR #6) |

Rollback: `supabase/rollback/20261013020000_device_auth_pin_limits.down.sql` (`a2c63fc7765f1d4d`),
`supabase/rollback/20261013010000_integrity_audit_privileges.down.sql` (`dc2a1377e61103bf`),
`tests/edge/baseline-v37.ts` (`aca7803aa74f043f` = v37 em produção).

### Compatibilidade comprovada (testes `npm run test:hardening` e `npm run test:e2e:v38`)
- v37 funciona igual com as migrações A e B aplicadas, então as migrações podem ir antes.
- App atual + v38 funciona, assim como app novo + v37. A ordem entre app e Edge Function não quebra nada.
- v38 **sem** as migrações recusa o login (503). Por isso a Edge Function só vai **depois** das migrações.

## 2. Ordem

1. Backup e pré-checagem (somente leitura)
2. Migração A → verificação
3. Migração B → verificação
4. Edge Function v38 → verificação
5. Merge do PR #6 (app) → verificação
6. 3 a 7 dias em modo `grace`, depois mudar para `enforce` (decisão do proprietário)

Faça um passo de cada vez, fora do horário de turno, com o gerente geral disponível
(veja "PIN compartilhado" no item 5).

## 3. Passo a passo

### Passo 1 — Backup e pré-checagem (somente leitura)
- Supabase → Database → Backups: confirmar que existe um backup do dia (as migrações não alteram dados, mas é a rede de segurança).
- Edge Function: `get_edge_function marinara-api-v2` → versão 37, `Index.ts` sha256 `aca7803aa74f043f…` (igual a `tests/edge/baseline-v37.ts`).
- SQL (somente leitura). **Todos os contadores devem ser 0**, senão pare:
```sql
select
 (select count(*) from shifts a join shifts b on a.staff_id=b.staff_id and a.id<b.id
   and tstzrange(a.clock_in, coalesce(a.clock_out,'infinity'),'[)') && tstzrange(b.clock_in, coalesce(b.clock_out,'infinity'),'[)')) as overlapping_shifts,
 (select count(*) from breaks a join breaks b on a.shift_id=b.shift_id and a.id<b.id
   and tstzrange(a.break_start, coalesce(a.break_end,'infinity'),'[)') && tstzrange(b.break_start, coalesce(b.break_end,'infinity'),'[)')) as overlapping_breaks,
 (select count(*) from shifts where clock_out < clock_in) as negative_shifts,
 (select count(*) from breaks where break_end < break_start) as negative_breaks;
```
- Anotar (só números): turnos abertos, sessões ativas
  (`select count(*) from staff_sessions where revoked_at is null and expires_at > now()`).

### Passo 2 — Migração A
- `apply_migration` com o conteúdo exato do arquivo A (nome: `integrity_audit_privileges`).
  A migração tem as próprias pré-checagens: se encontrar dados inválidos, aborta sem mudar nada.
- Verificar:
  - `select md5(pg_get_functiondef('public.clock_in_by_id'::regproc))` = `492152cef9c0c594ae36584dae6ab885`
    (start_break `effe8837…`, end_break `8b9332d2…`, clock_out `e219cdad…`; os de PostgreSQL 16 nos testes;
    se a 17 formatar diferente, conferir pelo texto do arquivo).
  - As 4 restrições existem: `shifts_no_overlap_per_staff`, `breaks_no_overlap_per_shift`,
    `shifts_clock_out_not_before_in`, `breaks_end_not_before_start`.
  - As 8 chamadas sem credencial (lista no fim) dão respostas iguais às de antes. A v37 continua no ar.
  - Logs da `marinara-api-v2` sem erros novos por 10 minutos.

### Passo 3 — Migração B
- `apply_migration` com o conteúdo exato do arquivo B (nome: `device_auth_pin_limits`).
- Verificar: `select device_mode from auth_settings` = `grace`; `select count(*) from auth_devices` = 0;
  v37 continua igual (mesmas 8 chamadas); sessões ativas = número anotado.

### Passo 4 — Edge Function v38
- `deploy_edge_function marinara-api-v2`, arquivo `Index.ts` (sha `9bc6537616fa3af0`), **verify_jwt = true**, entrypoint `Index.ts`.
- Conferir com `get_edge_function` que o código publicado tem o mesmo sha.
- Verificar:
  - 8 chamadas sem credencial (a de PIN inválido conta 1 tentativa no limite dos aparelhos não autorizados). Diferenças esperadas: `login` com PIN inválido agora dá **401** "Invalid PIN"
    (antes 500); `not_a_real_action` lista também as novas ações de aparelho.
  - O proprietário faz 1 login real pelo app. No log deve aparecer `[auth] login result=ok device=new` ou `device=approved`.
  - Funcionários já logados continuam logados (sessões ativas = número anotado; ninguém é deslogado).
  - Logs: só linhas `[auth] …` no formato fixo; nenhum PIN, token ou IP.

### Passo 5 — App (merge do PR #6)
- Merge no `main` → GitHub Pages publica o `index.html` em ~1 minuto.
- Verificar no iPhone: login, recarregar a página (continua logado), Clock In / Break / Clock Out,
  PIN errado mostra "PIN not recognised.", gerente vê **More → Devices**.

### Passo 6 — Modo `enforce` (depois de 3–7 dias)
- Em **More → Devices**, conferir que os aparelhos da equipe aparecem.
- Gerente geral: botão "Allow authorised devices only" (ou SQL `update auth_settings set device_mode='enforce'`).
- A partir daí, um aparelho novo precisa de código: gerente → More → Devices → **New device code**
  (vale 15 min, uma vez só). Na tela de PIN do aparelho novo: "Authorise this device".
- Recuperação (nenhum gerente com aparelho autorizado): no SQL editor do Supabase,
  `select public.auth_owner_pairing_code();` gera um código de uso único.

## 4. Critérios de interrupção (voltar imediatamente)
- Qualquer pré-checagem ≠ 0, ou migração com erro (ela se desfaz sozinha).
- Login correto falhando, ou mais lento que ~1 s.
- Clock In / Break / Clock Out com erro para quem já usava normalmente.
- Erro novo nos logs que não existia na v37 (ex.: `function … does not exist`, 500 em ações de ponto).
- Qualquer log com PIN, token ou IP.
- Funcionários deslogados em massa após o passo 4 (não deveria acontecer).
- Funcionário reclamando que não consegue entrar (exceto o caso "PIN compartilhado" abaixo).

## 5. Impacto nos funcionários
- Passos 1–3: nenhum.
- Passo 4:
  - Nenhuma mudança visível para quem acerta o PIN.
  - Depois de 5 PINs errados em 15 minutos, aquele aparelho espera 15 minutos. Com 20 erros em 24 horas, o aparelho fica bloqueado até fechar a janela de 24 horas ou até um gerente usar "Unlock" em Devices.
  - Aparelhos ainda não autorizados dividem um limite pequeno (5 em 15 min, 15 em 24 h). Se esse limite se esgotar, só os aparelhos novos esperam; os autorizados seguem normais.
- **PIN compartilhado**: hoje, se duas pessoas têm o mesmo PIN, o app entra como uma delas, sem avisar.
  Com a v38, as duas recebem "This PIN is used by more than one person…" até o gerente definir um PIN novo
  para uma delas (Team → Edit). Não é possível saber antes se isso existe sem testar PINs reais, o que não foi feito.
  Por isso o gerente geral deve estar disponível na publicação.
- Passo 5: o app passa a lembrar o login ao recarregar; as mensagens de erro mudam; nada some.

## 6. Rollback
| Nível | Quando | Como | Testado |
|---|---|---|---|
| App | problema só na tela | `git revert` do merge do PR #6 no `main` | app atual + v38 ✔ |
| Edge Function | problema de login ou ponto | publicar `tests/edge/baseline-v37.ts` como `marinara-api-v2` (verify_jwt true). Vira v39 com o código da v37 | v37 no banco migrado ✔; sessões da v38 continuam válidas ✔ |
| Banco | só se o banco for o problema | SQL: rollback **B** e depois rollback **A** (arquivos em `supabase/rollback/`) | funções voltam idênticas à produção (md5) e v37 passa no cenário completo ✔ |

O rollback do banco mantém de propósito a auditoria (tabelas e linhas), a regra "excluir turno não apaga histórico",
a coluna `pin_conflict_at` e a remoção de privilégios desnecessários. A v37 funciona com isso (testado).
Rollback B apaga autorizações de aparelhos e contadores (nenhum dado de funcionário, turno ou intervalo).

## 7. As 8 chamadas sem credencial (comparação antes/depois)
Pelo navegador na página do app (`API` e `SUPABASE_KEY` já existem na página):
`OPTIONS`; corpo `x` (JSON inválido); `{action:"manager_working"}`; `{action:"session_status",token:"not-a-real-session"}`;
`{action:"manager_working",token:"not-a-real-session"}`; `{action:"not_a_real_action",token:"x"}`; `{action:"login",pin:""}`;
`{action:"login",pin:"observe-test"}`.
Nunca enviar PIN numérico nem token real nessas verificações.
