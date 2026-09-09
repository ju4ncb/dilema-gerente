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

// PIN del botón de la pantalla de inicio. El valor por defecto está en el
// código —y por tanto en el repositorio— para que el botón funcione sin
// configurar nada. Defina ADMIN_PIN en Vercel para que sea de verdad
// secreto. ADMIN_TOKEN es la vía alterna, pensada para scripts.
const PIN_POR_DEFECTO = "103510";
const PIN_ESPERADO = process.env.ADMIN_PIN || PIN_POR_DEFECTO;
const TOKEN_ESPERADO = process.env.ADMIN_TOKEN || "";

// Un PIN de seis dígitos se agota a fuerza bruta en un millón de intentos.
// El contador por IP lo vuelve inviable sin encarecer el uso legítimo.
const MAX_INTENTOS = 5;
const VENTANA_INTENTOS = 900; // segundos

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

// Comparación en tiempo constante: un `===` sobre un secreto filtra, por
// lo que tarda, cuántos caracteres iniciales acertó quien esté probando.
function coincide(recibido, esperado) {
  if (typeof recibido !== "string" || !esperado) return false;
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

function autorizado(req) {
  return coincide(req.headers["x-admin-pin"], PIN_ESPERADO) ||
         coincide(req.headers["x-admin-token"], TOKEN_ESPERADO);
}

const quien = req =>
  (req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "desconocido";

const claveIntentos = ip => `dilema:intentos:${ip}`;

// El contador vive en Redis y no en memoria: cada invocación de una
// función serverless puede caer en una instancia distinta, así que un
// contador local no contaría casi nada.
async function intentosFallidos(ip) {
  if (!hayRedis) return 0;
  const db = await redis();
  return Number(await db.get(claveIntentos(ip))) || 0;
}

async function anotarFallo(ip) {
  if (!hayRedis) return;
  const db = await redis();
  const n = await db.incr(claveIntentos(ip));
  if (n === 1) await db.expire(claveIntentos(ip), VENTANA_INTENTOS);
}

async function limpiarFallos(ip) {
  if (!hayRedis) return;
  const db = await redis();
  await db.del(claveIntentos(ip));
}

// Borra todos los puntajes. Es irreversible y la URL es pública, de ahí
// el PIN, el contador de intentos y el registro en los logs.
async function reiniciar(req, res) {
  const ip = quien(req);
  res.setHeader("Cache-Control", "no-store");

  if (await intentosFallidos(ip) >= MAX_INTENTOS) {
    return res.status(429).json({
      error: `Demasiados intentos fallidos. Espere ${Math.round(VENTANA_INTENTOS / 60)} minutos.`
    });
  }

  if (!autorizado(req)) {
    await anotarFallo(ip);
    console.warn(`Intento fallido de reiniciar el escalafón desde ${ip}`);
    return res.status(401).json({ error: "PIN incorrecto" });
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

  await limpiarFallos(ip);
  console.log(`Escalafón reiniciado desde ${ip}: ${borrados} registro(s) borrado(s)`);
  return res.status(200).json({ ok: true, borrados });
}
