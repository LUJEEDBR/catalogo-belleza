// Tienda pública de Carpe Diem v2. Solo lee columnas públicas (sin costo ni existencia);
// RLS deja ver al público únicamente productos con publicado_en_linea = true.
// Fichas (beneficios, uso, recomendaciones, precauciones) en /fichas.json, por id de producto,
// tomadas del fabricante o de la etiqueta. Vista 360: fichas[id].giro = { n, carpeta } con fotos reales
// en fotos/360/<carpeta>/01.webp … NN.webp (no se generan con IA para no alterar el empaque).
import { createClient } from './vendor/supabase.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, BUCKET_FOTOS } from './config.js';

const WHATSAPP = '';            // número de Edith (52 + 10 dígitos), pendiente
const META = 500;               // entrega mismo día en CDMX
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = s => document.querySelector(s);
const pesos = n => '$' + Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const publica = ruta => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET_FOTOS}/${ruta}`;
const fotoTienda = p => { const n = (p.foto_url || '').split('?')[0].split('/').pop(); return n ? publica('tienda/' + n) : ''; };
const imgTag = (p, cls = '') => `<img class="${cls}" loading="lazy" src="${esc(fotoTienda(p))}" data-alt="${esc(p.foto_url || '')}" alt="${esc(p.nombre)}"
  onerror="if(this.dataset.alt&&this.src!==this.dataset.alt){this.src=this.dataset.alt}else{this.style.visibility='hidden'}">`;
const pres = p => p.presentacion_cantidad ? `${Number(p.presentacion_cantidad)} ${p.presentacion_unidad || ''}`.trim() : '';
const icoMas = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
const icoOk = '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

const CATEGORIAS = [
  ['Shampoo', /shampoo|champu/],
  ['Uñas', /\bunas\b|nail|tips/],
  ['Tratamientos', /mascarilla|mask|tratamiento|acondicionador|balsamo|conditioner|primer/],
  ['Peinado', /gel|crema para peinar|peinar|fijador|spray|termo ?protector|planchado/],
  ['Aceites y sérums', /aceite|oil|oleo|serum|silica|gotas|brillantador|silicon|blitz/],
  ['Ampolletas', /ampolleta|locion|lotion/],
  ['Accesorios', /brazalete|cortaunas|extensiones|joya|tatuaje/],
];
const categoria = p => { const t = norm(p.nombre); return (CATEGORIAS.find(([, r]) => r.test(t)) || ['Otros'])[0]; };

let productos = [], fichas = {}, cat = 'Todo';
let carrito = JSON.parse(localStorage.getItem('cd-carrito') || '{}');

async function cargar() {
  const demo = new URLSearchParams(location.search).has('demo');
  const pf = fetch('/fichas.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : {}).catch(() => ({}));
  if (demo) {
    productos = await (await fetch('/tienda-demo.json', { cache: 'no-cache' })).json();
    $('#aviso').textContent = 'Vista previa para aprobar el diseño. Aún no está publicada.'; $('#aviso').hidden = false;
  } else {
    const { data, error } = await sb.from('productos')
      .select('id,nombre,descripcion,foto_url,precio_publico,presentacion_cantidad,presentacion_unidad,marcas(nombre)')
      .eq('publicado_en_linea', true).order('nombre');
    if (error) console.warn(error);
    productos = data || [];
  }
  fichas = await pf;
  productos.forEach(p => (p._cat = categoria(p)));
  pintarChips(); pintar();
  const id = new URLSearchParams(location.hash.slice(1)).get('p'); if (id) abrirFicha(id);
}

function pintarChips() {
  const usadas = ['Todo', ...CATEGORIAS.map(c => c[0]), 'Otros'].filter(c => c === 'Todo' || productos.some(p => p._cat === c));
  $('#chips').innerHTML = usadas.map(c => `<button class="${c === cat ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
}

function tarjeta(p, i = 0) {
  const en = carrito[p.id]?.n || 0;
  const f = fichas[p.id];
  return `<article class="tarjeta" data-abrir="${p.id}" style="animation-delay:${Math.min(i, 12) * 30}ms">
    <div class="t-foto">${imgTag(p)}${f?.giro ? '<span class="etq">360°</span>' : ''}</div>
    <div class="t-info"><span class="marca">${esc(p.marcas?.nombre || '')}</span>
      <h3>${esc(p.nombre)}</h3><span class="pres">${esc(pres(p))}</span>
      <div class="t-fila"><b>${pesos(p.precio_publico)}</b>
        <button class="mas${en ? ' en' : ''}" data-id="${p.id}" aria-label="Agregar ${esc(p.nombre)}">${en ? icoOk : icoMas}</button></div></div>
  </article>`;
}

