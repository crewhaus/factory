/**
 * The regex worker, as SOURCE TEXT.
 *
 * It is a string on purpose, and it must stay one. `bun build --compile`
 * embeds only modules reachable through static imports; a worker started
 * from a separate file URL (`new Worker(new URL("./worker.ts", …))`) is
 * missing from a single-file binary and fails there — and only there, since
 * every test run from source finds the file. A Blob URL made from this string
 * travels inside whatever module imports it. `compiled-binary.test.ts` builds
 * a real binary to prove it.
 *
 * Plain ES2020, no imports, no template interpolation. It is exercised end to
 * end by the tests in `run.test.ts`, which is the only place it can be
 * checked: nothing type-checks the inside of a string.
 *
 * Protocol (one request at a time per worker):
 *   → { id, op, …request, giveUpMs, progressEveryMs, skip, maxItemChars }
 *   ← { kind: "ready" }                                  once, at startup
 *   ← { kind: "progress", id, completed, …increments }   batch ops
 *   ← { kind: "done", id, status, result?, partial?, … }
 *
 * Batch ops take `skip`: when true, an input the engine gives up on (or one
 * longer than `maxItemChars`) is listed in `undetermined` and the batch goes
 * on; when false, the first give-up ends the batch as "gave-up".
 *
 * WHY EVERY exec IS TIMED. When JavaScriptCore exceeds its backtracking
 * budget it abandons the match and returns null — exactly what "no match"
 * returns, with no exception, and lastIndex and RegExp.lastMatch left as a
 * genuine failure would leave them. The only observable difference is the
 * cost: every give-up measured took 0.4–3 s, while a real no-match over the
 * inputs this package admits takes microseconds to milliseconds. So a null
 * that took at least giveUpMs is reported as "gave-up", never as a no-match.
 */
