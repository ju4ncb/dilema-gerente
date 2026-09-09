/* El Dilema del Gerente — lógica de la evaluación */

const CONFIG = {
  videos: {
    // Para poner subtítulos, agregue `subtitulos: "videos/apertura.vtt"`
    // a la escena: reproducir() engancha la pista sola si el campo existe.
    apertura: {
      src: "videos/escena1-2-llamada-oficina.mp4",
      pie: "Escenas 1 y 2 — La llamada y la propuesta",
    },
    aprobado: {
      src: "videos/escena4a-aprobado.mp4",
      pie: "Escena 4A — El veredicto",
    },
    reprobado: {
      src: "videos/escena4b-reprobado.mp4",
      pie: "Escena 4B — El veredicto",
    },
  },
  estructura: { facil: 3, media: 2, dificil: 1 },
  // Segundos por caso. Decidir a tiempo también es parte del criterio:
  // si el reloj llega a cero, el caso queda en cero.
  limites: { facil: 60, media: 90, dificil: 120 },
  puntajeMaximo: 19,
  umbralAprobacion: 10,
  api: "/api/leaderboard",
  claveRegistro: "dilema:candidato",
  topeInicio: 5,
  topeRanking: 10,
  // Uno de cada N casos muestra el perro fantasma en la esquina.
  probabilidadPerro: 25,
};

const FASES = {
  facil: "Fase 1 — Criterio básico",
  media: "Fase 2 — Decisiones en tensión",
  dificil: "Fase 3 — El dilema",
};

// Umbrales de aviso de la cuenta regresiva, en segundos.
const AVISOS = [30, 10];

// Frases de ánimo entre casos. Son deliberadamente neutras: un "¡bien!"
// después de responder delataría el acierto, y todo el diseño se apoya en
// no dar retroalimentación hasta el dictamen.
const ALIENTOS = [
  "Siga adelante",
  "Vamos con la siguiente",
  "Mantenga el ritmo",
  "Siguiente decisión",
  "Buen ritmo",
  "Concentración",
  "Sin aflojar",
  "Ahí viene otra",
];

const estado = {
  nombre: "",
  banco: null,
  casos: [],
  indice: 0,
  respuestas: [],
  segundos: 0,
  alientos: [],
  // Reloj del caso en curso
  finCaso: 0,
  limiteCaso: 0,
  tickCaso: null,
  avisosDados: [],
  // Evita que un doble toque —o un clic que llega junto con el cero del
  // reloj— registre dos respuestas para el mismo caso.
  bloqueado: false,
  sonido: true,
};

// Cronómetro total, acumulado por tramos para poder pausarlo: los avisos
// entre casos no deben sumar al tiempo que decide el desempate.
const cronometro = { acumulado: 0, desde: null, tick: null };

const $ = (sel) => document.querySelector(sel);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Utilidades ──────────────────────────────────────────── */