function pintar() {
  const q = norm($('#q').value.trim());
  const lista = productos.filter(p => (cat === 'Todo' || p._cat === cat) && (!q || norm(`${p.nombre} ${p.marcas?.nombre || ''}`).includes(q)));
  $('#vacio').hidden = productos.length > 0;
  $('#titulo-lista').textContent = q ? 'Resultados' : cat;
  $('#conteo').textContent = lista.length ? `${lista.length} ${lista.length === 1 ? 'producto' : 'productos'}` : '';
  $('#lista').innerHTML = lista.map(tarjeta).join('') || (productos.length ? '<p class="vacio" style="grid-column:1/-1">Sin resultados.</p>' : '');
  // Destacados: con ficha oficial y foto, solo en la vista general
  const dest = productos.filter(p => fichas[p.id]?.fuente_tipo === 'oficial' && p.foto_url).slice(0, 8);
  $('#sec-dest').hidden = !!q || cat !== 'Todo' || dest.length < 3;
  $('#destacados').innerHTML = dest.map(tarjeta).join('');
  pintarCarrito();
}

/* ---------- Ficha ---------- */
let actual = null, nFicha = 1;
const TABS = [['beneficios', 'Beneficios'], ['modo_uso', 'Modo de uso'], ['recomendaciones', 'Consejos'], ['precauciones', 'Precauciones']];

function abrirFicha(id) {
  const p = productos.find(x => String(x.id) === String(id)); if (!p) return;
  actual = p; nFicha = 1; const f = fichas[p.id] || {};
  $('#f-marca').textContent = p.marcas?.nombre || '';
  $('#f-nombre').textContent = p.nombre;
  $('#f-pres').textContent = pres(p);
  $('#f-precio').textContent = pesos(p.precio_publico);
  $('#f-n').textContent = 1;
  $('#f-foto').className = 'f-foto'; $('#f-foto').innerHTML = imgTag(p);
  $('#f-vistas').hidden = !f.giro; $('#f-pista').hidden = true;
  $('#f-vistas').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.vista === 'foto'));
  const tabs = TABS.filter(([k]) => (Array.isArray(f[k]) ? f[k].length : f[k]));
  $('#f-tabs').hidden = !tabs.length;
  $('#f-tabs').innerHTML = tabs.map(([k, t], i) => `<button role="tab" class="${i ? '' : 'on'}" data-tab="${k}">${t}</button>`).join('');
  tabs.length ? mostrarTab(tabs[0][0]) : ($('#f-contenido').className = 'f-contenido',
    $('#f-contenido').innerHTML = `<p class="f-sin">${esc(p.descripcion || 'Pronto agregaremos la información del fabricante. Pregúntanos por WhatsApp y con gusto te orientamos.')}</p>`);
  const tipo = { oficial: 'Información del fabricante', etiqueta: 'Información de la etiqueta del producto' }[f.fuente_tipo];
  $('#f-fuente').innerHTML = tipo ? `${tipo}${f.fuente_url ? ` · <a href="${esc(f.fuente_url)}" target="_blank" rel="noopener">ver fuente</a>` : ''}` : '';
  abrir('#ficha');
  history.replaceState(null, '', '#p=' + p.id);
}

