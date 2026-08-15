/* ============================================================
   Claude Watermark Self-Check — CLIENT-SIDE ONLY
   Per datacontract 3.2.1: text never leaves the browser.
   Heuristic only — NOT official, NOT guaranteed accurate.
   No "remove/bypass" logic (PRD NOT-DO / compliance banned words).
   ============================================================ */
(function () {
  "use strict";

  // Publicly-known heuristic signals for AI-text watermarking discussion.
  // These are transparent checks on the INPUT TEXT ONLY — no API, no upload.
  function analyze(text) {
    var signals = [];
    var score = 0;

    // Signal 1: uncommon spacing/punctuation patterns sometimes discussed
    // in watermark research (e.g. zero-width / unusual unicode).
    var zw = (text.match(/[\u200B-\u200D\uFEFF]/g) || []).length;
    if (zw > 0) { signals.push("contains zero-width / invisible unicode characters (" + zw + ")"); score += 0.4; }

    // Signal 2: very high lexical uniformity (low type-token ratio) — a
    // weak, transparent heuristic sometimes associated with synthetic text.
    var tokens = text.toLowerCase().match(/[a-z0-9']+/g) || [];
    if (tokens.length >= 40) {
      var types = new Set(tokens).size;
      var ttr = types / tokens.length;
      if (ttr < 0.35) { signals.push("low lexical diversity (type-token ratio " + ttr.toFixed(2) + ")"); score += 0.3; }
    }

    // Signal 3: repeating n-gram patterns.
    var reps = (text.match(/(\b\w+\b)(?:\s+\1\b)+/gi) || []).length;
    if (reps >= 3) { signals.push("repeated phrase patterns (" + reps + ")"); score += 0.2; }

    var confidence = Math.min(1, score);
    var verdict;
    if (signals.length === 0) {
      verdict = "not_detected";
    } else if (confidence >= 0.5) {
      verdict = "likely_marked";
    } else {
      verdict = "uncertain";
    }
    return { verdict: verdict, confidence: confidence, signals: signals };
  }

  function render(res) {
    var box = document.getElementById("result");
    var label = {
      likely_marked: "Possibly carries an invisible marker",
      not_detected: "No heuristic signals found",
      uncertain: "Inconclusive — weak signals only"
    }[res.verdict];
    var cls = { likely_marked: "likely", not_detected: "not", uncertain: "uncertain" }[res.verdict];
    var sig = res.signals.length
      ? "<ul>" + res.signals.map(function (s) { return "<li>" + s + "</li>"; }).join("") + "</ul>"
      : "<p>No transparent heuristic signals detected in this text.</p>";
    box.className = "result " + cls;
    box.innerHTML =
      "<strong>" + label + "</strong> (confidence " + res.confidence.toFixed(2) + ")" +
      sig +
      "<p class='disclaimer'>Heuristic, client-side check only. This is NOT an official Anthropic tool and does NOT guarantee detection accuracy. It cannot remove or bypass any watermark. Results are indicative, not conclusive.</p>";
  }

  function run() {
    var ta = document.getElementById("input");
    var box = document.getElementById("result");
    var text = ta.value;
    if (!text.trim()) {
      box.className = "result error";
      box.textContent = "EMPTY_TEXT: please paste some text to check.";
      return;
    }
    if (text.length > 20000) {
      box.className = "result error";
      box.textContent = "TOO_LONG: text exceeds 20000 character limit.";
      return;
    }
    try {
      render(analyze(text));
    } catch (e) {
      box.className = "result error";
      box.textContent = "COMPUTE_FAILED: local check failed, please retry.";
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("checkBtn");
    if (btn) btn.addEventListener("click", run);
  });
})();
