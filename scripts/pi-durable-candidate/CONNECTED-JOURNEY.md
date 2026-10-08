# Connected product acceptance

The prepared PostgreSQL proof in PR #1193 remains frozen. The continuation does not upgrade its CP host identity or qualify a UI-selected model.

`selected-model-boundary.mjs` is an explicit desired-contract regression, outside normal test discovery. It saves a lead default and resolves its immutable selection through the actual packed metadata SDK and HTTP host, creates an actual restricted-role PostgreSQL message/intent with its recorded sender, and passes that selection to the trusted runtime fixture registration. It does not substitute the CLI's fixed selection. Registration acceptance alone would not qualify execution, payer disclosure, timeline publication or cancellation.

The actual run against clean CP `c91f623248996bc489a8fe69ae2dbfaa494083e6` and hash-verified `5f751b9a` public tarballs failed with `CONNECTED_SELECTION_REQUIRED`: HTTP 400 rejected the selected ref while all admission/provider counters remained unchanged. The CLI's fixed `msel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` differs from the metadata API's resolved ref. The report and failed log are retained outside source. No inference occurred; all owned hosts and PostgreSQL closed.

Required composition seams:

- Resolve the saved model choice and immutable selection through trusted current workspace/actor authority, and make preparation retain that exact selection. A fixed fixture fallback cannot satisfy this boundary.
- Supply a current publication-authority port equivalent to the product adapter's `assertPublicationCurrent`, callable after Adea's canonical message/intent/audience locks. Status/result availability alone does not authorize timeline publication.
- Separate-process cancellation may use the existing authenticated provider-response hold/release controls and bounded public status polling. No drain helper exists. An acknowledged `cancelling` result is not evidence of termination or settled charges.

`lead-payer-journey.spec.ts` mounts the real Solid controls with explicitly scripted API responses. It covers exact account/auth/funding/payer disclosure before explicit start, changed payer revision denial, a funding-await audience race, draft preservation, and truthful cancellation acknowledgement. These tests are independent UI-state evidence, not connected provider or timeline evidence. No baselines, caps, credentials, scopes or production modules are changed.

The three mounted cases passed with one worker. Initial Vite setup/load stalls are retained separately: unrelated `public/assets/worlds 2` contains 65,535 directory entries. This static fixture serves no public assets, performs no HMR, and discovers no unrelated application entries. Its stylesheet uses published UI base/theme tokens and explicit Tailwind sources for the real controls and fixture. Original assets, production styling and existing visual fixtures remain untouched; this is functional evidence, not screenshot qualification.
