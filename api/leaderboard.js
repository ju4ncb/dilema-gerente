import { timingSafeEqual } from "node:crypto";

const CLAVE = "dilema:escalafon";
const PUNTAJE_MAXIMO = 19;
const TOPE = 10;

// El score compuesto deja que Redis ordene por puntos y desempate por
// tiempo en una sola operación: más puntos sube, más segundos baja.
const componer = (puntos, segundos) => puntos * 1_000_000 - segundos;

const hayRedis = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
);
const enVercel = Boolean(process.env.VERCEL);

// El import es dinámico para que el servidor local pueda levantar el
// escalafón en memoria sin necesidad de instalar dependencias.
let cliente = null;
async function redis() {
  if (!cliente) {
    const { Redis } = await import("@upstash/redis");
    cliente = Redis.fromEnv();
  }
  return cliente;
}

// Sin credenciales y fuera de Vercel, el escalafón vive en memoria: se
// pierde al reiniciar el servidor, pero permite probar el flujo completo.
const memoria = [];

export default async function handler(req, res) {
  try {
    if (!hayRedis && enVercel) {
      return res.status(503).json({
        error: "El escalafón no tiene almacenamiento conectado. Instale la integración de Upstash Redis en Vercel."
      });
    }
    if (req.method === "POST") return await guardar(req, res);
    if (req.method === "GET") return await consultar(res);
    if (req.method === "DELETE") return await reiniciar(req, res);
    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Método no permitido" });
  } catch (error) {
    console.error("Fallo en el escalafón:", error);
    return res.status(500).json({ error: "No se pudo acceder al escalafón" });
  }
}

async function guardar(req, res) {
  const { nombre, puntos, segundos } = req.body ?? {};

  if (typeof nombre !== "string" || nombre.trim().length < 2) {
    return res.status(400).json({ error: "El nombre del candidato es obligatorio" });
  }
  if (!Number.isInteger(puntos) || puntos < 0 || puntos > PUNTAJE_MAXIMO) {
    return res.status(400).json({ error: "Puntaje fuera del rango permitido" });
  }
  if (!Number.isFinite(segundos) || segundos < 0 || segundos > 7200) {
    return res.status(400).json({ error: "Tiempo fuera del rango permitido" });
  }

  const fila = {
    nombre: nombre.trim().slice(0, 30),
    puntos,
    segundos: Math.round(segundos),
    fecha: Date.now()
  };

  if (hayRedis) {
    const db = await redis();
    await db.zadd(CLAVE, { score: componer(fila.puntos, fila.segundos), member: JSON.stringify(fila) });
  } else {
    memoria.push(fila);
  }

  return res.status(201).json({ ok: true });
}

async function consultar(res) {
  let filas;

  if (hayRedis) {
    const db = await redis();
    const crudo = await db.zrange(CLAVE, 0, TOPE - 1, { rev: true });
    filas = crudo.map(item => (typeof item === "string" ? JSON.parse(item) : item));
  } else {
    filas = [...memoria]
      .sort((a, b) => componer(b.puntos, b.segundos) - componer(a.puntos, a.segundos))
      .slice(0, TOPE);
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(filas);
}

/* ── Reinicio del escalafón ──────────────────────────────── */

// Comparación en tiempo constante: un `===` sobre un token filtra, por lo
// que tarda, cuántos caracteres iniciales acertó quien esté probando.
function tokenValido(recibido, esperado) {
  if (typeof recibido !== "string") return false;
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Borra todos los puntajes. Es irreversible y la URL es pública, así que
// exige un token: sin ADMIN_TOKEN definido no se borra nada, en vez de
// quedar abierto a cualquiera que descubra el método DELETE.
async function reiniciar(req, res) {
  const esperado = process.env.ADMIN_TOKEN;

  if (!esperado) {
    return res.status(503).json({
      error: "Defina la variable de entorno ADMIN_TOKEN para habilitar el reinicio del escalafón"
    });
  }
  if (!tokenValido(req.headers["x-admin-token"], esperado)) {
    return res.status(401).json({ error: "Token de administración inválido" });
  }

  let borrados;
  if (hayRedis) {
    const db = await redis();
    borrados = await db.zcard(CLAVE);
    await db.del(CLAVE);
  } else {
    borrados = memoria.length;
    memoria.length = 0;
  }

  console.log(`Escalafón reiniciado: ${borrados} registro(s) borrado(s)`);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ ok: true, borrados });
}
