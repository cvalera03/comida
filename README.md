# Comida 🍲

App para organizar el *batch cooking* del domingo entre dos personas: recetas, plan semanal,
lista de la compra, despensa y comparador de precios entre supermercados. Se usa desde el
iPhone como una app más (PWA) y los cambios se ven al instante en los dos móviles.

## Qué hace

| Sección | Para qué |
|---|---|
| **Semana** | Recetas elegidas para este domingo, qué falta, «Añadir lo que falta» a la compra y «Ya hemos cocinado» (marca como gastados los ingredientes que elijáis y vacía la semana). |
| **Recetas** | Crear, editar y eliminar recetas con ingredientes y cantidades, raciones, enlace, preparación y notas. El círculo de cada receta la mete o saca de la semana. |
| **Compra** | Lista agrupada por categoría, con el precio más barato conocido. Se marca al ir metiendo en el carro (**funciona sin cobertura**: los cambios se envían al volver la red). «Terminar compra» pasa lo comprado a la despensa. |
| **Despensa** | Inventario: qué hay y qué falta. Pulsar «Tengo» → pasa a «Falta» y se añade a la compra. Los **básicos/especias** no se gastan al cocinar: los marcáis vosotros cuando se acaben. En cada producto se apunta **precio y calidad (★1–5) por supermercado**. |
| **Ahorro** | Calcula dónde comprar la lista para que salga más barata: eliges el máximo de supermercados a visitar, la calidad mínima y cuánto pesa la calidad frente al precio. Muestra la compra repartida por tienda, el total, el ahorro frente a ir a un solo súper y qué productos no tienen precio aún. |

### Cómo funciona por dentro

```
 iPhone A ─┐   HTTPS (Tailscale)          ZimaOS (Docker)
           ├──────────────────────▶  contenedor "comida"  ──▶ /DATA/AppData/comida
 iPhone B ─┘   ◀── eventos en vivo ──   Python + SQLite           comida.db, config.json
```

- **Servidor**: `server.py`, solo librería estándar de Python (sin dependencias). API JSON + SQLite.
- **Tiempo real**: Server-Sent Events. Cuando uno cambia algo, el otro móvil se actualiza en <1 s.
- **Cliente**: PWA en HTML/CSS/JS sin frameworks ni compilación (`public/`). Guarda una copia local
  de los datos y un service worker para abrir al instante y funcionar sin conexión.
- **Acceso**: una contraseña compartida. La sesión dura ~13 meses. Si cambias la contraseña,
  se cierran todas las sesiones.
- **Imagen Docker**: ~18 MB, amd64 y arm64. El proceso corre como usuario sin privilegios.

## Instalar en ZimaOS

Elige **una** de las dos opciones.

### Opción A — Desde la interfaz de ZimaOS (recomendada)

1. Sube este proyecto a un repositorio de GitHub llamado `comida` (puede ser privado).
   El workflow `.github/workflows/docker.yml` construye y publica la imagen
   `ghcr.io/<tu-usuario>/comida:latest` automáticamente en cada push a `main`.
2. En GitHub → tu perfil → **Packages** → `comida` → *Package settings* → **Change visibility → Public**
   (la imagen no contiene datos ni contraseñas; así ZimaOS puede descargarla sin credenciales).
3. Edita `zimaos/comida.yml`: cambia `TU_USUARIO_GITHUB` y `APP_PASSWORD`.
4. En ZimaOS: **App Store → «+» (arriba a la derecha) → Install a customized app → Import**,
   pega el contenido de `zimaos/comida.yml` y dale a instalar.
5. Abre `http://<ip-del-zimaos>:8420`.

### Actualizar a una versión nueva

