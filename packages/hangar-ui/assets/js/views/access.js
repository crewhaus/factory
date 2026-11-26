/**
 * Access (`#/settings/access`, the owner's), Setup › Access (one harness) and Connections
 * › Hosts, over the versioned API's `access.*` and Home's own reads.
 *
 * - Members: who can sign in to this Home and what they can do, in words. [Remove] revokes
 *   every live grant, device, token and link they hold, one receipted request each, and
 *   shows each receipt in words. It is offered only when every list it revokes from was
 *   read whole; otherwise the page shows the command that removes them. It says someone
 *   is signed out everywhere only once the lists, read again, hold nothing live of theirs.
 * - Invite someone: a role (each with one line of what it allows), where, and how long the
 *   link works. The link arrives sealed to this tab and is opened here, in a secure
 *   context only; outside one, the page says where to open Home instead.
 * - Apps and scripts: service tokens, listed by their prefix and last use; a new token is
 *   shown once.
 *
 * Every action shows its command-line twin. The models are pure and exported for tests;
 * the pages build DOM with `el` only.
 */

import { clear, copyBtn, el, skeleton } from "../dom.js";
import { canSeal, makeSeal } from "../sealed.js";
import { shellQuote } from "../supervision.js";
import { emptyFor } from "../ui/empty.js";
import { call, createAction } from "../v1.js";
import { RECEIPT_WORDS } from "./harness-controls.js";

/** A value as one argument of a command a person may paste: bare when plainly safe, else quoted. Pure. */
export function shellArg(value) {
  const text = String(value);
  return /^[A-Za-z0-9_.:@/-]+$/.test(text) ? text : shellQuote(text);
}

/** Whether a list's row still counts: not revoked, not ended, not expired. Pure. */
export function isLive(row) {
  if (row === null || typeof row !== "object") return false;
  if (row.live === false) return false;
  if (row.state === "revoked" || row.state === "ended") return false;
  return row.revokedAt === undefined;
}

/** Whether a list was read whole: it answered, and nothing was left out. Pure. */
export function readWhole(answer) {
  return (
    answer?.ok === true &&
    Array.isArray(answer.body?.items) &&
    answer.body.truncated === undefined &&
    answer.body.next === undefined
  );
}

/** Why the page cannot remove a member itself, or `null` when it can. Pure. */
export function removalBlocked(answers) {
  const lists = Object.values(answers ?? {});
  if (lists.some((answer) => answer?.ok !== true)) {
    return "Some of this Home's access lists couldn't be read, so this page can't remove anyone.";
  }
  if (lists.some((answer) => !readWhole(answer))) {
    return "This Home holds more access records than this page reads, so this page can't remove anyone.";
  }
  return null;
}

/** The command that removes a member, by their id. Pure. */
export function memberTwin(row) {
  return `crewhaus access revoke --member ${shellArg(row.id)}`;
}

/** The roles, each with one line of what it allows. */
export const ROLE_LINES = Object.freeze([
  Object.freeze({
    id: "viewer",
    label: "Viewer",
    line: "Can see harnesses, results and decisions.",
  }),
  Object.freeze({
    id: "operator",
    label: "Operator",
    line: "Can run work, pause, and decide routine approvals.",
  }),
  Object.freeze({
    id: "maintainer",
    label: "Maintainer",
    line: "Can also change setup, quality and deployments.",
  }),
  Object.freeze({
    id: "owner",
    label: "Owner",
    line: "Can do everything, including access and security.",
  }),
]);

/** How long an invite link works, and its default. */
export const INVITE_EXPIRIES = Object.freeze([
  Object.freeze({ id: "24h", label: "24 hours", ms: 24 * 3_600_000 }),
  Object.freeze({ id: "3d", label: "3 days", ms: 3 * 86_400_000 }),
  Object.freeze({ id: "7d", label: "7 days", ms: 7 * 86_400_000 }),
]);

