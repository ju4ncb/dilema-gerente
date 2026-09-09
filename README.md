# El Dilema del Gerente

Juego de evaluación sobre liderazgo ético y sostenible. El candidato responde
seis casos y recibe un dictamen: el ascenso a Gerente de Operaciones y
Sostenibilidad, o el rechazo.

## Cómo funciona una partida

1. El candidato escribe su nombre.
2. Se reproduce el video de apertura, que junta las escenas 1 y 2 (la
   llamada y la propuesta).
3. Arranca el cronómetro y aparecen seis casos, tomados al azar del banco:
   - 3 de 15 casos fáciles (4 opciones, de 0 a 3 puntos, 1:00 cada uno)
   - 2 de 10 casos de dificultad media (4 opciones, de 0 a 3 puntos, 1:30)
   - 1 de 5 casos difíciles (5 opciones: tres de 0, una de 3, la mejor de 4, 2:00)
4. Se reproduce la escena 4A o la 4B según el puntaje.
5. Se muestra el dictamen con el desglose caso por caso y el escalafón.

El escalafón también se ve en la pantalla de inicio, con los cinco
mejores: saber contra quién se compite es lo que hace que valga la pena
competir. Si no hay almacenamiento conectado o todavía no hay puntajes,
ese bloque simplemente no aparece.

El puntaje máximo es **19**. El umbral de aprobación es **10 puntos**, es decir
más del 50% que exige el guion. El orden de las opciones se baraja en cada
partida, así que nadie puede memorizar posiciones.

El cronómetro corre solo durante los casos: se detiene mientras se reproducen
los videos, para que el ranking mida decisiones y no lo que tarda un video.

## El tiempo

Hay dos relojes a la vista, y miden cosas distintas.

**La cuenta regresiva del caso** es el número grande. Cada caso tiene su
propio límite —1:00 los fáciles, 1:30 los medios, 2:00 el difícil— y el
filo superior de la tarjeta se vacía a medida que corre: pasa a ámbar a
los 30 segundos y a rojo a los 10. **Si llega a cero, el caso se cierra
solo y vale cero puntos**, y así queda anotado en el desglose. La idea es
que decidir a tiempo forme parte del criterio que se evalúa: en una
gerencia, no decidir también es una decisión.

**El cronómetro total** es el número pequeño de abajo. Suma todos los
casos y es lo que desempata en el escalafón entre dos puntajes iguales.

Los límites se cambian en `CONFIG.limites` dentro de `app.js`, en segundos:

```js
limites: { facil: 60, media: 90, dificil: 120 },
```

### Las transiciones

Los cortes secos entre pantallas están cubiertos con avisos breves:

| Momento | Aviso |
|---|---|
| Fin de la cinemática de apertura | cuenta **1 · 2 · 3 · ¡Empieza!** |
| Al pasar de un caso al siguiente | una frase de ánimo al azar |
| Se agota el reloj de un caso | **¡Tiempo acabado!** |
| Al responder el último caso | **¡Preguntas realizadas!** |
| Fin de la cinemática del veredicto | **Dictamen final** |

Las frases de ánimo (`ALIENTOS` en `app.js`) son a propósito **neutras**
—«Siga adelante», «Mantenga el ritmo»— y no «¡bien!» ni «¡correcto!». Un
elogio después de responder delataría el acierto, y todo el juego se
apoya en no dar retroalimentación hasta el dictamen: si el estudiante ya
sabe cómo le fue caso por caso, la discusión del final se pierde.

**El cronómetro total se pausa mientras hay un aviso encima.** El tiempo
que se va en las transiciones no debe pesar en el desempate del escalafón.
El reloj del caso tampoco corre: arranca cuando el caso ya está pintado.

## Estructura

```
index.html            Las cinco pantallas del juego
styles.css            Identidad visual
app.js                Máquina de estados, selección aleatoria, cronómetro
preguntas.json        Banco de 30 casos
api/leaderboard.js    Función serverless del escalafón
videos/               Las escenas en 480p y 1080p (ver videos/LEEME.txt)
vercel.json           Cabeceras de caché para el despliegue
dev-server.mjs        Servidor local, sin dependencias
```