function barajar(lista) {
  const copia = [...lista];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

// Para el anuncio hablado: "2:30" se lee mal, "2 minutos y 30 segundos" no.
function enPalabras(segundos) {
  const m = Math.floor(segundos / 60);
  const s = Math.round(segundos % 60);
  const partes = [];
  if (m) partes.push(`${m} ${m === 1 ? "minuto" : "minutos"}`);
  if (s) partes.push(`${s} ${s === 1 ? "segundo" : "segundos"}`);
  return partes.join(" y ") || "0 segundos";
}

function formatearTiempo(segundos) {
  const m = Math.floor(segundos / 60);
  const s = Math.floor(segundos % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Los cambios de pantalla solo se veían: el foco se quedaba en un botón
// que dejaba de existir y quien navega por teclado o lector de pantalla
// no se enteraba de nada. El dato en <body> deja que el CSS ajuste el
// fondo y los márgenes según la pantalla en curso.
function mostrar(nombrePantalla, selectorFoco) {
  document.querySelectorAll(".pantalla").forEach((p) => {
    p.classList.toggle("activa", p.dataset.pantalla === nombrePantalla);
  });
  // `vista` y no `pantalla`: si se repite el nombre del atributo de las
  // secciones, un querySelector('[data-pantalla=...]') devuelve el <body>.
  document.body.dataset.vista = nombrePantalla;
  window.scrollTo(0, 0);
  if (selectorFoco) $(selectorFoco)?.focus({ preventScroll: true });
}

function anunciar(texto) {
  $("#anuncio").textContent = texto;
}

const sinMovimiento = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ── Cronómetro total ────────────────────────────────────── */

function arrancarCronometro() {
  if (cronometro.desde !== null) return;
  cronometro.desde = Date.now();
  cronometro.tick ??= setInterval(refrescarCronometro, 250);
}

function pausarCronometro() {
  if (cronometro.desde === null) return;
  cronometro.acumulado += Date.now() - cronometro.desde;
  cronometro.desde = null;
}

function detenerCronometro() {
  pausarCronometro();
  clearInterval(cronometro.tick);
  cronometro.tick = null;
}

function segundosCronometro() {
  const enCurso = cronometro.desde === null ? 0 : Date.now() - cronometro.desde;
  return (cronometro.acumulado + enCurso) / 1000;
}

function refrescarCronometro() {
  $("#reloj").textContent = formatearTiempo(segundosCronometro());
}

/* ── Avisos emergentes ───────────────────────────────────── */

function mostrarAviso(texto, tono) {
  const caja = $("#destello");
  const recuadro = $("#destello-caja");

  $("#destello-texto").textContent = texto;
  caja.className = `destello ${tono}`;
  caja.hidden = false;

  // Reinicia la animación del recuadro sin esconder el velo: así la cuenta
  // 1-2-3 late en cada número en vez de parpadear la página entre pasos.
  recuadro.style.animation = "none";
  void recuadro.offsetWidth;
  recuadro.style.animation = "";

  anunciar(texto);
}

function ocultarAviso() {
  $("#destello").hidden = true;
}

// El cronómetro no corre mientras hay un aviso encima: el tiempo que se
// va en las transiciones no debe pesar en el desempate del escalafón.
async function aviso(texto, tono = "neutro", ms = 1500) {
  const corria = cronometro.desde !== null;
  if (corria) pausarCronometro();

  mostrarAviso(texto, tono);
  await dormir(sinMovimiento() ? Math.min(ms, 700) : ms);
  ocultarAviso();

  if (corria) arrancarCronometro();
}

// Entre el final de la cinemática y la primera pregunta había un corte
// seco. La cuenta prepara y, de paso, avisa de que el reloj va a arrancar.
async function cuentaAtras() {
  const paso = sinMovimiento() ? 380 : 620;
  for (const numero of ["1", "2", "3"]) {
    mostrarAviso(numero, "cuenta");
    await dormir(paso);
  }
  mostrarAviso("¡Empieza!", "exito");
  await dormir(paso + 200);
  ocultarAviso();
}

function siguienteAliento() {
  if (!estado.alientos.length) estado.alientos = barajar(ALIENTOS);
  return estado.alientos.pop();
}

/* ── Inicio ──────────────────────────────────────────────── */

// El banco se pide al cargar la página, no al pulsar el botón. Así el
// arranque es inmediato y, sobre todo, reproducir() sigue colgando del
// toque del usuario: iOS bloquea el play si media un `await`.
const bancoPromesa = fetch("preguntas.json")
  .then((r) => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  })
  .then((datos) => (estado.banco = datos));

function prepararInicio() {
  const registrado = localStorage.getItem(CONFIG.claveRegistro);
  if (registrado) {
    const nota = $("#nota-registro");
    nota.querySelector("strong").textContent = registrado;
    nota.hidden = false;
  }

  // En un celular no hay teclas 1–5 que ofrecer.
  if (matchMedia("(hover: hover) and (pointer: fine)").matches) {
    $("#ayuda-caso").textContent =
      "Elija con las teclas 1–5 o haga clic en una opción.";
    $("#nombre").focus();
  }

  cargarEscalafonInicio();
  prepararReinicio();
  prepararPerro();
}

// El perro de la esquina no tiene nada que ver con la evaluación: es un
// huevo de pascua. Un clic lo premia con confeti y su propio sonido.
function prepararPerro() {
  document.querySelectorAll(".dumb-dog").forEach((perro) => {
    perro.onclick = () => {
      lanzarConfeti(perro);
      const sfx = new Audio("confetti.mp3");
      sfx.volume = 0.67;
      sfx.play().catch(() => {});
    };
  });
}

// El perro solo se asoma en uno de cada veinticinco casos: si saliera
// siempre dejaría de ser un hallazgo y pasaría a ser decorado.
function sortearPerroDelCaso() {
  const perro = $("#dumb-dog-caso");
  if (!perro) return;
  perro.hidden = Math.random() >= 1 / CONFIG.probabilidadPerro;
}

function lanzarConfeti(origen) {
  const capa = $("#confeti-lluvia");
  if (!capa || matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const rect = origen.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const colores = ["#c9a227", "#c6d2de", "#ce9155", "#4fa985", "#e8776d"];

  for (let i = 0; i < 26; i++) {
    const pieza = document.createElement("i");
    pieza.className = "confeti-pieza";
    const dx = (Math.random() - 0.5) * 90;
    const caida = 220 + Math.random() * 220;
    pieza.style.setProperty("--x0", `${cx + (Math.random() - 0.5) * 20}px`);
    pieza.style.setProperty("--y0", `${cy}px`);
    pieza.style.setProperty("--x1", `${cx + dx}px`);
    pieza.style.setProperty("--y1", `${cy + caida}px`);
    pieza.style.setProperty("--rot", `${180 + Math.random() * 540}deg`);
    pieza.style.animationDuration = `${900 + Math.random() * 500}ms`;
    pieza.style.animationDelay = `${Math.random() * 220}ms`;
    pieza.style.background = colores[i % colores.length];
    pieza.addEventListener("animationend", () => pieza.remove());
    capa.appendChild(pieza);
  }
}

function iniciar() {
  const campo = $("#nombre");
  const error = $("#error-nombre");
  const boton = $("#btn-iniciar");
  const nombre = campo.value.trim();

  if (boton.disabled) return;

  if (nombre.length < 2) {
    error.textContent = "Escriba su nombre para continuar.";
    error.hidden = false;
    campo.focus();
    return;
  }
  error.hidden = true;
  estado.nombre = nombre;

  if (estado.banco) return arrancarPartida();

  // Solo se llega aquí si la red va lenta y el banco no alcanzó a cargar.
  boton.disabled = true;
  boton.textContent = "Cargando los casos…";
  bancoPromesa.then(arrancarPartida).catch(() => {
    boton.disabled = false;
    boton.textContent = "Presentarse a la evaluación";
    error.textContent =
      "No se pudo cargar el banco de casos. Revise que preguntas.json esté publicado.";
    error.hidden = false;
  });
}

function arrancarPartida() {
  estado.casos = armarRonda(estado.banco);
  estado.respuestas = [];
  estado.indice = 0;
  estado.alientos = barajar(ALIENTOS);
  cronometro.acumulado = 0;
  cronometro.desde = null;
  $("#total-casos").textContent = estado.casos.length;

  reproducir("apertura", comenzarCasos);
}

function armarRonda(banco) {
  const ronda = [];
  for (const [nivel, cantidad] of Object.entries(CONFIG.estructura)) {
    barajar(banco[nivel])
      .slice(0, cantidad)
      .forEach((caso) => {
        ronda.push({ ...caso, nivel, opciones: barajar(caso.opciones) });
      });
  }
  return ronda;
}

/* ── Cinemática ──────────────────────────────────────────── */

function sincronizarSonido() {
  const video = $("#reproductor");
  const boton = $("#btn-sonido");
  video.muted = !estado.sonido;
  boton.setAttribute("aria-pressed", String(!estado.sonido));
  boton.classList.toggle("silenciado", !estado.sonido);
  $("#btn-sonido-texto").textContent = estado.sonido
    ? "Silenciar"
    : "Activar sonido";
}

// Los navegadores bloquean el autoplay con sonido. Antes de rendirse y
// mostrar un rectángulo negro, se reintenta en silencio: es lo que hace
// que la escena arranque igual en un celular.
async function arrancarVideo(video) {
  try {
    await video.play();
    return true;
  } catch {
    estado.sonido = false;
    sincronizarSonido();
    try {
      await video.play();
      return true;
    } catch {
      return false;
    }
  }
}

function reproducir(clave, alTerminar) {
  const { src, pie, subtitulos } = CONFIG.videos[clave];
  const video = $("#reproductor");
  const botonPlay = $("#btn-reproducir");

  $("#pie-video").textContent = pie;
  video.src = src;
  // Sin controles nativos: la escena no se adelanta ni se pausa, solo se
  // omite entera. El único mando es el de sonido.
  video.controls = false;
  video.disablePictureInPicture = true;
  botonPlay.hidden = true;
  sincronizarSonido();

  video.querySelectorAll("track").forEach((t) => t.remove());
  if (subtitulos) {
    const pista = document.createElement("track");
    pista.kind = "captions";
    pista.srclang = "es";
    pista.label = "Español";
    pista.src = subtitulos;
    pista.default = true;
    video.appendChild(pista);
  }

  // El foco va al contenedor, nunca al botón de omitir: si cae ahí, la
  // misma tecla Enter que arrancó la partida lo activa y se salta la escena.
  mostrar("video", "#escena");

  const seguir = () => {
    video.onended = null;
    video.onerror = null;
    $("#btn-saltar").onclick = null;
    $("#btn-sonido").onclick = null;
    botonPlay.onclick = null;
    botonPlay.hidden = true;
    video.pause();
    alTerminar();
  };

  video.onended = seguir;
  $("#btn-saltar").onclick = seguir;
  $("#btn-sonido").onclick = () => {
    estado.sonido = !estado.sonido;
    sincronizarSonido();
  };

  // Si el archivo no carga, ofrecer «toque para reproducir» es engañoso:
  // no hay nada que reproducir y solo queda omitir la escena.
  let roto = false;
  video.onerror = () => {
    roto = true;
    $("#pie-video").textContent = `${pie} — el video no se pudo cargar`;
    botonPlay.hidden = true;
  };

  // Si el navegador bloquea la reproducción automática, se ofrece un botón
  // grande en vez de dejar un rectángulo negro sin explicación.
  arrancarVideo(video).then((arrancó) => {
    if (arrancó || roto) return;
    botonPlay.hidden = false;
    botonPlay.onclick = () => {
      botonPlay.hidden = true;
      arrancarVideo(video);
    };
  });
}

/* ── Casos ───────────────────────────────────────────────── */

async function comenzarCasos() {
  await cuentaAtras();

  // El atajo se engancha después de la cuenta: si estuviera activo antes,
  // una tecla 1-5 llamaría a responder() sin que existan los botones.
  document.addEventListener("keydown", atajoTeclado);
  arrancarCronometro();
  pintarCaso();
}

function pintarCaso() {
  const caso = estado.casos[estado.indice];
  const total = estado.casos.length;

  estado.bloqueado = false;

  $("#num-caso").textContent = estado.indice + 1;
  $("#fase-caso").textContent = FASES[caso.nivel];
  // El avance cuenta el caso que se está respondiendo, no los ya cerrados:
  // de lo contrario la barra arrancaba en cero y terminaba en 5/6.
  $("#barra-avance").style.width = `${((estado.indice + 1) / total) * 100}%`;
  $("#enunciado").textContent = caso.pregunta;

  const lista = $("#opciones");
  lista.innerHTML = "";

  caso.opciones.forEach((opcion, i) => {
    const li = document.createElement("li");
    const boton = document.createElement("button");
    boton.className = "opcion";
    boton.type = "button";

    const tecla = document.createElement("span");
    tecla.className = "tecla";
    tecla.setAttribute("aria-hidden", "true");
    tecla.textContent = i + 1;

    const texto = document.createElement("span");
    texto.className = "opcion-texto";
    texto.textContent = opcion.texto;

    boton.append(tecla, texto);
    boton.onclick = () => responder(i);
    li.appendChild(boton);
    lista.appendChild(li);
  });

  sortearPerroDelCaso();

  mostrar("caso", "#enunciado");
  anunciar(
    `Caso ${estado.indice + 1} de ${total}. ${FASES[caso.nivel]}. Tiene ${enPalabras(CONFIG.limites[caso.nivel])}.`,
  );

  arrancarRelojCaso(CONFIG.limites[caso.nivel]);
}

/* ── Reloj del caso ──────────────────────────────────────── */

function arrancarRelojCaso(limite) {
  detenerRelojCaso();

  estado.limiteCaso = limite;
  estado.finCaso = Date.now() + limite * 1000;
  estado.avisosDados = [];

  pintarRelojCaso(limite);
  estado.tickCaso = setInterval(() => {
    const restante = (estado.finCaso - Date.now()) / 1000;
    if (restante <= 0) {
      pintarRelojCaso(0);
      agotarTiempo();
      return;
    }
    pintarRelojCaso(restante);
  }, 200);
}

function detenerRelojCaso() {
  clearInterval(estado.tickCaso);
  estado.tickCaso = null;
}

function pintarRelojCaso(restante) {
  const reloj = $("#reloj-caso");
  const barra = $("#barra-tiempo");

  reloj.textContent = formatearTiempo(Math.ceil(restante));
  barra.style.width = `${Math.max(0, (restante / estado.limiteCaso) * 100)}%`;

  const critico = restante <= 10;
  const alerta = restante <= 30;
  reloj.classList.toggle("alerta", alerta && !critico);
  reloj.classList.toggle("critico", critico);
  barra.classList.toggle("alerta", alerta && !critico);
  barra.classList.toggle("critico", critico);

  // Sin esto la cuenta regresiva sería puramente visual: un lector de
  // pantalla no la anuncia porque cambia cada 200 ms.
  for (const umbral of AVISOS) {
    if (restante <= umbral && !estado.avisosDados.includes(umbral)) {
      estado.avisosDados.push(umbral);
      anunciar(`Quedan ${umbral} segundos.`);
    }
  }
}

async function agotarTiempo() {
  if (estado.bloqueado) return;
  estado.bloqueado = true;
  detenerRelojCaso();

  const caso = estado.casos[estado.indice];
  document.querySelectorAll(".opcion").forEach((b) => (b.disabled = true));

  registrar(caso, null, 0);
  // Este aviso ya hace de transición: no se le encima uno de ánimo.
  await aviso("¡Tiempo acabado!", "alerta");
  avanzar(0, { aliento: false });
}

/* ── Respuesta ───────────────────────────────────────────── */

function atajoTeclado(evento) {
  const n = parseInt(evento.key, 10);
  const caso = estado.casos[estado.indice];
  if (caso && n >= 1 && n <= caso.opciones.length) responder(n - 1);
}

function responder(indiceOpcion) {
  if (estado.bloqueado) return;
  estado.bloqueado = true;
  detenerRelojCaso();

  const caso = estado.casos[estado.indice];
  const elegida = caso.opciones[indiceOpcion];

  const botones = document.querySelectorAll(".opcion");
  botones.forEach((b) => (b.disabled = true));
  botones[indiceOpcion].classList.add("elegida");

  registrar(caso, elegida.texto, elegida.puntos);
  avanzar(320, { aliento: true, avisoFinal: "¡Preguntas realizadas!" });
}

function registrar(caso, textoElegido, puntos) {
  const mejor = caso.opciones.reduce((a, b) => (b.puntos > a.puntos ? b : a));
  estado.respuestas.push({
    pregunta: caso.pregunta,
    nivel: caso.nivel,
    elegida: textoElegido,
    puntos,
    maximo: mejor.puntos,
    mejor: mejor.texto,
  });
}

// `avisoFinal` solo se muestra si este era el último caso: sirve de
// transición hacia la cinemática del veredicto.
function avanzar(espera, { aliento = true, avisoFinal = null } = {}) {
  estado.indice++;
  setTimeout(async () => {
    if (estado.indice < estado.casos.length) {
      if (aliento) await aviso(siguienteAliento(), "aliento", 1000);
      pintarCaso();
      return;
    }
    if (avisoFinal) await aviso(avisoFinal, "exito");
    cerrarEvaluacion();
  }, espera);
}

/* ── Veredicto ───────────────────────────────────────────── */

function cerrarEvaluacion() {
  detenerCronometro();
  detenerRelojCaso();
  document.removeEventListener("keydown", atajoTeclado);
  estado.segundos = Math.round(segundosCronometro());

  const puntos = estado.respuestas.reduce((suma, r) => suma + r.puntos, 0);
  const aprobado = puntos >= CONFIG.umbralAprobacion;

  reproducir(aprobado ? "aprobado" : "reprobado", async () => {
    // Sin esto se pasaba del último fotograma al dictamen de un tirón.
    await aviso("Dictamen final", "neutro", 1100);
    pintarVeredicto(puntos, aprobado);
  });
}

function pintarVeredicto(puntos, aprobado) {
  const porcentaje = Math.round((puntos / CONFIG.puntajeMaximo) * 100);

  const sello = $("#sello");
  sello.className = `sello ${aprobado ? "aprobado" : "reprobado"}`;
  $("#sello-texto").textContent = aprobado ? "Aprobado" : "No aprobado";

  $("#titulo-veredicto").textContent = aprobado
    ? `${estado.nombre}, el cargo es suyo`
    : `${estado.nombre}, todavía no`;

  $("#dictamen").textContent = aprobado
    ? "Demostró que el liderazgo no solo busca ganancias: también protege a las personas, la información y el entorno. Desde hoy es Gerente de Operaciones y Sostenibilidad."
    : "Un líder que antepone los resultados a la ética pone en riesgo a toda la organización. Refuerce sus criterios de responsabilidad y sostenibilidad antes de postularse a un cargo de dirección.";

  $("#cifra-puntos").textContent = puntos;
  $("#cifra-porcentaje").textContent = `${porcentaje}%`;
  $("#cifra-tiempo").textContent = formatearTiempo(estado.segundos);

  pintarDesglose();

  localStorage.setItem(CONFIG.claveRegistro, estado.nombre);
  enviarPuntaje(puntos);
  mostrar("veredicto", "#titulo-veredicto");
}

// El desglose muestra el enunciado: sin la pregunta a la vista no se
// puede discutir en grupo por qué una opción vale 2 y no 3.
function pintarDesglose() {
  const lista = $("#lista-desglose");
  lista.innerHTML = "";

  estado.respuestas.forEach((r, i) => {
    const li = document.createElement("li");
    const acerto = r.puntos === r.maximo;
    li.className = acerto ? "acierto" : "fallo";

    const rotulo = document.createElement("p");
    rotulo.className = "desglose-rotulo";
    rotulo.textContent = `Caso ${i + 1} · ${FASES[r.nivel]}`;

    const pregunta = document.createElement("p");
    pregunta.className = "desglose-pregunta";
    pregunta.textContent = r.pregunta;

    const suya = document.createElement("p");
    suya.className = "desglose-suya";
    const etiqueta = document.createElement("span");
    etiqueta.className = "desglose-etiqueta";
    etiqueta.textContent =
      r.elegida === null ? "Sin responder:" : "Su respuesta:";
    const texto = document.createElement("span");
    texto.textContent = ` ${r.elegida ?? "se agotó el tiempo del caso"}`;
    suya.append(etiqueta, texto);

    const marca = document.createElement("p");
    marca.className = "desglose-puntos";
    marca.textContent = `${r.puntos} de ${r.maximo} pt${r.maximo === 1 ? "" : "s"}`;

    li.append(rotulo, pregunta, suya, marca);

    if (!acerto) {
      const ideal = document.createElement("p");
      ideal.className = "desglose-ideal";
      const et = document.createElement("span");
      et.className = "desglose-etiqueta";
      et.textContent = "Mejor opción:";
      const tx = document.createElement("span");
      tx.textContent = ` ${r.mejor}`;
      ideal.append(et, tx);
      li.appendChild(ideal);
    }

    lista.appendChild(li);
  });
}

/* ── Escalafón ───────────────────────────────────────────── */

async function enviarPuntaje(puntos) {
  try {
    await fetch(CONFIG.api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nombre: estado.nombre,
        puntos,
        segundos: estado.segundos,
      }),
    });
  } catch {
    // Sin conexión al escalafón la evaluación sigue siendo válida.
  }
}

