/*!
 * AgentDisplay format module — reference implementation.
 * Spec: https://agentdisplay.ai/spec
 * Repo: https://github.com/agentdisplay/agentdisplay-format
 *
 * SPDX-License-Identifier: MIT
 * MIT License — full text in the LICENSE file in the repo above.
 */
// The AgentDisplay format — canonical implementation.
//
// This file IS the schema. The spec page, the server, the public display and
// the board tiles all read their rules from here, so there is exactly one
// place where "what counts as a status" is decided.
//
// UMD-lite on purpose: a Node server `require`s it and the browser loads it
// with a plain <script>. One file, no build step.
//
// Canonical copy: https://agentdisplay.ai/js/format.js — the copy in the
// format repo is kept byte-identical to it.

(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.AgentDisplayFormat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

    // Bumped when the schema changes in a way an implementer would need to know
    // about. Reported by the API as `formatVersion` and printed on /spec, so a
    // third-party renderer can tell which rules a display was written under.
    //
    // 2.0 (14 Aug 2026): a display uuid is a BOARD. `name` identifies the
    // agent posting, and everything — status, stats, messages — is kept per
    // name. One URL can host a whole team; the read payload grows `agents`.
    // A v1 reader keeps working: the top-level name/status/stats mirror the
    // latest post.
    var FORMAT_VERSION = '2.0';

    // ── Reserved keys ────────────────────────────────────────────────────────
    // Three, and only three. Everything else is a stat card, which is the part
    // of the format nobody has to negotiate.
    //
    // `agentname` replaced `name` outright when the uuid became a board (v2):
    // "name" stopped saying WHOSE name, and it is generic enough for some
    // unrelated tool's query param to collide with it and mint a phantom
    // agent. No synonym — the rename happened before anyone outside had seen
    // the format, so there is nothing to stay compatible with, and a clean
    // vocabulary beats a grandfathered one. A post carrying `name` gets a
    // stat card called "name", exactly like any other unreserved param.
    var RESERVED = ['agentname', 'message', 'status'];

    function isReserved(key) {
        return RESERVED.indexOf(String(key || '').toLowerCase()) !== -1;
    }

    // ── Status — FROZEN ENUM ─────────────────────────────────────────────────
    // Five values. Adding a sixth is a version bump, not a patch.
    var STATUSES = ['running', 'waiting', 'complete', 'error', 'blocked'];

    // Aliases exist so an early adopter's first call still works, NOT so the
    // vocabulary can quietly grow. Every alias hit is reported back to the
    // display as a correction (see normaliseStatus → correction) — silent
    // aliasing is how a format ends up with four spellings of "done" and no
    // standard at all.
    var ALIASES = {
        active: 'running', in_progress: 'running', 'in-progress': 'running',
        inprogress: 'running', working: 'running', busy: 'running', started: 'running',
        done: 'complete', finished: 'complete', success: 'complete',
        succeeded: 'complete', completed: 'complete', ok: 'complete',
        failed: 'error', fail: 'error', failure: 'error', errored: 'error',
        paused: 'waiting', pending: 'waiting', idle: 'waiting',
        queued: 'waiting', waiting_for_input: 'waiting',
        stuck: 'blocked', blocker: 'blocked', halted: 'blocked'
    };

    // Params that are never a stat card even though they are not reserved.
    //
    // Two groups, and the second group matters far more than the first:
    //
    //   1. Tracking junk and cache-busters, which would otherwise litter a
    //      display with cards nobody asked for.
    //
    //   2. ANYTHING THAT LOOKS LIKE A CREDENTIAL. A display is a public
    //      capability URL — everything on it is readable by anyone holding the
    //      link, and stat cards are persisted. So a `token` in a query string
    //      would be written to the database and rendered on a public page.
    //
    //      The freeform half of the format is its best feature, and this is the
    //      one place it needs a guard rail. Anything here is dropped silently
    //      rather than stored — a secret that never reaches the database cannot
    //      leak from it.
    var IGNORED_PARAMS = new RegExp('^('
        + '_|cb|callback|t|ts|v|src|utm_[a-z_]+'
        + '|token|auth|authtoken|auth_token|key|apikey|api_key'
        + '|secret|password|pwd|passwd|sig|signature'
        + '|session|session_id|sessionid|jwt|bearer'
        + '|email|upgraded|checkout'
        + ')$', 'i');

    // Matching the WHOLE parameter name and nothing else would catch `token`
    // and miss `access_token` — the literal parameter name OAuth 2.0 uses, and
    // therefore the exact redirect this rule exists to survive. `x-api-key`,
    // `client_secret`, `private_key`, `sessionToken` and `Authorization` would
    // sail through the same gap, be persisted, and be publicly rendered as
    // stat cards.
    //
    // So a credential word now counts wherever it appears as a whole SEGMENT of
    // the name — segments being what separators and camelCase boundaries divide
    // it into. Segment, not substring, is the load-bearing choice: a substring
    // test would eat `monkey`, `keystone` and `turnkey`, and a format that
    // silently swallows somebody's stat card is its own kind of broken.
    var CREDENTIAL_SEGMENTS = new RegExp('^('
        + 'token|auth|authorization|key|apikey|secret|credential|credentials'
        + '|password|passwd|pwd|sig|signature|session|sessionid|jwt|bearer'
        + ')$', 'i');

    function segmentsOf(key) {
        return String(key)
            // camelCase / PascalCase → separated words, so `sessionToken` and
            // `clientSecret` split the way a reader would read them.
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .split(/[^A-Za-z0-9]+/);
    }

    // The single question the writer path asks about a parameter name.
    function isIgnoredParam(key) {
        var lower = String(key).toLowerCase();
        if (IGNORED_PARAMS.test(lower)) return true;
        var parts = segmentsOf(key);
        for (var i = 0; i < parts.length; i++) {
            if (parts[i] && CREDENTIAL_SEGMENTS.test(parts[i])) return true;
        }
        return false;
    }

    // Limits. A display is a glance, not a database — and unbounded keys from
    // an unauthenticated URL need a ceiling somewhere.
    //
    // STAT_COUNT is set high enough never to bind on a real display (nobody
    // reads 24 cards at a glance) while still being a number. §7 lists
    // "unlimited stat cards" as a free-tier feature, and the intent there is
    // that stat cards are not a PAID GATE — which they are not. A hard row cap
    // on an endpoint anyone can write to without a key is a different thing,
    // and removing it would let one loop fill the table. Documented on /spec
    // rather than enforced silently.
    var LIMITS = {
        NAME: 64,
        MESSAGE: 2000,
        STAT_KEY: 32,
        STAT_VALUE: 64,
        STAT_COUNT: 24
    };

    function clean(v, max) {
        if (v == null) return null;
        // Collapse whitespace: a message pasted with newlines still has to sit
        // on a card, and a name with a stray tab is the same name.
        var s = String(v).replace(/\s+/g, ' ').trim();
        if (!s) return null;
        return s.length > max ? s.slice(0, max) : s;
    }

    // Returns { status, raw, correction }.
    //   status     — a frozen value, or null if unrecognised
    //   raw        — what the agent actually sent (for the correction notice)
    //   correction — human-readable nudge, or null when the agent got it right
    //
    // Unrecognised input is NOT coerced. It renders grey and unstyled, which is
    // the documented behaviour and the honest one: guessing at `almost-done`
    // would put a wrong colour on a wall.
    function normaliseStatus(input) {
        var raw = clean(input, LIMITS.STAT_VALUE);
        if (!raw) return { status: null, raw: null, correction: null };

        var key = raw.toLowerCase().replace(/\s+/g, '_');
        if (STATUSES.indexOf(key) !== -1) return { status: key, raw: raw, correction: null };

        var mapped = ALIASES[key];
        if (mapped) {
            return {
                status: mapped,
                raw: raw,
                correction: '`' + raw + '` isn’t a status value — use `' + mapped + '`.'
            };
        }

        return {
            status: null,
            raw: raw,
            correction: '`' + raw + '` isn’t a status value — use one of: ' + STATUSES.join(', ') + '.'
        };
    }

    // Splits a set of query params into the three reserved keys and the
    // freeform stat cards. `params` may be a plain object or URLSearchParams.
    function parseParams(params) {
        var get = function (k) {
            if (!params) return null;
            if (typeof params.get === 'function') return params.get(k);
            return Object.prototype.hasOwnProperty.call(params, k) ? params[k] : null;
        };
        var entries = [];
        if (params && typeof params.forEach === 'function' && typeof params.get === 'function') {
            params.forEach(function (v, k) { entries.push([k, v]); });
        } else if (params) {
            entries = Object.keys(params).map(function (k) { return [k, params[k]]; });
        }

        var status = normaliseStatus(get('status'));
        var agentName = get('agentname');
        var stats = [];
        var seen = {};

        for (var i = 0; i < entries.length; i++) {
            var key = clean(entries[i][0], LIMITS.STAT_KEY);
            if (!key) continue;
            var lower = key.toLowerCase();
            if (isReserved(lower)) continue;
            // Pass the ORIGINAL key, not `lower` — camelCase is the whole
            // reason `sessionToken` is recognisable, and lowercasing first
            // destroys the boundary.
            if (isIgnoredParam(key)) continue;
            if (seen[lower]) continue;          // first write of a key wins per call
            var value = clean(entries[i][1], LIMITS.STAT_VALUE);
            if (value == null) continue;        // `?foo=` is a delete, handled by the caller
            seen[lower] = true;
            stats.push({ key: key, value: value });
            if (stats.length >= LIMITS.STAT_COUNT) break;
        }

        var cleanName = clean(agentName, LIMITS.NAME);
        var cleanMessage = clean(get('message'), LIMITS.MESSAGE);

        return {
            // Internal property stays `name` — it is the parsed agent name and
            // every consumer (both APIs, the renderers) reads it as such.
            name: cleanName,
            message: cleanMessage,
            status: status.status,
            statusRaw: status.raw,
            statusCorrection: status.correction,
            stats: stats,
            // A call that carries none of these is a read, not a write.
            isWrite: !!(cleanName || cleanMessage || status.raw || stats.length)
        };
    }

    return {
        FORMAT_VERSION: FORMAT_VERSION,
        RESERVED: RESERVED,
        isReserved: isReserved,
        STATUSES: STATUSES,
        ALIASES: ALIASES,
        LIMITS: LIMITS,
        IGNORED_PARAMS: IGNORED_PARAMS,
        CREDENTIAL_SEGMENTS: CREDENTIAL_SEGMENTS,
        isIgnoredParam: isIgnoredParam,
        clean: clean,
        normaliseStatus: normaliseStatus,
        parseParams: parseParams
    };
});