const ROLE_WORD = Object.freeze({
  viewer: "Viewer",
  operator: "Operator",
  maintainer: "Maintainer",
  owner: "Owner",
});

/** What a set of grants lets someone do, in words: "Owner of Home", "Operator on 2 harnesses". Pure. */
export function accessWords(grants, homeOwner = false) {
  if (homeOwner) return "Owner of Home";
  const live = (Array.isArray(grants) ? grants : []).filter((g) => g && g.revokedAt === undefined);
  if (live.length === 0) return "No access";
  const parts = [];
  for (const role of ["owner", "maintainer", "operator", "viewer"]) {
    const of = live.filter((g) => g.role === role);
    if (of.length === 0) continue;
    if (of.some((g) => g.scope === "home")) {
      parts.push(`${ROLE_WORD[role]} of Home`);
      continue;
    }
    const harnesses = of.filter((g) => String(g.scope).startsWith("harness:")).length;
    const groups = of.filter((g) => String(g.scope).startsWith("group:")).length;
    const where = [
      harnesses > 0 ? `${harnesses} harness${harnesses === 1 ? "" : "es"}` : null,
      groups > 0 ? `${groups} group${groups === 1 ? "" : "s"}` : null,
    ].filter((p) => p !== null);
    parts.push(`${ROLE_WORD[role]} on ${where.join(" and ")}`);
  }
  return parts.join(", ");
}

/**
 * The Members table's rows from the five lists: `{id, name, access, links, kind,
 * grants, devices, tokens, linkIds}`, each counting only live rows. A grants list that
 * was not read says so in the Access column, never "No access". Pure.
 */
export function membersModel({ members, grants, links, devices, tokens, owner } = {}) {
  const items = (list) => (Array.isArray(list?.items) ? list.items : []);
  const grantsRead = Array.isArray(grants?.items);
  return items(members).map((m) => {
    const mine = (list) => items(list).filter((row) => row?.principal === m.id && isLive(row));
    const held = mine(grants);
    return {
      id: m.id,
      name: typeof m.displayName === "string" && m.displayName !== "" ? m.displayName : m.id,
      kind: m.kind === "service" ? "service" : "member",
      access:
        m.id === owner
          ? accessWords(held, true)
          : grantsRead
            ? accessWords(held, false)
            : "Access couldn't be read",
      links: mine(links).length,
      grants: held.map((g) => g.id),
      devices: mine(devices).map((d) => d.id),
      tokens: mine(tokens).map((t) => t.id),
      linkIds: mine(links).map((l) => l.id),
    };
  });
}

/** The CLI twin of an invite. Every value is one argument, quoted when it must be. Pure. */
export function inviteTwin(role, where, target) {
  // Each form is spelled whole, so every command the console shows is one a terminal runs.
  const r = shellArg(role);
  if (where === "harness") {
    return `crewhaus access invite --role ${r} --harness ${target ? shellArg(target) : "<h>"}`;
  }
  if (where === "group") {
    return `crewhaus access invite --role ${r} --group ${target ? shellArg(target) : "<g>"}`;
  }
  return `crewhaus access invite --role ${r} --home`;
}

/** The scope a grant or invite is for. Pure. */
export function scopeOf(where, target) {
  if (where === "harness" && target) return `harness:${target}`;
  if (where === "group" && target) return `group:${target}`;
  return "home";
}

/** The sentence beside a new invite link. Pure. */
export function inviteResultWords(expiresAt) {
  const at = Date.parse(String(expiresAt ?? ""));
  const until = Number.isFinite(at)
    ? new Date(at).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "it expires";
  return `Send this link to them. It works once, until ${until}.`;
}

const NOT_SECURE = "Open Home on its own computer or over HTTPS to manage access.";

const twinLine = (command) =>
  el("div", { class: "twin" }, [
    el("span", { class: "twin-label", text: "CLI twin" }),
    el("code", { class: "twin-cmd", tabindex: "0", text: command }),
    copyBtn(command, "copy"),
  ]);