## Entorno de desarrollo

Hay dos formas de levantar el proyecto en local. La primera no necesita
cuenta de Vercel ni instalar nada.

### Opción A — servidor local (recomendada para el día a día)

```bash
npm run dev          # equivale a: node dev-server.mjs
```

Abra <http://localhost:3000>. `dev-server.mjs` no tiene dependencias y
hace lo mismo que Vercel en lo que importa para este juego:

- sirve los archivos estáticos, con peticiones `Range` para que los
  videos se puedan adelantar y buscar;
- enruta `/api/leaderboard` al handler real de `api/leaderboard.js`, con
  el mismo contrato `req`/`res` (`req.body` ya parseado, `res.status()`,
  `res.json()`);
- recarga el handler cuando edita el archivo, sin reiniciar el servidor;
- carga `.env.local` si existe, igual que `vercel dev`.

**Sin credenciales de Upstash el escalafón funciona igual, guardado en
memoria.** Se pierde al reiniciar el servidor, pero permite probar el
recorrido completo —incluida la tabla de posiciones y el desempate por
tiempo— sin abrir ninguna cuenta.

Para probar contra el Redis de verdad, traiga las variables y vuelva a
levantar:

```bash
npx vercel env pull .env.local
npm run dev          # ahora dirá: escalafón: Upstash Redis
```

Un detalle importante: **no abra `index.html` con doble clic**. Con el
protocolo `file://` el navegador bloquea el `fetch` de `preguntas.json` y
el juego se queda en «No se pudo cargar el banco de casos». Siempre por
`http://localhost`.

### Opción B — `vercel dev`

```bash
npm install
npx vercel login
npx vercel link
npm run dev:vercel
```

Reproduce el entorno de Vercel con más fidelidad (rutas de `vercel.json`,
límites de las funciones, variables de entorno del proyecto). Vale la pena
correrlo al menos una vez antes de desplegar, pero para iterar sobre el
contenido y la interfaz la opción A es bastante más ágil.

### Despliegue

```bash
npm run deploy       # equivale a: vercel deploy --prod
```

### Conectar el escalafón

Los puntajes se guardan en Redis. El sistema de archivos de las funciones
serverless es efímero, así que un archivo JSON no serviría: lo escrito se
pierde en la siguiente invocación.

1. En el panel de Vercel, pestaña **Storage**, instale la integración de
   **Upstash Redis** desde el Marketplace y conéctela al proyecto.
2. Vercel inyecta `UPSTASH_REDIS_REST_URL` y `UPSTASH_REDIS_REST_TOKEN` como
   variables de entorno. `Redis.fromEnv()` las toma solo, sin configuración.
3. Para desarrollo local, traiga las variables con `npx vercel env pull`.

Sin esa integración el juego funciona completo; solo el escalafón muestra un
aviso de que no está disponible. En local, sin las variables, el escalafón
usa un almacén en memoria (ver arriba).

> **Cuidado con `vercel env pull`.** Ese comando trae las credenciales de
> **producción**. Con `.env.local` en su sitio, cada partida que juegue en
> local escribe en el escalafón real. Para probar sin ensuciar los datos
> de la clase, renombre el archivo (`mv .env.local .env.local.off`) y el
> servidor vuelve al almacén en memoria.

### Reiniciar el escalafón

**En desarrollo**, si está usando el almacén en memoria, basta con
reiniciar el servidor: `Ctrl+C` y `npm run dev`. Los puntajes viven en la
memoria del proceso y no sobreviven.

**En producción** hay tres caminos, de menos a más cómodo si lo va a
hacer seguido:

1. **Consola de Upstash.** Entre a la base desde el panel de Vercel
   (pestaña Storage), abra el *Data Browser* y borre la clave
   `dilema:escalafon`. No requiere tocar código.

