# Marinara Hours isolated multi-location implementation

Goal: fix Clock Out, retain Hawthorne operation, add explicit membership and shift location isolation.
Authority: user's 18 October mission. Autonomous implementation is explicitly authorised; no production writes, migrations, merge or deployment.

Architecture: preserve v38 authentication and legacy routes with multi-location disabled by default. When enabled on an isolated backend, route authorised session actions through location-aware transactional RPCs. Keep one staff identity; use membership role/department per restaurant, and immutable location on each shift. No automatic global administrators. RLS denies direct client access; only authenticated Edge service calls reach scoped RPCs.

- [x] Establish main c68fb3e and published HTML hash; inspect actual schema and applied migrations read-only.
- [x] Reproduce manager saving regression in browser; fix panel refresh, finally, bounded transport, reconciliation.
- [ ] Add additive location/membership/admin/audit schema and scoped operations; prove cross-location denial and shared employee history with synthetic PostgreSQL.
- [ ] Integrate Edge routing and restaurant selector, refresh all manager/staff views and PDF labels; admin memberships and consolidated reports.
- [ ] Run existing suites and new regression/integration/browser suites; use CI PostgreSQL because local installation is unavailable.
- [ ] Inspect changes independently; publish only branch and draft PR; isolated Preview only if genuine backend infrastructure is available.

Review focus: delayed commit after timeout; membership removal during writes; cross-location shift identifier; shared-staff profile edits; stale responses after restaurant changes.

Evidence: Frank's 17 October shift is completed, clock_out 12:00Z (22:00 Brisbane), approved=true; no edits. Production Edge version 38. Applied integrity/auth migrations dated 14 October; do not reapply.