function section(title, children) {
  const id = `access-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return el("section", { class: "card access-card", "aria-labelledby": id }, [
    el("h2", { class: "card-title", id, tabindex: "-1", text: title }),
    ...children,
  ]);
}

/** The five lists the Members table and [Remove] read, each up to one page. */
async function readAccessLists() {
  const [members, grants, links, devices, tokens] = await Promise.all([
    call("access.members.list", { query: { limit: "500" } }),
    call("access.grants.list", { query: { limit: "500" } }),
    call("access.links.list", { query: { limit: "500" } }),
    call("access.devices.list", { query: { limit: "500" } }),
    call("access.tokens.list", { query: { limit: "500" } }),
  ]);
  return { members, grants, links, devices, tokens };
}

/** The Members table's rows from the five answers. Pure. */
function rowsOf(answers, owner) {
  return membersModel({
    members: answers.members.body,
    grants: answers.grants.body,
    links: answers.links.body,
    devices: answers.devices.body,
    tokens: answers.tokens.body,
    owner,
  });
}

/** The owner's Access page. */
export async function renderAccess(root, ctx = {}) {
  clear(root).appendChild(skeleton(4));
  const me = await call("me.get");
  if (ctx.signal?.aborted) return;
  clear(root);
  if (!me.ok || me.body?.can?.["home.access.manage"] !== true) {
    root.appendChild(
      emptyFor({
        cause: "no-access",
        detail: "Only an owner of this Home manages who can sign in.",
      }),
    );
    return;
  }
  if (!canSeal()) {
    root.appendChild(el("p", { class: "notice", text: NOT_SECURE }));
    return;
  }
  const self = me.body?.principal?.id;
  const first = await readAccessLists();
  if (ctx.signal?.aborted) return;
  // The status stays while the lists are drawn again, so each receipt stays shown and is
  // announced; the invite form is never redrawn, so a draft there survives.
  const status = el("p", { class: "access-status", role: "status", "aria-live": "polite" });
  const membersPart = el("div");
  const tokensPart = el("div");
  const draw = (answers) => {
    const rows = rowsOf(answers, self);
    const redraw = async () => {
      const again = await readAccessLists();
      if (ctx.signal?.aborted) return again;
      draw(again);
      document.getElementById("access-members")?.focus();
      return again;
    };
    membersPart.replaceChildren(
      membersSection(rows, self, status, removalBlocked(answers), redraw),
    );
    tokensPart.replaceChildren(tokensSection(answers.tokens.body, rows, redraw));
  };
  draw(first);
  root.appendChild(membersPart);
  root.appendChild(status);
  root.appendChild(inviteSection(ctx.route?.query?.harness ?? ""));
  root.appendChild(tokensPart);
}

function membersSection(rows, self, status, blocked, redraw) {
  const table = el("table", { class: "table" }, [
    el("caption", { class: "sr-only", text: "Members of this Home" }),
    el("thead", null, [
      el("tr", null, [
        el("th", { scope: "col", text: "Name" }),
        el("th", { scope: "col", text: "Access" }),
        el("th", { scope: "col", text: "Linked accounts" }),
        el("th", { scope: "col", text: "Actions" }),
      ]),
    ]),
    el(
      "tbody",
      null,
      rows
        .filter((row) => row.kind === "member")
        .map((row) =>
          el("tr", null, [
            el("th", { scope: "row", text: row.name }),
            el("td", { text: row.access }),
            el("td", { text: String(row.links) }),
            el("td", null, [
              row.id === self
                ? el("span", { class: "muted", text: "You" })
                : removeControl(row, status, blocked, redraw),
            ]),
          ]),
        ),
    ),
  ]);
  return section("Members", [
    el("p", { class: "muted", text: "People who can sign in to this Home, and what they can do." }),
    el("div", { class: "table-scroll", role: "region", "aria-label": "Members", tabindex: "0" }, [
      table,
    ]),
    blocked !== null ? el("p", { class: "muted", text: blocked }) : null,
    twinLine("crewhaus access members"),
  ]);
}

/** Every revoke [Remove] sends for one member, one action each. Pure. */
export function removalActions(row) {
  return [
    ...row.grants.map((id) => ({ id: "access.grants.revoke", params: { grt: id } })),
    ...row.devices.map((id) => ({ id: "access.devices.revoke", params: { dev: id } })),
    ...row.tokens.map((id) => ({ id: "access.tokens.revoke", params: { crd: id } })),
    ...row.linkIds.map((id) => ({ id: "access.links.revoke", params: { lnk: id } })),
  ];
}

/** What each revoke [Remove] sends is, in words. */
const STEP_WORDS = Object.freeze({
  "access.grants.revoke": "Grant removed",
  "access.devices.revoke": "Signed out of a device",
  "access.tokens.revoke": "Token revoked",
  "access.links.revoke": "Account unlinked",
});

/** One revoke's line: what it did and its receipt's state, in words. Pure. */
export function removalStepLine(step, answer) {
  const what = STEP_WORDS[step.id] ?? "Revoked";
  if (answer?.ok !== true) {
    const why = typeof answer?.error?.message === "string" ? answer.error.message : "Not done.";
    return `${what}: Refused. ${why}`;
  }
  return `${what}: ${RECEIPT_WORDS[answer.body?.receipt?.state] ?? "Sent"}.`;
}

/**
 * What [Remove] says when it is done, from the lists read again: "signed out everywhere"
 * only when they were read whole and hold nothing live of that member's. Pure.
 */
export function removalSummary(row, answers) {
  const twin = memberTwin(row);
  if (answers === undefined || removalBlocked(answers) !== null) {
    return `Couldn't check that ${row.name} holds nothing more. In a terminal: ${twin}`;
  }
  const after = rowsOf(answers, undefined).find((r) => r.id === row.id);
  const left = after === undefined ? 0 : removalActions(after).length;
  return left === 0
    ? `${row.name} is signed out everywhere and has no access now.`
    : `${row.name} still holds ${left === 1 ? "one grant, device, token or link" : `${left} grants, devices, tokens or links`}. In a terminal: ${twin}`;
}

