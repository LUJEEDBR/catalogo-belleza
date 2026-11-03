import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import * as db from './db.js';
import { sincronizar, descargarCatalogo } from './sync.js';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

const $ = s => document.querySelector(s);
const vistas = ['login', 'escaner', 'ficha', 'venta', 'elegir', 'reporte'];
const mostrar = v => {
  vistas.forEach(n => ($(`#vista-${n}`).hidden = n !== v));
  const tabs = v !== 'login'; $('#tabs').hidden = !tabs; document.body.classList.toggle('con-tabs', tabs);
  const tab = { ficha: 'escaner', elegir: 'venta' }[v] || v;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('activo', b.dataset.tab === tab));
};
const dinero = n => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const toast = (t, ms = 2200) => { const el = $('#toast'); el.textContent = t; el.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (el.hidden = true), ms); };

let perfil = null;          // { id, nombre, rol }
let actual = null;          // producto en ficha (null = nuevo)
let fotoBlob = null;
let fotoUrlExterna = null;  // imagen de Open Beauty Facts si no hay foto propia

// ---------- Service worker + estado de red ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
// Pide que el navegador no borre la base local (clave en iPhone: úsala instalada en pantalla de inicio)
navigator.storage?.persist?.();
async function pintarRed() {
  const p = $('#estado-red'), n = await db.contarPendientes().catch(() => 0);
  p.textContent = (navigator.onLine ? 'en línea' : 'sin internet') + (n ? ` · ${n} por subir` : '');
  p.classList.toggle('off', !navigator.onLine);
}
async function sync() {
  if (!perfil) return;
  const r = await sincronizar(sb);
  if (r.subidos) toast(`Subí ${r.subidos} cambio${r.subidos > 1 ? 's' : ''} ✓`);
  if (r.rechazados.length) toast(r.rechazados.join(' · '), 5000);
  pintarRed(); cargarMarcas(); precargarFotos();
}
// Baja todas las miniaturas una vez por sesión para que el catálogo se vea completo sin internet
let fotosPrecargadas = false;
async function precargarFotos() {
  if (fotosPrecargadas || !navigator.onLine) return; fotosPrecargadas = true;
  const urls = (await db.todosLosProductos()).map(p => p.foto_url).filter(u => u && u.includes('/storage/v1/object/public/'));
  for (const u of urls) await fetch(u).catch(() => {});
}
addEventListener('online', sync); addEventListener('offline', pintarRed);
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
setInterval(sync, 60000); pintarRed();

// ---------- Sesión ----------
async function cargarPerfil() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { perfil = null; $('#btn-salir').hidden = true; return mostrar('login'); }
  const { data } = await sb.from('usuarios').select('id,nombre,rol').eq('id', session.user.id).maybeSingle()
    .then(r => r, () => ({ data: null }));
  if (data) localStorage.setItem('perfil', JSON.stringify(data));
  perfil = data || JSON.parse(localStorage.getItem('perfil') || 'null')
    || { id: session.user.id, nombre: session.user.email, rol: 'empleado' };
  $('#btn-salir').hidden = false;
  $('#rol-info').textContent = `Hola, ${perfil.nombre} · ${perfil.rol === 'dueno' ? 'dueña' : 'empleado'}`;
  mostrar('escaner');
  cargarMarcas();
  sync(); // sube pendientes y baja el catálogo a este teléfono
}

$('#form-login').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#login-error').textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email: f.get('email'), password: f.get('password') });
  if (error) $('#login-error').textContent = 'Correo o contraseña incorrectos.';
  else cargarPerfil();
});
$('#btn-salir').addEventListener('click', async () => { detener(); await sb.auth.signOut(); cargarPerfil(); });

// ---------- Escáner (BarcodeDetector en Android, ZXing como respaldo) ----------
// Un solo escáner para Capturar y Vender: cada vista pone su <video>, su botón y qué hacer al leer.
let stream = null, corriendo = false, zxing = null, ultimo = { codigo: null, t: 0 }, esc_ = null;
const FORMATOS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
const ESCANERES = {
  captura: { video: () => $('#video'), btn: () => $('#btn-escanear'), alLeer: c => alLeer(c) },
  venta:   { video: () => $('#video-venta'), btn: () => $('#btn-escanear-venta'), alLeer: c => agregarPorCodigo(c) },
};

