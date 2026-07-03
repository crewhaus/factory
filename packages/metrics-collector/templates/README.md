# metrics-collector templates

Copy-and-edit scheduling templates for the ops signals this package's metrics
feed. They are **templates**, not active workflows — copy one into your
deployment repository's `.github/workflows/` and fill in the `<PLACEHOLDER>`
comments.

## `slo-probe.yml` — scheduled SLO / TTFT probe (ops item 37)

Runs `crewhaus doctor --slo` on a cron. The probe compares the recent p95
time-to-first-token (from the durable `.crewhaus/metrics/sessions.jsonl`
history — the same `model_ttft_seconds` signal this package's histogram
measures) against the cwd spec's `observability.slo.ttft_ms` target:

- **within SLO / no history yet** → exit 0 (a green run; a cold store never
  false-pages).
- **sustained breach** → exit 1 (a red run → your alerting fires), and the log
  names faster candidate models plus the `crewhaus eval --models …` command to
  confirm a swap holds quality before you change the spec.

The same command doubles as a container `HEALTHCHECK`:

```dockerfile
HEALTHCHECK --interval=60s --timeout=10s CMD crewhaus doctor --slo || exit 1
```

The runtime **SLO monitor** (gated by `CREWHAUS_SLO` with a lowered
`observability.slo` block) is the live, in-flight half — it walks the declared
`mitigation` ladder (`alert → pause-intake → rollback`) *during* a run. This
probe is the scheduled, out-of-band confirmation.
