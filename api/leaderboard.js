import { timingSafeEqual } from "node:crypto";

const CLAVE = "dilema:escalafon";
// Conteo de respuestas del curso, para el desglose comparativo. Un solo
// hash con campos «F01:2» —caso e índice de opción antes de barajar— en
// vez de una clave por caso: son ~150 campos, caben de sobra en una
// lectura, y se borran de un golpe cuando se reinicia el escalafón.
const CLAVE_RESPUESTAS = "dilema:respuestas";
const PUNTAJE_MAXIMO = 19;
const TOPE = 10;

// Un caso sin responder también cuenta: que el 20 % del curso dejara
// vencer el reloj es justamente lo que vale la pena discutir.
const SIN_RESPONDER = "t";
const ID_CASO = /^[FMD]\d{2}$/;
const MAX_OPCIONES = 5;

// El score compuesto deja que Redis ordene por puntos y desempate por
// tiempo en una sola operación: más puntos sube, más segundos baja.
const componer = (puntos, segundos) => puntos * 1_000_000 - segundos;

// Vercel nombra las credenciales de distinta forma segun como se aprovisione
// la base —UPSTASH_REDIS_REST_* o KV_REST_API_*— y, si al conectar la tienda
// se le puso un prefijo, antepone ese prefijo a todo: MITIENDA_UPSTASH_...
// Redis.fromEnv() solo mira los dos nombres exactos, asi que buscamos por
// sufijo y armamos el cliente a mano. Un prefijo es la causa mas silenciosa
// de un escalafon caido: las variables estan puestas y aun asi no se ven.
const porSufijo = sufijo => {
  const exacta = process.env[sufijo];
  if (exacta) return { nombre: sufijo, valor: exacta };
  const nombre = Object.keys(process.env).find(
    k => k.endsWith(`_${sufijo}`) && process.env[k]
  );
  return nombre ? { nombre, valor: process.env[nombre] } : null;
};

const urlRest = porSufijo("UPSTASH_REDIS_REST_URL") || porSufijo("KV_REST_API_URL");
const tokenRest = porSufijo("UPSTASH_REDIS_REST_TOKEN") || porSufijo("KV_REST_API_TOKEN");

const hayRedis = Boolean(urlRest && tokenRest);
const enVercel = Boolean(process.env.VERCEL);

// Se reportan —solo los nombres, nunca los valores— cuando el escalafon no
// arranca: sin esto, un 503 no distingue «no conecte nada» de «conecte una
// tienda que no habla REST», que es el error mas facil de cometer.
const detectadas = () =>
  Object.keys(process.env).filter(k =>
    /(UPSTASH_REDIS|KV_REST_API|KV_URL|REDIS_URL)/.test(k)
  );

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
    cliente = new Redis({ url: urlRest.valor, token: tokenRest.valor });
  }
  return cliente;
}

// Sin credenciales y fuera de Vercel, el escalafón vive en memoria: se
// pierde al reiniciar el servidor, pero permite probar el flujo completo.
const memoria = [];
const memoriaRespuestas = new Map();

export default async function handler(req, res) {
  try {
    if (!hayRedis && enVercel) {
      const presentes = detectadas();
      return res.status(503).json({
        error: "El escalafón no tiene almacenamiento conectado. Instale la integración de Upstash Redis en Vercel.",
        // Diagnóstico: la tienda «Redis» propia de Vercel solo inyecta
        // REDIS_URL, que es una conexión TCP y no la API REST que usa
        // este código. Hay que instalar Upstash Redis desde el Marketplace.
        variablesDetectadas: presentes,
        pista: presentes.length
          ? "Hay variables de Redis, pero ninguna pareja REST (…UPSTASH_REDIS_REST_URL/TOKEN o …KV_REST_API_URL/TOKEN). Instale Upstash Redis desde el Marketplace de Vercel."
          : "No llegó ninguna variable de Redis a esta función: conecte la tienda al proyecto y vuelva a desplegar."
      });
    }
    if (req.method === "POST") return await guardar(req, res);
    if (req.method === "GET") return await consultar(req, res);
    if (req.method === "DELETE") return await reiniciar(req, res);
    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Método no permitido" });
  } catch (error) {
    console.error("Fallo en el escalafón:", error);
    // El detalle viaja al cliente a proposito: es lo unico que distingue
    // «token vencido» de «base borrada» sin abrir los logs de Vercel. Los
    // mensajes de Upstash no incluyen credenciales.
    return res.status(500).json({
      error: "No se pudo acceder al escalafón",
      detalle: String(error?.message ?? error).slice(0, 200)
    });
  }
}