async function iniciar(modo = 'captura') {
  if (corriendo) detener();
  esc_ = ESCANERES[modo]; const video = esc_.video();
  corriendo = true; esc_.btn().textContent = 'Detener';
  if ('BarcodeDetector' in window) {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = stream; await video.play();
    const det = new BarcodeDetector({ formats: FORMATOS });
    const loop = async () => {
      if (!corriendo) return;
      try { const r = await det.detect(video); if (r[0]) await leer(r[0].rawValue); } catch {}
      requestAnimationFrame(loop);
    };
    loop();
  } else {
    zxing = new ZXing.BrowserMultiFormatReader();
    zxing.decodeFromConstraints({ video: { facingMode: 'environment' } }, video, r => { if (r) leer(r.getText()); });
  }
}
function leer(codigo) {
  const ahora = Date.now();
  if (codigo === ultimo.codigo && ahora - ultimo.t < 2500) return; // evita lecturas dobles
  ultimo = { codigo, t: ahora };
  return esc_?.alLeer(codigo);
}
function detener() {
  corriendo = false;
  if (esc_) esc_.btn().textContent = 'Escanear';
  if (zxing) { zxing.reset(); zxing = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
}
const alternar = modo => () => (corriendo && esc_ === ESCANERES[modo] ? detener() : iniciar(modo).catch(err => {
  detener(); toast('No pude abrir la cámara: revisa el permiso.'); console.error(err); }));
$('#btn-escanear').addEventListener('click', alternar('captura'));
$('#btn-escanear-venta').addEventListener('click', alternar('venta'));

// Sonido + vibración
const ctx = window.AudioContext ? new AudioContext() : null;
function bip(ok = true) {
  navigator.vibrate?.(ok ? 60 : [40, 60, 40]);
  if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = ok ? 1200 : 400; g.gain.value = 0.15;
  o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.12);
}

async function alLeer(codigo) {
  const rafaga = $('#chk-rafaga').checked;
  const prod = await buscarPorCodigo(codigo);
  bip(!!prod);
  if (prod && rafaga) { toast(`${prod.nombre} · $${prod.precio_publico ?? '—'} · ${prod.existencia} pzas`); return; }
  detener();
  abrirFicha(codigo, prod);
}

$('#form-manual').addEventListener('submit', e => {
  e.preventDefault(); const c = $('#codigo-manual').value.trim(); if (c) alLeer(c); });
$('#btn-sin-codigo').addEventListener('click', () => { detener(); abrirFicha(null, null); });

// ---------- Búsqueda: Supabase primero, luego Open Beauty Facts ----------
async function buscarPorCodigo(codigo) {
  if (navigator.onLine) {
    try {
      const { data, error } = await sb.from('productos').select('*, marcas(nombre)')
        .or(`codigo_barras.eq.${codigo},codigo_interno.eq.${codigo}`).maybeSingle();
      if (error) throw error;
      if (data) db.guardarLocales([data]);
      return data;
    } catch { /* sin red real: usa la copia local */ }
  }
  return db.buscarLocal(codigo);
}

async function buscarOBF(codigo) {
  try {
    const r = await fetch(`https://world.openbeautyfacts.org/api/v2/product/${encodeURIComponent(codigo)}.json` +
      '?fields=product_name,product_name_es,brands,quantity,image_front_url');
    const j = await r.json();
    if (j.status !== 1) return null;
    const p = j.product; const q = (p.quantity || '').match(/([\d.,]+)\s*(ml|g|pzas?)/i);
    return { nombre: p.product_name_es || p.product_name || '', marca: (p.brands || '').split(',')[0].trim(),
      presentacion_cantidad: q ? q[1].replace(',', '.') : '', presentacion_unidad: q ? q[2].toLowerCase().replace(/^pza$/, 'pzas') : '',
      foto: p.image_front_url || null };
  } catch { return null; }
}

