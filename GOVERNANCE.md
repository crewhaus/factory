# CrewHaus Governance

This document describes how decisions are made in the CrewHaus Factory project.

## Model

CrewHaus uses a **BDFL-lite** governance model. There is a project lead with final decision-making authority. Contributors and maintainers participate in design discussions, RFCs, and code review, but the project lead resolves disputes and sets direction.

This is appropriate for a young project. As the community grows, we expect governance to formalize — likely toward a small steering committee or a foundation model. See "When this changes" at the end.

## Roles

### Project lead

**Current:** Max ([@studiomax](https://github.com/studiomax) — verify the actual handle on launch)

The project lead:

- Has final say on architecture, roadmap, license, and brand
- Reviews and accepts RFCs
- Invites maintainers
- Owns the trademarks and brand assets
- Speaks for the project officially

The project lead is appointed by the owner of CrewHaus IP (currently Max Meier, operating as StudioMax; see ADR-008). Succession is by appointment of the prior project lead with documented reasoning, or by the IP owner in their absence. Because the IP owner is a natural person rather than a corporate entity, succession planning is a real risk that needs explicit attention — see `docs/governance/succession.md` (to be added by Day 180).

### Core maintainers

People with release authority and a vote on major governance changes. At launch there is one core maintainer (the project lead).

Core maintainers:

- Approve major architectural changes (per RFC process)
- Approve releases
- Can veto changes to the three pillars (compiler-first, active eval, security fabric)
- Are listed in `CODEOWNERS`

### Maintainers

People with merge rights in specific areas (per `CODEOWNERS`). Maintainers review and merge PRs in their area, but don't have authority over project-wide decisions.

### Trusted contributors

People with consistent quality contributions who are eligible to be invited to maintainer status. No special permissions yet, but they are the bench from which maintainers are drawn.

### Contributors

Anyone who's opened a PR, an issue, or an RFC. Welcome.

## Maintainer ladder

| Level | Permissions | How to advance |
|---|---|---|
| Contributor | Submit issues, PRs, RFCs | Open a PR |
| Trusted contributor | Recognized; eligible for invites | 3+ accepted contributions across 2+ areas |
| Maintainer | Merge rights in specific areas | Invitation by project lead |
| Core maintainer | Release authority and governance vote | Invitation by existing core maintainers, ratified by project lead |

## Decision-making

### Who decides what

| Decision type | Decided by |
|---|---|
| Project direction, roadmap priorities | Project lead, in consultation with core maintainers |
| Architecture changes affecting pillars | RFC + project lead approval |
| New target shape | RFC + relevant area maintainer + project lead approval |
| Breaking schema changes | RFC + project lead approval |
| License changes | Project lead alone (binding on all future contributions; existing code stays under its original license) |
| Brand and trademark decisions | Project lead alone |
| Governance changes | Project lead, after RFC discussion |
| Implementation details within an area | Area maintainer |
| Bug fixes | Any maintainer with merge rights in the affected area |
| Documentation improvements | Any maintainer; project lead reviews voice-and-tone |

### RFCs

Changes that require an RFC before any code is merged:

- New target shape (new `Ir<Target>V0` variant)
- New trust boundary site
- Changes to the eval optimization loop
- Schema changes affecting existing specs
- Cross-package architectural shifts
- Governance changes (including changes to this document)

RFC template is in [`CONTRIBUTING.md`](CONTRIBUTING.md). The RFC issue stays open until accepted, rejected, or withdrawn.

### Disputes

If contributors disagree on a technical or process question:

1. Discuss in the relevant issue or PR. Most disagreements resolve here.
2. If unresolved, escalate via @-mention to the project lead.
3. The project lead's decision is final for the version of the project they are leading.

## Code of Conduct enforcement

See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Reports go to **conduct@crewhaus.ai**. The project lead handles reports unless the project lead is the subject, in which case reports go to the entity that owns CrewHaus IP.

## Ownership of project assets

The following are owned by Max Meier (operating as StudioMax):

- The trademarks: CrewHaus, Crewhaus Factory, Crewhaus Cloud, Crewhaus Forge
- The logo and visual identity
- The domain names: crewhaus.ai and subdomains
- The npm scope: `@crewhaus`
- The GitHub organization: `crewhaus`

Contributors retain copyright on their contributions but license them under Apache-2.0 as a condition of contribution (see [`CONTRIBUTING.md`](CONTRIBUTING.md) and the DCO).

## When this changes

We expect this governance model to evolve. Triggers that should prompt a governance review:

- **Project lead unavailability** — if the project lead is unreachable for more than 30 days, core maintainers can convene to address urgent issues; structural changes require the project lead's eventual return or a formal succession.
- **Three or more core maintainers** — likely formalize to a steering committee with documented voting.
- **Foundation joining** — if the project joins Apache Foundation, Linux Foundation, etc., adopt their governance template.
- **Acquisition or fundraise** — IP and governance get re-papered as part of the transaction.

Until any of these triggers, this document is the governance model.

## When the project lead can no longer serve

If the project lead becomes unavailable permanently, the entity that owns CrewHaus IP appoints a successor. If both the project lead and the IP-owning entity are unavailable, the core maintainers convene and elect a successor from among trusted contributors, by simple majority.

The succession plan is documented separately at [`docs/governance/succession.md`](docs/governance/succession.md) (to be added by Day 180).

---

*This document is part of the official CrewHaus project policy. Changes require an RFC.*