async function consultarEscalafon() {
  const respuesta = await fetch(CONFIG.api);
  if (!respuesta.ok) throw new Error(respuesta.status);
  return respuesta.json();
}

// Una sola forma de dibujar el escalafón, usada en el arranque y al final.
// La barra hace comparable de un vistazo lo que una columna de números
// obliga a leer fila por fila.
function construirEscalafon(filas, tope) {
  const lista = document.createElement("ol");
  lista.className = "escalafon";

  filas.slice(0, tope).forEach((fila, i) => {
    const li = document.createElement("li");
    li.className = "puesto";
    if (i < 3) li.classList.add(`podio-${i + 1}`);
    if (estado.nombre && fila.nombre === estado.nombre)
      li.classList.add("propio");

    const num = document.createElement("span");
    num.className = "puesto-num";
    num.textContent = i + 1;

    const datos = document.createElement("div");
    datos.className = "puesto-datos";

    const nombre = document.createElement("p");
    nombre.className = "puesto-nombre";
    nombre.textContent = fila.nombre;

    const medidor = document.createElement("div");
    medidor.className = "medidor";
    const relleno = document.createElement("i");
    relleno.style.width = `${Math.round((fila.puntos / CONFIG.puntajeMaximo) * 100)}%`;
    medidor.appendChild(relleno);

    datos.append(nombre, medidor);

    const marcas = document.createElement("div");
    marcas.className = "puesto-marcas";
    const pts = document.createElement("strong");
    pts.textContent = fila.puntos;
    const tiempo = document.createElement("span");
    tiempo.textContent = formatearTiempo(fila.segundos);
    marcas.append(pts, tiempo);

    li.append(num, datos, marcas);
    lista.appendChild(li);
  });

  return lista;
}

