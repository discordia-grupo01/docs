(function () {
  var root = document.documentElement;

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    try { localStorage.setItem("discordia-docs-theme", theme); } catch (e) {}
  }

  var toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      applyTheme(next);
      if (document.getElementById("viewer")) location.reload();
    });
  }

  var app = document.getElementById("app");
  var openBtn = document.getElementById("nav-open");
  function setNav(open) {
    app.classList.toggle("nav-is-open", open);
    if (openBtn) openBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  if (openBtn) openBtn.addEventListener("click", function () { setNav(true); });
  var closeBtn = document.getElementById("nav-close");
  if (closeBtn) closeBtn.addEventListener("click", function () { setNav(false); });
  var scrim = document.getElementById("scrim");
  if (scrim) scrim.addEventListener("click", function () { setNav(false); });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") setNav(false);
  });
  var current = document.querySelector('.nav-sub a[aria-current="page"]');
  if (current && current.scrollIntoView) current.scrollIntoView({ block: "center" });
})();

function discordiaColors() {
  var dark = document.documentElement.getAttribute("data-theme") !== "light";
  return dark
    ? { bg: "#1e2d42", panel: "#1c293b", card: "#1a2e40", text: "#f5f2eb", muted: "#a8c6df", accent: "#2d7a8c", border: "rgba(168,198,223,0.18)", dark: true }
    : { bg: "#fbf7f0", panel: "#eae5d9", card: "#ede8dc", text: "#18181b", muted: "#245c6b", accent: "#245c6b", border: "rgba(36,92,107,0.22)", dark: false };
}

function fixDarkContrast(viewer) {
  var BASE = { r: 30, g: 45, b: 66, a: 1 };
  var CARD = "rgb(26, 46, 64)";
  var pending = new Set();
  var timer;

  function parse(s) {
    var m = s.match(/[\d.]+/g);
    if (!m || m.length < 3) return null;
    return { r: +m[0], g: +m[1], b: +m[2], a: m.length > 3 ? +m[3] : 1 };
  }
  function lin(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function lum(c) { return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b); }
  function ratio(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function effectiveBg(el) {
    while (el && el !== document.body) {
      var c = parse(getComputedStyle(el).backgroundColor);
      if (c && c.a > 0.5) return c;
      el = el.parentElement;
    }
    return BASE;
  }
  function lighten(fg, bg) {
    var out = { r: fg.r, g: fg.g, b: fg.b };
    for (var i = 0; i < 12 && ratio(out, bg) < 4.5; i++) {
      out = { r: out.r + (255 - out.r) * 0.12, g: out.g + (255 - out.g) * 0.12, b: out.b + (255 - out.b) * 0.12 };
    }
    return "rgb(" + Math.round(out.r) + "," + Math.round(out.g) + "," + Math.round(out.b) + ")";
  }
  function hasText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3 && el.childNodes[i].textContent.trim()) return true;
    }
    return false;
  }

  function run() {
    var batch = new Set();
    pending.forEach(function (node) {
      if (!viewer.contains(node)) return;
      batch.add(node);
      node.querySelectorAll("*").forEach(function (child) { batch.add(child); });
    });
    pending.clear();
    var fresh = [];
    batch.forEach(function (el) { if (!(el instanceof SVGElement)) fresh.push(el); });
    var lightBg = [];
    fresh.forEach(function (el) {
      var bg = parse(getComputedStyle(el).backgroundColor);
      if (bg && bg.a > 0.5 && lum(bg) > 0.5 && !el.hasAttribute("data-keep-bg")) lightBg.push(el);
    });
    lightBg.forEach(function (el) { el.style.setProperty("background-color", CARD, "important"); });
    var fixes = [];
    fresh.forEach(function (el) {
      if (!hasText(el) && el.tagName !== "SELECT" && el.tagName !== "INPUT") return;
      var fg = parse(getComputedStyle(el).color);
      if (!fg) return;
      var bg = effectiveBg(el);
      if (ratio(fg, bg) < 4) fixes.push([el, lighten(fg, bg)]);
    });
    fixes.forEach(function (f) { f[0].style.setProperty("color", f[1], "important"); });
  }

  new MutationObserver(function (records) {
    records.forEach(function (r) {
      if (r.type === "attributes") pending.add(r.target);
      r.addedNodes.forEach(function (n) { if (n.nodeType === 1) pending.add(n); });
    });
    clearTimeout(timer);
    timer = setTimeout(run, 120);
  }).observe(viewer, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
}

function initOpenApi(specUrl) {
  var c = discordiaColors();
  if (c.dark) {
    var viewer = document.getElementById("viewer");
    viewer.classList.add("oa-dark");
    fixDarkContrast(viewer);
  }
  Redoc.init(
    specUrl,
    {
      hideDownloadButton: false,
      scrollYOffset: ".header",
      hideHostname: true,
      expandResponses: "200,201",
      theme: {
        colors: {
          primary: { main: c.accent },
          text: { primary: c.text, secondary: c.muted },
          http: { get: "#2f855a", post: "#2d7a8c", put: "#f0b232", patch: "#a8c6df", delete: "#e05252" },
          border: { dark: c.border, light: c.border },
          responses: { success: { color: "#38a169" }, error: { color: "#e05252" } }
        },
        typography: {
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: "15px",
          headings: { fontFamily: "Outfit, Inter, sans-serif" },
          code: { fontFamily: "ui-monospace, Menlo, Consolas, monospace", color: c.dark ? "#a9d8a0" : "#2e7531", backgroundColor: c.dark ? "#14212f" : "#f1ece1" }
        },
        sidebar: { backgroundColor: c.panel, textColor: c.text, activeTextColor: c.accent, groupItems: { textTransform: "none" } },
        rightPanel: {
          backgroundColor: c.dark ? "#0f1922" : "#245c6b",
          textColor: "#f5f2eb",
          servers: { overlay: { backgroundColor: c.dark ? "#14212f" : "#1d4e5a", textColor: "#f5f2eb" }, url: { backgroundColor: c.dark ? "#0b141c" : "#173f49" } }
        },
        codeBlock: { backgroundColor: c.dark ? "#0b141c" : "#173f49" },
        schema: { nestedBackground: c.card, typeNameColor: c.muted, typeTitleColor: c.text }
      }
    },
    document.getElementById("viewer")
  );
}

function initAsyncApi(specUrl) {
  var c = discordiaColors();
  document.getElementById("viewer").classList.add(c.dark ? "aui-dark" : "aui-light");
  fetch(specUrl)
    .then(function (r) { return r.text(); })
    .then(function (schema) {
      AsyncApiStandalone.render(
        { schema: schema, config: { show: { sidebar: true, info: true, servers: true, operations: true, messages: true, schemas: true, errors: false } } },
        document.getElementById("viewer")
      );
    });
}