1. `git push` desde el Mac y espera a que la Action termine en verde
   ([pestaña Actions](https://github.com/cvalera03/comida/actions), unos 2 minutos).
2. En el Terminal de ZimaOS (o por SSH), descarga la imagen nueva y recrea el contenedor
   (todo con `sudo`: el usuario normal de ZimaOS no tiene acceso a Docker):
   ```bash
   sudo docker pull ghcr.io/cvalera03/comida:latest && DIR=$(sudo docker inspect comida --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}') && sudo docker compose --project-directory "$DIR" up -d
   ```
   Alternativa sin comandos para el segundo paso: icono de Comida → ⋮ → Settings → Save.
3. En los iPhone, cerrad la app (deslizar hacia arriba) y abridla de nuevo. Si aún se ve la
   versión anterior, repetidlo una vez más.

Los datos no se tocan: viven en `/DATA/AppData/comida` y el servidor adapta la base de datos
a la versión nueva automáticamente al arrancar.

### Opción B — Por SSH, construyendo en el propio servidor

```bash
scp -r Comida root@<ip-del-zimaos>:/DATA/AppData/comida-src
```
```bash
ssh root@<ip-del-zimaos>
```
```bash
cd /DATA/AppData/comida-src && APP_PASSWORD='vuestra-contraseña' docker compose up -d --build
```

Los datos quedan en `/DATA/AppData/comida` (se cambia con `DATA_PATH=...`).

## Acceder desde fuera de casa (gratis): Tailscale

Tailscale crea una red privada entre el servidor y vuestros móviles, sin abrir puertos del router.

1. En ZimaOS: **App Store → Tailscale → Instalar** e inicia sesión.
2. En los dos iPhone: instala **Tailscale** desde la App Store con la misma cuenta
   (o invita a tu pareja a tu tailnet). Deja activado *VPN On Demand* para que siempre esté conectado.
3. Ya podéis abrir `http://<nombre-del-zimaos>:8420` desde cualquier sitio.

**Recomendado — HTTPS**: el modo sin conexión completo de iOS (service worker) necesita HTTPS.
En la consola de Tailscale activa *DNS → MagicDNS* y *HTTPS Certificates*, y luego en ZimaOS:

```bash
docker exec tailscale tailscale serve --bg 8420
```

(Si el contenedor de Tailscale tiene otro nombre, míralo con `docker ps`.) Usad entonces
`https://<nombre-del-zimaos>.<tu-tailnet>.ts.net`.

> Alternativa: **Cloudflare Tunnel** (también disponible como app en ZimaOS) si preferís una URL
> pública con dominio propio (~10 €/año el dominio). La contraseña protege la app, pero Tailscale
> es más seguro porque la app no queda expuesta a Internet.

## Instalar en los iPhone

1. Abre la URL en **Safari** (tiene que ser Safari).
2. Botón **Compartir → Añadir a pantalla de inicio**.
3. Abre «Comida» desde el icono y entra con la contraseña. Hacedlo en los dos móviles.

## Copias de seguridad

Todo está en `/DATA/AppData/comida/comida.db`. Opciones:

- Incluir `/DATA/AppData/comida` en la copia de seguridad de ZimaOS.
- Descargar un JSON con todo (con la sesión iniciada): `https://<url>/api/export`.

## Desarrollo en el Mac

Sin Docker (solo necesita Python 3.9+):

```bash
APP_PASSWORD=prueba DATA_DIR=./data python3 server.py
```

Con Docker (Colima ya está instalado en este Mac):

```bash
colima start
```
```bash
APP_PASSWORD=prueba DATA_PATH=./data docker compose up --build
```

Abrir `http://localhost:8420` (con Docker) o `http://localhost:8080` (sin Docker).
Tras cambiar ficheros de `public/`, sube la versión de `CACHE` en `public/sw.js` para que los
móviles descarguen la nueva versión. Iconos: `python3 tools/make_icons.py`.

### API (resumen)

`GET /api/state` devuelve todo; `GET /api/events` es el canal en vivo. Escritura:
`/api/products`, `/api/products/:id/out`, `/api/stores`, `PUT /api/prices`, `/api/recipes`,
`/api/plan/{generate-list,cooked,clear}`, `/api/shopping`, `/api/shopping/{finish,clear}`.

## Ideas para más adelante

- Importar recetas desde una URL (leyendo el `schema.org/Recipe` de la web).
- Historial de precios por producto y aviso cuando algo sube.
- Menú por días (qué táper toca cada día) y fecha de caducidad de cada táper.
- Varias listas (p. ej. «compra grande del mes»).