2. **API REST de Upstash**, con las variables que ya tiene:

   ```bash
   curl -X POST "$UPSTASH_REDIS_REST_URL/del/dilema:escalafon"      -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"
   ```

3. **El botón de la pantalla de inicio**, que es lo más cómodo entre
   grupos. Abajo del escalafón hay un enlace discreto, *Reiniciar el
   escalafón*, que despliega un campo de PIN. El PIN por defecto es
   **103510**.

   Responde `{"ok":true,"borrados":N}` y la pantalla confirma con un
   aviso. Para scripts existe la misma ruta con la cabecera
   `x-admin-token` contra la variable `ADMIN_TOKEN`:

   ```bash
   curl -X DELETE https://SU-PROYECTO.vercel.app/api/leaderboard      -H "x-admin-pin: 103510"
   ```

   ```powershell
   # PowerShell
   Invoke-RestMethod -Method Delete `
     -Uri "https://SU-PROYECTO.vercel.app/api/leaderboard" `
     -Headers @{ "x-admin-pin" = "103510" }
   ```

#### Qué protege el PIN y qué no

El PIN **se comprueba en el servidor**, nunca en el navegador: el código
que llega al cliente no lo contiene, así que no se puede sacar leyendo el
código fuente de la página.

Pero el valor por defecto sí está en `api/leaderboard.js`, y este
repositorio es público: **cualquiera que lo abra puede leer 103510**.
Para una dinámica de aula alcanza —evita el borrado por curiosidad o por
accidente—, pero si quiere que sea de verdad secreto, defina `ADMIN_PIN`
en Vercel (**Settings → Environment Variables**) y vuelva a desplegar. La
variable reemplaza al valor por defecto, que deja de servir.

Como un PIN de seis dígitos se agota a fuerza bruta en un millón de
intentos, el endpoint lleva un contador por IP en Redis: **cinco fallos
bloquean esa IP durante 15 minutos** (`429`). El contador se borra al
acertar. En local, sin Redis, no hay contador: solo cuenta en producción,
que es donde importa.

## Las cinemáticas

Las escenas se reproducen en un escenario propio, sin los controles
nativos del reproductor: no se pueden adelantar ni pausar, solo omitir
enteras. Los únicos mandos son **Activar sonido / Silenciar** y **Omitir
escena**, sobre el video.

El escenario crece con una animación hasta un máximo de 1280×720 y toma
la proporción del video. En pantallas menores usa el ancho disponible y
hasta el 90 % del alto, lo que ocurra primero. Dos consecuencias que vale
tener presentes:

- En un celular **acostado** la escena llega al 90 % del alto: es la forma
  de verlas en grande.
- En un celular **vertical** el límite es el ancho, no el alto. Un video
  16:9 a lo ancho de la pantalla mide poco más de la mitad de esa anchura
  en alto, y llegar a 90 % de alto exigiría recortar la imagen. Se
  prefiere no recortar.

Si el navegador bloquea la reproducción automática con sonido, la escena
se reintenta en silencio y el botón queda en «Activar sonido». Solo si
tampoco eso funciona aparece un «Toque para reproducir».

### Los archivos

Son tres escenas —la apertura, que junta las escenas 1 y 2, y los dos
desenlaces— y cada una existe en dos calidades:

| | 480p (celular) | 1080p (escritorio) |
|---|---|---|
| Apertura (35 s) | 1,7 MB | 9,4 MB |
| Aprobado (10 s) | 0,6 MB | 3,3 MB |
| Reprobado (10 s) | 0,5 MB | 3,6 MB |
| **Por partida** | **~2,2 MB** | **~12,8 MB** |

El nombre sin sufijo se configura en el campo `base` de `CONFIG.videos`
dentro de `app.js`; el `.480` o `.1080` lo agrega `reproducir()`. Ver
también `videos/LEEME.txt`, que trae los comandos de `ffmpeg` para
regenerar las calidades si reemplaza una escena.