// ---------- Ficha ----------
async function abrirFicha(codigo, prod) {
  const f = $('#form-producto'); f.reset();
  actual = prod; fotoBlob = null; fotoUrlExterna = null;
  $('#foto-preview').src = prod?.foto_url || '';
  $('#ficha-msg').textContent = '';
  f.codigo_barras.value = codigo || '';
  if (prod) {
    $('#ficha-origen').textContent = 'Producto ya registrado';
    for (const k of ['nombre', 'presentacion_cantidad', 'presentacion_unidad', 'genero', 'precio_publico',
      'existencia', 'ubicacion', 'ubicacion_detalle']) if (prod[k] != null) f[k].value = prod[k];
    f.marca.value = prod.marcas?.nombre || '';
    if (!prod.codigo_barras) f.codigo_barras.value = prod.codigo_interno;
  } else if (codigo) {
    $('#ficha-origen').textContent = 'Nuevo · buscando datos…';
    mostrar('ficha');
    const obf = navigator.onLine ? await buscarOBF(codigo) : null;
    if (obf) {
      f.nombre.value = obf.nombre; f.marca.value = obf.marca;
      f.presentacion_cantidad.value = obf.presentacion_cantidad; f.presentacion_unidad.value = obf.presentacion_unidad;
      if (obf.foto) { fotoUrlExterna = obf.foto; $('#foto-preview').src = obf.foto; }
      $('#ficha-origen').textContent = 'Nuevo · datos de Open Beauty Facts (revísalos y toma tu foto)';
    } else $('#ficha-origen').textContent = 'Nuevo · no hay datos en línea, captúralo y toma foto';
  } else {
    $('#ficha-origen').textContent = 'Nuevo sin código · se le asignará un código interno';
  }
  // Solo la dueña cambia precios de productos existentes
  f.precio_publico.readOnly = !!prod && perfil?.rol !== 'dueno';
  mostrar('ficha');
}
$('#btn-cancelar').addEventListener('click', () => mostrar('escaner'));

// Foto: recorte cuadrado al centro, 600px, WebP (JPEG si el navegador no soporta WebP)
async function comprimirFoto(file) {
  const img = await createImageBitmap(file);
  const lado = Math.min(img.width, img.height), T = 600;
  const c = document.createElement('canvas'); c.width = c.height = T;
  c.getContext('2d').drawImage(img, (img.width - lado) / 2, (img.height - lado) / 2, lado, lado, 0, 0, T, T);
  let b = await new Promise(r => c.toBlob(r, 'image/webp', 0.8));
  if (!b || b.type !== 'image/webp') b = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
  return b;
}
$('#input-foto').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  fotoBlob = await comprimirFoto(file);
  $('#foto-preview').src = URL.createObjectURL(fotoBlob);
  leerEtiqueta(file);
});

// Imagen completa (sin recorte) a 1280px para que la IA lea bien la etiqueta
async function imagenParaIA(file) {
  const img = await createImageBitmap(file);
  const k = Math.min(1, 1280 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const b = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  const buf = new Uint8Array(await b.arrayBuffer());
  let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Al tomar foto: la IA lee la etiqueta y llena los campos vacíos (nunca pisa lo ya capturado)
async function leerEtiqueta(file) {
  if (!navigator.onLine) return;
  const f = $('#form-producto'), origen = $('#ficha-origen'), antes = origen.textContent;
  origen.textContent = '✨ Leyendo la etiqueta…';
  try {
    const { data, error } = await sb.functions.invoke('leer-etiqueta', {
      body: { imagen: await imagenParaIA(file), mime: 'image/jpeg' } });
    if (error || !data || data.error) throw error || new Error(data?.error || 'sin datos');
    let n = 0;
    const poner = (campo, valor) => {
      if (valor == null || valor === '' || !f[campo] || f[campo].value) return;
      f[campo].value = valor; n++;
    };
    poner('nombre', data.nombre); poner('marca', data.marca);
    poner('presentacion_cantidad', data.presentacion_cantidad);
    poner('presentacion_unidad', data.presentacion_unidad); poner('genero', data.genero);
    if (f.descripcion) poner('descripcion', data.descripcion);
    origen.textContent = n ? `✨ Llené ${n} campo${n > 1 ? 's' : ''} con la foto · revísalos y pon el precio` : antes;
    if (n) { bip(true); navigator.vibrate?.(30); f.precio_publico.focus(); }
  } catch (err) {
    console.warn('leer-etiqueta', err);
    origen.textContent = antes;
    toast('No pude leer la etiqueta, captúrala a mano.');
  }
}

async function cargarMarcas() {
  if (!navigator.onLine) return;
  const { data } = await sb.from('marcas').select('nombre').order('nombre');
  $('#lista-marcas').innerHTML = (data || []).map(m => `<option value="${m.nombre}">`).join('');
}

$('#form-producto').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const num = v => (v === '' ? null : Number(v));
    const fila = {
      nombre: f.nombre.value.trim(),
      marca_nombre: f.marca.value.trim(),          // se convierte en marca_id al sincronizar
      presentacion_cantidad: num(f.presentacion_cantidad.value),
      presentacion_unidad: f.presentacion_unidad.value || null,
      genero: f.genero.value || null,
      existencia: num(f.existencia.value) ?? 0,
      ubicacion: f.ubicacion.value,
      ubicacion_detalle: f.ubicacion_detalle.value.trim() || null,
      cambio_cliente_en: new Date().toISOString(),
    };
    if (!actual || perfil?.rol === 'dueno') fila.precio_publico = num(f.precio_publico.value);

    let op;
    if (actual) op = { tipo: 'update', id: actual.id, fila };
    else {
      fila.id = crypto.randomUUID();
      if (f.codigo_barras.value) fila.codigo_barras = f.codigo_barras.value;
      if (fotoUrlExterna) fila.foto_url = fotoUrlExterna;
      op = { tipo: 'insert', id: fila.id, fila };
    }
    if (fotoBlob) op.foto = fotoBlob;
    await db.encolar(op);

    // copia local inmediata para que el mostrador la vea aunque no haya internet
    const { marca_nombre, ...local } = fila;
    await db.guardarLocales([{ ...(actual || {}), ...local, marcas: { nombre: marca_nombre },
      foto_url: local.foto_url ?? actual?.foto_url ?? null, foto_local: fotoBlob || actual?.foto_local || null }]);

    toast(navigator.onLine ? 'Guardado ✓' : 'Guardado en el teléfono · se sube al volver el internet');
    mostrar('escaner');
    if ($('#chk-rafaga').checked) iniciar('captura');
    await sync();
  } catch (err) {
    console.error(err); $('#ficha-msg').textContent = `Error: ${err.message}`;
  } finally { btn.disabled = false; pintarRed(); }
});