export const REGEX_WORKER_SOURCE = `"use strict";
var giveUpMs = 100;
var progressEveryMs = 10;

function GaveUp(ms) { this.ms = ms; this.index = undefined; this.ruleIndex = undefined; this.partial = undefined; }
function TooLarge(what) { this.what = what; }

function advance(s, i, unicode) {
  if (!unicode || i + 1 >= s.length) return i + 1;
  var c = s.charCodeAt(i);
  if (c < 0xd800 || c > 0xdbff) return i + 1;
  var d = s.charCodeAt(i + 1);
  return d >= 0xdc00 && d <= 0xdfff ? i + 2 : i + 1;
}

function run(re, s, at) {
  re.lastIndex = at;
  var t0 = performance.now();
  var m = re.exec(s);
  var ms = performance.now() - t0;
  if (m === null && ms >= giveUpMs) throw new GaveUp(ms);
  return m;
}

function isUnicode(flags) { return flags.indexOf("u") >= 0 || flags.indexOf("v") >= 0; }
function withFlag(flags, f) { return flags.indexOf(f) >= 0 ? flags : flags + f; }
function withoutFlag(flags, f) { return flags.split(f).join(""); }

function captureChars(m) {
  var n = 0;
  for (var i = 0; i < m.length; i++) if (typeof m[i] === "string") n += m[i].length;
  return n;
}

function groupsOf(m) {
  if (!m.groups) return undefined;
  var out = {};
  for (var k in m.groups) out[k] = m.groups[k];
  return out;
}

function opTest(req) {
  var re = new RegExp(req.pattern, req.flags);
  return { status: "ok", result: { matched: run(re, req.input, 0) !== null } };
}

function opMatchAll(req) {
  var flags = withFlag(req.flags, "g");
  var re = new RegExp(req.pattern, flags);
  var unicode = isUnicode(flags);
  var s = req.input;
  var matches = [];
  var chars = 0;
  var truncatedBy;
  var at = 0;
  try {
    while (at <= s.length) {
      var m = run(re, s, at);
      if (m === null) break;
      if (matches.length >= req.maxMatches) { truncatedBy = "maxMatches"; break; }
      var size = captureChars(m);
      if (chars + size > req.maxOutputChars) { truncatedBy = "maxOutputChars"; break; }
      chars += size;
      matches.push({ match: m[0], index: m.index, captures: m.slice(1), groups: groupsOf(m) });
      at = re.lastIndex;
      if (m[0].length === 0) at = advance(s, at, unicode);
    }
  } catch (e) {
    if (e instanceof GaveUp) e.partial = { matches: matches, truncated: false };
    throw e;
  }
  var result = { matches: matches, truncated: truncatedBy !== undefined };
  if (truncatedBy !== undefined) result.truncatedBy = truncatedBy;
  return { status: "ok", result: result };
}

/* ECMAScript GetSubstitution, for a string replacement. */
function substitute(template, matched, str, position, captures, groups) {
  if (template.indexOf("$") < 0) return template;
  var out = "";
  var m = captures.length;
  var i = 0;
  while (i < template.length) {
    var c = template.charAt(i);
    if (c !== "$" || i + 1 >= template.length) { out += c; i += 1; continue; }
    var n = template.charAt(i + 1);
    if (n === "$") { out += "$"; i += 2; continue; }
    if (n === "&") { out += matched; i += 2; continue; }
    if (n === "\`") { out += str.slice(0, position); i += 2; continue; }
    if (n === "'") { out += str.slice(Math.min(position + matched.length, str.length)); i += 2; continue; }
    if (n >= "0" && n <= "9") {
      var n2 = template.charAt(i + 2);
      var digitCount = n2 >= "0" && n2 <= "9" ? 2 : 1;
      var index = parseInt(template.slice(i + 1, i + 1 + digitCount), 10);
      if (index > m && digitCount === 2) { digitCount = 1; index = parseInt(n, 10); }
      if (index >= 1 && index <= m) {
        var cap = captures[index - 1];
        out += cap === undefined ? "" : cap;
      } else {
        out += template.slice(i, i + 1 + digitCount);
      }
      i += 1 + digitCount;
      continue;
    }
    if (n === "<") {
      var close = template.indexOf(">", i + 2);
      if (groups === undefined || close < 0) { out += "$<"; i += 2; continue; }
      var name = template.slice(i + 2, close);
      var value = groups[name];
      out += value === undefined ? "" : String(value);
      i = close + 1;
      continue;
    }
    out += "$";
    i += 1;
  }
  return out;
}

function opReplace(req) {
  var flags = req.flags;
  var global = flags.indexOf("g") >= 0;
  var unicode = isUnicode(flags);
  var re = new RegExp(req.pattern, flags);
  var s = req.input;
  var out = "";
  var next = 0;
  var count = 0;
  var at = 0;
  for (;;) {
    var m = run(re, s, global ? at : 0);
    if (m === null) break;
    var matched = m[0];
    var position = Math.max(Math.min(m.index, s.length), 0);
    var rep = substitute(req.replacement, matched, s, position, m.slice(1), m.groups);
    if (position >= next) {
      if (out.length + (position - next) + rep.length > req.maxOutputChars) throw new TooLarge("output");
      out += s.slice(next, position) + rep;
      next = position + matched.length;
    }
    count += 1;
    if (!global) break;
    at = re.lastIndex;
    if (matched.length === 0) at = advance(s, at, unicode);
    if (at > s.length) break;
  }
  if (out.length + (s.length - next) > req.maxOutputChars) throw new TooLarge("output");
  out += s.slice(next);
  return { status: "ok", result: { output: out, replacements: count } };
}

/* ECMAScript String.prototype.split with a RegExp separator. The spec tries a
   sticky match at each position q; a global exec from q finds the first
   position >= q where that sticky match succeeds, so this is equivalent and
   lets every exec be timed. */
function opSplit(req) {
  var flags = withFlag(withoutFlag(req.flags, "y"), "g");
  var unicode = isUnicode(flags);
  var re = new RegExp(req.pattern, flags);
  var s = req.input;
  var lim = req.limit === undefined ? 4294967295 : req.limit >>> 0;
  var pieces = [];
  var chars = 0;
  var truncatedBy;
  function push(piece) {
    if (pieces.length >= req.maxMatches) { truncatedBy = "maxMatches"; return false; }
    var len = typeof piece === "string" ? piece.length : 0;
    if (chars + len > req.maxOutputChars) { truncatedBy = "maxOutputChars"; return false; }
    chars += len;
    pieces.push(piece);
    return pieces.length < lim;
  }
  function done() {
    var result = { pieces: pieces, truncated: truncatedBy !== undefined };
    if (truncatedBy !== undefined) result.truncatedBy = truncatedBy;
    return { status: "ok", result: result };
  }
  if (lim === 0) return done();
  var size = s.length;
  if (size === 0) {
    if (run(re, s, 0) === null) push(s);
    return done();
  }
  var p = 0;
  var q = 0;
  while (q < size) {
    var z = run(re, s, q);
    if (z === null || z.index >= size) break;
    var e = Math.min(re.lastIndex, size);
    if (e === p) { q = advance(s, z.index, unicode); continue; }
    if (!push(s.slice(p, z.index))) return done();
    for (var k = 1; k < z.length; k++) if (!push(z[k])) return done();
    p = e;
    q = p;
  }
  push(s.slice(p));
  return done();
}

function progress(id, completed, extra) {
  var msg = { kind: "progress", id: id, completed: completed };
  for (var k in extra) msg[k] = extra[k];
  postMessage(msg);
}

/* A batch op's progress reporter: every progressEveryMs, the increments of
   each named list since the last report. */
function Reporter(id, lists) {
  this.id = id;
  this.lists = lists;
  this.sent = {};
  for (var k in lists) this.sent[k] = 0;
  this.last = performance.now();
}
Reporter.prototype.tick = function (completed, scalars) {
  var now = performance.now();
  if (now - this.last < progressEveryMs) return;
  var extra = {};
  for (var s in scalars) extra[s] = scalars[s];
  for (var k in this.lists) {
    extra[k] = this.lists[k].slice(this.sent[k]);
    this.sent[k] = this.lists[k].length;
  }
  progress(this.id, completed, extra);
  this.last = now;
};

/* One input of a batch: the match, or undefined when it is skipped as
   undetermined. A give-up is rethrown unless the batch skips. */
function tryRun(req, re, s) {
  if (s.length > req.maxItemChars) {
    if (req.skip) return undefined;
    throw new TooLarge("item");
  }
  try {
    return run(re, s, 0);
  } catch (e) {
    if (req.skip && e instanceof GaveUp) return undefined;
    throw e;
  }
}

function opTestEach(req) {
  var re = new RegExp(req.pattern, req.flags);
  var inputs = req.inputs;
  var matched = [];
  var undetermined = [];
  var report = new Reporter(req.id, { matched: matched, undetermined: undetermined });
  var truncated = false;
  var i = 0;
  try {
    for (; i < inputs.length; i++) {
      var m = tryRun(req, re, inputs[i]);
      if (m === undefined) {
        undetermined.push(i);
      } else if (m !== null) {
        if (matched.length >= req.maxMatches) { truncated = true; break; }
        matched.push(i);
      }
      report.tick(i + 1);
    }
  } catch (e) {
    if (e instanceof GaveUp) {
      e.index = i;
      e.partial = { matched: matched, scanned: i, truncated: false, undetermined: undetermined };
    }
    throw e;
  }
  return { status: "ok", result: { matched: matched, scanned: i, truncated: truncated, undetermined: undetermined } };
}

function compileRules(rules) {
  var out = [];
  for (var r = 0; r < rules.length; r++) out.push(new RegExp(rules[r].pattern, rules[r].flags));
  return out;
}

function opFirstMatchingRule(req) {
  var rules = compileRules(req.rules);
  var inputs = req.inputs;
  var ruleIndexes = [];
  var undetermined = [];
  var report = new Reporter(req.id, { ruleIndexes: ruleIndexes, undetermined: undetermined });
  var i = 0;
  var j = 0;
  try {
    for (; i < inputs.length; i++) {
      var hit = -1;
      for (j = 0; j < rules.length; j++) {
        var m = tryRun(req, rules[j], inputs[i]);
        /* An earlier rule that could not be answered leaves "which rule
           matches first" undetermined, whatever the later rules say. */
        if (m === undefined) { hit = null; break; }
        if (m !== null) { hit = j; break; }
      }
      if (hit === null) undetermined.push(i);
      ruleIndexes.push(hit);
      report.tick(i + 1);
    }
  } catch (e) {
    if (e instanceof GaveUp) {
      e.index = i;
      e.ruleIndex = j;
      e.partial = { ruleIndexes: ruleIndexes, undetermined: undetermined };
    }
    throw e;
  }
  return { status: "ok", result: { ruleIndexes: ruleIndexes, undetermined: undetermined } };
}

/* Every pattern against every input. Hits and undetermined answers travel
   as flat [pattern, input, pattern, input, …] lists. */
function opTestMatrix(req) {
  var patterns = compileRules(req.patterns);
  var inputs = req.inputs;
  var hits = [];
  var unknown = [];
  var report = new Reporter(req.id, { hits: hits, unknown: unknown });
  var i = 0;
  var p = 0;
  try {
    for (; i < inputs.length; i++) {
      for (p = 0; p < patterns.length; p++) {
        var m = tryRun(req, patterns[p], inputs[i]);
        if (m === undefined) unknown.push(p, i);
        else if (m !== null) hits.push(p, i);
      }
      report.tick(i + 1);
    }
  } catch (e) {
    if (e instanceof GaveUp) {
      e.index = i;
      e.ruleIndex = p;
      e.partial = { hits: hits, unknown: unknown, completed: i };
    }
    throw e;
  }
  return { status: "ok", result: { hits: hits, unknown: unknown } };
}

/* One replacement over many inputs; the outputs' total size is capped. */
function opReplaceEach(req) {
  var inputs = req.inputs;
  var outputs = [];
  var undetermined = [];
  var report = new Reporter(req.id, { outputs: outputs, undetermined: undetermined });
  var chars = 0;
  var replacements = 0;
  var i = 0;
  try {
    for (; i < inputs.length; i++) {
      var s = inputs[i];
      var one;
      if (s.length > req.maxItemChars) {
        if (!req.skip) throw new TooLarge("item");
        one = undefined;
      } else {
        try {
          one = opReplace({ pattern: req.pattern, flags: req.flags, input: s, replacement: req.replacement, maxOutputChars: req.maxOutputChars - chars }).result;
        } catch (e) {
          if (!(req.skip && e instanceof GaveUp)) throw e;
          one = undefined;
        }
      }
      if (one === undefined) {
        undetermined.push(i);
        outputs.push(null);
      } else {
        chars += one.output.length;
        replacements += one.replacements;
        outputs.push(one.output);
      }
      report.tick(i + 1, { replacements: replacements });
    }
  } catch (e) {
    if (e instanceof GaveUp) {
      e.index = i;
      e.partial = { outputs: outputs, replacements: replacements, undetermined: undetermined };
    }
    throw e;
  }
  return { status: "ok", result: { outputs: outputs, replacements: replacements, undetermined: undetermined } };
}

var ops = {
  test: opTest,
  matchAll: opMatchAll,
  replace: opReplace,
  split: opSplit,
  testEach: opTestEach,
  firstMatchingRule: opFirstMatchingRule,
  testMatrix: opTestMatrix,
  replaceEach: opReplaceEach
};

self.onmessage = function (ev) {
  var req = ev.data;
  giveUpMs = req.giveUpMs;
  progressEveryMs = req.progressEveryMs;
  var t0 = performance.now();
  var out;
  try {
    var op = ops[req.op];
    if (op === undefined) throw new Error("unknown op " + String(req.op));
    out = op(req);
  } catch (e) {
    if (e instanceof GaveUp) {
      out = { status: "gave-up", execMs: e.ms };
      if (e.index !== undefined) out.index = e.index;
      if (e.ruleIndex !== undefined) out.ruleIndex = e.ruleIndex;
      if (e.partial !== undefined) out.partial = e.partial;
    } else if (e instanceof TooLarge) {
      out = { status: e.what === "item" ? "item-too-large" : "output-too-large" };
    } else {
      out = { status: "error", code: "exec-threw", reason: String(e && e.message ? e.message : e) };
    }
  }
  out.kind = "done";
  out.id = req.id;
  out.elapsedMs = performance.now() - t0;
  postMessage(out);
};

postMessage({ kind: "ready" });
`;