/**
 * [Remove], then its confirmation in place: the sentence, and Remove or Cancel. When the
 * lists were not read whole, the command that removes them instead, and why.
 */
function removeControl(row, status, blocked, redraw) {
  const holder = el("div", { class: "remove-control" });
  if (blocked !== null) {
    holder.appendChild(
      el("code", { class: "twin-cmd mono", tabindex: "0", text: memberTwin(row) }),
    );
    return holder;
  }
  const ask = el("button", {
    class: "btn btn-danger",
    type: "button",
    text: "Remove",
    "aria-label": `Remove ${row.name}`,
    onClick: () => {
      const cancel = el("button", {
        class: "btn btn-ghost",
        type: "button",
        text: "Cancel",
        onClick: () => {
          holder.replaceChildren(ask);
          ask.focus();
        },
      });
      const yes = el("button", {
        class: "btn btn-danger",
        type: "button",
        text: `Remove ${row.name}`,
        onClick: () => void removeMember(row, status, redraw),
      });
      holder.replaceChildren(
        el("p", { text: `Remove ${row.name}? They're signed out everywhere and lose access now.` }),
        yes,
        cancel,
        el("code", { class: "twin-cmd mono", tabindex: "0", text: memberTwin(row) }),
      );
      yes.focus();
    },
  });
  holder.appendChild(ask);
  return holder;
}

