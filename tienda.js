// Tienda pública de Carpe Diem (primera versión). Solo lee columnas públicas (sin costo ni existencia);
// RLS deja ver al público únicamente productos con publicado_en_linea = true.
import { createClient } from './vendor/supabase.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, BUCKET_FOTOS } from './config.js';

const WHATSAPP = '';            // número de Edith (52 + 10 dígitos), pendiente
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = s => document.querySelector(s);
const pesos = n => '$' + Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const publica = ruta => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET_FOTOS}/${ruta}`;
// Foto de tienda (fondo blanco, fotos/tienda/) y, si aún no existe, la del inventario
const fotoTienda = p => { const n = (p.foto_url || '').split('?')[0].split('/').pop(); return n ? publica('tienda/' + n) : ''; };

let productos = [], carrito = JSON.parse(localStorage.getItem('cd-carrito') || '{}');

async function cargar() {
  const demo = new URLSearchParams(location.search).has('demo');
  if (demo) {
    productos = await (await fetch('/tienda-demo.json')).json();
    $('#t-aviso').textContent = 'Vista de ejemplo para aprobar el diseño: precios ficticios.'; $('#t-aviso').hidden = false;
  } else {
    const { data, error } = await sb.from('productos')
      .select('id,nombre,descripcion,foto_url,precio_publico,presentacion_cantidad,presentacion_unidad,marcas(nombre)')
      .eq('publicado_en_linea', true).order('nombre');
    if (error) console.warn(error);
    productos = data || [];
  }
  pintar();
}

function pintar() {
  const q = $('#t-q').value.trim().toLowerCase();
  const lista = productos.filter(p => !q || `${p.nombre} ${p.marcas?.nombre || ''}`.toLowerCase().includes(q));
  $('#t-vacio').hidden = productos.length > 0;
  $('#t-lista').innerHTML = lista.map(p => {
    const pres = p.presentacion_cantidad ? `${p.presentacion_cantidad} ${p.presentacion_unidad || ''}` : '';
    const en = carrito[p.id]?.n || 0;
    return `<article class="t-prod">
      <div class="t-foto"><img loading="lazy" src="${esc(fotoTienda(p))}" data-alt="${esc(p.foto_url || '')}" alt="${esc(p.nombre)}"
        onerror="if(this.dataset.alt&&this.src!==this.dataset.alt){this.src=this.dataset.alt}else{this.remove()}"></div>
      <div class="t-info"><span class="t-marca">${esc(p.marcas?.nombre || '')}</span>
        <h3>${esc(p.nombre)}</h3><span class="t-pres">${esc(pres)}</span>
        <div class="t-fila"><b>${pesos(p.precio_publico)}</b>
          <button class="t-agregar${en ? ' en' : ''}" data-id="${p.id}">${en ? `En pedido · ${en}` : 'Agregar'}</button></div></div>
    </article>`;
  }).join('');
  pintarCarrito();
}

function pintarCarrito() {
  const items = Object.values(carrito);
  const n = items.reduce((a, i) => a + i.n, 0), total = items.reduce((a, i) => a + i.n * i.precio, 0);
  $('#t-cuenta').hidden = !n; $('#t-cuenta').textContent = n;
  $('#t-items').innerHTML = items.map(i => `<li><span>${esc(i.nombre)}</span>
    <span class="t-cant"><button data-menos="${i.id}">−</button>${i.n}<button data-mas="${i.id}">+</button></span>
    <b>${pesos(i.n * i.precio)}</b></li>`).join('') || '<li class="t-nota">Aún no agregas productos.</li>';
  $('#t-total').textContent = pesos(total);
  $('#t-nota-envio').textContent = total >= 500
    ? 'En CDMX cerca del Metro: entrega el mismo día y pagas al recibir.'
    : 'Pedidos mayores a $500 en CDMX: entrega el mismo día. Para otros lugares te enviamos el costo de envío por WhatsApp.';
  $('#t-whatsapp').disabled = !n;
  localStorage.setItem('cd-carrito', JSON.stringify(carrito));
}

function cambiar(id, d) {
  const p = productos.find(x => String(x.id) === String(id)); const i = carrito[id];
  if (!i && d > 0 && p) carrito[id] = { id, nombre: p.nombre, precio: Number(p.precio_publico || 0), n: 1 };
  else if (i) { i.n += d; if (i.n <= 0) delete carrito[id]; }
  pintar();
}

document.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.id) cambiar(b.dataset.id, 1);
  if (b.dataset.mas) cambiar(b.dataset.mas, 1);
  if (b.dataset.menos) cambiar(b.dataset.menos, -1);
});
$('#t-abrir-carrito').onclick = () => ($('#t-carrito').hidden = false);
$('#t-cerrar').onclick = () => ($('#t-carrito').hidden = true);
$('#t-carrito').onclick = e => { if (e.target.id === 't-carrito') e.target.hidden = true; };
$('#t-q').oninput = pintar;
$('#t-whatsapp').onclick = () => {
  const items = Object.values(carrito); const total = items.reduce((a, i) => a + i.n * i.precio, 0);
  const txt = ['Hola, quiero hacer este pedido en Carpe Diem:', ...items.map(i => `• ${i.n} × ${i.nombre} — ${pesos(i.n * i.precio)}`),
    `Total: ${pesos(total)}`, 'Entrega en: '].join('\n');
  window.open(`https://wa.me/${WHATSAPP}?text=${encodeURIComponent(txt)}`, '_blank');
};
cargar();
