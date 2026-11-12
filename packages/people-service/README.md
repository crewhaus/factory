# @crewhaus/people-service

Profile management for Home and `crewhaus people` ([#521](https://github.com/crewhaus/factory/issues/521),
[module brief 329](https://github.com/crewhaus/docs/blob/main/module-briefs/329-people-service.md)).
It holds the rules a profile obeys and who may do what with one; [`@crewhaus/people`](https://github.com/crewhaus/factory/tree/main/packages/people)'s
vault keeps the records. It never enters a compiled harness, and a test fails if an emitter names it.

```ts
import { createPeopleAdmin } from "@crewhaus/people-service";

const admin = createPeopleAdmin({
  vault, // openVault(...) from @crewhaus/people/vault
  receipts: (request, effect) => control.commands.submit(request, effect),
  actor, // the acting principal, prn_…
});
const person = await admin.createPerson({ kind: "personal", label: "Sam" });
```

## Commands and reads

Every change is one command in Home's workspace ledger: its receipt is accepted before the vault
changes, and it holds ids and counts, never a note. The receipts port is shaped like
`@crewhaus/control-service`'s `commands.submit`, which the CLI passes in; this package imports neither
control-service nor access-control. Reads write nothing.

| Function | What it does |
|---|---|
| `setup`, `vaultState`, `rotateKeys` | set up the vault, say where its key is (never the key), rotate it |
| `listPersons`, `createPerson`, `getPerson`, `updatePerson` | profiles: personal, group (`audience`) and made-up (`synthetic`) |
| `listClaims`, `addClaim`, `reviseClaim`, `reviewClaim`, `reviewList` | notes, and the review tray |
| `previewExport`, `writeExport` | `crewhaus.people.v1`, with a fingerprint the preview and the file share |
| `activity` | what changed, by count, newest first |
| `planErasure`, `runErasure` | a dry run, then the erasure after the profile's name is typed |

## The rules

- Health and worldview notes are special by nature. A special note is only ever stated, never
  observed or inferred.
- Sensitive and special notes start as suggestions and count only once the owner keeps them.
- A profile about someone else needs a basis (guardian or carer, their agreement, or an agreement
  with them), and holds no special note until their agreement can be recorded.
- A rejected note's keyed fingerprint keeps the same words out of that area, in any spelling, until
  the note is reopened.
- A profile's kind never changes. An off-limits area takes no note.
- Notes are compare-and-set: an edit made against an old revision is refused with the note as it
  stands.

## Who may do what

`authorizePerson(row, principal, permission)` is the policy, over one index row. No workspace role
implies anything: a Home owner who is not a profile's owner, custodian or named viewer holds nothing
on it.

| Who | Holds |
|---|---|
| The owner | every permission on that profile |
| A custodian | all but what the basis withholds: export, for a profile kept by agreement |
| A viewer the owner named | `people.person.read` |
| Anyone else | nothing |

Adding a profile (`people.space.use`) belongs to the space's owner, the member who set profiles up.
"Not allowed" and "no such profile" are the same answer, byte for byte.

## Export

UTF-8 JSON with sorted keys, ending in a newline: the profile, its notes and its rejected notes.
Sensitive notes are left out unless asked for; rejected ones go in so they stay rejected. Every
string passes the credential masker, and the preview counts the notes it masked. A file is written
`0600`, never through a link, and never over an existing file without `force`.

## Erasure

`planErasure` writes nothing. It counts what goes, lists what stays (downloaded exports, backups made
before today, a space key that environment custody cannot rotate) and answers a nonce good for ten
minutes. `runErasure` refuses an expired nonce, a profile that changed since the dry run, and a typed
name that is not the profile's. Then it deletes the person's key, then their records, rotates the
space key, and records that an erasure happened, with ids and counts only. A run that stopped part
way is finished by running it again.