/** Every revoke, one receipt each, then the lists read again to say what is left. */
async function removeMember(row, status, redraw) {
  const lines = [];
  for (const step of removalActions(row)) {
    const answer = await createAction(step.id, { params: step.params, body: {} }).run();
    lines.push(removalStepLine(step, answer));
    status.textContent = lines.join(" ");
  }
  const again = await redraw();
  status.textContent = [...lines, removalSummary(row, again)].join(" ");
}

function inviteSection(harness) {
  const role = el(
    "select",
    { class: "input", id: "invite-role" },
    ROLE_LINES.map((r) =>
      el("option", { value: r.id, selected: r.id === "operator", text: r.label }),
    ),
  );
  const where = el("select", { class: "input", id: "invite-where" }, [
    el("option", { value: "home", text: "All harnesses" }),
    el("option", { value: "group", text: "A group" }),
    el("option", { value: "harness", selected: harness !== "", text: "One harness" }),
  ]);
  const target = el("input", {
    class: "input",
    id: "invite-target",
    type: "text",
    value: harness,
    autocomplete: "off",
  });
  const expires = el(
    "select",
    { class: "input", id: "invite-expires" },
    INVITE_EXPIRIES.map((e) => el("option", { value: e.id, text: e.label })),
  );
  const result = el("div", { class: "invite-result", role: "status", "aria-live": "polite" });
  const twin = el("div");
  const drawTwin = () =>
    twin.replaceChildren(twinLine(inviteTwin(role.value, where.value, target.value.trim())));
  for (const field of [role, where, target]) field.addEventListener("change", drawTwin);
  drawTwin();
  const send = el("button", {
    class: "btn btn-primary",
    type: "button",
    text: "Create invite link",
    onClick: async () => {
      const span = INVITE_EXPIRIES.find((e) => e.id === expires.value) ?? INVITE_EXPIRIES[0];
      const seal = await makeSeal();
      const answer = await createAction("access.invites.create", {
        body: {
          role: role.value,
          scope: scopeOf(where.value, target.value.trim()),
          expiresAt: new Date(Date.now() + span.ms).toISOString(),
          seal: seal.seal,
        },
      }).run();
      if (!answer.ok) {
        result.replaceChildren(
          el("p", { text: answer.error?.message ?? "The invite was not made." }),
        );
        return;
      }
      const code = await seal.open(answer.body.issued, "access.invites.create");
      const link = `${window.location.origin}/invite#c=${encodeURIComponent(code)}`;
      result.replaceChildren(
        el("p", { text: inviteResultWords(answer.body?.invite?.expiresAt) }),
        el("code", { class: "mono", tabindex: "0", text: link }),
        copyBtn(link, "Copy link"),
      );
    },
  });
  // What each role allows, one line each, beside the choice rather than inside it.
  const roleLines = el(
    "ul",
    { class: "muted role-lines", id: "invite-role-lines" },
    ROLE_LINES.map((r) => el("li", { text: `${r.label}: ${r.line}` })),
  );
  role.setAttribute("aria-describedby", "invite-role-lines");
  return section("Invite someone", [
    el("label", { for: "invite-role", text: "Role" }),
    role,
    roleLines,
    el("label", { for: "invite-where", text: "Where" }),
    where,
    el("label", { for: "invite-target", text: "Group or harness (when not all)" }),
    target,
    el("label", { for: "invite-expires", text: "Expires" }),
    expires,
    send,
    result,
    twin,
  ]);
}

