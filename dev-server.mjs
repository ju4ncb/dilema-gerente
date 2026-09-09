/* Servidor de desarrollo — imita lo que hace Vercel, sin cuenta ni CLI.
 *
 *   node dev-server.mjs        → http://localhost:3000
 *
 * Sirve los archivos estáticos con soporte de Range (para que los videos
 * se puedan adelantar) y enruta /api/* a los handlers de la carpeta api/,
 * con el mismo contrato req/res que usa Vercel. */

import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL(".", import.meta.url));
const PUERTO = Number(process.env.PORT) || 3000;

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

/* ── Variables de entorno ────────────────────────────────── */

// Lee .env.local igual que `vercel dev`, para que UPSTASH_* estén
// disponibles si el usuario ya corrió `vercel env pull`.
for (const archivo of [".env.local", ".env"]) {
  const ruta = join(RAIZ, archivo);
  if (!existsSync(ruta)) continue;
  for (const linea of readFileSync(ruta, "utf8").split(/\r?\n/)) {
    const par = linea.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/);
    if (!par || linea.trimStart().startsWith("#")) continue;
    const valor = par[2].trim().replace(/^(['"])(.*)\1$/s, "$2");
    process.env[par[1]] ??= valor;
  }
  console.log(`  variables cargadas desde ${archivo}`);
}

/* ── API ─────────────────────────────────────────────────── */

// Adapta el ServerResponse de Node a la interfaz res.status().json()
// que esperan los handlers de Vercel.
function adaptar(res) {
  res.status = codigo => { res.statusCode = codigo; return res; };
  res.json = cuerpo => {
    if (!res.hasHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(cuerpo));
    return res;
  };
  res.send = cuerpo => { res.end(cuerpo); return res; };
  return res;
}

async function leerCuerpo(req) {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const trozos = [];
  for await (const trozo of req) trozos.push(trozo);
  if (!trozos.length) return undefined;
  const crudo = Buffer.concat(trozos).toString("utf8");
  try {
    return JSON.parse(crudo);
  } catch {
    return crudo;
  }
}

async function atenderApi(req, res, ruta) {
  const archivo = join(RAIZ, "api", `${ruta.replace(/^\/api\//, "")}.js`);
  if (!existsSync(archivo)) {
    return adaptar(res).status(404).json({ error: "Función no encontrada" });
  }

  // El mtime invalida el caché de módulos solo cuando el archivo cambia:
  // así se recarga al editarlo, pero el estado en memoria sobrevive entre
  // peticiones.
  const url = new URL(`api/${ruta.replace(/^\/api\//, "")}.js`, import.meta.url);
  const modulo = await import(`${url}?v=${statSync(archivo).mtimeMs}`);
  req.body = await leerCuerpo(req);
  req.query = Object.fromEntries(new URL(req.url, "http://localhost").searchParams);
  await modulo.default(req, adaptar(res));
}

/* ── Archivos estáticos ──────────────────────────────────── */

function atenderEstatico(req, res, ruta) {
  const relativa = normalize(decodeURIComponent(ruta === "/" ? "/index.html" : ruta)).replace(/^[\\/]+/, "");
  const archivo = join(RAIZ, relativa);

  // Evita que un ../ se escape de la carpeta del proyecto.
  if (!archivo.startsWith(RAIZ.endsWith(sep) ? RAIZ : RAIZ + sep)) {
    res.writeHead(403).end("Prohibido");
    return;
  }
  if (!existsSync(archivo) || !statSync(archivo).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("No encontrado");
    return;
  }

  const { size } = statSync(archivo);
  const tipo = TIPOS[extname(archivo).toLowerCase()] ?? "application/octet-stream";
  const rango = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);

  // Los videos piden trozos: sin 206 el navegador no puede adelantar.
  if (rango) {
    const inicio = rango[1] ? Number(rango[1]) : 0;
    const fin = rango[2] ? Math.min(Number(rango[2]), size - 1) : size - 1;
    if (inicio >= size || inicio > fin) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, {
      "Content-Type": tipo,
      "Content-Length": fin - inicio + 1,
      "Content-Range": `bytes ${inicio}-${fin}/${size}`,
      "Accept-Ranges": "bytes"
    });
    createReadStream(archivo, { start: inicio, end: fin }).pipe(res);
    return;
  }

  res.writeHead(200, {
    "Content-Type": tipo,
    "Content-Length": size,
    "Accept-Ranges": "bytes",
    // El código y los casos se releen siempre; los videos se guardan en el
    // caché del navegador para no bajar decenas de MB en cada recarga.
    "Cache-Control": relativa.startsWith("videos") ? "public, max-age=3600" : "no-store"
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(archivo).pipe(res);
}

/* ── Arranque ────────────────────────────────────────────── */

const servidor = createServer(async (req, res) => {
  const ruta = new URL(req.url, "http://localhost").pathname;
  try {
    if (ruta.startsWith("/api/")) await atenderApi(req, res, ruta);
    else atenderEstatico(req, res, ruta);
  } catch (error) {
    console.error(`✗ ${req.method} ${ruta}`, error);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Error del servidor de desarrollo" }));
  }
});

servidor.on("error", error => {
  if (error.code === "EADDRINUSE") {
    console.error(`\n  El puerto ${PUERTO} ya está ocupado.`);
    console.error(`  Cierre el otro servidor o use: PORT=3001 npm run dev\n`);
    process.exit(1);
  }
  throw error;
});

servidor.listen(PUERTO, () => {
  const hayRedis = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const conRedis = hayRedis ? "Upstash Redis" : "memoria (se pierde al reiniciar)";
  console.log(`\n  El Dilema del Gerente\n  http://localhost:${PUERTO}\n  escalafón: ${conRedis}\n`);
});