// =====================================================================
// PESTAÑAS
// =====================================================================
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => {
  detener(); mostrar(b.dataset.tab);
  if (b.dataset.tab === 'reporte') pintarReporte();
  if (b.dataset.tab === 'venta') pintarCarrito();
}));
const fotoDe = p => p?.foto_local instanceof Blob ? URL.createObjectURL(p.foto_local) : p?.foto_url || '';
const miniatura = p => fotoDe(p) ? `<img src="${esc(fotoDe(p))}" alt="" loading="lazy">` : '<span class="sin-foto">💄</span>';

// =====================================================================
// VENDER: carrito
// =====================================================================
let carrito = [];               // [{ producto, cantidad, precio_unitario, foto }]
let metodoPago = 'efectivo';
let fotoVenta = null;           // foto tomada para un producto sin código

function agregarAlCarrito(producto, foto = null) {
  const ya = !foto && carrito.find(l => l.producto.id === producto.id && !l.foto);
  if (ya) ya.cantidad++;
  else carrito.push({ producto, cantidad: 1, precio_unitario: Number(producto.precio_publico || 0), foto });
  pintarCarrito();
}

async function agregarPorCodigo(codigo) {
  const prod = await buscarPorCodigo(codigo);
  bip(!!prod);
  if (!prod) return toast(`El código ${codigo} no está en el catálogo. Dalo de alta en Capturar.`, 3500);
  if (prod.precio_publico == null) toast(`${prod.nombre} no tiene precio todavía`, 3000);
  agregarAlCarrito(prod);
  toast(`+ ${prod.nombre}`);
}

function pintarCarrito() {
  const ul = $('#carrito');
  ul.innerHTML = carrito.map((l, i) => `
    <li>
      ${l.foto ? `<img src="${URL.createObjectURL(l.foto)}" alt="">` : miniatura(l.producto)}
      <div class="info"><b>${esc(l.producto.nombre)}</b>
        <small>${dinero(l.precio_unitario)} c/u${l.foto ? ' · por foto' : ''}</small></div>
      <div class="der"><span class="monto">${dinero(l.cantidad * l.precio_unitario)}</span>
        <div class="stepper"><button type="button" data-i="${i}" data-d="-1">−</button>
        <output>${l.cantidad}</output><button type="button" data-i="${i}" data-d="1">+</button></div></div>
    </li>`).join('');
  const piezas = carrito.reduce((a, l) => a + l.cantidad, 0);
  const total = carrito.reduce((a, l) => a + l.cantidad * l.precio_unitario, 0);
  $('#carrito-cuenta').textContent = piezas ? `· ${piezas} pza${piezas > 1 ? 's' : ''}` : '';
  $('#carrito-vacio').hidden = carrito.length > 0;
  const b = $('#btn-cobrar'); b.textContent = `Cobrar ${dinero(total)}`; b.disabled = !carrito.length;
}
$('#carrito').addEventListener('click', e => {
  const b = e.target.closest('button[data-i]'); if (!b) return;
  const l = carrito[b.dataset.i]; l.cantidad += Number(b.dataset.d);
  if (l.cantidad <= 0) carrito.splice(b.dataset.i, 1);
  pintarCarrito();
});
document.querySelectorAll('#metodo-pago button').forEach(b => b.addEventListener('click', () => {
  metodoPago = b.dataset.v;
  document.querySelectorAll('#metodo-pago button').forEach(x => x.classList.toggle('activo', x === b));
}));

