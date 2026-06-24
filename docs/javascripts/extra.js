/* Interactive bounding-box playground (provenance page). Progressive
   enhancement — the figure still shows a static box without JS. */
(function () {
  "use strict";
  function init() {
    document.querySelectorAll(".bbox-demo").forEach(function (demo) {
      if (demo.dataset.wired) return;
      demo.dataset.wired = "1";
      var canvas = demo.querySelector(".bbox-canvas");
      var img = demo.querySelector(".bbox-canvas img");
      var rect = demo.querySelector(".bbox-rect");
      var handle = demo.querySelector(".bbox-handle");
      if (!canvas || !img || !rect) return;

      var box = {
        x: parseFloat(demo.dataset.x || "0.08"),
        y: parseFloat(demo.dataset.y || "0.30"),
        w: parseFloat(demo.dataset.w || "0.84"),
        h: parseFloat(demo.dataset.h || "0.06"),
      };
      function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

      function paint() {
        rect.style.left = (box.x * 100) + "%";
        rect.style.top = (box.y * 100) + "%";
        rect.style.width = (box.w * 100) + "%";
        rect.style.height = (box.h * 100) + "%";
        var f = function (n) { return n.toFixed(3); };
        var rows = demo.querySelectorAll(".bbox-readout .ro-row .v");
        if (rows.length >= 4) {
          rows[0].textContent = f(box.x);
          rows[1].textContent = f(box.y);
          rows[2].textContent = f(box.w);
          rows[3].textContent = f(box.h);
        }
        var json = demo.querySelector(".bbox-json");
        if (json) {
          json.innerHTML =
            '{ <span class="c-key">"chronos_page"</span>: <span class="c-num">42</span>,\n' +
            '  <span class="c-key">"chronos_bbox"</span>: [' +
            '<span class="c-num">' + f(box.x) + '</span>, ' +
            '<span class="c-num">' + f(box.y) + '</span>, ' +
            '<span class="c-num">' + f(box.w) + '</span>, ' +
            '<span class="c-num">' + f(box.h) + '</span>] }';
        }
      }

      var drag = null;
      function pt(e) {
        var r = canvas.getBoundingClientRect();
        return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
      }
      function down(mode) {
        return function (e) {
          e.preventDefault();
          var p = pt(e);
          drag = { mode: mode, px: p.x, py: p.y, box: { x: box.x, y: box.y, w: box.w, h: box.h } };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        };
      }
      function move(e) {
        if (!drag) return;
        var p = pt(e), dx = p.x - drag.px, dy = p.y - drag.py;
        if (drag.mode === "move") {
          box.x = clamp(drag.box.x + dx, 0, 1 - drag.box.w);
          box.y = clamp(drag.box.y + dy, 0, 1 - drag.box.h);
        } else {
          box.w = clamp(drag.box.w + dx, 0.03, 1 - box.x);
          box.h = clamp(drag.box.h + dy, 0.02, 1 - box.y);
        }
        paint();
      }
      function up() {
        drag = null;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      }
      rect.addEventListener("pointerdown", down("move"));
      if (handle) handle.addEventListener("pointerdown", function (e) { e.stopPropagation(); down("resize")(e); });

      if (img.complete) paint(); else img.addEventListener("load", paint);
      paint();
    });
  }
  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", init);
})();
