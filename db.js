// IndexedDB: copia local del catálogo + cola de cambios pendientes.
const DB = 'catalogo-belleza', VER = 2;
let _db;

function abrir() {
  if (_db) return Promise.resolve(_db);
  return new Promise((ok, mal) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = e => {
      const d = r.result;
      if (e.oldVersion < 1) {
        const p = d.createObjectStore('productos', { keyPath: 'id' });
        p.createIndex('codigo_barras', 'codigo_barras');
        p.createIndex('codigo_interno', 'codigo_interno');
        d.createObjectStore('cola', { keyPath: 'n', autoIncrement: true });
        d.createObjectStore('meta');
      }
      if (e.oldVersion < 2) d.createObjectStore('ventas', { keyPath: 'id' }).createIndex('fecha_hora', 'fecha_hora');
    };
    r.onsuccess = () => ok((_db = r.result));
    r.onerror = () => mal(r.error);
  });
}
const req = r => new Promise((ok, mal) => { r.onsuccess = () => ok(r.result); r.onerror = () => mal(r.error); });
async function store(nombre, modo = 'readonly') { return (await abrir()).transaction(nombre, modo).objectStore(nombre); }

// ---- productos locales ----
export async function guardarLocales(lista) {
  const s = await store('productos', 'readwrite');
  for (const p of lista) s.put(p);
  return new Promise(ok => (s.transaction.oncomplete = ok));
}
export async function productoLocal(id) { return req((await store('productos')).get(id)); }
export async function buscarLocal(codigo) {
  const s = await store('productos');
  return (await req(s.index('codigo_barras').get(codigo))) || (await req(s.index('codigo_interno').get(codigo))) || null;
}

export async function todosLosProductos() { return req((await store('productos')).getAll()); }

// ---- ventas locales (bajadas + pendientes) ----
export async function guardarVentas(lista) {
  const s = await store('ventas', 'readwrite');
  for (const v of lista) s.put(v);
  return new Promise(ok => (s.transaction.oncomplete = ok));
}
export async function ventasDesde(isoDesde) {
  const s = await store('ventas');
  return req(s.index('fecha_hora').getAll(IDBKeyRange.lowerBound(isoDesde)));
}
export async function descontarExistencia(items) {
  const s = await store('productos', 'readwrite');
  for (const it of items) {
    const p = await req(s.get(it.producto_id));
    if (p) { p.existencia = (p.existencia ?? 0) - it.cantidad; s.put(p); }
  }
  return new Promise(ok => (s.transaction.oncomplete = ok));
}

// ---- cola ----
export async function encolar(op) { return req((await store('cola', 'readwrite')).add({ ...op, creado: Date.now() })); }
export async function pendientes() { return req((await store('cola')).getAll()); }
export async function quitar(n) { return req((await store('cola', 'readwrite')).delete(n)); }
export async function contarPendientes() { return req((await store('cola')).count()); }

// ---- meta (marca de tiempo de la última descarga) ----
export async function getMeta(k) { return req((await store('meta')).get(k)); }
export async function setMeta(k, v) { return req((await store('meta', 'readwrite')).put(v, k)); }
