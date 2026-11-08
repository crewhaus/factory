# @crewhaus/access-control

Who may operate a harness ([#507](https://github.com/crewhaus/factory/issues/507),
[#513](https://github.com/crewhaus/factory/issues/513)). This package owns the members and service
principals of a Home, the roles granted to them, their hashed credentials, invites, the links from
outside identities (a Slack user, a GitHub account, a proxy login), the pure `authorize()` check, and
the approver projection each governed harness reads.

The design is in [module brief 323](https://github.com/crewhaus/docs/blob/main/module-briefs/323-access-control.md).
This package is its first stage: the records, `authorize()`, `registerDomain()`, the projection writer
and the bootstrap migration, with `crewhaus access` in direct mode as the first caller.

It is files and WebCrypto: it imports `@crewhaus/control-contract`, `@crewhaus/control-records`,
`@crewhaus/tool-safety/fs` and Node built-ins, spawns no process, opens no socket and reads no file of
its own package at runtime. It never enters a compiled harness, which reads only the projection.
`surface.test.ts` holds that.

## Files

Every path is under the Hangar root (`~/.crewhaus/hangar` by default). Directories are `0700`, files
`0600`. Nothing is created by a read: `access/` appears the first time someone changes access.

| Under `<hangarRoot>/access/` | What it is |
|---|---|
| `principals.jsonl` | `{id: prn_, kind: member\|service, state: active\|removed}` |
| `grants.jsonl` | `{id: grt_, principal, role, scope, grantedBy, expiresAt?, state: active\|revoked, revokedAt?}` |
| `credentials.jsonl` | `{id: crd_, principal, kind: bootstrap\|service, sha256, prefixHint?, permissions?, harnesses?, contentRead?, subjectAssert?, expiresAt?, state, revokedAt?}` |
| `invites.jsonl` | `{id: inv_, role, scope, sha256, expiresAt, createdBy, state: open\|consumed\|revoked, consumedAt?, revokedAt?, principal?}` |
| `links.jsonl` | `{id: lnk_, principal, provider, subjectRef, verifiedVia: owner\|bootstrap, state, revokedAt?}` |
| `governed.jsonl` | `{id: hrn_, state: governed, since}`: one row per harness, the first time it is governed |
| `revision.json` | `{v: 1, epoch, at}`: the access revision, moved once by every change |
| `subjects.json` | `{v: 1, principals: {prn_: {displayName, contact?}}, links: {lnk_: "<subject>"}}` |
| `keys/subject.key` | the key `subjectRef` is a keyed digest under |
| `lock`, `claims/` | the one access lock, and the claims that settle how an invite ends |

Every ledger row is `{id, state, at, by, …}`, one file per kind, folded by `id`. `by` is always a
stored actor, never a raw `local:` id. No row holds a secret, a display name, a contact or a readable
link subject: those live only in the rewritable `subjects.json`, so erasing a person rewrites it and
the projections, and appends tombstones. Every field name tests false under the masker's
`isCredentialKey`.

In each governed harness, `.crewhaus/run/control/approvers.json` is control-contract's
`ApproverProjection`: `{v: 1, epoch, generatedAt, harness, owner, governedSince, members, links}`.

## Secrets

Secrets are 32 random bytes, base64url, after a prefix: `cha_` a session, `chp_` a personal token,
`chs_` a service token, `chi_` an invite code (`mintIssuedSecret`). A record keeps only the sha256 of
the secret, and a lookup is by that digest. A list shows a `prefixHint` (the first eight characters),
never the digest. The bootstrap token stays in `<hangarRoot>/token`, where Home and the CLI read it;
its digest is recorded as the owner's `bootstrap` credential.

Both `redact.ts` copies (in `@crewhaus/ir` and `@crewhaus/spec-patch`) mask the `ch*_` shapes, so a
CrewHaus secret is masked wherever it appears.

## Exports

| Export | Does | First consumer |
|---|---|---|
| `ensureAccessSetUp(hangarRoot, {localActor, now?, displayName?})` | The bootstrap migration, idempotent and piece by piece: the owner, its `owner` grant over the whole Home, a `local` link from the OS user, and the bootstrap's digest | every mutating `crewhaus access` verb |
| `openAccess(hangarRoot, {now?, harnesses?})` | A handle: `createInvite`, `grant`, `revoke`, `removeMember`, `link`, `unlink`, `mintServiceToken`, `sync`, `authorize`, `registerDomain`, `load` | `crewhaus access` |
| `redeemInvite(hangarRoot, code, {now?, principal?})` | Spend an invite once: the claim on its end decides | the invite-acceptance route, later in this release |
| `loadAccessSnapshot(hangarRoot)` | `absent` (no `access/`: one owner implied), `present` with a frozen snapshot, or `unreadable` naming the file | `crewhaus access members`, `tokens`, every mutation |
| `authorize(snapshot, actor, permission, target, {now, domains?})` | Pure: `{allow: true, grant}` or `{allow: false, needs, role}` | every mutating verb (`home.access.manage`) |
| `effectiveRole` | The highest live grant covering a target | `authorize`, the projection writer |
| `listMembers`, `listTokens`, `listInvites` | Views with no digest and no readable subject | `crewhaus access members`, `tokens` |
| `localActorOf({username, hostname})` | `local:<user>@<host>`, always within the grammar | `crewhaus access` |
| `localPrincipalOf(snapshot, localActor)` | The principal an OS user is linked to | `crewhaus access sync` |
| `mintIssuedSecret(kind)` | A new secret of a kind | invites and service tokens |
| `INVITE_TTL_MS`, `SERVICE_TOKEN_TTL_MS` | The lifetimes: an invite 24 hours by default and 7 days at most; a service token 180 days | `--expires` |

## Rules

- **Every change goes one way.** Under the access lock: load, check that the actor holds
  `home.access.manage`, plan the rows, refuse the whole change if one row would reach 4096 bytes,
  append, move the revision, rewrite `subjects.json` when it changed, then bring the projections to
  the new records. The lock is not re-entrant, so one lock covers every ledger a change writes.
- **Grants.** A member's role on a harness is the highest live grant covering it: `home` covers every
  harness, `group:<g>` a harness in that registry group, `harness:<h>` that harness. There are no
  deny grants, and revoking removes. Reading the Home and one's own preferences come with any live
  grant; every other Home permission needs a `home` grant at or above its role.
- **Services** hold no grants. A service token lists its permissions (only those a service may hold)
  and its harnesses; `h.read` comes with each harness, content only with `contentRead`, and naming a
  run's subject only with `subjectAssert`. A token that lists no harness acts on none.
- **Domains.** `registerDomain(name, checker)` on a handle hands every permission `<name>.…` to its
  checker. With no checker it is refused; no role implies it; a core prefix (`home`, `h`, `self`) or a
  second registration throws. Two handles never share domains.
- **What stays.** The last owner of the whole Home cannot be revoked. The home owner, the principal the
  migration created, keeps the owner grant that made it the home owner, its local link and the
  bootstrap credential: hand-over is not part of this stage. Any other grant it holds can be revoked.
- **Expiry.** Only a viewer grant can carry an end time, and a grant with one is never copied into a
  projection as a decider.
- **Invites** work only while their creator may still manage access: removing the creator, or revoking
  the grant that let them manage access, withdraws their open invites, and redeeming one re-checks.
- **The same OS user on a renamed computer** is still the owner: when the user part of the local actor
  matches the owner's local link and the Hangar root belongs to that user, the new name is linked too.
- **Projections** are written only for a governed harness: one a live grant other than the home
  owner's covers, or one on which a principal with a live Slack link may decide. GitHub and proxy links
  are never projected. A harness stays governed, and its `governedSince` comes from `governed.jsonl`,
  so deleting the file never resets it. A change rewrites only the projections whose content differs
  from the file, or whose file is absent or unreadable. Every change moves the revision above the
  highest epoch of any registered harness's file, so a lost `revision.json` never leaves a file ahead
  of the records; one still ahead is reported as not updated, and `sync` moves the revision above it
  and replaces it. A failure never undoes the change; it is reported per harness, the verb exits 1,
  and `crewhaus access sync` retries.
  `sync` also follows registry group edits, which move coverage without an access change.

## `crewhaus access`

`members`, `tokens`, `invite`, `grant`, `revoke`, `link`, `unlink`, `mint` and `sync`, in
`apps/cli/src/access-cmd.ts`, which only parses and prints. Every verb works with Home stopped; the OS
user who owns the Home acts as its owner, and another user of the same computer is refused.