// Búsqueda por nombre o código desde el carrito
$('#form-buscar-venta').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('#buscar-venta').value.trim(); if (!q) return;
  const porCodigo = await buscarPorCodigo(q);
  $('#buscar-venta').value = '';
  if (porCodigo) return agregarAlCarrito(porCodigo);
  abrirElegir(null, q);
});

// Sin código: toma foto y elige el producto viéndolo en la rejilla de fotos
$('#input-foto-venta').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  detener();
  abrirElegir(await comprimirFoto(file), '');
});

let catalogoLocal = [];
async function abrirElegir(foto, texto) {
  fotoVenta = foto;
  $('#foto-venta-preview').hidden = !foto;
  if (foto) $('#foto-venta-preview').src = URL.createObjectURL(foto);
  $('#buscar-elegir').value = texto;
  $('#form-alta-rapida').reset();
  if (texto) $('#form-alta-rapida').nombre.value = texto;
  catalogoLocal = await db.todosLosProductos();
  pintarRejilla();
  mostrar('elegir');
}
function pintarRejilla() {
  const q = $('#buscar-elegir').value.trim().toLowerCase();
  const lista = catalogoLocal
    .filter(p => !q || `${p.nombre} ${p.marcas?.nombre || ''} ${p.codigo_interno || ''}`.toLowerCase().includes(q))
    .sort((a, b) => (fotoDe(b) ? 1 : 0) - (fotoDe(a) ? 1 : 0) || a.nombre.localeCompare(b.nombre))
    .slice(0, 60);
  $('#rejilla').innerHTML = lista.map(p => `
    <button type="button" data-id="${p.id}">${miniatura(p)}<b>${esc(p.nombre)}</b><small>${dinero(p.precio_publico)}</small></button>`).join('')
    || '<p class="vacio" style="grid-column:1/-1">No encontré nada con ese nombre</p>';
}
$('#buscar-elegir').addEventListener('input', pintarRejilla);
$('#rejilla').addEventListener('click', e => {
  const b = e.target.closest('button[data-id]'); if (!b) return;
  agregarAlCarrito(catalogoLocal.find(p => p.id === b.dataset.id), fotoVenta);
  mostrar('venta');
});
$('#btn-elegir-cancelar').addEventListener('click', () => mostrar('venta'));

// Alta rápida: crea el producto (el servidor le pone código interno INT-xxxxxx) y lo agrega al carrito
$('#form-alta-rapida').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const fila = { id: crypto.randomUUID(), nombre: f.nombre.value.trim(), precio_publico: Number(f.precio_publico.value),
    existencia: 1, ubicacion: 'anaquel', cambio_cliente_en: new Date().toISOString() };
  const op = { tipo: 'insert', id: fila.id, fila };
  if (fotoVenta) op.foto = fotoVenta;
  await db.encolar(op);
  const prod = { ...fila, foto_local: fotoVenta, marcas: null };
  await db.guardarLocales([prod]);
  agregarAlCarrito(prod, fotoVenta);
  toast('Producto dado de alta ✓'); mostrar('venta'); pintarRed();
});

// Cobrar: se guarda en el teléfono y pasa por la misma cola offline
$('#btn-cobrar').addEventListener('click', async () => {
  if (!carrito.length) return;
  const btn = $('#btn-cobrar'); btn.disabled = true;
  const sinPrecio = carrito.find(l => !(l.precio_unitario > 0));
  if (sinPrecio && !confirm(`${sinPrecio.producto.nombre} está en $0. ¿Cobrar así?`)) { btn.disabled = false; return; }
  const venta = {
    tipo: 'venta', id: crypto.randomUUID(), fecha_hora: new Date().toISOString(), metodo_pago: metodoPago,
    usuario: perfil?.id, total: Math.round(carrito.reduce((a, l) => a + l.cantidad * l.precio_unitario, 0) * 100) / 100,
    items: carrito.map(l => ({ producto_id: l.producto.id, cantidad: l.cantidad, precio_unitario: l.precio_unitario,
      ...(l.foto ? { foto: l.foto } : {}) })),
  };
  await db.encolar(venta);
  await db.guardarVentas([{ ...venta, pendiente: true, items: venta.items.map(({ foto, ...x }) => x) }]);
  await db.descontarExistencia(venta.items);
  bip(true);
  toast(`Venta de ${dinero(venta.total)} ✓${navigator.onLine ? '' : ' · se sube al volver el internet'}`, 3000);
  carrito = []; pintarCarrito(); pintarRed();
  sync();
});

