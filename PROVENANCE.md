# Provenance subsystem: deployment, policy, and design notes

This file collects the non-code design decisions and open deployment
questions for the additive ground-truth/provenance layer described in
AGENTS.md's "Provenance subsystem" section. Code lives in `src/core/`,
`src/engine/`, `src/packs/`. This file is where the surrounding policy,
research, and operational questions live -- items that are real, named,
and load-bearing for an actual deployment, but are not code.

## Domain grounding (research notes)

casey's shipped design (AGENTS.md, README.md) already encodes an implicit
farmer -> field worker/reporter -> operator/district-vet-equivalent ->
national-authority chain: a reporter (often a field worker relaying what
they saw, not the animals' owner) messages casey, an operator dashboard
triages and can hand off, and the case_type taxonomy (outbreak/follow_up/
lab_sample/import_alert) is casey's own working notion of what a national
vet service's case categories look like. This subsystem does not invent a
new chain -- it slots into the one casey already assumes.

- Notifiable/reportable disease alignment: casey's `suspected_disease`
  codelist (see `src/packs/animal-health.js`) is a starter list
  (foot_and_mouth, newcastle, anthrax, rabies) chosen as illustrative
  examples of WOAH-notifiable diseases; a real deployment MUST replace this
  codelist with the exact list its national veterinary authority maintains
  -- this is precisely what a config pack is FOR: a new country/authority
  ships a new pack, not new code.
- Species scope: cattle/goat/sheep/poultry/pig/other, matching casey's
  existing `species` free-text field's implicit scope. A pack can extend
  this codelist per deployment without an engine change.
- Languages/literacy: casey's existing `caseSystemPrompt` design (mirror the
  contact's language, plain warm one-idea-per-sentence, no jargon) is the
  literacy-appropriate interaction layer this subsystem's stricter data
  model sits BEHIND -- a field worker never sees "provenance" or
  "Observation", only their own language's plain words for the report
  (AGENTS.md's existing design principle: "Field workers see only their
  operation's vocabulary").

## Privacy, ethics, and legal

- **Consent.** A farmer/contact's location and personal data consent should
  be captured as its own provenance-tagged field (`consent: given |
  declined | not_asked`) rather than assumed. A contact who declines
  location consent must still be able to submit a report -- degraded to a
  no-location observation, explicitly flagged, never blocked from
  reporting entirely (this is a hard requirement, not a nice-to-have: a
  platform that refuses an honest report over a location refusal teaches
  people not to report).
- **Data protection compliance.** For a South African deployment (casey's
  shipped default, `CASEY_COUNTRY_CODE=27`), POPIA (Protection of Personal
  Information Act) governs. casey's existing PII-free enquiry/aggregate
  projections (AGENTS.md: `enquiryRow` excludes `external_id`/`contact_id`
  on every list/enquiry surface; every management report/audit export is
  aggregate-only) already satisfy the core minimization principle POPIA
  requires -- a deployment's compliance review should confirm this holds
  for whatever NEW dashboard views this subsystem adds (data-quality
  monitoring, the drilldown endpoint), which must inherit the same PII-free
  discipline. A deployment outside South Africa must confirm its own
  jurisdiction's equivalent law and any cross-border data-transfer rules
  before aggregate data crosses a border (e.g. to a regional authority).
- **Harm-protection incentive design.** This is upstream of any code this
  subsystem can write: if reporting a disease triggers uncompensated
  culling with no recourse, the platform's real function becomes teaching
  farmers not to report, and no amount of provenance tagging fixes that.
  A deployment MUST settle its own culling/compensation policy with its
  veterinary authority before scaling reporting -- this is a governance
  precondition, not a feature request.
- **Data-sharing agreements.** Before any aggregate export (the data-escrow
  export below, or a routine management report) leaves casey and reaches a
  veterinary authority, a deployment needs an explicit data-sharing
  agreement settled with that authority -- what is shared, at what
  granularity, under what retention. This subsystem's aggregate/report
  surfaces are built assuming such an agreement exists; it does not
  negotiate one.

## Reliability, connectivity, and hardware

- **Low-end/low-bandwidth.** Every new dashboard view this subsystem adds
  (data-quality monitoring, drilldown) must follow casey's existing
  dashboard discipline: aggregate-only payloads, no unbounded row dumps
  (mirroring `case-store.js _count`'s existing CAP=50000 discipline and the
  dashboard's existing PAGE_MAX=200 pagination).
- **SMS/USSD fallback.** freddie's channel adapters today are WhatsApp and
  Discord only -- there is no SMS/USSD receive path. This is a real gap for
  the lowest-connectivity reporters (no smartphone, or a smartphone with no
  data). Closing it is a freddie-level channel-adapter addition (out of
  casey's own scope per the layering mandate: "agentic harness -> freddie"),
  noted here so a deployment knows it is a known, named gap rather than an
  oversight.
- **Power and localization.** A future offline field-capture client (see
  AGENTS.md's "What this subsystem does NOT yet do") would need to be
  battery-light with resumable sync, and fully localized (languages, units,
  date formats, iconography) for low-literacy users -- the same discipline
  casey's existing chat interaction already follows, extended to a client
  surface that does not exist yet.

## Data-quality monitoring and correction protocol

- **Monitoring.** `src/core/quality-flags.js` computes missing_gps / stale /
  unverified / conflicting flags per Observation, live, as a pure function
  -- an admin data-quality dashboard panel would aggregate these flags
  (rate of missing evidence, rate unverified, sync lag via
  `aggregate.js recency()`) the same way every other casey dashboard panel
  aggregates over the event log, additive to the existing dashboard.
- **Correction protocol.** A correction is a new Observation with
  `correctsId` + `correctionReason` set (`src/core/observation.js`) --
  never a silent overwrite, never a delete. An operator or field worker
  flags bad data by submitting a correcting Observation with a stated
  reason; the original stays in the raw log, permanently, for audit. This
  mirrors casey's existing field-correction diff-tracking discipline
  (AGENTS.md: `case_report`'s old-to-new diff on an overwritten field) at
  the new subsystem's own provenance-tagged, versioned granularity.
- **Published corrections.** A platform that has never published a
  correction is not trustworthy, it is just quiet. A deployment running
  this subsystem at scale should define what a public correction
  announcement looks like (e.g. a dashboard "corrections" feed, or a
  periodic note to the veterinary authority) once real corrections start
  accumulating -- the append-only correction chain (`correctsId`) is the
  data source such an announcement would read from.

## Adversarial and integrity work

- **Fraud-detection signals.** Statistical patterns (too-regular timing,
  implausible distributions) on a reporter's history are a HUMAN-REVIEW
  signal, never an auto-punishment mechanism -- consistent with casey's
  existing reputation-signal design (weight review, never silently discard
  data). This subsystem's raw log gives such a signal a real data source
  (per-reporter observation timestamps) to compute over; the actual
  statistical test is a future addition once real reporting volume exists
  to validate against (a fraud heuristic tuned on zero real data is a
  guess, not a signal).
- **Photo provenance.** EXIF is trivially forged or stripped. A real
  deployment wanting duplicate-photo detection needs a perceptual hash
  compared against prior submissions for the same subject, flagged for
  human review on a match -- never auto-rejected, since a genuinely similar
  photo (same pen, different day) is a plausible false positive a human
  can resolve in seconds but an automated reject cannot.
- **Device/identity binding.** Phones get shared, sold, and pooled among
  field workers in practice. This subsystem's `observerId` is whatever
  identity the channel adapter reports (a WhatsApp/Discord contact id
  today) -- it is a REPORTER identity, not a device identity, and a
  deployment should not conflate the two. A stronger accreditation scheme
  (roles-fieldworker-identity-verification) is the mechanism for
  strengthening WHO is asserted to be reporting; it does not by itself
  solve a shared-device scenario.
- **Insider threat / pack governance.** A config pack is a plain-text,
  git-tracked, diffable artifact like any other casey source file -- a
  change to a pack's escalation rules or codelists goes through the same
  review process as a code change. Because every Observation is
  permanently stamped with the exact `packVersion` that captured it
  (`schema-at-the-boundary`), a later pack edit can never silently rewrite
  the recorded meaning of a historical observation -- the historical record
  stays anchored to the version that actually captured it.

## Epistemics

- **Case-definition versioning.** `src/core/observation.js`'s
  `caseDefinitionVersion` field exists precisely so a change in what counts
  as "suspected" vs "probable" vs "confirmed" is stamped and distinguishable
  from a genuine change in the underlying disease pattern over time -- a
  deployment should populate this field whenever its case-definition
  changes, and treat a time-series discontinuity that coincides with a
  definition-version change as a definitional artifact, not an outbreak.
- **Coverage is the deepest threat to ground truth, not data error.**
  `src/core/aggregate.js`'s `withCoverage`/`sparseMark` exist because
  reporting bias (cases cluster where reporters are, not where disease is)
  cannot be fixed by better provenance tagging -- it needs an honest,
  always-shown coverage denominator. Every rate/prevalence view this
  subsystem's data eventually backs must show its denominator or refuse to
  show a rate at all (raw counts only) rather than imply a population-wide
  prevalence from an untracked sample.
- **Time semantics.** onset / observed / reported / synced are captured as
  four distinct fields specifically because conflating them invents and
  erases apparent outbreaks in a time series -- see AGENTS.md's Observation
  record section for the field-level detail.

## Sync and offline design (for a future capture client)

casey's live capture surface (WhatsApp/Discord via freddie) is inherently
online -- there is no offline gap in TODAY's system. This section documents
the architecture a future offline-first field client would need to follow,
so that work is a reviewed implementation against a real contract rather
than an improvisation:

- **Append-only + peer reconciliation, not last-write-wins.** A field
  device would hold its OWN real append-only log (mirroring
  `src/core/raw-log.js`'s own append-only discipline) and be authoritative
  for what it personally observed; sync is reconciliation between peers
  (the device's log and casey's server-side log), not an upload that
  treats the server as the sole truth. `core/write-path.js`'s existing
  no-silent-inference + per-subject-lock discipline is the reconciliation
  model to generalize: a synced Observation goes through the exact same
  `writeObservation()` chokepoint as a live agent-turn write.
- **Tamper-evident signing.** Each Observation captured on a device would
  carry a device-id + capture-timestamp + content-hash signature at
  capture time, so provenance survives the sync hop even if the transport
  is compromised or delayed. This is additive metadata on the Observation
  record, not a new field type.
- **Recency, not completeness.** A dashboard reading data from a
  partially-synced fleet of devices must show "last synced X ago"
  (`aggregate.js recency()`) rather than implying the aggregate reflects
  every report that exists -- a delayed sync is honest lag, not silently
  hidden.

## Failure and exit planning

- **Data escrow.** A national veterinary authority using casey's aggregate
  data should be able to receive a full open-format export (every raw
  Observation plus every aggregate, in a format readable without casey
  itself) if a deployment winds down. Because `src/core/raw-log.js`'s
  format IS already a plain JSONL file (one JSON object per line, no
  proprietary encoding), a data-escrow export is close to "hand over the
  file" -- a full implementation would additionally bundle the pack
  version(s) that captured the data (so the export is self-describing) and
  a plain-text README explaining the schema.
- **Deliberate failure drills.** `src/core/raw-log.js` was witnessed
  surviving a simulated crash mid-write (a truncated JSONL line is detected
  and skipped, never trusted as valid, and every prior real record survives
  the corruption) -- see AGENTS.md's provenance-subsystem section for the
  witnessed evidence. A production deployment should periodically re-run
  this class of drill (cut the process mid-write, corrupt a line, replay a
  duplicate sync) against its real data directory as a standing operational
  practice, not a one-time proof.
- **Announcing platform correctness.** See "Published corrections" above --
  the same discipline applies to a platform-level failure (a bug that
  produced wrong aggregates for a period): the fix should be as visible as
  the original number was.

## Operations and sustainability

- **Training.** Field workers and CAHW-equivalent reporters need materials
  and in-person/refresher training on what casey asks for and why (this
  mirrors casey's existing low-literacy design principle -- the training
  burden should be minimal precisely because the chat interaction is
  designed to need no separate app/login).
- **Connectivity/airtime funding.** Honest reports do not arrive if a field
  worker cannot afford the airtime/data to send a WhatsApp message --
  this is an operational funding commitment outside casey's own code, named
  here so a deployment budget accounts for it explicitly.
- **Support and incident response.** A deployment needs a defined on-call
  path for both outbreak escalations (already served by casey's existing
  `CASEY_ALERT_WEBHOOK`/`CASEY_ESCALATE_WEBHOOK`) and PLATFORM incidents
  (casey itself misbehaving) -- these are two different response teams with
  two different urgency profiles.
- **Governance.** Who owns the platform, who approves a config-pack change
  (a governance event, not an admin whim -- see "Insider threat" above),
  who validates the disease/condition taxonomy a pack encodes, and who
  signs off before an aggregate reaches an external authority: a
  deployment should name these roles explicitly before scaling.
- **Monitoring and evaluation.** Success should be measured against real
  outcomes (faster response time, verified outbreak detection) rather than
  vanity metrics (message volume, case count) -- casey's existing
  SLA-compliance and time-to-first-reply reporting (`report-analytics.js`)
  is the kind of outcome metric this subsystem's own data should eventually
  feed into, once real deployment volume exists to measure against.