function tokensSection(list, rows, reload) {
  const items = Array.isArray(list?.items) ? list.items : [];
  const services = rows.filter((row) => row.kind === "service");
  const shown = el("div", { class: "token-result", role: "status", "aria-live": "polite" });
  const pick = el(
    "select",
    { class: "input", id: "token-service" },
    services.map((s) => el("option", { value: s.id, text: s.name })),
  );
  return section("Apps and scripts", [
    items.length === 0
      ? el("p", { class: "muted", text: "No tokens yet." })
      : el(
          "ul",
          { class: "home-list" },
          items.map((t) =>
            el("li", null, [
              el("span", { class: "mono", text: String(t.prefixHint ?? t.id) }),
              el("span", {
                class: "muted",
                text: t.lastUsedAt ? ` last used ${t.lastUsedAt}` : " not used yet",
              }),
              el("button", {
                class: "btn btn-ghost",
                type: "button",
                text: "Revoke",
                onClick: async () => {
                  await createAction("access.tokens.revoke", {
                    params: { crd: t.id },
                    body: {},
                  }).run();
                  reload();
                },
              }),
            ]),
          ),
        ),
    services.length === 0
      ? el("p", {
          class: "muted",
          text: "Add a service with `crewhaus access mint --service <name>` to give it a token.",
        })
      : el("div", null, [
          el("label", { for: "token-service", text: "Service" }),
          pick,
          el("button", {
            class: "btn",
            type: "button",
            text: "New token",
            onClick: async () => {
              const seal = await makeSeal();
              const answer = await createAction("access.tokens.mint", {
                body: { principal: pick.value, seal: seal.seal },
              }).run();
              if (!answer.ok) {
                shown.replaceChildren(
                  el("p", { text: answer.error?.message ?? "No token was made." }),
                );
                return;
              }
              const secret = await seal.open(answer.body.issued, "access.tokens.mint");
              shown.replaceChildren(
                el("p", { text: "Copy this token now. You won't see it again." }),
                el("code", { class: "mono", tabindex: "0", text: secret }),
                copyBtn(secret, "Copy token"),
              );
            },
          }),
        ]),
    shown,
    twinLine("crewhaus access tokens"),
  ]);
}

/** Setup › Access: who can work on this harness, from `home.harnessAccess`. */
export async function renderHarnessAccess(root, ctx = {}) {
  clear(root).appendChild(skeleton(3));
  const [answer, me] = await Promise.all([
    call("home.harnessAccess", { params: { h: ctx.id } }),
    call("me.get"),
  ]);
  if (ctx.signal?.aborted) return;
  clear(root);
  if (!answer.ok) {
    root.appendChild(
      emptyFor({
        cause: answer.status === 403 ? "no-access" : "connection-failed",
        subject: "who can work on this harness",
        detail: answer.error?.message,
      }),
    );
    return;
  }
  const name = String(ctx.detail?.inventory?.specName ?? ctx.detail?.entry?.specName ?? ctx.id);
  const members = Array.isArray(answer.body?.members) ? answer.body.members : [];
  root.appendChild(
    section(`Who can work on ${name}`, [
      el(
        "ul",
        { class: "home-list" },
        members.map((m) =>
          el("li", null, [
            el("span", { text: String(m.name ?? m.principal) }),
            el("span", {
              class: "muted",
              text: ` ${(Array.isArray(m.grants) ? m.grants : [])
                .map(
                  (g) =>
                    `${ROLE_WORD[g.role] ?? g.role} (${g.scope === "home" ? "all harnesses" : g.scope === "group" ? "a group" : "this harness"})`,
                )
                .join(", ")}`,
            }),
          ]),
        ),
      ),
      me.ok && me.body?.can?.["home.access.manage"] === true
        ? el("a", {
            class: "btn",
            href: `#/settings/access?harness=${encodeURIComponent(ctx.id)}`,
            text: "Invite to this harness",
          })
        : null,
      el("p", {
        class: "muted",
        text: "Everyone with access to this Home: crewhaus access members",
      }),
    ]),
  );
}

