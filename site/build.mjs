import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { marked } from "marked";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dist = path.join(here, "dist");
const org = "discordia-grupo01";

const assetVersion = createHash("sha1")
  .update(await readFile(path.join(here, "assets", "style.css")))
  .update(await readFile(path.join(here, "assets", "site.js")))
  .digest("hex")
  .slice(0, 8);

const TEAM = ["Juana Galli", "Alexia Aroa", "Facundo Madotta", "Fabricio Batastini", "Manuel Peñalva", "Mora Lema"];

const SERVICES = [
  { repo: "identify-service", title: "Identidad", text: "Registro, login, sesiones, 2FA y perfil." },
  { repo: "servers", title: "Servidores", text: "Servidores, canales, roles y permisos, y moderación." },
  { repo: "messaging", title: "Mensajería", text: "Mensajes, mensajes directos, menciones y estado de actividad." },
  { repo: "notifications", title: "Notificaciones", text: "No leídos, historial, preferencias y push." },
  { repo: "billing", title: "Pagos", text: "Premium, puntos y boosts de servidores." },
  { repo: "admin", title: "Administración", text: "API del backoffice: suspensiones y expediente." },
  { repo: "metrics", title: "Métricas", text: "Actividad de servidores y estado de la plataforma." },
  { repo: "voice-sfu", title: "Voz", text: "Salas de voz, tokens y llamadas privadas." },
];

const OPERATION_DOCS = [
  { file: "reintentos-y-dlq.md", slug: "reintentos-y-dlq" },
  { file: "voice-replica-migration.md", slug: "voice-replica" },
  { file: "formato-de-errores.md", slug: "formato-de-errores" },
];

const SECTIONS = [
  { id: "adr", title: "ADRs", text: "Decisiones de arquitectura y sus alternativas." },
  { id: "diagramas", title: "Diagramas", text: "Diagramas C4, despliegue y flujos principales." },
  { id: "openapi", title: "OpenAPI", text: "La API REST de cada servicio." },
  { id: "asyncapi", title: "AsyncAPI", text: "Los eventos entre servicios por RabbitMQ." },
  { id: "operacion", title: "Operación", text: "Reintentos, colas de eventos fallidos y réplicas." },
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function readText(file) {
  return readFile(file, "utf8");
}

function firstHeading(md, fallback) {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

function tableValue(md, label) {
  const m = md.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, "i"));
  return m ? m[1].trim() : "";
}