function mostrarTab(k) {
  const f = fichas[actual.id] || {}; const v = f[k];
  $('#f-tabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === k));
  $('#f-contenido').className = 'f-contenido' + (k === 'precauciones' ? ' alerta' : '');
  $('#f-contenido').innerHTML = Array.isArray(v) ? `<ul>${v.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`
    : String(v || '').split(/\n+/).map(x => `<p>${esc(x)}</p>`).join('');
}

/* Visor 360: arrastra para recorrer las fotos reales del producto */
function giro360() {
  const f = fichas[actual.id]; if (!f?.giro) return;
  const { n, carpeta } = f.giro; const urls = Array.from({ length: n }, (_, i) => publica(`360/${carpeta}/${String(i + 1).padStart(2, '0')}.webp`));
  const caja = $('#f-foto'); caja.className = 'f-foto giro';
  caja.innerHTML = `<img src="${urls[0]}" alt="${esc(actual.nombre)} 360°">`;
  urls.forEach(u => (new Image().src = u));
  const img = caja.querySelector('img'); let i = 0, x0 = null, i0 = 0;
  const paso = () => Math.max(4, caja.clientWidth / (n * 1.2));
  caja.onpointerdown = e => { x0 = e.clientX; i0 = i; caja.setPointerCapture(e.pointerId); $('#f-pista').hidden = true; };
  caja.onpointermove = e => { if (x0 === null) return; i = ((i0 - Math.round((e.clientX - x0) / paso())) % n + n) % n; img.src = urls[i]; };
  caja.onpointerup = caja.onpointercancel = () => (x0 = null);
  $('#f-pista').hidden = false;
}

/* ---------- Carrito ---------- */
function pintarCarrito() {
  const items = Object.values(carrito);
  const n = items.reduce((a, i) => a + i.n, 0), total = items.reduce((a, i) => a + i.n * i.precio, 0);
  $('#cuenta').hidden = !n; $('#cuenta').textContent = n;
  $('#items').innerHTML = items.map(i => {
    const p = productos.find(x => String(x.id) === String(i.id));
    return `<li>${p ? imgTag(p) : '<span class="ph"></span>'}
      <div class="nom"><span>${esc(i.nombre)}</span>
      <span class="cant"><button data-menos="${i.id}" aria-label="Menos">−</button><span>${i.n}</span><button data-mas="${i.id}" aria-label="Más">+</button></span></div>
      <b>${pesos(i.n * i.precio)}</b></li>`;
  }).join('') || '<li class="vacio-c">Aún no agregas productos.</li>';
  $('#total').textContent = pesos(total);
  $('#meta-barra').style.width = Math.min(100, (total / META) * 100) + '%';
  $('#nota-envio').textContent = !n ? '' : total >= META
    ? 'Listo: en CDMX cerca del Metro te lo entregamos el mismo día y pagas al recibir.'
    : `Te faltan ${pesos(META - total)} para la entrega el mismo día en CDMX. Fuera de CDMX te mandamos el costo de envío por WhatsApp.`;
  $('#whatsapp').disabled = !n;
  localStorage.setItem('cd-carrito', JSON.stringify(carrito));
}

function cambiar(id, d) {
  const p = productos.find(x => String(x.id) === String(id)); const i = carrito[id];
  if (!i && d > 0 && p) carrito[id] = { id, nombre: p.nombre, precio: Number(p.precio_publico || 0), n: d };
  else if (i) { i.n += d; if (i.n <= 0) delete carrito[id]; }
  pintar();
  if (d > 0) { const c = $('#cuenta'); c.classList.remove('pulso'); void c.offsetWidth; c.classList.add('pulso'); }
}

function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 1800); }

/* ---------- Hojas ---------- */
function abrir(sel) { const h = $(sel); h.hidden = false; document.body.classList.add('bloqueo'); requestAnimationFrame(() => requestAnimationFrame(() => h.classList.add('abierta'))); }
function cerrar(h) {
  h.classList.remove('abierta'); setTimeout(() => { h.hidden = true; if (!document.querySelector('.hoja.abierta')) document.body.classList.remove('bloqueo'); }, 380);
  if (h.id === 'ficha') history.replaceState(null, '', location.pathname + location.search);
}

document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b?.dataset.id) { e.stopPropagation(); cambiar(b.dataset.id, 1); toast('Agregado a tu pedido'); return; }
  if (b?.dataset.mas) return cambiar(b.dataset.mas, 1);
  if (b?.dataset.menos) return cambiar(b.dataset.menos, -1);
  if (b?.dataset.cat) { cat = b.dataset.cat; pintarChips(); pintar(); return; }
  if (b?.dataset.tab) return mostrarTab(b.dataset.tab);
  if (b?.dataset.vista) {
    $('#f-vistas').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    if (b.dataset.vista === 'giro') giro360(); else { $('#f-foto').className = 'f-foto'; $('#f-foto').innerHTML = imgTag(actual); $('#f-pista').hidden = true; }
    return;
  }
  if (b?.hasAttribute('data-cerrar')) return cerrar(b.closest('.hoja'));
  const t = e.target.closest('[data-abrir]'); if (t) return abrirFicha(t.dataset.abrir);
  if (e.target.classList.contains('hoja')) cerrar(e.target);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.hoja.abierta').forEach(cerrar); });
$('#f-mas').onclick = () => ($('#f-n').textContent = ++nFicha);
$('#f-menos').onclick = () => ($('#f-n').textContent = nFicha = Math.max(1, nFicha - 1));
$('#f-agregar').onclick = () => { cambiar(actual.id, nFicha); cerrar($('#ficha')); toast(nFicha > 1 ? `${nFicha} agregados a tu pedido` : 'Agregado a tu pedido'); };
$('#abrir-carrito').onclick = () => abrir('#carrito');
$('#q').oninput = pintar;
addEventListener('scroll', () => $('#barra').classList.toggle('vid', scrollY > 8), { passive: true });
$('#whatsapp').onclick = () => {
  const items = Object.values(carrito); const total = items.reduce((a, i) => a + i.n * i.precio, 0);
  const txt = ['Hola, quiero hacer este pedido en Carpe Diem:', ...items.map(i => `• ${i.n} × ${i.nombre} — ${pesos(i.n * i.precio)}`),
    `Total: ${pesos(total)}`, 'Entrega en: '].join('\n');
  window.open(`https://wa.me/${WHATSAPP}?text=${encodeURIComponent(txt)}`, '_blank');
};
cargar();