/** Connections › Hosts: this Home's host, how it is reached, its version and its service. Pure words. */
export function hostLines(status, platform = "") {
  const host = status?.host ?? {};
  const reached = {
    loopback: "on this computer",
    lan: "over the local network",
    proxy: "through a proxy",
  };
  const lines = [
    `Home runs on ${String(host.name ?? "this computer")}, reached ${reached[host.reachedBy] ?? "here"}.`,
    `Version ${String(status?.version ?? "unknown")}.`,
    status?.service?.installed === true
      ? "Home runs as a service and starts again after a restart."
      : status?.service?.installed === false
        ? "Home stays stopped after a restart. Install the Home service to change that."
        : "Whether Home starts again after a restart is not known here.",
    "To keep harnesses running when your computer sleeps, install Home on an always-on Linux or macOS machine and open it from there.",
  ];
  if (/win/i.test(platform)) {
    lines.push(
      "The Home service isn't supported on Windows yet. Keep `crewhaus hangar` running instead.",
    );
  }
  return lines;
}

export async function renderHosts(root, ctx = {}) {
  clear(root).appendChild(skeleton(2));
  const status = await call("home.status");
  if (ctx.signal?.aborted) return;
  clear(root);
  if (!status.ok) {
    root.appendChild(
      emptyFor({ cause: "connection-failed", subject: "Home", detail: status.error?.message }),
    );
    return;
  }
  const platform = typeof navigator === "undefined" ? "" : String(navigator.platform ?? "");
  root.appendChild(
    section("This Home", [
      ...hostLines(status.body, platform).map((line) => el("p", { text: line })),
      twinLine("crewhaus hangar status"),
    ]),
  );
}

/**
 * Your account's access part: the caller's own grants from `me.get`, and for the owner
 * this Home's devices, tokens and links that are theirs, each with Revoke. Anyone else
 * hears who revokes one.
 */
export async function renderYourAccess(root) {
  const me = await call("me.get");
  if (!me.ok) {
    root.replaceChildren(el("p", { class: "muted", text: "Your access could not be read." }));
    return;
  }
  const self = me.body?.principal?.id;
  const grants = Array.isArray(me.body?.grants) ? me.body.grants : [];
  const children = [el("p", { text: `Your access: ${accessWords(grants, false)}.` })];
  if (me.body?.can?.["home.access.manage"] === true && canSeal()) {
    const [devices, tokens, links] = await Promise.all([
      call("access.devices.list", { query: { limit: "500" } }),
      call("access.tokens.list", { query: { limit: "500" } }),
      call("access.links.list", { query: { limit: "500" } }),
    ]);
    const mine = (answer) =>
      (Array.isArray(answer.body?.items) ? answer.body.items : []).filter(
        (row) => row?.principal === self && isLive(row),
      );
    const list = (title, rows, label, op, param) =>
      el("div", null, [
        el("h3", { text: title }),
        rows.length === 0
          ? el("p", { class: "muted", text: "None." })
          : el(
              "ul",
              { class: "home-list" },
              rows.map((row) =>
                el("li", null, [
                  el("span", { text: label(row) }),
                  el("button", {
                    class: "btn btn-ghost",
                    type: "button",
                    text: "Revoke",
                    onClick: async (event) => {
                      const answer = await createAction(op, {
                        params: { [param]: row.id },
                        body: {},
                      }).run();
                      event.target.replaceWith(
                        el("span", {
                          class: "muted",
                          text: answer.ok ? "Revoked." : (answer.error?.message ?? "Not revoked."),
                        }),
                      );
                    },
                  }),
                ]),
              ),
            ),
      ]);
    children.push(
      list(
        "Devices",
        mine(devices),
        (d) => String(d.label ?? d.id),
        "access.devices.revoke",
        "dev",
      ),
      list(
        "Command-line tokens",
        mine(tokens),
        (t) => String(t.prefixHint ?? t.id),
        "access.tokens.revoke",
        "crd",
      ),
      list(
        "Linked accounts",
        mine(links),
        (l) => String(l.provider ?? l.id),
        "access.links.revoke",
        "lnk",
      ),
    );
  } else {
    children.push(
      el("p", { class: "muted", text: "Ask the owner of this Home to revoke a device or token." }),
    );
  }
  root.replaceChildren(section("Your access", children));
}
