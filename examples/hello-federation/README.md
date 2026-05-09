# hello-federation

Section 34 — sample federation deployment fixture.

This directory holds the minimal scaffolding for a two-deployment
federation smoke. Production deployments compose the federation pieces
themselves; this folder is intentionally light.

Inputs (production deployments wire these in spec.federation.peers):

- `deployment-a` (caller) — researcher agent. mTLS cert at
  `~/.crewhaus/federation/deployment-a/{cert,key}.pem`.
- `deployment-b` (callee) — code-reviewer agent. mTLS cert at
  `~/.crewhaus/federation/deployment-b/{cert,key}.pem`.

Run `bun run smoke:section-34` for the in-process two-deployment smoke
(no docker required). The full docker-compose fixture is gated behind
`CREWHAUS_FEDERATION_LIVE=1` and is a TODO for the cross-host pilot.