async function guardar(req, res) {
  const { nombre, puntos, segundos, respuestas } = req.body ?? {};

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

  const votos = depurarRespuestas(respuestas);

  if (hayRedis) {
    const db = await redis();
    // Una sola ida y vuelta para el puntaje y los seis conteos: en una
    // función serverless cada round trip a Upstash se paga en latencia.
    const tuberia = db.pipeline();
    tuberia.zadd(CLAVE, { score: componer(fila.puntos, fila.segundos), member: JSON.stringify(fila) });
    for (const voto of votos) tuberia.hincrby(CLAVE_RESPUESTAS, voto, 1);
    await tuberia.exec();
  } else {
    memoria.push(fila);
    for (const voto of votos) {
      memoriaRespuestas.set(voto, (memoriaRespuestas.get(voto) ?? 0) + 1);
    }
  }

  // El conteo vuelve en la misma respuesta del POST: el desglose lo
  // necesita de inmediato y así se evita una segunda consulta. Ya incluye
  // el voto que se acaba de registrar, que es lo que hace que el candidato
  // se vea dentro de la estadística y no al lado de ella.
  const casos = votos.map(voto => voto.split(":")[0]);
  return res.status(201).json({
    ok: true,
    estadisticas: casos.length ? await conteos(casos) : {},
    total: await cuantos()
  });
}

// Lo que llega del navegador se reduce a campos «F01:2» y se descarta todo
// lo demás: el endpoint es público y el conteo es lo único del juego que un
// tercero podría inflar sin dejar rastro en el escalafón.
function depurarRespuestas(lista) {
  if (!Array.isArray(lista)) return [];

  const campos = [];
  const vistos = new Set();

  for (const item of lista.slice(0, 20)) {
    const id = item?.id;
    // Un caso repetido no suma dos veces: una partida vota una sola vez
    // por caso, y sin esta guarda bastaría con duplicar el arreglo.
    if (typeof id !== "string" || !ID_CASO.test(id) || vistos.has(id)) continue;

    const opcion = item?.opcion;
    const nulo = opcion === null || opcion === undefined;
    if (!nulo && (!Number.isInteger(opcion) || opcion < 0 || opcion >= MAX_OPCIONES)) {
      continue;
    }

    vistos.add(id);
    campos.push(`${id}:${nulo ? SIN_RESPONDER : opcion}`);
  }

  return campos;
}

// Devuelve { "F01": { "0": 12, "2": 3, "t": 1 }, ... } para los casos
// pedidos. Se lee el hash entero —son ~150 campos— porque un HGETALL sale
// más barato que seis HMGET encadenados.
async function conteos(casos) {
  const pedidos = new Set(casos);
  let crudo;

  if (hayRedis) {
    const db = await redis();
    crudo = Object.entries((await db.hgetall(CLAVE_RESPUESTAS)) ?? {});
  } else {
    crudo = [...memoriaRespuestas.entries()];
  }

  const salida = {};
  for (const [campo, valor] of crudo) {
    const corte = campo.lastIndexOf(":");
    const id = campo.slice(0, corte);
    if (!pedidos.has(id)) continue;
    (salida[id] ??= {})[campo.slice(corte + 1)] = Number(valor) || 0;
  }
  return salida;
}

async function cuantos() {
  if (!hayRedis) return memoria.length;
  const db = await redis();
  return await db.zcard(CLAVE);
}

async function consultar(req, res) {
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

  // La pantalla de sala necesita además cuántos han jugado en total: el
  // tope son diez filas y «10 candidatos» diría poco en un salón de
  // cuarenta. Va tras un parámetro para no cambiarle la forma a la
  // respuesta que ya consumen las demás pantallas.
  if (req.query?.datos === "sala") {
    return res.status(200).json({ filas, total: await cuantos() });
  }

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

  // El conteo de respuestas se va con el escalafón: si sobreviviera, el
  // grupo siguiente vería el desglose comparado contra el grupo anterior.
  let borrados;
  if (hayRedis) {
    const db = await redis();
    borrados = await db.zcard(CLAVE);
    await db.del(CLAVE, CLAVE_RESPUESTAS);
  } else {
    borrados = memoria.length;
    memoria.length = 0;
    memoriaRespuestas.clear();
  }

  await limpiarFallos(ip);
  console.log(`Escalafón reiniciado desde ${ip}: ${borrados} registro(s) borrado(s)`);
  return res.status(200).json({ ok: true, borrados });
}