Los masters sin recomprimir quedan en `videos/originales/`, fuera del
despliegue (`.vercelignore`) y fuera del repositorio (`.gitignore`).

**Cómo se elige la calidad.** `elegirCalidad()`, en `app.js`, decide una
sola vez al cargar y no vuelve a revisar: cambiar de calidad a mitad de
escena obligaría a recargar el archivo. Manda 480p si el navegador pide
`Save-Data`, si la conexión es 2G o 3G, o si es un celular (`pointer:
coarse` con pantalla menor a 1100 px) que no confirme tener holgura de
sobra. Safari no expone `navigator.connection`, así que en iPhone gana
siempre 480p — que es justo el caso que más importa cuidar.

**Los archivos arrancan por el índice.** Todos se codifican con
`-movflags +faststart`, que mueve la caja `moov` al principio. Sin eso el
navegador tiene que bajar el archivo **entero** antes de dibujar el primer
cuadro; con eso le bastan unos 40 KB. En la apertura la diferencia es de
42,25 MB a 0,04 MB antes de que empiece a verse algo. Si regenera un
video, no omita esa bandera.

Sobre el plan gratuito de Vercel, con los pesos actuales:

| Límite del plan Hobby | Valor | Situación |
|---|---|---|
| Archivos subidos por despliegue | 100 MB | ~20 MB de video: **cabe de sobra** |
| Transferencia de datos al mes | 100 GB | ~2,2 MB por partida en celular; decenas de miles de partidas |
| Tamaño máximo de respuesta cacheada en el CDN | 10 MB | todos los archivos quedan por debajo: **se sirven desde el borde** |

Con `Cache-Control: immutable` ya puesto en `vercel.json`, cada archivo se
cachea en el CDN la primera vez y el resto de la clase lo recibe desde el
borde. Si más adelante agrega escenas y se acerca a los 100 MB, súbalas a
Cloudinary o Vercel Blob y ponga las URL completas en `CONFIG.videos`.

## Notas para la presentación

- La interfaz está pensada para que los estudiantes entren desde el
  celular: una sola columna, objetivos táctiles cómodos y la cabecera con
  el reloj pegada arriba, que si no se pierde de vista al bajar entre las
  opciones. Está probada de 320 px en adelante.
- En computador se responde además con las teclas 1 a 5, útil si va a
  proyectar y manejar el juego desde el teclado. La ayuda al pie del caso
  se adapta sola: solo menciona las teclas si hay teclado.
- Para poner subtítulos a los videos, agregue `subtitulos: "videos/x.vtt"`
  a la escena en `CONFIG.videos`; la pista se engancha sola.
- El bloqueo de "un intento por persona" usa `localStorage`, que cualquiera
  puede borrar desde la consola. Alcanza para una presentación en aula. Si
  necesita algo más firme, valide en `api/leaderboard.js` que el nombre no
  exista ya, con `ZSCORE` antes del `ZADD`.
- Los navegadores bloquean la reproducción automática con sonido hasta que
  haya una interacción del usuario. Como el primer video arranca después de
  que el candidato pulsa un botón, no hay problema; aun así el botón
  *Continuar* siempre está disponible por si un video falla.
- Vale la pena abrir el desglose caso por caso frente al grupo: en los casos
  de dificultad media, la opción de 2 puntos casi siempre es "hacer lo
  correcto de forma incompleta", y ahí está la discusión interesante.

## Editar los casos

Todo el contenido vive en `preguntas.json`. Para agregar un caso, respete la
estructura de puntajes de su nivel: fáciles y medios llevan cuatro opciones
con 0, 1, 2 y 3 puntos; los difíciles llevan cinco con 0, 0, 0, 3 y 4. Si
cambia la cantidad de casos por fase, ajuste `CONFIG.estructura`,
`CONFIG.puntajeMaximo` y `CONFIG.umbralAprobacion` en `app.js`, y
`PUNTAJE_MAXIMO` en `api/leaderboard.js`.
