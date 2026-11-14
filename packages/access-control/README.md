# @crewhaus/access-control

Who may operate a harness ([#507](https://github.com/crewhaus/factory/issues/507),
[#513](https://github.com/crewhaus/factory/issues/513)). This package owns the members and service
principals of a Home, the roles granted to them, their hashed credentials, invites, the links from
outside identities (a Slack user, a GitHub account, a proxy login), the pure `authorize()` check, and
the approver projection each governed harness reads.

The design is in [module brief 323](https://github.com/crewhaus/docs/blob/main/module-briefs/323-access-control.md).
Stage 1 is the records, `authorize()`, `registerDomain()`, the projection writer and the bootstrap
migration, with `crewhaus access` in direct mode as the first caller. Stage 2 is the owner signing in:
Home's own key and the boot tickets (moved here from hangar-server), browsers' device keys and sealed
sessions, the owner's settings blocks, and `authenticate()`, which Home calls on every request.

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
| `devices.jsonl` | `{id: dev_, principal, deviceJwk, state: active\|revoked, revokedAt?}`: each browser's PUBLIC signing key |
| `sessions.jsonl` | `{id: crd_, principal, device, sha256, expiresAt, state: active\|ended, endedAt?, reason?}`: the digest of each session's secret |
| `security.jsonl` | `{v: 1, at, event: "identity_header_ignored", listener, peerRef}`: a proxy identity header that did not count, at most once per peer per hour; `peerRef` is a keyed digest, never the address |

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

`devices.jsonl` and `sessions.jsonl` are not authority: `loadAccessSnapshot` never folds them, and
signing in, coming back and refreshing never move the access revision. Signing out and rotating Home's
own key do. Their fold is tolerant: a torn line is skipped, never a reason to sign everyone out.

## Signing in

- **Home's own key** (`<hangarRoot>/token`, the bootstrap) is the owner only on
  `<hangarRoot>/home.sock`, or over TCP from a loopback peer (`127.0.0.0/8`, `::1` in every spelling,
  `::ffff:127.x.y.z`) whose request carries none of `Forwarded`, `X-Forwarded-*`, `X-Real-IP` or the
  proxy's identity header, while the key is not socket-only and no proxy is trusted. With access set up
  it is the live `bootstrap` credential with that digest, so `rotateBootstrap` takes effect on a running
  Home at its next request. No setting accepts it from anywhere else.
- **Boot tickets** (`/boot/<nonce>`, 2 minutes) are minted with Home's own key and spent for an
  **exchange code** (60 seconds); a **challenge** (60 seconds) is what a returning device signs. Both are
  single use, deleted before their expiry is checked, and at most 256 of each live at once.
- **A device key** is a non-extractable ECDSA P-256 key the browser makes; Home keeps its public JWK.
  It signs `canonicalJson({v: 1, op: "auth.session", device, nonce, seal})`, so a relay cannot swap in
  its own seal. It is unusable 30 days after it last signed in.
- **A session** (`cha_…`) lasts an hour from its last use and 12 hours at most. The sliding deadline is
  kept in memory (from the session's row after a restart), so checking a session writes nothing. A
  refresh issues a new secret with the same deadline.
- **Sealed issuance.** A request that gets a secret sends `seal`, a one-off ECDH P-256 public key. Home
  answers `{alg: "ECDH-ES+A256GCM", epk, iv, ct}`: ECDH with its own one-off key (`epk`, the raw
  uncompressed point), HKDF-SHA256 (empty salt, info `crewhaus.hangar.v1/issued`), AES-256-GCM with the
  operation id as additional data, every value lowercase hex. The browser half is
  `hangar-ui/assets/js/sealed.js`; a test seals here and opens there.
- **`authenticate(request, peer, config, state)`** takes the proxy identity (only from a listed peer
  with the proxy's secret, or on `proxy.sock`), then the bearer (`cha_` a session, `chs_` a service
  token, `chx_` a scoped token, any other `ch?_` shape unknown, anything else Home's own key under the
  rules above), refuses a bearer and an identity that name different principals (`identity_mismatch`),
  and answers 403 `not_invited` for an identity nobody linked. It answers every live identity, with the
  credential a token used; what each may do is Home's choke point's to decide, route by route, with
  `authorize()`. A tab-only session counts only over TCP, on the address the LAN door bound, with no
  forwarding or proxy header.
- **Joining from an invite.** `acceptInvite` spends the code first (the claim decides; a second use is
  `consumed`), then writes a new member, their display name (in `subjects.json` only), the invite's
  grant, and either a device key and a sealed session, or, for a page served over plain HTTP, a
  tab-only session from a secret the page made, of which only the digest is kept. A tab-only session
  cannot be renewed. A write that fails after the claim answers 503 and the invite stays spent.
- **Scoped tokens.** `mintScopedToken` makes a `chx_<payload>.<mac>` token from a live service token:
  run refs only, read acts only (`run.events.read`, `run.result.read`), each one the service may
  delegate on every ref's harness, for at most 15 minutes, signed with `access/keys/scoped.key` (0600).
  `verifyScopedToken` checks its MAC in constant time, its clock, and that the minting service token is
  still live, so revoking that token ends every token it minted. Each token carries the service's
  scoped-token epoch it was minted under: `bumpScopedEpoch` moves the epoch up, which ends every scoped
  token the service minted, on a request or on a stream it opened, while its own tokens stay live. Nothing about a token is stored.
- **Domains and objects.** A domain's checker receives the object the request is about (`ref`) exactly
  as the caller named it, and no `ref` key at all when none was named: a checker that decides per object
  refuses then. `registerDomainIn` keeps every domain table to one set of rules.
- **`--no-auth`.** `noAuthRefusal` says why Home must not turn sign-in off: a trusted proxy is set, or
  someone other than the owner has access.
- **Rotation.** `rotateBootstrap` writes a new key at 0600, revokes the old digest, records the new one
  (socket-only when asked, and it stays so until `tcp`), ends every session and revokes every device
  key, and moves the revision once. Another user of the computer is refused.
- **The owner's settings.** `readOwnerSettings` reads `access` (`trustedProxy {header, peers, hosts,
  secretDigest?, socket?}`, `allowedHosts`) and `links` (`baseUrl`: https, or http on loopback) from
  `<hangarRoot>/settings.json`; an `access` block that is not right is refused naming the file and
  the field. `writeOwnerBlock` changes one block and keeps the rest.

## Exports

| Export | Does | First consumer |
|---|---|---|
| `ensureAccessSetUp(hangarRoot, {localActor, now?, displayName?})` | The bootstrap migration, idempotent and piece by piece: the owner, its `owner` grant over the whole Home, a `local` link from the OS user, and the bootstrap's digest | every mutating `crewhaus access` verb |
| `openAccess(hangarRoot, {now?, harnesses?})` | A handle: `createInvite`, `grant`, `revoke`, `removeMember`, `link`, `unlink`, `mintServiceToken`, `bumpScopedEpoch`, `sync`, `authorize`, `registerDomain`, `load` | `crewhaus access` |
| `redeemInvite(hangarRoot, code, {now?, principal?})` | Spend an invite once: the claim on its end decides | the sign-in handle's `acceptInvite` |
| `loadAccessSnapshot(hangarRoot)` | `absent` (no `access/`: one owner implied), `present` with a frozen snapshot, or `unreadable` naming the file | `crewhaus access members`, `tokens`, every mutation |
| `authorize(snapshot, actor, permission, target, {now, domains?, ref?})` | Pure: `{allow: true, grant}` or `{allow: false, needs, role}`; a domain's checker gets `ref` unchanged | every mutating verb (`home.access.manage`), Home's choke point |
| `domainOf`, `registerDomainIn` | A permission's domain; the one set of rules every domain table keeps | `authorize`, Home's domain table |
| `effectiveRole` | The highest live grant covering a target | `authorize`, the projection writer |
| `listMembers`, `listTokens`, `listInvites` | Views with no digest and no readable subject | `crewhaus access members`, `tokens` |
| `localActorOf({username, hostname})` | `local:<user>@<host>`, always within the grammar | `crewhaus access` |
| `localPrincipalOf(snapshot, localActor)` | The principal an OS user is linked to | `crewhaus access sync` |
| `mintIssuedSecret(kind)` | A new secret of a kind | invites and service tokens |
| `INVITE_TTL_MS`, `SERVICE_TOKEN_TTL_MS` | The lifetimes: an invite 24 hours by default and 7 days at most; a service token 180 days | `--expires` |
| `ensureToken`, `tokenEquals`, `TOKEN_FILENAME`, `createBootTickets`, `BOOT_TICKET_TTL_MS` | Home's own key and the boot tickets, moved from hangar-server (which re-exports them for one release) | Home's boot |
| `openSignIn(hangarRoot, {now?, localActor, harnesses?})` | The sign-in handle: boot tickets, exchange codes, challenges, `exchange`, `acceptInvite`, `signInWithDevice`, `refresh`, `signOut`, `verifyBearer`, `onEnd`, `checkSessions`, `scopedKey` | Home's sign-in routes |
| `authenticate`, `hasForwardingHeaders`, `hostNameOf` | One request to at most one principal | Home's choke point |
| `mintScopedToken`, `verifyScopedToken`, `SCOPED_TOKEN_TTL_MS`, `SCOPED_ACT_PERMISSIONS`, `scopedEpochOf`, `scopedEpochBumpRow` | Scoped tokens for one run's reads; a service's scoped-token epoch, and the one row that bumps it inside a change | Home's route tests; `authenticate` |
| `queuedActorHolds(snapshot, {actor, credentialRef?}, permission, target, {now, domains?})` | Pure: whether a command's submitter may still do it when it is dispatched from its receipt; a receipt that names a credential is checked against exactly that credential | Home's re-check before a command is dispatched |
| `noAuthRefusal(hangarRoot)` | Why `--no-auth` must not be used here, or nothing | `crewhaus hangar --no-auth` |
| `rotateBootstrap(hangarRoot, {localActor, socketOnly?, tcp?, now?})` | Replace Home's own key | `crewhaus hangar rotate-token` |
| `readOwnerSettings`, `writeOwnerBlock`, `SETTINGS_FILENAME`, `OWNER_BLOCKS` | The owner's settings blocks | Home's boot, `crewhaus access proxy` |
| `isLoopbackAddress`, `parseCidr`, `cidrContains` | Addresses as bytes | `authenticate` |
| `HOME_SOCKET`, `PROXY_SOCKET`, `PROXY_SECRET_HEADER`, `SIGN_IN_LIMITS`, `BOOTSTRAP_PRINCIPAL` | Names and lifetimes | Home, the CLI |

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

`members`, `tokens`, `invite`, `grant`, `revoke`, `link`, `unlink`, `mint`, `sync` and `proxy`, in
`apps/cli/src/access-cmd.ts`, which only parses and prints. Every verb works with Home stopped; the OS
user who owns the Home acts as its owner, and another user of the same computer is refused.
