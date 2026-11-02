# Headless parity audit — independent review

**Reviewed:** 2026-11-02  
**Purpose:** Prepare an integration checklist for the headless design-engine work without changing its branch or implementation.  
**Reviewed PR:** [#332 — Add headless CodeLab workspace runtime and design engine](https://github.com/gavilandavid89-pixel/CodeLab/pull/332)  
**Reviewed branch/commit:** `feat/headless-design-engine-core` at `23714f100a416bd766b9a0b46c6aadd817805072`.  
**Boundary:** This document is an independent audit only. It does not modify any file in PR #332, trigger its workflows, or merge any work.

## 1. Evidence snapshot

| Check | Observed result | Interpretation |
|---|---|---|
| Headless Design Engine workflow #423 | [Success](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/41388946266) on `23714f10` | The headless-specific workflow passed for the latest observed commit. |
| Full Validate CodeLab workflow #2072 | [Failure](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/41388638077) on earlier commit `8ee578e4` | The full validation gate was not green on that SHA. |
| Failed assertion from #2072 | `tests/design-tools.test.js:116`, message: “layer reorder must place the selected layer at the requested index”; it expected the bridge source to match `/list\\.splice\\(targetIndex, 0, element\\)/`. | This is a brittle source-shape assertion: it couples a behavior check to a specific implementation string. It must not be treated as proof that runtime reorder behavior is broken. |
| Latest full validation on `23714f10` | No run observed in the Actions list checked during this audit. | **Unverified.** Do not mark the full PR green until the full Validate CodeLab workflow passes on the latest head. |
| Agent Space Browser Runner #285 | [Success](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/41388638042) on `8ee578e4` | Useful supporting signal, but it does not replace full validation on the latest SHA. |

## 2. Headless capabilities described by PR #332

These are capabilities declared in the PR description and should be confirmed against executable integration tests and persisted readback before merge:

- Authenticated workspace headless endpoint, with ownership/token checks, project validation, revision checks, and atomic persistence.
- Idempotent operation receipts, including retry behavior after server restart.
- Design operations for canvas/layout, element add/update/duplicate/reorder/delete, bulk delete, alignment/distribution, and SVG preview.
- Workspace/project lifecycle, branch lifecycle and merge undo, code writes, component insertion, design token application, templates, import/export, and design-to-web conversion.
- Read-only queries for component search/inspection, token generation, project/code/design reads, and accessibility audits.
- Separately versioned workspace design-system read/write/import/export.
- Isolated headless preview diagnostics and interactions.
- Image attachment with type/size validation and preserved alternative text.

This list is a PR-scope inventory, not a claim that every item has passed live production testing.

## 3. Integration gates

Before combining PR #332 with independent bridge/documentation work, verify each gate with evidence tied to the same candidate commit:

1. **CI gate:** Headless Design Engine, full Validate CodeLab, and Agent Space Browser Runner all pass on the candidate SHA.
2. **Reorder regression:** Replace any brittle source-text assertion with a behavior-level test if the current assertion is still present. Test forward/backward reorder, first/last index, invalid IDs/indexes, and preservation of unrelated layers.
3. **Authenticated API:** Confirm missing/invalid token, wrong workspace ownership, unknown project, malformed operation, and stale revision are rejected without mutation.
4. **Atomicity and retry:** Force a batch failure and confirm no partial mutation; retry an identical operation ID and confirm no duplicate effect; reuse the ID with different payload and confirm rejection.
5. **Persistence:** Read back project/design changes from the server; verify idempotency receipts and workspace design-system revisions across restart where the test environment supports it.
6. **History and branches:** Verify undo/redo, merge/undo-merge, and stale/conflicting branch writes against exact saved content.
7. **Import/export:** Round-trip design JSON and design-system JSON; validate remapped IDs, prototype targets, custom canvas size, unit preservation, sanitization, and bounded output.
8. **Preview isolation:** Confirm the fresh preview context cannot access application cookies/local storage or make network requests, and verify diagnostics report runtime failures.
9. **Quota and approvals:** Ensure AI actions do not run without explicit approval, respect provider failure/quota handling, and do not expose API keys.
10. **Live service check:** Only after CI is green, verify the deployed app/API. Keep ephemeral Render persistence limitations separate from code correctness.

## 4. Coordination boundaries

- Do not cherry-pick, edit, or push to `feat/headless-design-engine-core` during independent development.
- Keep this audit and bridge inventory documentation in separate files/branches.
- Integrate only after both workstreams are ready, then run the full validation suite on the combined candidate.
- Do not describe the PR as fully validated based only on the headless-specific workflow.

## 5. Current verdict (checked 2026-11-02)

**Headless-specific tests:** passed on commit `45b1526c643b43f042974314df2224843a885f73`; runs #424 and #425 both completed successfully. Run #425 is the latest observed headless workflow: https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/41390469774.

**Full PR validation:** still pending. The latest observed `Validate CodeLab` run is #2072 on older commit `8ee578e489b80b473380a3936e757845fcd086a0` and failed at `Test design system tokens and contrast`, with assertion text `layer reorder must place the selected layer at the requested index`: https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/41388638077. Inspection of `tests/design-tools.test.js` on the current headless branch shows the old `splice(targetIndex, 0, element)` source-text assertion is no longer present; the current test instead checks that the action is exposed and validates element identifiers. This is evidence that the specific stale assertion changed, not proof that the full validation now passes.

**Merge recommendation:** do not merge based on headless-specific green runs alone. Wait for a full `Validate CodeLab` pass on the latest PR head, then perform the integration gates above. No workflow was manually re-run as part of this read-only audit.
