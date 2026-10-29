# WABA R12 — GitHub Actions cost gate and regression policy

## Scope / evidence

- Source is certified Draft [PR #52](https://github.com/omarge/pago-telegraf-waba/pull/52), exact HEAD `5c010f22daaa7723459f337ec495688333953c46`.
- On that HEAD GitHub executed **11 workflows** for one PR commit. The [R12 F+G consolidated run #40814091062](https://github.com/omarge/pago-telegraf-waba/actions/runs/40814091062) was GREEN: full PostgreSQL18 **370 pass / 0 fail / 1 intentional broker-only skip**, isolated cross-gate **1 pass**, security policy **3 pass**. Separate Kafka real functional CI was also GREEN.
- Nine historical workflows overlap the same full `node --test tests/*.test.js` PostgreSQL regression and/or the disposable Kafka action. Re-running them merely because a later R12 file changed increases cost without independent new financial evidence.

## Change: no recurring historical full regressions on every PR

On this **isolated CI-optimization branch only**, nine already certified R12 workflows keep their original dedicated `push.branches` trigger, but their broad `pull_request.paths` triggers are replaced with `workflow_dispatch`:

- R12-ABC full regression
- R12-DE real Kafka + full regression
- R12-E reversals
- R12-F transport-factory fence
- R12-G held-event gap
- R12-A rebalance
- R12-B HOLD journal
- R12-AB integration
- R12 Kafka secure-offset baseline

These historical jobs remain available on their original push branches. A manual `workflow_dispatch` requires that GitHub makes the workflow available on the repository's default branch; as the WABA R12 stack is still entirely Draft, **do not assume manual dispatch is available for these branch-only workflows**.

Two automatic mechanisms remain intact:
1. **R12 F+G integrated gate**, which is the consolidated PostgreSQL18, security and cross-module check on substantive source/test changes.
2. **R12-D disposable broker functional gate**, when its specific Kafka wire test or workflow is changed. This still does NOT certify TLS/SCRAM/ACL.

Existing unrelated F06/menu checks are not touched. No financial, runtime, DB schema or provider code is modified by this CI-only branch.

## Operator rule for future phases

| Change | Verification |
|---|---|
| Documentation, audit notes, metadata | Read-only/static inspection; no GitHub Actions regression |
| Isolated parser/config/test edit | Focused unit/syntax tests locally where feasible |
| Economic state, concurrency, idempotency, UNKNOWN/replay | Focused adversarial tests with PostgreSQL 18 only when the invariant changes |
| Kafka transport, ACL or consumer group | Isolated broker/broker-security run only when that transport changes |
| Integrated milestone / GO gate | ONE complete regression for the consolidated SHA, review independent logs and artifacts |
| UAT/production release | Explicit final gate and authorization; never infer GO from previous offline checks |

**IMPORTANT:** Do not merge this CI-only change without confirming GitHub required checks, branch protection and reusable/manual final certification. A previously required historical status becoming absent may legitimately block merging; that is safer than silently weakening branch protection. On a final code release, run the full consolidated financial suite on the exact candidate SHA once, and keep `production_go=NO_GO` until real secured Kafka, Payment Engine/provider reconciliation and independent UAT pass.

## Safety

No `main`/`master`, host1, secrets, `.env`, actual PSP, bank, Kafka production or Meta/WABA messages are modified. This is **CI cost optimization**, not financial certification or production approval.
