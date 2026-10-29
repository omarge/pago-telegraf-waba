# R23-A — Remove duplicate full PostgreSQL18 PR workflows without losing financial tests

## Proven redundant Actions on R22 exact HEAD

Certified R22 Draft [PR #72](https://github.com/omarge/pago-telegraf-waba/pull/72) head `24a471b358134cec372f5eb25579c5ff6b28cafd` executed **four** automatic full PostgreSQL18 suites against the same commit:
- R11 #40825279245: `node --test tests/*.test.js`
- R12 canonical preflight #40825279241: `node --test tests/*.test.js`
- R12 noncapture owner identity #40825279243: `node --test tests/*.test.js`
- R12 F+G integrated #40825279234: `node --test tests/*.test.js` AND an additional redundant single-test PG18 cross-gate job, plus a separate Kafka policy job.

All four executed the same 421-case suite (420 PASS / 0 FAIL / 1 broker-only SKIP). This redundantly booted three extra PG18 service containers, ran three extra `npm install` operations and repeated the entire regression; the cross-gate also runs inside the 421-case full suite.

## Actual implementation

Three legacy workflow YAMLs now retain their branch-scoped historical `push` triggers but remove the automatic `pull_request` trigger, replacing it with `workflow_dispatch` for explicitly approved manual runs:
- `.github/workflows/waba-businessos-r11-financial.yml`
- `.github/workflows/waba-businessos-r12-canonical-wire.yml`
- `.github/workflows/waba-businessos-r12-noncapture-identity.yml`

The one remaining consolidated `.github/workflows/waba-businessos-r12fg-integration.yml` now triggers on R11 handoff, method/Fraud binding, authorization adapter, R12 canonical source/tests/schema, the PG test migration harness, pinned protobuf contracts, and its own YAML. It still executes the **entire** WABA PG18 regression with pinned Protobuf byte parity. It still runs a Kafka test transport-override policy job in parallel without a PG service.

The duplicate `cross-gate` PostgreSQL job is deleted because `tests/businessos-r12-fg-hold-integration.test.js` is already included in `node --test tests/*.test.js` and passed as part of all R22 full-suite runs. **No test file was removed, skipped, or loosened**.

## Expected difference (not a certification claim until exact SHA Actions confirm)

| Change category on a future PR | Previously | Target |
|---|---:|---:|
| R11 / R12 combined economic change | 2–4 full PG18 workflow runs + extra PG18 cross-gate | 1 full PG18 + 1 fast policy job |
| Canonical Protobuf contract change | standalone full PG18 canonical + other overlaps | 1 consolidated full PG18 with proto hash checks |
| Unrelated WABA UI / pure R13 shape work | no required PG18 by this change | no required PG18 |
| Explicit historical workflow validation | per-branch / manual-only | unchanged option, not automatically billed |

**GitHub limitation:** manually dispatching a workflow may require the workflow to be registered on the repository default branch. This Draft does not claim `workflow_dispatch` is currently executable from non-default branches. It preserves the old branch-specific push triggers and does not change production branch protections.

## Safety, review and remaining work

The R12 F+G workflow still checks pinned `payment.proto` and `common.proto` hashes; a deliberate schema evolution must be separately reviewed and pin changes approved. Existing R11 and canonical test cases continue to execute inside full regression; no actual financial source code was changed in this PR. Prior certified R22 exact-SHA artifacts are preserved; no need to rerun them.

Future owners should separately decide whether to broaden this consolidated gate to every WABA change and whether a separate high-stakes security gate is necessary. Only actual changed money/offset/source invariants warrant this financial regression. No main/master, host1, secrets, `.env`, real broker, Meta or PSP interaction. `production_go=NO_GO`.