const ICONS = {
  "": '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  adr: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  diagramas: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  openapi: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
  asyncapi: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  operacion: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  menu: '<path d="M4 12h16"/><path d="M4 18h16"/><path d="M4 6h16"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};
const icon = (name, size = 20) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

function layout({ title, base, sectionId, sidebarTitle, sidebarItems, activePath, body, wide, head = "", scripts = "" }) {
  const entries = [{ id: "", title: "Introducción", href: "index.html" }].concat(SECTIONS.map((s) => ({ ...s, href: `${s.id}/index.html` })));
  const nav = entries
    .map((s) => {
      const isSection = (s.id || "") === (sectionId || "");
      const current = isSection && (!sidebarItems || activePath === s.href);
      const link = `<a class="nav-item${isSection ? " is-section" : ""}" href="${base}${s.href}"${current ? ' aria-current="page"' : ""}>${icon(s.id)}<span>${esc(s.title)}</span></a>`;
      const sub =
        isSection && sidebarItems
          ? `<div class="nav-sub">${sidebarItems.map((i) => `<a href="${base}${i.href}"${i.href === activePath ? ' aria-current="page"' : ""}>${esc(i.label)}</a>`).join("")}</div>`
          : "";
      return link + sub;
    })
    .join("");
  const crumb = (entries.find((s) => (s.id || "") === (sectionId || "")) || entries[0]).title;
  return `<!doctype html>
<html lang="es" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Discordia</title>
<script>try{var t=localStorage.getItem("discordia-docs-theme");if(t)document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@500;600;700&display=swap">
<link rel="stylesheet" href="${base}assets/style.css?v=${assetVersion}">
${head}
</head>
<body>
<div class="app" id="app">
<aside class="nav" id="nav" aria-label="Menú lateral">
  <div class="nav-brand">
    <a class="brand" href="${base}index.html">Discordia <small>Documentación</small></a>
    <button class="icon-btn nav-close" id="nav-close" type="button" aria-label="Cerrar menú">${icon("close")}</button>
  </div>
  <nav class="nav-list" aria-label="Navegación principal">${nav}</nav>
</aside>
<div class="scrim" id="scrim"></div>
<div class="main-col">
<header class="header">
  <button class="icon-btn nav-open" id="nav-open" type="button" aria-label="Abrir menú" aria-controls="nav" aria-expanded="false">${icon("menu")}</button>
  <span class="crumb">${esc(crumb)}</span>
  <button class="icon-btn" id="theme-toggle" type="button" aria-label="Cambiar entre tema oscuro y claro"><span class="when-dark">${icon("sun")}</span><span class="when-light">${icon("moon")}</span></button>
</header>
<main class="content ${wide ? "wide" : "prose"}">
${body}
</main>
</div>
</div>
<script src="${base}assets/site.js?v=${assetVersion}"></script>
${scripts}
</body>
</html>
`;
}

async function writePage(rel, html) {
  const file = path.join(dist, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, html);
}

function listPage(items, mapRow) {
  return `<div class="list">${items.map(mapRow).join("")}</div>`;
}

async function buildIntro() {
  const md = await readText(path.join(here, "content", "intro.md"));
  const body = `<div class="hero"><h1>Discordia</h1><p class="lead">Plataforma de comunidades con servidores, canales de texto y voz, mensajes directos y Premium. Documentación técnica del proyecto.</p></div>
<div class="cards">${SECTIONS.map((s) => `<a class="card" href="${s.id}/index.html"><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></a>`).join("")}</div>
<div class="md">${marked.parse(md)}<ul class="team">${TEAM.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>`;
  await writePage("index.html", layout({ title: "Introducción", base: "", sectionId: "", body }));
}

async function buildAdrs() {
  const dir = path.join(root, "adr");
  const files = existsSync(dir) ? (await readdir(dir)).filter((f) => /^\d{3}-.*\.md$/.test(f)).sort() : [];
  const items = [];
  for (const f of files) {
    const md = await readText(path.join(dir, f));
    const num = f.slice(0, 3);
    const title = firstHeading(md, f).replace(/^ADR[\s-]*\d+\s*:\s*/i, "").replace(/`/g, "");
    items.push({ num, slug: f.replace(/\.md$/, ""), title, status: tableValue(md, "Estado").replace(/`/g, "").split(/[.(]/)[0].trim(), date: tableValue(md, "Fecha"), md });
  }
  const side = items.map((i) => ({ href: `adr/${i.slug}.html`, label: `${i.num} · ${i.title}` }));
  const index = `<div class="md"><h1>Decisiones de arquitectura</h1><p>Cada ADR explica un problema real del proyecto, qué se decidió y por qué, y qué alternativas se descartaron.</p></div>${listPage(items, (i) => `<a class="row" href="${i.slug}.html"><span class="num">${i.num}</span><span class="title">${esc(i.title)}</span><span class="meta">${esc(i.status)}${i.date ? " · " + esc(i.date) : ""}</span></a>`)}`;
  await writePage("adr/index.html", layout({ title: "ADRs", base: "../", sectionId: "adr", sidebarTitle: "ADRs", sidebarItems: side, activePath: "adr/index.html", body: index }));
  for (const i of items) {
    await writePage(`adr/${i.slug}.html`, layout({ title: `ADR ${i.num}`, base: "../", sectionId: "adr", sidebarTitle: "ADRs", sidebarItems: side, activePath: `adr/${i.slug}.html`, body: `<article class="md">${marked.parse(i.md)}</article>` }));
  }
  return items.length;
}

async function fetchSpec(repo) {
  if (process.env.OPENAPI_LOCAL) {
    const file = path.resolve(root, "..", repo, "openapi.yaml");
    return existsSync(file) ? readText(file) : null;
  }
  const res = await fetch(`https://raw.githubusercontent.com/${org}/${repo}/main/openapi.yaml`);
  return res.ok ? res.text() : null;
}

async function buildOpenApi() {
  const found = [];
  for (const s of SERVICES) {
    const text = await fetchSpec(s.repo);
    if (!text) {
      console.warn(`aviso: no se encontró el openapi.yaml de ${s.repo}`);
      continue;
    }
    const spec = load(text);
    await mkdir(path.join(dist, "openapi"), { recursive: true });
    await writeFile(path.join(dist, "openapi", `${s.repo}.yaml`), text);
    found.push({ ...s, version: spec?.info?.version || "", paths: Object.keys(spec?.paths || {}).length });
  }
  if (found.length === 0) throw new Error("No se pudo leer ningún openapi.yaml");
  const side = found.map((s) => ({ href: `openapi/${s.repo}.html`, label: s.title }));
  const index = `<div class="md"><h1>APIs REST</h1><p>Cada servicio publica su contrato OpenAPI en su repositorio. Esta página lo lee de la rama <code>main</code> en cada actualización del sitio.</p></div>${listPage(found, (s) => `<a class="row" href="${s.repo}.html"><span class="title">${esc(s.title)} <span class="badge">${esc(s.repo)}</span></span><span class="meta">${s.paths} rutas · ${esc(s.text)}</span></a>`)}`;
  await writePage("openapi/index.html", layout({ title: "OpenAPI", base: "../", sectionId: "openapi", sidebarTitle: "OpenAPI", sidebarItems: side, activePath: "openapi/index.html", body: index }));
  for (const s of found) {
    const body = `<div class="viewer-note"><span>${esc(s.title)} · <code>${esc(s.repo)}</code>${s.version ? " · versión " + esc(s.version) : ""}</span><a href="${s.repo}.yaml">Descargar openapi.yaml</a></div><div id="viewer"></div>`;
    await writePage(`openapi/${s.repo}.html`, layout({
      title: `OpenAPI · ${s.title}`, base: "../", sectionId: "openapi", sidebarTitle: "OpenAPI", sidebarItems: side, activePath: `openapi/${s.repo}.html`, body, wide: true,
      scripts: `<script src="https://cdn.jsdelivr.net/npm/redoc@2.5.1/bundles/redoc.standalone.js"></script><script>initOpenApi("${s.repo}.yaml");</script>`,
    }));
  }
  return found.length;
}