// =====================================================================
// REPORTE: por día, por hora y más vendidos (se calcula con la copia local, funciona sin internet)
// =====================================================================
let rangoDias = 1;
document.querySelectorAll('#rango button').forEach(b => b.addEventListener('click', () => {
  rangoDias = Number(b.dataset.d);
  document.querySelectorAll('#rango button').forEach(x => x.classList.toggle('activo', x === b));
  pintarReporte();
}));
const enMX = iso => new Date(new Date(iso).toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
const diaMX = iso => { const d = enMX(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function pintarReporte() {
  const hoy = enMX(new Date().toISOString()); hoy.setHours(0, 0, 0, 0);
  const inicio = new Date(hoy); inicio.setDate(inicio.getDate() - (rangoDias - 1));
  const ventas = (await db.ventasDesde(new Date(Date.now() - (rangoDias + 1) * 864e5).toISOString()))
    .filter(v => enMX(v.fecha_hora) >= inicio);
  const productos = Object.fromEntries((await db.todosLosProductos()).map(p => [p.id, p]));

  const total = ventas.reduce((a, v) => a + Number(v.total), 0);
  $('#r-total').textContent = dinero(total);
  $('#r-num').textContent = ventas.length;
  $('#r-prom').textContent = dinero(ventas.length ? total / ventas.length : 0);

  // Por hora (de 9 a 21 h siempre, más cualquier otra hora con ventas)
  const porHora = {};
  for (const v of ventas) { const h = enMX(v.fecha_hora).getHours(); porHora[h] = (porHora[h] || 0) + Number(v.total); }
  const horas = [...new Set([...Array(13).keys()].map(i => i + 9).concat(Object.keys(porHora).map(Number)))].sort((a, b) => a - b);
  const max = Math.max(1, ...Object.values(porHora));
  $('#r-horas').innerHTML = horas.map(h => `<div title="${h}:00 · ${dinero(porHora[h] || 0)}">
    <i class="${porHora[h] ? '' : 'cero'}" style="height:${Math.max(2, ((porHora[h] || 0) / max) * 100)}%"></i><small>${h}</small></div>`).join('');

  // Por día
  const porDia = {};
  for (const v of ventas) {
    const d = diaMX(v.fecha_hora); porDia[d] ||= { n: 0, t: 0, p: 0 };
    porDia[d].n++; porDia[d].t += Number(v.total); if (v.pendiente) porDia[d].p++;
  }
  $('#r-dias').innerHTML = Object.entries(porDia).sort((a, b) => b[0].localeCompare(a[0])).map(([d, x]) => {
    const f = new Date(d + 'T12:00:00').toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'short' });
    return `<li><div class="info"><b>${f[0].toUpperCase() + f.slice(1)}</b><small>${x.n} venta${x.n > 1 ? 's' : ''}${x.p ? `<span class="pendiente">${x.p} por subir</span>` : ''}</small></div>
      <span class="monto">${dinero(x.t)}</span></li>`; }).join('')
    || '<li><div class="info"><small>Sin ventas en este periodo</small></div></li>';

  // Más vendidos (top 10 por piezas)
  const porProd = {};
  for (const v of ventas) for (const it of v.items || []) {
    porProd[it.producto_id] ||= { pzas: 0, imp: 0 };
    porProd[it.producto_id].pzas += it.cantidad; porProd[it.producto_id].imp += it.cantidad * Number(it.precio_unitario);
  }
  $('#r-top').innerHTML = Object.entries(porProd).sort((a, b) => b[1].pzas - a[1].pzas || b[1].imp - a[1].imp).slice(0, 10)
    .map(([id, x], i) => { const p = productos[id] || { nombre: 'Producto' };
      return `<li><span class="rank">${i + 1}</span>${miniatura(p)}<div class="info"><b>${esc(p.nombre)}</b>
        <small>${x.pzas} pza${x.pzas > 1 ? 's' : ''}</small></div><span class="monto">${dinero(x.imp)}</span></li>`; }).join('');
}

sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') cargarPerfil(); });
cargarPerfil();