// En el arranque el escalafón es un extra: si falla o está vacío se
// esconde entero, sin avisos de error que estorben antes de empezar.
// También se vuelve a llamar tras un reinicio, así que tiene que saber
// ocultarse, no solo aparecer.
async function cargarEscalafonInicio() {
  const seccion = $("#avance-escalafon");
  const caja = $("#escalafon-inicio");

  const esconder = () => {
    caja.innerHTML = "";
    seccion.hidden = true;
  };

  let filas;
  try {
    filas = await consultarEscalafon();
  } catch {
    return esconder();
  }
  if (!filas.length) return esconder();

  caja.innerHTML = "";
  caja.appendChild(construirEscalafon(filas, CONFIG.topeInicio));
  seccion.hidden = false;
}

/* ── Reinicio del escalafón ──────────────────────────────── */

function cerrarFormaPin() {
  $("#forma-pin").hidden = true;
  $("#btn-abrir-pin").setAttribute("aria-expanded", "false");
  $("#pin").value = "";
  $("#error-pin").hidden = true;
}

async function reiniciarEscalafon(evento) {
  evento.preventDefault();

  const campo = $("#pin");
  const error = $("#error-pin");
  const boton = $("#btn-confirmar-pin");
  const pin = campo.value.trim();

  if (!pin) {
    error.textContent = "Escriba el PIN.";
    error.hidden = false;
    campo.focus();
    return;
  }

  boton.disabled = true;
  boton.textContent = "Borrando…";

  let respuesta;
  try {
    // El PIN viaja en una cabecera y se compara contra el servidor. Aquí
    // no hay nada que comparar: el navegador no guarda el secreto.
    respuesta = await fetch(CONFIG.api, {
      method: "DELETE",
      headers: { "x-admin-pin": pin },
    });
  } catch {
    error.textContent = "No se pudo contactar al servidor.";
    error.hidden = false;
    boton.disabled = false;
    boton.textContent = "Borrar";
    return;
  }

  boton.disabled = false;
  boton.textContent = "Borrar";

  if (!respuesta.ok) {
    const cuerpo = await respuesta.json().catch(() => ({}));
    error.textContent = cuerpo.error ?? "No se pudo reiniciar el escalafón.";
    error.hidden = false;
    campo.select();
    return;
  }

  const { borrados } = await respuesta.json().catch(() => ({ borrados: 0 }));
  cerrarFormaPin();
  await cargarEscalafonInicio();
  await aviso(
    `Escalafón reiniciado · ${borrados} registro${borrados === 1 ? "" : "s"}`,
    "exito",
    1400,
  );
  $("#btn-abrir-pin").focus();
}

