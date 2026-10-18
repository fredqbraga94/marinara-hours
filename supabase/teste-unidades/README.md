# Teste: unidades (Paddington / Clayfield) + papel admin

Ramo SÓ de teste. Não é o ramo principal; não muda o Hawthorne.

- Banco de teste: Supabase "Marinara Hours - Teste Unidades" (kskrkzxiaxesvghvvecp).
- `index.html` neste ramo aponta para o banco de teste (faixa laranja "TEST ENVIRONMENT").
- `01_units_admin_role.sql` e `02_admin_device_mode.sql` já foram aplicados no banco de teste.
- Produção (nnchgomdnnqsaovfivob) NÃO foi alterada.

Papéis:
- admin: vê e age em todas as unidades (seletor de unidade no painel).
- manager: manager geral da própria unidade (floor + kitchen).
- floor_manager / kitchen_manager: só o próprio setor da própria unidade.
