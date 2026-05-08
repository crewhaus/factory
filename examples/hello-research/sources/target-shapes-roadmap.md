# CrewHaus Factory — Target Shapes (Roadmap)

As of 2026-05, target shapes that are SHIPPED:

- cli (Section 1–5, hardened in §7–§14)
- workflow (Section 6)
- channel (Section 12)
- graph (Section 19)
- managed (Section 20)
- pipeline / RAG (Section 21)
- crew (Section 22 — researcher → writer → critic flows with handoff + A2A)

Target shapes still planned:

- research (Section 23 — autonomous research agent; THIS shape)
- batch (Section 23 — queue worker)
- voice (Section 24)
- browser (Section 25)
- studio (Section 26 — authoring/inspection UI on top of every shape)

The factory's design is "one spec, many runtimes". Adding a new shape
extends the spec discriminated union, the IR, the compiler dispatch,
and a new `target-<shape>` codegen package.
