#!/usr/bin/env python3
"""
Comida — servidor de la app de batch cooking.

Solo usa la librería estándar de Python (3.9+): http.server + sqlite3.
Sirve la PWA de /public, expone una API JSON en /api y empuja cambios en
tiempo real a todos los dispositivos conectados mediante Server-Sent Events.

Variables de entorno:
  APP_PASSWORD   contraseña compartida (si falta se genera y guarda en data/config.json)
  PORT           puerto (8080)
  HOST           interfaz (0.0.0.0)
  DATA_DIR       carpeta de datos (./data)
  COOKIE_SECURE  "1" para marcar la cookie como Secure (detrás de HTTPS)
"""
import hashlib
import hmac
import json
import mimetypes
import os
import queue
import re
import secrets
import sqlite3
import sys
import threading
import time
import unicodedata
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

BASE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(BASE, "public")
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE, "data"))
PORT = int(os.environ.get("PORT", "8080"))
HOST = os.environ.get("HOST", "0.0.0.0")
COOKIE_NAME = "comida_session"
COOKIE_MAX_AGE = 60 * 60 * 24 * 400  # ~13 meses: la PWA del iPhone no pide login a menudo

os.makedirs(DATA_DIR, exist_ok=True)


# ---------------------------------------------------------------- config ----

def load_config():
    path = os.path.join(DATA_DIR, "config.json")
    cfg = {}
    if os.path.exists(path):
        with open(path) as f:
            cfg = json.load(f)
    changed = False
    if "secret" not in cfg:
        cfg["secret"] = secrets.token_hex(32)
        changed = True
    if not os.environ.get("APP_PASSWORD") and "password" not in cfg:
        cfg["password"] = secrets.token_urlsafe(9)
        changed = True
    if changed:
        with open(path, "w") as f:
            json.dump(cfg, f, indent=2)
        os.chmod(path, 0o600)
    return cfg


CONFIG = load_config()
PASSWORD = os.environ.get("APP_PASSWORD") or CONFIG["password"]
SECRET = CONFIG["secret"].encode()


def make_token():
    # El token depende de la contraseña: si la cambias, se cierran todas las sesiones.
    return hmac.new(SECRET, ("session:" + PASSWORD).encode(), hashlib.sha256).hexdigest()


TOKEN = make_token()


# -------------------------------------------------------------- database ----

SCHEMA = """
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  category TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '',
  staple INTEGER NOT NULL DEFAULT 0,      -- 1 = despensa/especia: no se gasta al cocinar
  in_stock INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS stores(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS prices(
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  price REAL,
  quality INTEGER,
  updated_at INTEGER,
  PRIMARY KEY(product_id, store_id)
);
CREATE TABLE IF NOT EXISTS recipes(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  servings INTEGER,
  url TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  planned INTEGER NOT NULL DEFAULT 0,
  times_cooked INTEGER NOT NULL DEFAULT 0,
  last_cooked INTEGER,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS recipe_ingredients(
  id INTEGER PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0
);
-- Cada compra es una lista: la abierta es la actual, las cerradas son el historial.
CREATE TABLE IF NOT EXISTS shopping_lists(
  id INTEGER PRIMARY KEY,
  created_at INTEGER,
  closed_at INTEGER
);
CREATE TABLE IF NOT EXISTS shopping(
  id INTEGER PRIMARY KEY,
  list_id INTEGER REFERENCES shopping_lists(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  quantity TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',        -- obsoleto; se sustituye por shopping_recipes
  manual INTEGER NOT NULL DEFAULT 0,      -- 1 = añadido a mano (no se quita al desmarcar recetas)
  checked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER
);
-- Qué recetas han pedido cada producto de la lista (un producto aparece una sola vez).
CREATE TABLE IF NOT EXISTS shopping_recipes(
  shopping_id INTEGER NOT NULL REFERENCES shopping(id) ON DELETE CASCADE,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  PRIMARY KEY(shopping_id, recipe_id)
);
CREATE INDEX IF NOT EXISTS idx_ing_recipe ON recipe_ingredients(recipe_id);
CREATE INDEX IF NOT EXISTS idx_shop_product ON shopping(product_id);
"""

