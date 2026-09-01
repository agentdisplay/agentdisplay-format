/*!
 * AgentDisplay renderer — reference implementation.
 * Spec: https://agentdisplay.ai/spec
 * Repo: https://github.com/agentdisplay/agentdisplay-format
 *
 * SPDX-License-Identifier: MIT
 * MIT License — full text in the LICENSE file in the repo above.
 */
// The AgentDisplay renderer — canonical implementation.
//
// ONE renderer, two modes:
//   renderDisplay()  the full page at agentdisplay.ai/{uuid}
//   renderTile()     a tile on a board grid
//
// They share this file deliberately. A wall of twelve agents and a single
// public display have to agree on what `blocked` looks like, and the freeform
// stat-card behaviour has to behave identically in both or the format quietly
// forks. Styling lives in css/display.css — this file emits class names only.
//
// Canonical copy: https://agentdisplay.ai/js/render.js — the copy in the
// format repo is kept byte-identical to it.

(function (root, factory) {
    var fmt = (typeof module === 'object' && module.exports)
        ? require('./format.js')
        : root.AgentDisplayFormat;
    var api = factory(fmt);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.AgentDisplayRender = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (FORMAT) {

    // ── Status treatments ────────────────────────────────────────────────────
    // Colour AND shape, because §6's real test is a thumbnail: at 40px the hue
    // may be all a reader gets, but colour alone fails for ~8% of them and
    // fails again in a greyscale screenshot. Every status carries a glyph.
    //
    // Hues are spread as far apart as five can be while staying readable on the
    // near-black surface: cyan / amber / green / red / violet.
    var STATUS_META = {
        running:  { label: 'Running',  color: '#4fc3f7', glyph: 'play',  live: true },
        waiting:  { label: 'Waiting',  color: '#f59e0b', glyph: 'clock', live: false },
        complete: { label: 'Complete', color: '#4ade80', glyph: 'check', live: false },
        error:    { label: 'Error',    color: '#ef4444', glyph: 'cross', live: false },
        blocked:  { label: 'Blocked',  color: '#c084fc', glyph: 'bar',   live: false }
    };

    // Anything the format didn't recognise renders here: grey and unstyled, as
    // documented. The display still works — it just doesn't reward the guess.
    var UNKNOWN_META = { label: 'Unknown', color: '#5a5e6a', glyph: 'dot', live: false };

    var GLYPHS = {
        play:  '<path d="M5 3.5v9l7.5-4.5z"/>',
        clock: '<path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zm0 2.2a.8.8 0 01.8.8V8l2.4 1.4a.8.8 0 11-.8 1.4L7.6 9.2A.8.8 0 017.2 8.5V4.5a.8.8 0 01.8-.8z"/>',
        check: '<path d="M13.6 4.2a1 1 0 010 1.4l-6 6a1 1 0 01-1.4 0L2.9 8.3a1 1 0 011.4-1.4l2.6 2.6 5.3-5.3a1 1 0 011.4 0z"/>',
        cross: '<path d="M4.1 4.1a1 1 0 011.4 0L8 6.6l2.5-2.5a1 1 0 111.4 1.4L9.4 8l2.5 2.5a1 1 0 11-1.4 1.4L8 9.4l-2.5 2.5a1 1 0 11-1.4-1.4L6.6 8 4.1 5.5a1 1 0 010-1.4z"/>',
        bar:   '<path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM4.6 7.1h6.8a.9.9 0 010 1.8H4.6a.9.9 0 010-1.8z"/>',
        dot:   '<circle cx="8" cy="8" r="3.4"/>'
    };

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function metaFor(status) {
        return (status && STATUS_META[status]) || UNKNOWN_META;
    }

    function statusIcon(status, size) {
        var m = metaFor(status);
        var px = size || 16;
        return '<svg class="ad-icon" viewBox="0 0 16 16" width="' + px + '" height="' + px
            + '" aria-hidden="true" focusable="false" fill="currentColor">' + GLYPHS[m.glyph] + '</svg>';
    }

    // The pill is the single most-screenshotted element on the site. It gets
    // the icon, the word, and a colour — all three, at a size that survives
    // being posted into a Discord thread at half scale.
    function statusPill(status, opts) {
        var m = metaFor(status);
        var cls = 'ad-status ad-status--' + (status && STATUS_META[status] ? status : 'unknown');
        if (opts && opts.compact) cls += ' ad-status--compact';
        return '<span class="' + cls + '" role="status">'
            + statusIcon(status, opts && opts.compact ? 12 : 16)
            + '<span class="ad-status-label">' + esc(m.label) + '</span>'
            + '</span>';
    }

    function timeAgo(value) {
        var d = value instanceof Date ? value : new Date(value);
        if (isNaN(d.getTime())) return '';
        var diff = Math.floor((Date.now() - d.getTime()) / 1000);
        if (diff < 0) diff = 0;
        if (diff < 10) return 'just now';
        if (diff < 60) return diff + 's ago';
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
        var days = Math.floor(diff / 86400);
        return days + (days === 1 ? ' day ago' : ' days ago');
    }

    function formatTimestamp(value) {
        var d = value instanceof Date ? value : new Date(value);
        if (isNaN(d.getTime())) return '';
        var time = d.toTimeString().slice(0, 5);
        var date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        return date + ' · ' + time;
    }

    // Right-align a stat value only when it is actually a number — "42" in a
    // column reads as data, "shipping to prod" reads as a label and should sit
    // left. Cheap test, big difference on a grid.
    function isNumeric(v) {
        return /^[-+]?[$€£]?\s?\d[\d,]*(\.\d+)?\s?%?$/.test(String(v).trim());
    }

    function statCard(stat) {
        var numeric = isNumeric(stat.value);
        // Stats are global state — the last value an agent sent for that key,
        // carried forward until it sends another. That makes staleness
        // invisible by default, so each card carries when it was last
        // reported. Cheap honesty: no pixels, available on hover.
        var age = stat.updatedAt
            ? ' title="' + esc(stat.key) + ' last reported ' + esc(timeAgo(stat.updatedAt)) + '"'
            : '';
        return '<div class="ad-stat' + (numeric ? ' ad-stat--num' : '') + '"' + age + '>'
            + '<div class="ad-stat-key">' + esc(stat.key) + '</div>'
            + '<div class="ad-stat-value">' + esc(stat.value) + '</div>'
            + '</div>';
    }

    function statsBlock(stats, limit) {
        if (!stats || !stats.length) return '';
        var list = limit ? stats.slice(0, limit) : stats;
        return '<div class="ad-stats">' + list.map(statCard).join('') + '</div>';
    }

    // The correction notice. Quiet, not an error state — the display works, the
    // agent just used a word that isn't in the spec. This is the whole reason
    // aliases are allowed at all: it teaches the five words instead of letting
    // `done` and `finished` propagate until nobody knows which one is real.
    function correctionNotice(correction) {
        if (!correction) return '';
        // The correction arrives with `backticks` around the offending token —
        // turn those into <code> after escaping, so the token stands out
        // without the notice becoming an HTML hole.
        var html = esc(correction).replace(/`([^`]+)`/g, '<code>$1</code>');
        return '<div class="ad-correction">'
            + '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="currentColor">'
            + '<path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 4a.9.9 0 01.9.9v3.4a.9.9 0 01-1.8 0V4.9A.9.9 0 018 4zm0 6.2a1 1 0 110 2 1 1 0 010-2z"/></svg>'
            + '<span>' + html + '</span>'
            + '<a class="ad-correction-link" href="/spec">spec</a>'
            + '</div>';
    }

    // `number` is the message's position in the display's history, newest
    // highest. It is the one piece of metadata that is always meaningful — it
    // says how much this agent has had to say, which is exactly what someone
    // glancing at a display wants to know and what an arbitrary stat card
    // cannot tell them.
    // `currentStatus` is passed for the NEWEST message only. It gives that card
    // the status colour and its rail — the latest message IS the current state,
    // so colouring it says what a separate status pill used to, in the place a
    // reader is already looking.
    //
    // The word still appears alongside it. Colour carries the signal at a
    // glance; the word is what keeps that signal legible to a reader who cannot
    // separate red from green, or who is looking at a greyscale screenshot.
    // Spec §7 requires both, and dropping the pill must not quietly drop that.
    function messageCard(msg, isHistory, number, currentStatus) {
        var statusTag = '';
        if (currentStatus) {
            var meta = metaFor(currentStatus);
            statusTag = '<span class="ad-msg-status">' + statusIcon(currentStatus, 11)
                + esc(meta.label.toLowerCase()) + '</span>';
        }
        return '<article class="ad-msg'
            + (isHistory ? ' ad-msg--history' : '')
            + (currentStatus ? ' ad-msg--current' : '') + '">'
            + '<div class="ad-msg-meta">'
            + (number ? '<span class="ad-msg-num">#' + number + '</span>' : '')
            + '<time datetime="' + esc(new Date(msg.timestamp).toISOString()) + '">'
            + esc(formatTimestamp(msg.timestamp)) + '</time>'
            + '<span class="ad-msg-ago" data-ts="' + esc(msg.timestamp) + '">'
            + esc(timeAgo(msg.timestamp)) + '</span>'
            + statusTag
            + '</div>'
            + '<p class="ad-msg-body">' + esc(msg.message) + '</p>'
            + '</article>';
    }

    // "14 messages · updated 39m ago" — how much this agent has said, and how
    // long since it last said anything.
    //
    // Split out because it does not always belong on the card: the display page
    // renders it in the top bar beside the agent's name, where it reads as part
    // of the display's identity rather than as another line of content above
    // the feed. Same builder either way, so the two cannot drift.
    function metaLine(data) {
        data = data || {};
        var messages = data.messages || [];
        var total = typeof data.messageCount === 'number' ? data.messageCount : messages.length;
        var parts = [];
        if (total) parts.push(total === 1 ? '1 message' : total + ' messages');
        if (data.lastUpdate) {
            parts.push('updated <span class="ad-msg-ago" data-ts="' + esc(data.lastUpdate) + '">'
                + esc(timeAgo(data.lastUpdate)) + '</span>');
        }
        return parts.join(' &middot; ');
    }

    // ── Full display ─────────────────────────────────────────────────────────
    // Order is deliberate: status first (the thing you came to check), then the
    // numbers, then the words. A screenshot cropped to the top third is still
    // a useful screenshot.
    function renderDisplay(data, opts) {
        data = data || {};
        opts = opts || {};
        var messages = data.messages || [];
        var name = data.name || 'Agent';
        var m = metaFor(data.status);

        // The true total, when the server reports it — the feed is capped, so
        // counting the loaded array would under-report a busy display.
        var total = typeof data.messageCount === 'number' ? data.messageCount : messages.length;

        // Stats sit under the status pill, inside the header, right-aligned.
        // They used to be a full-width row of their own below the card, which
        // read as the headline of the display — and a headline is exactly what
        // an arbitrary agent-chosen number must not be. Tucked beside the
        // status they read as what they are: supporting figures.
        // opts.hideName — the display page carries the agent's name in its top
        // bar, where identity belongs. The name does not change; giving it the
        // largest type on the page spent the loudest element on the least
        // surprising fact, and pushed the status (the thing someone came to
        // read) into second place. The landing page still shows it on the card,
        // because there the bar is the site's own brand.
        // No header card any more. It was a full-width panel whose only jobs
        // were holding the status pill and the stats — and the status now
        // travels with the newest message, where it means more. What is left
        // is a bare row: the name (when shown) and the stats, right-aligned.
        var meta = opts.hideMeta ? '' : metaLine(data);

        var head = '<div class="ad-head">'
            + (opts.hideName ? '' : '<h1 class="ad-name">' + esc(name) + '</h1>')
            + statsBlock(data.stats)
            + '</div>'
            + (meta ? '<div class="ad-updated">' + meta + '</div>' : '');

        var body = correctionNotice(data.statusCorrection);

        var feed;
        if (!messages.length) {
            feed = '<div class="ad-empty">'
                + '<div class="ad-empty-dot" aria-hidden="true"></div>'
                + '<p>' + esc(opts.emptyText || 'Waiting for the first message…') + '</p>'
                + '</div>';
        } else {
            // Newest first, so it carries the highest number — and the status.
            feed = '<div class="ad-feed">'
                + messages.map(function (msg, i) {
                    return messageCard(msg, i > 0, total - i, i === 0 ? data.status : null);
                }).join('')
                + '</div>';
        }

        return '<div class="ad-display" data-status="' + esc(data.status || 'unknown') + '">'
            + head + body + feed + '</div>';
    }

    // ── Tile ─────────────────────────────────────────────────────────────────
    // A grid tile has a different job (§9): on a wall with twelve agents up
    // nobody reads paragraphs — they take in all of them at once. Name, status, and at
    // most two stats — the rest lives behind expand.
    //
    // `pinned` is a list of stat keys the board owner chose for the face;
    // without it the first two win, which is the only sane default for a
    // freeform key space.
    function renderTile(data, opts) {
        data = data || {};
        opts = opts || {};

        // A payload carrying a roster is a BOARD — a cluster of agents behind
        // one uuid — and rendering it as its latest agent tells a wall that a
        // three-agent team is one healthy bot. Any consumer handing whole
        // /data payloads to renderTile (an overview page, a board widget)
        // gets the cluster face automatically; callers slicing out a single
        // agent (the display page's own board) pass no roster and are
        // untouched.
        if ((data.agents || []).length > 1 && !opts.singleAgent) {
            return renderClusterTile(data, opts);
        }

        var stats = data.stats || [];
        var messages = data.messages || [];

        var pinned = opts.pinned && opts.pinned.length
            ? opts.pinned.map(function (k) {
                for (var i = 0; i < stats.length; i++) {
                    if (stats[i].key.toLowerCase() === String(k).toLowerCase()) return stats[i];
                }
                return null;
            }).filter(Boolean)
            : stats;

        var face = pinned.slice(0, 2);
        var latest = messages[0] || null;
        var hasDetail = stats.length > face.length || messages.length > 1;

        // An agent that said `running` an hour ago and has been silent since is
        // not the same as an agent that is running. Say so on the tile — but as
        // a note about the silence, not as a status, because the format has no
        // value for "probably dead" and inventing one would be a lie.
        var quiet = '';
        if (data.lastUpdate && data.status === 'running') {
            var idleMin = (Date.now() - new Date(data.lastUpdate).getTime()) / 60000;
            var threshold = opts.quietAfterMinutes || 15;
            if (idleMin > threshold) {
                quiet = '<span class="ad-tile-stale">quiet for '
                    + esc(timeAgo(data.lastUpdate).replace(/ ago$/, '')) + '</span>';
            }
        }

        return '<div class="ad-tile" data-status="' + esc(data.status || 'unknown') + '">'
            + '<div class="ad-tile-head">'
            + '<span class="ad-tile-name">' + esc(data.name || 'Agent') + '</span>'
            + statusPill(data.status, { compact: true })
            + '</div>'
            + (face.length ? '<div class="ad-tile-stats">' + face.map(statCard).join('') + '</div>' : '')
            + (opts.showLatest !== false && latest
                ? '<p class="ad-tile-msg">' + esc(latest.message) + '</p>' : '')
            + (hasDetail ? '<div class="ad-tile-detail">'
                + (stats.length ? statsBlock(stats) : '')
                + messages.slice(0, 6).map(function (msg, i) { return messageCard(msg, i > 0); }).join('')
                + '</div>' : '')
            + '<div class="ad-tile-foot">'
            + (quiet || (data.lastUpdate
                ? '<span class="ad-msg-ago" data-ts="' + esc(data.lastUpdate) + '">'
                    + esc(timeAgo(data.lastUpdate)) + '</span>'
                : '<span></span>'))
            + (hasDetail ? '<button type="button" class="ad-tile-toggle" data-ad-toggle'
                + ' aria-expanded="false" aria-label="Show messages and remaining stats">'
                + (stats.length > face.length ? '+' + (stats.length - face.length) + ' ' : '')
                + '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" fill="currentColor">'
                + '<path d="M3.3 5.8a1 1 0 011.4 0L8 9.1l3.3-3.3a1 1 0 111.4 1.4l-4 4a1 1 0 01-1.4 0l-4-4a1 1 0 010-1.4z"/>'
                + '</svg></button>' : '')
            + '</div>'
            + '</div>';
    }

    // ── Cluster tile ─────────────────────────────────────────────────────────
    // One display, many agents: the tile face is the ROSTER — each agent's
    // name and status word on its own row — under a headline pill carrying the
    // board's WORST status (spec §7: a board summarised by its happiest agent
    // hides the one thing worth knowing).
    var STATUS_RANK = ['error', 'blocked', 'waiting', 'running', 'complete'];

    function worstStatus(agents) {
        for (var r = 0; r < STATUS_RANK.length; r++) {
            for (var i = 0; i < agents.length; i++) {
                if (agents[i].status === STATUS_RANK[r]) return STATUS_RANK[r];
            }
        }
        return null;
    }

    function renderClusterTile(data, opts) {
        var agents = data.agents || [];
        var messages = data.messages || [];
        var worst = worstStatus(agents);
        var shown = agents.slice(0, 6);
        var overflow = agents.length - shown.length;
        var hasDetail = messages.length > 0;

        var rows = shown.map(function (a) {
            var m = metaFor(a.status);
            if (a.redacted && !a.name) {
                return '<div class="ad-cluster-row ad-cluster-row--locked">'
                    + '<span class="ad-cluster-lock" aria-hidden="true">&#128274;</span>'
                    + '<span class="ad-cluster-name">Locked</span></div>';
            }
            return '<div class="ad-cluster-row" data-status="' + esc(a.status || 'unknown') + '">'
                + (a.redacted
                    ? '<span class="ad-cluster-lock" aria-hidden="true">&#128274;</span>'
                    : '<span class="ad-cluster-dot" style="background:' + m.color + '" aria-hidden="true"></span>')
                + '<span class="ad-cluster-name">' + esc(a.name || 'Unnamed') + '</span>'
                + '<span class="ad-cluster-status" style="color:' + (a.redacted ? 'inherit' : m.color) + '">'
                + (a.redacted ? 'locked' : esc(a.status || (a.statusRaw ? a.statusRaw : '—')))
                + '</span>'
                + '</div>';
        }).join('');

        return '<div class="ad-tile ad-tile--cluster" data-status="' + esc(worst || 'unknown') + '">'
            + '<div class="ad-tile-head">'
            + '<span class="ad-tile-name">' + agents.length + ' agents</span>'
            + statusPill(worst, { compact: true })
            + '</div>'
            + '<div class="ad-cluster-list">' + rows
            + (overflow > 0 ? '<div class="ad-cluster-more">+' + overflow + ' more</div>' : '')
            + '</div>'
            + (hasDetail ? '<div class="ad-tile-detail">'
                + messages.slice(0, 6).map(function (msg, i) { return messageCard(msg, i > 0); }).join('')
                + '</div>' : '')
            + '<div class="ad-tile-foot">'
            + (data.lastUpdate
                ? '<span class="ad-msg-ago" data-ts="' + esc(data.lastUpdate) + '">'
                    + esc(timeAgo(data.lastUpdate)) + '</span>'
                : '<span></span>')
            + (hasDetail ? '<button type="button" class="ad-tile-toggle" data-ad-toggle'
                + ' aria-expanded="false" aria-label="Show the message feed">'
                + '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" fill="currentColor">'
                + '<path d="M3.3 5.8a1 1 0 011.4 0L8 9.1l3.3-3.3a1 1 0 111.4 1.4l-4 4a1 1 0 01-1.4 0l-4-4a1 1 0 010-1.4z"/>'
                + '</svg></button>' : '')
            + '</div>'
            + '</div>';
    }

    // Keeps every "3m ago" on the page honest without a re-render. Call once;
    // returns a stop function.
    function startAgoTicker(rootEl, intervalMs) {
        var host = rootEl || (typeof document !== 'undefined' ? document : null);
        if (!host || !host.querySelectorAll) return function () {};
        var tick = function () {
            var nodes = host.querySelectorAll('.ad-msg-ago[data-ts]');
            for (var i = 0; i < nodes.length; i++) {
                nodes[i].textContent = timeAgo(nodes[i].getAttribute('data-ts'));
            }
        };
        tick();
        var id = setInterval(tick, intervalMs || 30000);
        return function () { clearInterval(id); };
    }

    return {
        FORMAT: FORMAT,
        STATUS_META: STATUS_META,
        UNKNOWN_META: UNKNOWN_META,
        esc: esc,
        metaFor: metaFor,
        statusIcon: statusIcon,
        statusPill: statusPill,
        statCard: statCard,
        statsBlock: statsBlock,
        correctionNotice: correctionNotice,
        messageCard: messageCard,
        metaLine: metaLine,
        timeAgo: timeAgo,
        formatTimestamp: formatTimestamp,
        worstStatus: worstStatus,
        renderDisplay: renderDisplay,
        renderTile: renderTile,
        renderClusterTile: renderClusterTile,
        startAgoTicker: startAgoTicker
    };
});