async function buildAsyncApi() {
  const dir = path.join(root, "asyncapi");
  const files = (await readdir(dir)).filter((f) => /^[\w-]+\.yaml$/.test(f)).sort();
  const items = [];
  for (const f of files) {
    const text = await readText(path.join(dir, f));
    const spec = load(text);
    const slug = f.replace(/\.yaml$/, "");
    const description = String(spec?.info?.description || "").trim().split(/\n\s*\n/)[0].replace(/\s+/g, " ");
    items.push({ slug, file: f, text, title: spec?.info?.title || slug, description, channels: Object.keys(spec?.channels || {}).length });
  }
  await mkdir(path.join(dist, "asyncapi"), { recursive: true });
  const side = items.map((i) => ({ href: `asyncapi/${i.slug}.html`, label: i.title.replace(/^Discordia\s*[—-]\s*/, "") }));
  const index = `<div class="md"><h1>Eventos</h1><p>Los servicios se avisan los cambios por RabbitMQ, en el exchange <code>discordia.events</code>. Cada documento describe un dominio: qué eventos hay, quién los publica y quién los consume. Los campos salen del repositorio <code>events-contract</code>.</p></div>${listPage(items, (i) => `<a class="row" href="${i.slug}.html"><span class="title">${esc(i.title)}</span><span class="meta">${i.channels} canales</span></a>`)}`;
  await writePage("asyncapi/index.html", layout({ title: "AsyncAPI", base: "../", sectionId: "asyncapi", sidebarTitle: "AsyncAPI", sidebarItems: side, activePath: "asyncapi/index.html", body: index }));
  for (const i of items) {
    await writeFile(path.join(dist, "asyncapi", i.file), i.text);
    const body = `<div class="viewer-note"><span>${esc(i.title)}</span><a href="${i.file}">Descargar ${esc(i.file)}</a></div><div id="viewer"></div>`;
    await writePage(`asyncapi/${i.slug}.html`, layout({
      title: `AsyncAPI · ${i.title}`, base: "../", sectionId: "asyncapi", sidebarTitle: "AsyncAPI", sidebarItems: side, activePath: `asyncapi/${i.slug}.html`, body, wide: true,
      head: `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@asyncapi/react-component@3.2.3/styles/default.min.css">`,
      scripts: `<script src="https://cdn.jsdelivr.net/npm/@asyncapi/react-component@3.2.3/browser/standalone/index.js"></script><script>initAsyncApi("${i.file}");</script>`,
    }));
  }
  return items.length;
}

const DIAGRAMS = [
  { file: "c4-1-contexto.png", group: "C4", title: "Nivel 1 · Contexto", text: "Discordia como una sola caja: quién la usa y con qué sistemas de terceros se relaciona." },
  { file: "c4-2-contenedores.png", group: "C4", title: "Nivel 2 · Contenedores", text: "Las piezas que se despliegan por separado, cada servicio con su base y el bus de eventos." },
  { file: "c4-3-messaging-una-instancia.png", group: "C4", title: "Nivel 3 · messaging (una instancia)", text: "Cómo está hecho messaging por dentro: quién entra, qué reglas aplica, dónde guarda y cómo avisa." },
  { file: "c4-3-messaging-dos-instancias.png", group: "C4", title: "Nivel 3 · messaging (dos instancias)", text: "Lo propio de cada instancia y lo que comparten: Mongo, el outbox en Postgres y RabbitMQ." },
  { file: "c4-3-messaging-flujo-entre-instancias.png", group: "C4", title: "Nivel 3 · messaging: un mensaje entre dos instancias", text: "El camino de un mensaje desde quien lo envía, conectado a una instancia, hasta quien lo recibe, en otra." },
  { file: "c4-3-voice-signaling.png", group: "C4", title: "Nivel 3 · voice-sfu (signaling)", text: "El servicio que autoriza las salas de voz y emite los tokens; el audio va directo a LiveKit." },
  { file: "despliegue.png", group: "Despliegue y flujos", title: "Despliegue", text: "Dónde corre cada pieza y cómo llega ahí." },
  { file: "flujo-compra-de-premium.png", group: "Despliegue y flujos", title: "Flujo: compra de Premium", text: "Suscripción en Mercado Pago y cómo se enteran los demás servicios, con eventos firmados." },
  { file: "flujo-entrar-a-un-canal-de-voz.png", group: "Despliegue y flujos", title: "Flujo: entrar a un canal de voz", text: "Token de signaling, conexión directa a LiveKit y aviso de presencia." },
  { file: "flujo-suspension-por-el-staff.png", group: "Despliegue y flujos", title: "Flujo: suspensión por el staff", text: "Cuatro servicios bloquean la cuenta sin consultarle a admin." },
  { file: "mapa-de-eventos.png", group: "Despliegue y flujos", title: "Mapa de eventos", text: "Quién publica cada evento y quién lo consume, según el catálogo de events-contract." },
  { file: "resiliencia-reintentos-y-dlq.png", group: "Despliegue y flujos", title: "Resiliencia: reintentos y DLQ", text: "Qué pasa cuando un evento no se puede procesar." },
];