SEED_STORES = ["Mercadona", "Lidl", "Carrefour"]
SEED_STAPLES = [
    ("Sal", "Especias"), ("Pimienta negra", "Especias"), ("Pimentón", "Especias"),
    ("Comino", "Especias"), ("Orégano", "Especias"), ("Ajo en polvo", "Especias"),
    ("Aceite de oliva", "Despensa"), ("Vinagre", "Despensa"),
]

DB_LOCK = threading.RLock()
DB = sqlite3.connect(os.path.join(DATA_DIR, "comida.db"), check_same_thread=False)
DB.row_factory = sqlite3.Row
DB.execute("PRAGMA foreign_keys=ON")
DB.execute("PRAGMA journal_mode=WAL")


def init_db():
    with DB_LOCK:
        fresh = DB.execute(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='products'"
        ).fetchone()[0] == 0
        DB.executescript(SCHEMA)
        if fresh:
            now = int(time.time())
            for s in SEED_STORES:
                DB.execute("INSERT INTO stores(name) VALUES (?)", (s,))
            for name, cat in SEED_STAPLES:
                DB.execute(
                    "INSERT INTO products(name, category, staple, in_stock, updated_at) VALUES (?,?,1,1,?)",
                    (name, cat, now),
                )
        migrate()
        DB.commit()


def migrate():
    """Actualiza bases de datos creadas con versiones anteriores sin perder datos."""
    cols = {r[1] for r in DB.execute("PRAGMA table_info(shopping)")}
    if "list_id" not in cols:
        DB.execute("ALTER TABLE shopping ADD COLUMN list_id INTEGER "
                   "REFERENCES shopping_lists(id) ON DELETE CASCADE")
    if "manual" not in cols:
        DB.execute("ALTER TABLE shopping ADD COLUMN manual INTEGER NOT NULL DEFAULT 0")
        # Antes se guardaban los nombres de las recetas como texto: los enlazamos.
        for s in rows("SELECT id, source FROM shopping"):
            linked = False
            for name in filter(None, (x.strip() for x in (s["source"] or "").split(","))):
                r = row("SELECT id FROM recipes WHERE name = ?", (name,))
                if r:
                    DB.execute("INSERT OR IGNORE INTO shopping_recipes VALUES (?, ?)", (s["id"], r["id"]))
                    linked = True
            if not linked:
                DB.execute("UPDATE shopping SET manual=1 WHERE id=?", (s["id"],))
    DB.execute("CREATE INDEX IF NOT EXISTS idx_shop_list ON shopping(list_id)")
    DB.execute("UPDATE shopping SET list_id=? WHERE list_id IS NULL", (active_list_id(),))


def rows(sql, args=()):
    return [dict(r) for r in DB.execute(sql, args).fetchall()]


def row(sql, args=()):
    r = DB.execute(sql, args).fetchone()
    return dict(r) if r else None


# ------------------------------------------------------------- real time ----

VERSION = int(time.time() * 1000)
SUBSCRIBERS = set()
SUB_LOCK = threading.Lock()


def bump():
    """Marca un cambio y avisa a todos los dispositivos conectados."""
    global VERSION
    VERSION += 1
    msg = json.dumps({"version": VERSION})
    with SUB_LOCK:
        for q in list(SUBSCRIBERS):
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass


# ------------------------------------------------------------ domain ops ----

class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def clean_str(v, maxlen=2000):
    if v is None:
        return ""
    return str(v).strip()[:maxlen]


def bool_int(v):
    return 1 if v in (True, 1, "1", "true", "on") else 0


