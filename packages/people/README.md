# @crewhaus/people

People profiles, kept outside every harness ([#521](https://github.com/crewhaus/factory/issues/521),
[module brief 328](https://github.com/crewhaus/docs/blob/main/module-briefs/328-people.md)).

A profile is a set of notes about a person a harness helps: how they like to be told things, what
they need, what they are working towards. It lives in an encrypted vault beside Home's own files,
never in a harness's directory, so no harness, repository or backup of a harness carries it.

This release ships the vault, `@crewhaus/people/vault`. The package's main entry is what a compiled
harness will load once harnesses can use a profile; it exports nothing yet.

```ts
import { openVault } from "@crewhaus/people/vault";

const vault = openVault({ root: join(hangarRoot, "people"), secrets: Bun.secrets });
if (!vault.ok) throw new Error(vault.reason); // inside a git work tree or a harness directory
await vault.setUp({ custody: "keychain", owner });
```

## Where it lives

`<hangarRoot>/people/` (`~/.crewhaus/hangar/people/` by default), directories `0700`, files `0600`.
A root inside a git work tree, or at or under a registered harness's directory, is refused before
anything is created; the refusal names the fix, `CREWHAUS_HANGAR_ROOT`.

| Path | Holds |
|---|---|
| `vault.json`, `policy.json` | the custody kind, the space key's version and a key check; backup retention |
| `keys/<space>.v<n>.kek` | the space key, under file custody only |
| `spaces/<space>/index.json` | one row per profile: ids, revision and state, never a word of it |
| `spaces/<space>/persons/<psn>/key.json` | the person's own key, wrapped by the space key |
| `…/person.sealed`, `…/claims/NNNNNN.sealed`, `…/rejected.sealed` | the profile, its notes (one sealed line per revision) and the fingerprints of rejected notes |
| `…/exports.jsonl`, `…/activity/NNNNNN.jsonl` | content-free records of exports and changes |
| `erasures.jsonl` | content-free records of erasures |

## Keys

WebCrypto only. A random space key wraps one random key per person (AES-256-GCM); HKDF-SHA256 derives
that person's record key and fingerprint key from it. Each sealed record binds its kind, its person,
its id and its revision, so a record moved to another profile, or replayed at another revision, does
not open.

| Custody | Where the space key is | Notes |
|---|---|---|
| `keychain` | the OS credential store, service `ai.crewhaus.people` | the default when the store answers |
| `environment` | `CREWHAUS_PEOPLE_SPACE_KEY`, 64 hex characters | weaker; a rotation takes its new key from the caller |
| `file` | `keys/<space>.v<n>.kek` | weaker; refused when other users can read it |

The vault takes the credential store as a port shaped like `Bun.secrets`, so the package itself is
node-only. A key it cannot reach answers `locked` with the reason, never "no profiles".

## Forgetting

Erasing a profile deletes its key first, then its records, then rotates the space key and re-wraps
every remaining person's key, so a copy of the old files made before the erasure no longer opens.
Each step is idempotent: a run that stopped part way is finished by running it again.

Notes are compare-and-set: `appendClaimRevision(psn, note, {expectRev})` answers
`{conflict: "stale_claim_revision", current}` when someone else changed the note first.

The rules about what a profile may hold live in `@crewhaus/people-service`.
