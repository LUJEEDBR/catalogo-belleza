// Sincronización: descarga el catálogo a IndexedDB y sube la cola en orden.
// Regla de conflictos: "último cambio gana" por cambio_cliente_en (lo aplica el trigger en Supabase);
// los cambios de precio de empleados los rechaza el servidor (42501) y se descartan con aviso.
import * as db from './db.js';
import { BUCKET_FOTOS } from './config.js';

let sincronizando = false;
const esErrorDeRed = e => !navigator.onLine || e instanceof TypeError || /fetch|network|Failed/i.test(e?.message || '');

export async function descargarCatalogo(sb) {
  const desde = (await db.getMeta('ultima_descarga')) || '1970-01-01T00:00:00Z';
  const inicio = new Date().toISOString();
  let pagina = 0, total = 0;
  for (;;) {
    const { data, error } = await sb.from('productos').select('*, marcas(nombre)')
      .gt('actualizado_en', desde).order('actualizado_en').range(pagina * 500, pagina * 500 + 499);
    if (error) throw error;
    await db.guardarLocales(data); total += data.length;
    if (data.length < 500) break; pagina++;
  }
  await db.setMeta('ultima_descarga', inicio);
  return total;
}

async function idMarca(sb, nombre) {
  if (!nombre) return null;
  const { data } = await sb.from('marcas').select('id').ilike('nombre', nombre).maybeSingle();
  if (data) return data.id;
  const { data: nueva, error } = await sb.from('marcas').insert({ nombre }).select('id').single();
  if (error?.code === '23505') return (await sb.from('marcas').select('id').ilike('nombre', nombre).single()).data.id;
  if (error) throw error;
  return nueva.id;
}

async function subirFoto(sb, clave, blob, carpeta = 'productos') {
  const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
  const ruta = `${carpeta}/${clave}.${ext}`;
  const { error } = await sb.storage.from(BUCKET_FOTOS).upload(ruta, blob, { upsert: true, contentType: blob.type });
  if (error) throw error;
  return sb.storage.from(BUCKET_FOTOS).getPublicUrl(ruta).data.publicUrl + `?v=${Date.now()}`;
}

// Venta: sube las fotos de lo vendido sin código y registra todo en una sola llamada (idempotente)
async function aplicarVenta(sb, op) {
  const items = [];
  for (const [i, it] of op.items.entries()) {
    const { foto, ...resto } = it;
    if (foto instanceof Blob) resto.foto_url = await subirFoto(sb, `${op.id}-${i + 1}`, foto, 'ventas');
    items.push(resto);
  }
  const { error } = await sb.rpc('registrar_venta',
    { p_id: op.id, p_fecha_hora: op.fecha_hora, p_metodo_pago: op.metodo_pago || null, p_items: items });
  if (error) throw error;
  await db.guardarVentas([{ id: op.id, fecha_hora: op.fecha_hora, metodo_pago: op.metodo_pago, total: op.total,
    usuario: op.usuario, pendiente: false, items: items.map(({ foto_url, ...x }) => x) }]);
  return null;
}

export async function descargarVentas(sb, dias = 90) {
  const desde = (await db.getMeta('ventas_desde')) || new Date(Date.now() - dias * 864e5).toISOString();
  const inicio = new Date().toISOString();
  const { data, error } = await sb.from('ventas')
    .select('id, fecha_hora, metodo_pago, total, usuario, creado_en, venta_detalle(producto_id, cantidad, precio_unitario)')
    .gt('creado_en', desde).order('creado_en').limit(5000);
  if (error) throw error;
  await db.guardarVentas(data.map(v => ({ ...v, pendiente: false, items: v.venta_detalle })));
  await db.setMeta('ventas_desde', inicio);
}

async function aplicar(sb, op) {
  if (op.tipo === 'venta') return aplicarVenta(sb, op);
  const fila = { ...op.fila };
  if ('marca_nombre' in fila) { fila.marca_id = await idMarca(sb, fila.marca_nombre); delete fila.marca_nombre; }

  let guardado;
  if (op.tipo === 'insert') {
    const r = await sb.from('productos').insert(fila).select().single();
    if (r.error?.code === '23505') { // ya existía (reintento o el código lo dio de alta alguien más): pasa a update
      const { id, codigo_barras, ...resto } = fila;
      guardado = (await sb.from('productos').update(resto)
        .or(`id.eq.${id}${codigo_barras ? `,codigo_barras.eq.${codigo_barras}` : ''}`).select().maybeSingle().throwOnError()).data;
    } else if (r.error) throw r.error; else guardado = r.data;
  } else {
    guardado = (await sb.from('productos').update(fila).eq('id', op.id).select().maybeSingle().throwOnError()).data;
  }
  // guardado null = el servidor ignoró un cambio más viejo (último cambio gana)
  if (op.foto && guardado) {
    const url = await subirFoto(sb, guardado.codigo_barras || guardado.codigo_interno, op.foto);
    guardado = (await sb.from('productos').update({ foto_url: url, cambio_cliente_en: new Date().toISOString() })
      .eq('id', guardado.id).select().single().throwOnError()).data;
  }
  return guardado;
}

// Devuelve { subidos, rechazados: [mensajes], pendientes }
export async function sincronizar(sb) {
  if (sincronizando || !navigator.onLine) return { subidos: 0, rechazados: [], pendientes: await db.contarPendientes() };
  sincronizando = true;
  let subidos = 0; const rechazados = [];
  try {
    for (const op of await db.pendientes()) {
      try {
        const g = await aplicar(sb, op);
        if (g) await db.guardarLocales([g]);
        await db.quitar(op.n); subidos++;
      } catch (e) {
        if (esErrorDeRed(e)) break; // sin internet: se reintenta luego, en el mismo orden
        const quien = op.tipo === 'venta' ? `Venta de $${op.total}` : (op.fila.nombre || 'Producto');
        rechazados.push(e.code === '42501' && op.tipo !== 'venta' ? `${quien}: solo la dueña cambia precios` : `${quien}: ${e.message}`);
        // error de datos/permisos: no bloquea la cola. Una venta nunca se borra: se queda para reintentar.
        if (op.tipo !== 'venta') await db.quitar(op.n);
      }
    }
    await descargarCatalogo(sb).catch(() => {});
    await descargarVentas(sb).catch(() => {});
  } finally { sincronizando = false; }
  return { subidos, rechazados, pendientes: await db.contarPendientes() };
}