function prepararReinicio() {
  const forma = $("#forma-pin");
  const abrir = $("#btn-abrir-pin");

  abrir.onclick = () => {
    const abriendo = forma.hidden;
    forma.hidden = !abriendo;
    abrir.setAttribute("aria-expanded", String(abriendo));
    if (abriendo) $("#pin").focus();
    else cerrarFormaPin();
  };

  $("#btn-cancelar-pin").onclick = () => {
    cerrarFormaPin();
    abrir.focus();
  };

  forma.addEventListener("submit", reiniciarEscalafon);
}

async function pintarRanking() {
  mostrar("ranking", "#foco-ranking");
  const contenedor = $("#contenedor-ranking");
  contenedor.innerHTML = `<p class="cargando">Consultando el escalafón…</p>`;

  let filas;
  try {
    filas = await consultarEscalafon();
  } catch {
    contenedor.innerHTML = `<p class="vacio">El escalafón no está disponible. Conecte el almacenamiento en Vercel para guardar los resultados.</p>`;
    return;
  }

  if (!filas.length) {
    contenedor.innerHTML = `<p class="vacio">Nadie ha completado la evaluación todavía.</p>`;
    return;
  }

  contenedor.innerHTML = "";
  contenedor.appendChild(construirEscalafon(filas, CONFIG.topeRanking));
}

/* ── Arranque ────────────────────────────────────────────── */

$("#btn-iniciar").onclick = iniciar;
$("#nombre").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  // Sin esto la pulsación sigue viva cuando ya cambió la pantalla y activa
  // el elemento que acaba de recibir el foco: la cinemática se saltaba sola.
  e.preventDefault();
  iniciar();
});
$("#btn-ranking").onclick = pintarRanking;
$("#btn-reiniciar").onclick = () => location.reload();

mostrar("inicio");
prepararInicio();