def name_key(name):
    """Clave para reconocer el mismo producto escrito de otra forma:
    sin mayúsculas, tildes ni plurales ("Tomates Fritos" == "tomate frito")."""
    s = unicodedata.normalize("NFD", str(name).lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    words = []
    for w in re.findall(r"[a-z0-9]+", s):
        if len(w) > 4 and w.endswith("es") and w[-3] in "lnrdzj":
            w = w[:-2]      # limones -> limon, panes -> pan
        elif len(w) > 3 and w.endswith("s"):
            w = w[:-1]      # tomates -> tomate, garbanzos -> garbanzo
        words.append(w)
    return " ".join(words)


def find_product(name):
    key = name_key(name)
    for p in rows("SELECT id, name FROM products"):
        if name_key(p["name"]) == key:
            return p
    return None


def get_or_create_product(name):
    name = clean_str(name, 120)
    if not name:
        raise ApiError(400, "El nombre no puede estar vacío")
    p = find_product(name)
    if p:
        return p["id"]
    cur = DB.execute(
        "INSERT INTO products(name, updated_at) VALUES (?, ?)", (name, int(time.time()))
    )
    return cur.lastrowid


def active_list_id():
    r = row("SELECT id FROM shopping_lists WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1")
    if r:
        return r["id"]
    return DB.execute(
        "INSERT INTO shopping_lists(created_at) VALUES (?)", (int(time.time()),)
    ).lastrowid


SHOPPING_SQL = (
    "SELECT s.id, s.list_id, s.product_id, s.quantity, s.manual, s.checked, s.created_at, "
    "COALESCE(p.name, s.name) AS name, p.category AS category "
    "FROM shopping s LEFT JOIN products p ON p.id = s.product_id WHERE s.list_id = ? "
)


def full_state():
    lid = active_list_id()
    shopping = rows(SHOPPING_SQL + "ORDER BY s.checked, s.created_at, s.id", (lid,))
    links = {}
    for l in rows("SELECT sr.shopping_id, sr.recipe_id FROM shopping_recipes sr "
                  "JOIN shopping s ON s.id = sr.shopping_id WHERE s.list_id = ?", (lid,)):
        links.setdefault(l["shopping_id"], []).append(l["recipe_id"])
    for s in shopping:
        s["recipe_ids"] = links.get(s["id"], [])
    history = rows("SELECT * FROM shopping_lists WHERE closed_at IS NOT NULL "
                   "ORDER BY closed_at DESC LIMIT 12")
    for h in history:
        h["items"] = rows(SHOPPING_SQL + "ORDER BY s.checked DESC, name COLLATE NOCASE", (h["id"],))
    recipes = rows("SELECT * FROM recipes ORDER BY name COLLATE NOCASE")
    ings = rows("SELECT * FROM recipe_ingredients ORDER BY recipe_id, position, id")
    by_recipe = {}
    for i in ings:
        by_recipe.setdefault(i["recipe_id"], []).append(
            {"product_id": i["product_id"], "quantity": i["quantity"]}
        )
    for r in recipes:
        r["ingredients"] = by_recipe.get(r["id"], [])
    return {
        "version": VERSION,
        "products": rows("SELECT * FROM products ORDER BY name COLLATE NOCASE"),
        "stores": rows("SELECT * FROM stores ORDER BY name COLLATE NOCASE"),
        "prices": rows("SELECT product_id, store_id, price, quality, updated_at FROM prices"),
        "recipes": recipes,
        "list": row("SELECT * FROM shopping_lists WHERE id=?", (lid,)),
        "shopping": shopping,
        "history": history,
    }


PRODUCT_FIELDS = {"name", "category", "unit", "staple", "in_stock", "notes"}


def product_values(body, partial):
    vals = {}
    for k in PRODUCT_FIELDS:
        if k not in body:
            continue
        if k in ("staple", "in_stock"):
            vals[k] = bool_int(body[k])
        else:
            vals[k] = clean_str(body[k], 120 if k != "notes" else 2000)
    if "name" in vals and not vals["name"]:
        raise ApiError(400, "El nombre no puede estar vacío")
    if not partial and "name" not in vals:
        raise ApiError(400, "Falta el nombre")
    return vals


def create_product(body):
    vals = product_values(body, partial=False)
    other = find_product(vals["name"])
    if other:
        raise ApiError(409, "Ya existe: «%s»" % other["name"])
    vals["updated_at"] = int(time.time())
    cols = ",".join(vals)
    cur = DB.execute(
        "INSERT INTO products(%s) VALUES (%s)" % (cols, ",".join("?" * len(vals))),
        list(vals.values()),
    )
    return row("SELECT * FROM products WHERE id=?", (cur.lastrowid,))


def update_product(pid, body):
    vals = product_values(body, partial=True)
    if "name" in vals:
        other = find_product(vals["name"])
        if other and other["id"] != pid:
            raise ApiError(409, "Ya existe: «%s»" % other["name"])
    if vals:
        vals["updated_at"] = int(time.time())
        DB.execute(
            "UPDATE products SET %s WHERE id=?" % ",".join(k + "=?" for k in vals),
            list(vals.values()) + [pid],
        )
    return row("SELECT * FROM products WHERE id=?", (pid,))


def add_item(product_id, manual, quantity="", recipe_id=None):
    """Añade un producto a la lista actual. Si ya está, no se duplica: solo se
    apunta qué receta lo pide (o que también se quiere a mano)."""
    lid = active_list_id()
    item = row("SELECT * FROM shopping WHERE list_id=? AND product_id=?", (lid, product_id))
    added = item is None
    if added:
        name = row("SELECT name FROM products WHERE id=?", (product_id,))["name"]
        sid = DB.execute(
            "INSERT INTO shopping(list_id, product_id, name, quantity, manual, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (lid, product_id, name, quantity, 1 if manual else 0, int(time.time())),
        ).lastrowid
    else:
        sid = item["id"]
        if manual:
            DB.execute(
                "UPDATE shopping SET manual=1, quantity=CASE WHEN ?<>'' THEN ? ELSE quantity END "
                "WHERE id=?", (quantity, quantity, sid))
    if recipe_id:
        DB.execute("INSERT OR IGNORE INTO shopping_recipes(shopping_id, recipe_id) VALUES (?,?)",
                   (sid, recipe_id))
    return sid, added


def sync_recipe(rid):
    """Pone en la lista los ingredientes de la receta que no tenéis en casa."""
    added = 0
    for i in rows("SELECT ri.product_id FROM recipe_ingredients ri "
                  "JOIN products p ON p.id = ri.product_id "
                  "WHERE ri.recipe_id=? AND p.in_stock=0", (rid,)):
        added += add_item(i["product_id"], manual=False, recipe_id=rid)[1]
    return added


def unsync_recipe(rid):
    """Quita de la lista lo que solo estaba por esta receta (y no está ya en el carro)."""
    lid = active_list_id()
    DB.execute("DELETE FROM shopping_recipes WHERE recipe_id=? AND shopping_id IN "
               "(SELECT id FROM shopping WHERE list_id=?)", (rid, lid))
    return DB.execute(
        "DELETE FROM shopping WHERE list_id=? AND manual=0 AND checked=0 "
        "AND id NOT IN (SELECT shopping_id FROM shopping_recipes)", (lid,)).rowcount


def set_planned(rid, body):
    r = row("SELECT planned FROM recipes WHERE id=?", (rid,))
    if not r:
        raise ApiError(404, "Receta no encontrada")
    planned = bool_int(body.get("planned"))
    DB.execute("UPDATE recipes SET planned=? WHERE id=?", (planned, rid))
    if planned:
        return {"added": sync_recipe(rid), "removed": 0}
    return {"added": 0, "removed": unsync_recipe(rid)}


def delete_recipe(rid):
    unsync_recipe(rid)
    DB.execute("DELETE FROM recipes WHERE id=?", (rid,))
    return {"ok": True}


def mark_out(pid, body):
    if not row("SELECT id FROM products WHERE id=?", (pid,)):
        raise ApiError(404, "Producto no encontrado")
    DB.execute("UPDATE products SET in_stock=0, updated_at=? WHERE id=?", (int(time.time()), pid))
    added = False
    if body.get("add_to_list", True):
        _, added = add_item(pid, manual=True)
    return {"ok": True, "added": added}


def save_recipe(rid, body):
    name = clean_str(body.get("name"), 120)
    if not name:
        raise ApiError(400, "La receta necesita un nombre")
    servings = body.get("servings")
    try:
        servings = int(servings) if servings not in (None, "") else None
    except (TypeError, ValueError):
        servings = None
    fields = (
        name, servings, clean_str(body.get("url"), 500),
        clean_str(body.get("instructions"), 20000), clean_str(body.get("notes"), 5000),
    )
    if rid is None:
        cur = DB.execute(
            "INSERT INTO recipes(name, servings, url, instructions, notes, planned, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            fields + (bool_int(body.get("planned")), int(time.time())),
        )
        rid = cur.lastrowid
    else:
        if not row("SELECT id FROM recipes WHERE id=?", (rid,)):
            raise ApiError(404, "Receta no encontrada")
        DB.execute(
            "UPDATE recipes SET name=?, servings=?, url=?, instructions=?, notes=? WHERE id=?",
            fields + (rid,),
        )
    if "ingredients" in body:
        DB.execute("DELETE FROM recipe_ingredients WHERE recipe_id=?", (rid,))
        seen = set()
        for pos, ing in enumerate(body.get("ingredients") or []):
            pname = clean_str(ing.get("name"), 120)
            if not pname:
                continue
            pid = get_or_create_product(pname)
            if pid in seen:
                continue
            seen.add(pid)
            DB.execute(
                "INSERT INTO recipe_ingredients(recipe_id, product_id, quantity, position) VALUES (?,?,?,?)",
                (rid, pid, clean_str(ing.get("quantity"), 60), pos),
            )
        # Si la receta ya está en la semana, la lista se ajusta a los ingredientes nuevos.
        if row("SELECT planned FROM recipes WHERE id=?", (rid,))["planned"]:
            unsync_recipe(rid)
            sync_recipe(rid)
    return {"id": rid}


def planned_ids():
    return [r["id"] for r in rows("SELECT id FROM recipes WHERE planned=1")]


def generate_list(_body):
    return {"added": sum(sync_recipe(rid) for rid in planned_ids())}


def clear_plan(_body):
    for rid in planned_ids():
        unsync_recipe(rid)
    DB.execute("UPDATE recipes SET planned=0")
    return {"ok": True}


def mark_cooked(body):
    consume = {int(x) for x in body.get("consume_ids") or []}
    now = int(time.time())
    for pid in consume:
        DB.execute(
            "UPDATE products SET in_stock=0, updated_at=? WHERE id=? AND staple=0", (now, pid)
        )
    cur = DB.execute(
        "UPDATE recipes SET planned=0, times_cooked=times_cooked+1, last_cooked=? WHERE planned=1",
        (now,),
    )
    return {"recipes": cur.rowcount, "consumed": len(consume)}


HISTORY_KEEP = 30


def finish_shopping(body):
    """Cierra la compra actual: lo marcado pasa a la despensa, la lista queda en
    el historial y se empieza una nueva. Lo no comprado se pasa a la nueva lista
    o se descarta, según se elija (así no se acumulan cosas de semana en semana)."""
    lid = active_list_id()
    checked = rows("SELECT * FROM shopping WHERE list_id=? AND checked=1", (lid,))
    pending = rows("SELECT id FROM shopping WHERE list_id=? AND checked=0", (lid,))
    if not checked and not pending:
        raise ApiError(400, "La lista está vacía")
    now = int(time.time())
    for s in checked:
        if s["product_id"]:
            DB.execute("UPDATE products SET in_stock=1, updated_at=? WHERE id=?", (now, s["product_id"]))
    carry = bool(body.get("carry_over"))
    DB.execute("UPDATE shopping_lists SET closed_at=? WHERE id=?", (now, lid))
    new_lid = active_list_id()
    if carry:
        DB.execute("UPDATE shopping SET list_id=? WHERE list_id=? AND checked=0", (new_lid, lid))
    if not checked and carry:
        DB.execute("DELETE FROM shopping_lists WHERE id=?", (lid,))  # nada que archivar
    old = rows("SELECT id FROM shopping_lists WHERE closed_at IS NOT NULL "
               "ORDER BY closed_at DESC LIMIT -1 OFFSET ?", (HISTORY_KEEP,))
    for o in old:
        DB.execute("DELETE FROM shopping_lists WHERE id=?", (o["id"],))
    return {"stocked": len(checked), "carried": len(pending) if carry else 0,
            "dropped": 0 if carry else len(pending)}


def have_item(sid):
    """"Esto ya lo tenemos": se quita de la lista y queda marcado en la despensa."""
    s = row("SELECT product_id FROM shopping WHERE id=?", (sid,))
    if not s:
        raise ApiError(404, "No está en la lista")
    if s["product_id"]:
        DB.execute("UPDATE products SET in_stock=1, updated_at=? WHERE id=?",
                   (int(time.time()), s["product_id"]))
    DB.execute("DELETE FROM shopping WHERE id=?", (sid,))
    return {"ok": True}


def delete_history(list_id):
    DB.execute("DELETE FROM shopping_lists WHERE id=? AND closed_at IS NOT NULL", (list_id,))
    return {"ok": True}


def put_price(body):
    try:
        pid = int(body["product_id"])
        sid = int(body["store_id"])
    except (KeyError, TypeError, ValueError):
        raise ApiError(400, "Faltan producto o supermercado")
    price = body.get("price")
    quality = body.get("quality")
    try:
        price = None if price in (None, "") else round(float(str(price).replace(",", ".")), 2)
    except ValueError:
        raise ApiError(400, "Precio no válido")
    try:
        quality = None if quality in (None, "", 0) else max(1, min(5, int(quality)))
    except ValueError:
        raise ApiError(400, "Calidad no válida")
    if price is None and quality is None:
        DB.execute("DELETE FROM prices WHERE product_id=? AND store_id=?", (pid, sid))
    else:
        DB.execute(
            "INSERT INTO prices(product_id, store_id, price, quality, updated_at) VALUES (?,?,?,?,?) "
            "ON CONFLICT(product_id, store_id) DO UPDATE SET price=excluded.price, "
            "quality=excluded.quality, updated_at=excluded.updated_at",
            (pid, sid, price, quality, int(time.time())),
        )
    return {"ok": True}


def create_store(body):
    name = clean_str(body.get("name"), 60)
    if not name:
        raise ApiError(400, "Falta el nombre")
    if row("SELECT id FROM stores WHERE name=? COLLATE NOCASE", (name,)):
        raise ApiError(409, "Ese supermercado ya existe")
    cur = DB.execute("INSERT INTO stores(name) VALUES (?)", (name,))
    return {"id": cur.lastrowid}


def rename_store(sid, body):
    name = clean_str(body.get("name"), 60)
    if not name:
        raise ApiError(400, "Falta el nombre")
    DB.execute("UPDATE stores SET name=? WHERE id=?", (name, sid))
    return {"ok": True}


def patch_shopping(sid, body):
    sets, args = [], []
    if "checked" in body:
        sets.append("checked=?")
        args.append(bool_int(body["checked"]))
    if "quantity" in body:
        sets.append("quantity=?")
        args.append(clean_str(body["quantity"], 60))
    if sets:
        DB.execute("UPDATE shopping SET %s WHERE id=?" % ",".join(sets), args + [sid])
    return {"ok": True}


def create_shopping(body):
    pid = get_or_create_product(body.get("name"))
    sid, added = add_item(pid, manual=True, quantity=clean_str(body.get("quantity"), 60))
    return {"id": sid, "added": added}


# ----------------------------------------------------------------- routes ----
# (método, patrón, función(match, body) -> dict, muta_datos)

def _id(m, i=1):
    return int(m.group(i))


ROUTES = [
    ("GET", r"/api/state", lambda m, b: full_state(), False),
    ("GET", r"/api/export", lambda m, b: full_state(), False),

    ("POST", r"/api/products", lambda m, b: create_product(b), True),
    ("PATCH", r"/api/products/(\d+)", lambda m, b: update_product(_id(m), b), True),
    ("DELETE", r"/api/products/(\d+)",
     lambda m, b: DB.execute("DELETE FROM products WHERE id=?", (_id(m),)) and {"ok": True}, True),
    ("POST", r"/api/products/(\d+)/out", lambda m, b: mark_out(_id(m), b), True),

    ("POST", r"/api/stores", lambda m, b: create_store(b), True),
    ("PATCH", r"/api/stores/(\d+)", lambda m, b: rename_store(_id(m), b), True),
    ("DELETE", r"/api/stores/(\d+)",
     lambda m, b: DB.execute("DELETE FROM stores WHERE id=?", (_id(m),)) and {"ok": True}, True),

    ("PUT", r"/api/prices", lambda m, b: put_price(b), True),

    ("POST", r"/api/recipes", lambda m, b: save_recipe(None, b), True),
    ("PUT", r"/api/recipes/(\d+)", lambda m, b: save_recipe(_id(m), b), True),
    ("PATCH", r"/api/recipes/(\d+)", lambda m, b: set_planned(_id(m), b), True),
    ("DELETE", r"/api/recipes/(\d+)", lambda m, b: delete_recipe(_id(m)), True),

    ("POST", r"/api/plan/generate-list", lambda m, b: generate_list(b), True),
    ("POST", r"/api/plan/cooked", lambda m, b: mark_cooked(b), True),
    ("POST", r"/api/plan/clear", lambda m, b: clear_plan(b), True),

    ("POST", r"/api/shopping", lambda m, b: create_shopping(b), True),
    ("PATCH", r"/api/shopping/(\d+)", lambda m, b: patch_shopping(_id(m), b), True),
    ("DELETE", r"/api/shopping/(\d+)",
     lambda m, b: DB.execute("DELETE FROM shopping WHERE id=?", (_id(m),)) and {"ok": True}, True),
    ("POST", r"/api/shopping/(\d+)/have", lambda m, b: have_item(_id(m)), True),
    ("POST", r"/api/shopping/finish", lambda m, b: finish_shopping(b), True),
    ("POST", r"/api/shopping/clear",
     lambda m, b: DB.execute("DELETE FROM shopping WHERE list_id=?", (active_list_id(),))
     and {"ok": True}, True),
    ("DELETE", r"/api/history/(\d+)", lambda m, b: delete_history(_id(m)), True),
]
ROUTES = [(meth, re.compile("^" + pat + "$"), fn, mut) for meth, pat, fn, mut in ROUTES]


# ---------------------------------------------------------------- server ----

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Comida/1.0"

    def log_message(self, fmt, *args):
        if os.environ.get("QUIET") != "1":
            sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    # -- helpers
    def send_json(self, status, data, extra_headers=None):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or []):
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def authed(self):
        raw = self.headers.get("Cookie")
        if not raw:
            return False
        c = cookies.SimpleCookie()
        try:
            c.load(raw)
        except cookies.CookieError:
            return False
        return COOKIE_NAME in c and hmac.compare_digest(c[COOKIE_NAME].value, TOKEN)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 1_000_000:
            raise ApiError(413, "Petición demasiado grande")
        if not length:
            return {}
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            raise ApiError(400, "JSON no válido")
        if not isinstance(data, dict):
            raise ApiError(400, "Se esperaba un objeto JSON")
        return data

    def cookie_header(self, value, max_age):
        secure = os.environ.get("COOKIE_SECURE") == "1" or \
            self.headers.get("X-Forwarded-Proto", "") == "https"
        return "%s=%s; Path=/; Max-Age=%d; HttpOnly; SameSite=Lax%s" % (
            COOKIE_NAME, value, max_age, "; Secure" if secure else "")

    # -- verbs
    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_PATCH(self):
        self.dispatch("PATCH")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            if method == "GET":
                return self.serve_static(path)
            return self.send_json(405, {"error": "Método no permitido"})
        try:
            self.handle_api(method, path)
        except ApiError as e:
            self.send_json(e.status, {"error": e.message})
        except sqlite3.IntegrityError as e:
            self.send_json(409, {"error": "Conflicto de datos: %s" % e})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("ERROR %s %s: %r\n" % (method, path, e))
            self.send_json(500, {"error": "Error interno"})

    def handle_api(self, method, path):
        if path == "/api/health":
            return self.send_json(200, {"ok": True})
        if path == "/api/login" and method == "POST":
            body = self.read_body()
            if hmac.compare_digest(str(body.get("password", "")).encode(), PASSWORD.encode()):
                return self.send_json(200, {"ok": True},
                                      [("Set-Cookie", self.cookie_header(TOKEN, COOKIE_MAX_AGE))])
            time.sleep(1)  # frena ataques de fuerza bruta
            raise ApiError(401, "Contraseña incorrecta")
        if path == "/api/logout" and method == "POST":
            return self.send_json(200, {"ok": True}, [("Set-Cookie", self.cookie_header("", 0))])

        if not self.authed():
            raise ApiError(401, "No autenticado")

        if path == "/api/events" and method == "GET":
            return self.stream_events()

        for meth, pat, fn, mutates in ROUTES:
            if meth != method:
                continue
            m = pat.match(path)
            if not m:
                continue
            body = self.read_body() if method in ("POST", "PUT", "PATCH") else {}
            with DB_LOCK:
                try:
                    result = fn(m, body)
                    if mutates or DB.in_transaction:  # una lectura puede crear la lista actual
                        DB.commit()
                except Exception:
                    DB.rollback()
                    raise
            if mutates:
                bump()
                if isinstance(result, dict):
                    result.setdefault("version", VERSION)
            if path == "/api/export":
                return self.send_json(200, result, [
                    ("Content-Disposition", 'attachment; filename="comida-backup.json"')])
            return self.send_json(200, result)
        raise ApiError(404, "Ruta no encontrada")

    def stream_events(self):
        q = queue.Queue(maxsize=50)
        with SUB_LOCK:
            SUBSCRIBERS.add(q)
        self.close_connection = True
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(("retry: 3000\ndata: %s\n\n" % json.dumps({"version": VERSION})).encode())
            self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=20)
                    self.wfile.write(("data: %s\n\n" % msg).encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")  # mantiene viva la conexión en proxies
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with SUB_LOCK:
                SUBSCRIBERS.discard(q)

    def serve_static(self, path):
        if path == "/" or not os.path.splitext(path)[1]:
            path = "/index.html"
        full = os.path.realpath(os.path.join(PUBLIC, path.lstrip("/")))
        if not full.startswith(os.path.realpath(PUBLIC) + os.sep) or not os.path.isfile(full):
            return self.send_json(404, {"error": "No encontrado"})
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith(("json", "javascript")):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # El service worker gestiona la caché; el navegador siempre revalida.
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    init_db()
    srv = Server((HOST, PORT), Handler)
    print("Comida escuchando en http://%s:%d" % (HOST, PORT))
    if not os.environ.get("APP_PASSWORD"):
        print("Contraseña (guardada en %s/config.json): %s" % (DATA_DIR, PASSWORD))
    sys.stdout.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