async function buildDiagramas() {
  const dir = path.join(root, "diagramas");
  const items = DIAGRAMS.filter((d) => existsSync(path.join(dir, d.file))).map((d) => ({ ...d, slug: d.file.replace(/\.png$/, "") }));
  if (!items.length) return 0;
  await cp(dir, path.join(dist, "diagramas"), { recursive: true });
  const side = items.map((i) => ({ href: `diagramas/${i.slug}.html`, label: i.title }));
  const groups = [...new Set(items.map((i) => i.group))];
  const index = `<div class="md"><h1>Diagramas</h1><p>Los tres niveles del modelo C4 y los flujos que explican cómo trabajan los servicios entre sí.</p></div>${groups
    .map((g) => `<div class="md"><h2>${esc(g)}</h2></div>${listPage(items.filter((i) => i.group === g), (i) => `<a class="row" href="${i.slug}.html"><span class="title">${esc(i.title)}</span><span class="meta">${esc(i.text)}</span></a>`)}`)
    .join("")}`;
  await writePage("diagramas/index.html", layout({ title: "Diagramas", base: "../", sectionId: "diagramas", sidebarTitle: "Diagramas", sidebarItems: side, activePath: "diagramas/index.html", body: index }));
  for (const i of items) {
    const body = `<div class="md"><h1>${esc(i.title)}</h1><p>${esc(i.text)}</p></div><figure class="diagram"><a href="${i.file}" target="_blank" rel="noopener"><img src="${i.file}" alt="${esc(i.title)}: ${esc(i.text)}" loading="lazy"></a><figcaption><a href="${i.file}" target="_blank" rel="noopener">Abrir en tamaño completo</a></figcaption></figure>`;
    await writePage(`diagramas/${i.slug}.html`, layout({ title: i.title, base: "../", sectionId: "diagramas", sidebarTitle: "Diagramas", sidebarItems: side, activePath: `diagramas/${i.slug}.html`, body }));
  }
  return items.length;
}

async function buildOperation() {
  const items = [];
  for (const d of OPERATION_DOCS) {
    const file = path.join(root, d.file);
    if (!existsSync(file)) continue;
    const md = await readText(file);
    items.push({ slug: d.slug, title: firstHeading(md, d.slug), md });
  }
  const side = items.map((i) => ({ href: `operacion/${i.slug}.html`, label: i.title }));
  const index = `<div class="md"><h1>Operación</h1><p>Documentos para operar el sistema.</p></div>${listPage(items, (i) => `<a class="row" href="${i.slug}.html"><span class="title">${esc(i.title)}</span></a>`)}`;
  await writePage("operacion/index.html", layout({ title: "Operación", base: "../", sectionId: "operacion", sidebarTitle: "Operación", sidebarItems: side, activePath: "operacion/index.html", body: index }));
  for (const i of items) {
    await writePage(`operacion/${i.slug}.html`, layout({ title: i.title, base: "../", sectionId: "operacion", sidebarTitle: "Operación", sidebarItems: side, activePath: `operacion/${i.slug}.html`, body: `<article class="md">${marked.parse(i.md)}</article>` }));
  }
  return items.length;
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(path.join(here, "assets"), path.join(dist, "assets"), { recursive: true });
await writeFile(path.join(dist, ".nojekyll"), "");

await buildIntro();
const counts = { adr: await buildAdrs(), diagramas: await buildDiagramas(), openapi: await buildOpenApi(), asyncapi: await buildAsyncApi(), operacion: await buildOperation() };
console.log("sitio generado en", dist, counts);
