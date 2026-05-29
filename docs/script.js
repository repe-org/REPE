/* ============================================================
   REPE site — interactive header byte map, nav, reveals
   ============================================================ */
(function () {
  "use strict";

  // Header field definitions (must total 32 bytes, in spec order).
  var FIELDS = [
    { name: "spec",         type: "uint16_t", offset: 0,  size: 2, cls: "f-spec",         note: "0x1507 magic" },
    { name: "version",      type: "uint8_t",  offset: 2,  size: 1, cls: "f-version",      note: "protocol version (2)" },
    { name: "flags",        type: "uint8_t",  offset: 3,  size: 1, cls: "f-flags",        note: "bit 0: notify" },
    { name: "ec",           type: "uint32_t", offset: 4,  size: 4, cls: "f-ec",           note: "error code" },
    { name: "id",           type: "uint64_t", offset: 8,  size: 8, cls: "f-id",           note: "request identifier" },
    { name: "body_length",  type: "uint64_t", offset: 16, size: 8, cls: "f-body_length",  note: "length of body" },
    { name: "query_length", type: "uint32_t", offset: 24, size: 4, cls: "f-query_length", note: "length of query" },
    { name: "query_format", type: "uint16_t", offset: 28, size: 2, cls: "f-query_format", note: "query format code" },
    { name: "body_format",  type: "uint16_t", offset: 30, size: 2, cls: "f-body_format",  note: "body format code" }
  ];

  // Map each byte offset (0..31) to its owning field.
  var byteOwner = [];
  FIELDS.forEach(function (f) {
    for (var i = 0; i < f.size; i++) byteOwner[f.offset + i] = f;
  });

  function swatchColor(cls) {
    // Pull the computed background of a field color by creating a probe element.
    var probe = document.createElement("span");
    probe.className = cls;
    probe.style.display = "none";
    document.body.appendChild(probe);
    var color = getComputedStyle(probe).backgroundColor;
    document.body.removeChild(probe);
    return color;
  }

  // ---- Build byte map -------------------------------------------------
  var bytemap = document.querySelector(".bytemap");
  if (bytemap) {
    for (var b = 0; b < 32; b++) {
      var owner = byteOwner[b];
      var cell = document.createElement("div");
      cell.className = "byte " + (owner ? owner.cls : "");
      cell.setAttribute("role", "listitem");
      if (owner) {
        cell.dataset.field = owner.name;
        cell.title = owner.name + " (" + owner.type + ")";
      }
      var off = document.createElement("span");
      off.className = "byte__off";
      off.textContent = b;
      cell.appendChild(off);
      bytemap.appendChild(cell);
    }
  }

  // ---- Build field table ----------------------------------------------
  var rows = document.getElementById("field-rows");
  if (rows) {
    FIELDS.forEach(function (f) {
      var tr = document.createElement("tr");
      tr.dataset.field = f.name;
      var range = f.size === 1 ? String(f.offset) : f.offset + "–" + (f.offset + f.size - 1);
      tr.innerHTML =
        '<td><span class="swatch ' + f.cls + '"></span>' + f.name + "</td>" +
        '<td><span class="ftype">' + f.type + "</span></td>" +
        "<td>" + range + "</td>" +
        "<td>" + f.size + "</td>";
      rows.appendChild(tr);
    });
    // Color the swatches from their field classes.
    rows.querySelectorAll(".swatch").forEach(function (s) {
      s.style.background = swatchColor(s.className.replace("swatch ", ""));
    });
  }

  // ---- Highlight linking ----------------------------------------------
  var allBytes = bytemap ? Array.prototype.slice.call(bytemap.querySelectorAll(".byte")) : [];
  var allRows = rows ? Array.prototype.slice.call(rows.querySelectorAll("tr")) : [];

  function highlight(name) {
    allBytes.forEach(function (c) {
      var match = c.dataset.field === name;
      c.classList.toggle("is-active", match);
      c.classList.toggle("is-dim", name != null && !match);
    });
    allRows.forEach(function (r) {
      r.classList.toggle("is-active", r.dataset.field === name);
    });
  }
  function clearHighlight() {
    allBytes.forEach(function (c) { c.classList.remove("is-active", "is-dim"); });
    allRows.forEach(function (r) { r.classList.remove("is-active"); });
  }

  function bind(el) {
    var name = el.dataset.field;
    if (!name) return;
    el.addEventListener("mouseenter", function () { highlight(name); });
    el.addEventListener("mouseleave", clearHighlight);
    el.addEventListener("focus", function () { highlight(name); });
    el.addEventListener("blur", clearHighlight);
    // Tap-to-toggle on touch devices.
    el.addEventListener("click", function () {
      var active = el.classList.contains("is-active");
      clearHighlight();
      if (!active) highlight(name);
    });
  }
  allBytes.forEach(bind);
  allRows.forEach(bind);

  // ---- Mobile nav -----------------------------------------------------
  var toggle = document.querySelector(".nav__toggle");
  var links = document.querySelector(".nav__links");
  if (toggle && links) {
    toggle.addEventListener("click", function () {
      var open = links.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    links.addEventListener("click", function (e) {
      if (e.target.tagName === "A") {
        links.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  // ---- Copy-to-clipboard ---------------------------------------------
  document.querySelectorAll(".copy").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy") || "";
      var done = function () {
        var original = btn.textContent;
        btn.textContent = "✓";
        btn.classList.add("is-copied");
        setTimeout(function () {
          btn.textContent = original;
          btn.classList.remove("is-copied");
        }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () {});
      }
    });
  });

  // ---- Hero header language toggle (C++ / Rust) ----------------------
  var codecard = document.querySelector(".hero__visual .codecard");
  if (codecard) {
    var codetabs = Array.prototype.slice.call(codecard.querySelectorAll(".codetab"));
    var panels = Array.prototype.slice.call(codecard.querySelectorAll(".codecard__code"));
    codetabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        var lang = tab.dataset.lang;
        codetabs.forEach(function (t) {
          t.setAttribute("aria-pressed", t === tab ? "true" : "false");
        });
        panels.forEach(function (p) {
          p.hidden = p.dataset.lang !== lang;
        });
      });
    });
  }

  // ---- Scroll reveal --------------------------------------------------
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var revealTargets = document.querySelectorAll(".card, .panel, .impl-card, .header-explorer, .layout, .section__head");
  if (!reduceMotion && "IntersectionObserver" in window) {
    revealTargets.forEach(function (el) { el.classList.add("reveal"); });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    revealTargets.forEach(function (el) { io.observe(el); });
  }
})();
