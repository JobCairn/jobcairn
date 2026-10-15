/*
  JobCairn video kit: cue lookup, VO-paced reveals, push transitions, caption rail.
  Load after GSAP and before the composition script. Copy next to index.html.
  Adapted from HyperFrames (Apache-2.0): caption authoring rules (grouping, one
  group at a time, hard kill after exit), motion doctrine (power3 settle, one
  direction for ordinary seams), determinism rules (fromTo, no clocks, no random).

  Every function only adds tweens to the paused timeline you pass in.
  Nothing here reads time, randomness, the network or input state.
*/
(function () {
  function norm(t) {
    return String(t).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  }

  // Drop empty, music and filler tokens before timing or captions.
  function clean(words) {
    return (words || []).filter(function (w) {
      var t = String(w && w.text || "").trim();
      if (!t) return false;
      if (/^[♪-♯�]+$/.test(t)) return false;
      if (/^(uh|uhm|um|umm|erm)[.,]?$/i.test(t)) return false; // filler is not shown
      return true;
    });
  }

  // Start time of the first match of `phrase` at or after `after`.
  // Returns `fallback` when the words are missing or the phrase is not found.
  function cue(words, phrase, after, fallback) {
    var toks = String(phrase).split(/\s+/).map(norm).filter(Boolean);
    if (!toks.length || !words || !words.length) return fallback;
    for (var i = 0; i < words.length; i++) {
      if (words[i].start < (after || 0)) continue;
      var hit = true;
      for (var j = 0; j < toks.length; j++) {
        var w = words[i + j];
        if (!w || norm(w.text) !== toks[j]) { hit = false; break; }
      }
      if (hit) return Math.max(0, words[i].start - 0.1);
    }
    return fallback;
  }

  // Reduced motion (Settings > Videos > Motion): set on the root as data-motion="reduced". Reveals become short
  // fades, nothing pans, zooms or drifts. Read once from the page, never from the viewer's machine.
  var root = document.getElementById("root");
  var REDUCED = !!root && root.getAttribute("data-motion") === "reduced";

  // Default entrance: long-tail power3 settle. Pass `from` to vary direction.
  function reveal(tl, target, t, from, dur) {
    if (REDUCED) { fade(tl, target, t, 0.3); return; }
    var f = Object.assign({ opacity: 0, y: 28 }, from || {});
    tl.fromTo(target, f, { opacity: 1, x: 0, y: 0, scale: 1, duration: dur || 0.6, ease: "power3.out" }, t);
  }

  // Opacity only: for labels, arrowheads and anything that should arrive without moving.
  function fade(tl, target, t, dur) {
    tl.fromTo(target, { opacity: 0 }, { opacity: 1, duration: dur || 0.3, ease: "power2.out" }, t);
  }

  // Grow a line or bar from its transform-origin. Element must be block-level and sized.
  function draw(tl, target, t, dur) {
    if (REDUCED) { tl.fromTo(target, { scaleX: 1, opacity: 0 }, { scaleX: 1, opacity: 1, duration: 0.3, ease: "power2.out" }, t); return; }
    tl.fromTo(target, { scaleX: 0 }, { scaleX: 1, duration: dur || 0.5, ease: "power3.inOut" }, t);
  }

  // Draw an SVG stroke that has pathLength="1" and stroke-dasharray="1" (an edge, a tick).
  function drawPath(tl, target, t, dur) {
    if (REDUCED) { tl.fromTo(target, { opacity: 0, attr: { "stroke-dashoffset": 0 } }, { opacity: 1, duration: 0.3 }, t); return; }
    tl.fromTo(target, { attr: { "stroke-dashoffset": 1 } }, { attr: { "stroke-dashoffset": 0 }, duration: dur || 0.5, ease: "power3.inOut" }, t);
  }

  // An icon draws its own strokes, one after another (total under 0.5s).
  function drawIcon(tl, target, t) {
    var parts = document.querySelectorAll(target + " > *");
    if (!parts.length) return;
    var gap = Math.min(0.08, 0.35 / parts.length);
    Array.prototype.forEach.call(parts, function (el, k) {
      tl.fromTo(el, { attr: { "stroke-dashoffset": 1 } }, { attr: { "stroke-dashoffset": 0 }, duration: 0.6, ease: "power2.inOut" }, t + k * gap);
    });
  }

  // Words land one after another (a quote, a kinetic line). Total stagger is kept short.
  function words(tl, target, t, gap) {
    var list = document.querySelectorAll(target);
    Array.prototype.forEach.call(list, function (el, k) {
      if (REDUCED) tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.25 }, t + k * Math.min(gap, 0.04));
      else tl.fromTo(el, { opacity: 0, y: 48 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, t + k * gap);
    });
  }

  // Slow push-in on a picture across its scene (Ken Burns). Linear, one direction, finite.
  function kenBurns(tl, target, t0, t1) {
    if (REDUCED || !(t1 > t0)) return;
    tl.fromTo(target, { scale: 1, x: 0 }, { scale: 1.08, x: -14, duration: t1 - t0, ease: "none" }, t0);
  }

  // The background grid drifts a little over the whole video: one transform-only tween, linear, finite.
  function drift(tl, target, end) {
    if (REDUCED || !(end > 0)) return;
    tl.fromTo(target, { x: 0, y: 0 }, { x: -120, y: -60, duration: end, ease: "none" }, 0);
  }

  // Scene seam. Both stages move together on one axis, same ease, same duration.
  // dir "left" is the film's current (next point). "up" is reserved for the conclusion.
  function seam(tl, outStage, inStage, t, dir, dur) {
    var d = dur || 0.6;
    if (REDUCED) {
      if (outStage) tl.to(outStage, { opacity: 0, duration: 0.3, ease: "power2.in" }, t);
      if (inStage) tl.fromTo(inStage, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power2.out" }, t + 0.2);
      return;
    }
    var p = dir === "up" ? "yPercent" : "xPercent";
    var o = {}; o[p] = -100; o.duration = d; o.ease = "power3.inOut";
    var a = {}; a[p] = 100;
    var b = {}; b[p] = 0; b.duration = d; b.ease = "power3.inOut";
    if (outStage) tl.to(outStage, o, t);
    if (inStage) tl.fromTo(inStage, a, b, t);
  }

  function groupWords(words, maxWords, maxChars, gap) {
    var out = [], cur = [], chars = 0;
    function flush() { if (cur.length) out.push(cur); cur = []; chars = 0; }
    words.forEach(function (w) {
      var text = String(w.text).trim();
      if (cur.length) {
        var prev = cur[cur.length - 1];
        if (w.start - prev.end > gap || cur.length >= maxWords || chars + text.length + 1 > maxChars) flush();
      }
      cur.push({ text: text, start: w.start, end: w.end });
      chars += text.length + 1;
      if (/[.!?]["')]?$/.test(text)) flush();
      else if (/[,;:]$/.test(text) && cur.length >= 3) flush();
    });
    flush();
    return out;
  }

  // Caption rail: 3-5 word groups, one visible at a time, active word in accent.
  function captions(tl, words, opts) {
    opts = opts || {};
    var host = document.getElementById(opts.hostId || "captions");
    var list = clean(words);
    if (!host || !list.length) return 0;
    var ink = opts.ink || "#eef1f3", accent = opts.accent || "#f2b441";
    var groups = groupWords(list, opts.maxWords || 5, opts.maxChars || 42, opts.gap || 0.35);
    groups.forEach(function (g, gi) {
      var el = document.createElement("div");
      el.className = "cg";
      el.id = "cg-" + gi;
      g.forEach(function (w, wi) {
        var s = document.createElement("span");
        s.className = "cw";
        s.id = "cg-" + gi + "-" + wi;
        s.textContent = w.text;
        el.appendChild(s);
        if (wi < g.length - 1) el.appendChild(document.createTextNode(" "));
      });
      host.appendChild(el);
      var start = g[0].start;
      var next = groups[gi + 1] ? groups[gi + 1][0].start : Infinity;
      var end = Math.min(g[g.length - 1].end + 0.4, next - 0.04, opts.until || Infinity);
      tl.fromTo(el, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.16, ease: "power2.out" }, start);
      if (opts.karaoke !== false) {
        Array.prototype.forEach.call(el.querySelectorAll(".cw"), function (s, wi) {
          var w = g[wi];
          tl.fromTo(s, { color: ink }, { color: accent, duration: 0.06, immediateRender: false }, w.start);
          tl.fromTo(s, { color: accent }, { color: ink, duration: 0.1, immediateRender: false }, Math.max(w.start + 0.06, w.end));
        });
      }
      var out = Math.max(start + 0.17, end - 0.12);
      tl.to(el, { opacity: 0, duration: 0.12, ease: "power2.in" }, out);
      tl.set(el, { visibility: "hidden" }, out + 0.12); // hard kill: never two groups at once
    });
    return groups.length;
  }

  // Count-up as baked frames (one set per frame, eased power3.out). Seek-safe: no onUpdate.
  function count(tl, target, from, to, t, dur, o) {
    o = o || {};
    if (REDUCED) { tl.set(target, { textContent: (o.prefix || "") + Number(to).toFixed(o.decimals || 0) + (o.suffix || "") }, t); return; }
    var fps = 30, n = Math.max(1, Math.round((dur || 1.4) * fps)), dec = o.decimals || 0;
    for (var k = 0; k <= n; k++) {
      var p = k / n, e = 1 - Math.pow(1 - p, 3);
      var v = (from + (to - from) * e).toFixed(dec);
      tl.set(target, { textContent: (o.prefix || "") + v + (o.suffix || "") }, t + k / fps);
    }
  }

  // Scene start times straight from the clip attributes, so timing lives in one place.
  function starts(ids) {
    var o = {};
    ids.forEach(function (id) {
      var el = document.getElementById(id);
      o[id] = el ? parseFloat(el.getAttribute("data-start")) || 0 : 0;
    });
    return o;
  }

  window.CareerKit = {
    clean: clean, cue: cue, reveal: reveal, fade: fade, draw: draw, drawPath: drawPath, drawIcon: drawIcon, words: words,
    kenBurns: kenBurns, drift: drift, seam: seam, captions: captions, count: count, starts: starts, reduced: REDUCED,
  };
})();
