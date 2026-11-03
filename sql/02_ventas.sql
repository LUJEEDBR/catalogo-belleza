-- =====================================================================
-- Catálogo Belleza · Ventas (registro por día, hora y producto)
-- Requiere 01_esquema_rls.sql. Pegar en Supabase > SQL Editor > Run.
-- =====================================================================

-- ---------- TABLAS ----------
create table if not exists public.ventas (
  id           uuid primary key,                         -- lo genera el teléfono (sirve offline y evita duplicados)
  fecha_hora   timestamptz not null default now(),       -- hora real de la venta en el teléfono
  usuario      uuid references public.usuarios(id) on delete set null default auth.uid(),
  total        numeric(10,2) not null default 0 check (total >= 0),
  metodo_pago  text check (metodo_pago in ('efectivo','tarjeta','transferencia','otro')),
  creado_en    timestamptz not null default now()        -- cuándo llegó al servidor
);
create index if not exists ventas_fecha_idx on public.ventas (fecha_hora desc);

create table if not exists public.venta_detalle (
  id              bigint generated always as identity primary key,
  venta_id        uuid not null references public.ventas(id) on delete cascade,
  producto_id     uuid not null references public.productos(id) on delete restrict,
  cantidad        integer not null check (cantidad > 0),
  precio_unitario numeric(10,2) not null check (precio_unitario >= 0),
  subtotal        numeric(10,2) generated always as (cantidad * precio_unitario) stored,
  foto_url        text                                    -- foto tomada si se vendió sin código
);
create index if not exists venta_detalle_venta_idx on public.venta_detalle (venta_id);
create index if not exists venta_detalle_producto_idx on public.venta_detalle (producto_id);

-- ---------- REGISTRAR VENTA (atómico + idempotente) ----------
-- p_items: [{ "producto_id": uuid, "cantidad": 2, "precio_unitario": 189.00, "foto_url": null }, ...]
-- Si la venta ya existe (reintento de la cola offline) no hace nada y devuelve su id.
create or replace function public.registrar_venta(
  p_id uuid, p_fecha_hora timestamptz, p_metodo_pago text, p_items jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  it jsonb; v_total numeric(10,2) := 0;
begin
  if not public.es_staff() then
    raise exception 'Sin permiso para vender' using errcode = '42501';
  end if;
  if exists (select 1 from public.ventas where id = p_id) then
    return p_id;
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'La venta no tiene productos';
  end if;

  insert into public.ventas (id, fecha_hora, usuario, metodo_pago)
  values (p_id, coalesce(p_fecha_hora, now()), auth.uid(), nullif(p_metodo_pago, ''));

  perform set_config('app.en_venta', '1', true);   -- para no llenar historial_cambios con cada descuento

  for it in select * from jsonb_array_elements(p_items) loop
    insert into public.venta_detalle (venta_id, producto_id, cantidad, precio_unitario, foto_url)
    values (p_id, (it->>'producto_id')::uuid, (it->>'cantidad')::int,
            (it->>'precio_unitario')::numeric, nullif(it->>'foto_url', ''));
    update public.productos set existencia = existencia - (it->>'cantidad')::int
      where id = (it->>'producto_id')::uuid;
    v_total := v_total + (it->>'cantidad')::int * (it->>'precio_unitario')::numeric;
  end loop;

  update public.ventas set total = v_total where id = p_id;
  perform set_config('app.en_venta', '', true);
  return p_id;
end $$;

revoke all on function public.registrar_venta(uuid, timestamptz, text, jsonb) from public, anon;
grant execute on function public.registrar_venta(uuid, timestamptz, text, jsonb) to authenticated;

-- El respaldo de cambios no registra los descuentos de existencia por venta
create or replace function public.productos_despues_actualizar() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.precio_publico is distinct from old.precio_publico then
    insert into public.historial_precios (producto_id, campo, precio_anterior, precio_nuevo, usuario)
    values (new.id, 'precio_publico', old.precio_publico, new.precio_publico, auth.uid());
  end if;
  if new.precio_mayoreo is distinct from old.precio_mayoreo then
    insert into public.historial_precios (producto_id, campo, precio_anterior, precio_nuevo, usuario)
    values (new.id, 'precio_mayoreo', old.precio_mayoreo, new.precio_mayoreo, auth.uid());
  end if;
  if new.costo is distinct from old.costo then
    insert into public.historial_precios (producto_id, campo, precio_anterior, precio_nuevo, usuario)
    values (new.id, 'costo', old.costo, new.costo, auth.uid());
  end if;
  if coalesce(current_setting('app.en_venta', true), '') <> '1' then
    insert into public.historial_cambios (producto_id, usuario, datos_anteriores)
    values (old.id, auth.uid(), to_jsonb(old));
  end if;
  return new;
end $$;

-- ---------- RLS ----------
alter table public.ventas        enable row level security;
alter table public.venta_detalle enable row level security;

-- Dueña ve todas las ventas; cada empleado ve las suyas
drop policy if exists ventas_ver on public.ventas;
create policy ventas_ver on public.ventas for select to authenticated
  using (public.es_dueno() or (public.es_staff() and usuario = auth.uid()));
drop policy if exists ventas_borrar on public.ventas;
create policy ventas_borrar on public.ventas for delete to authenticated using (public.es_dueno());
-- Altas solo por registrar_venta(); nadie edita ventas directamente

drop policy if exists venta_detalle_ver on public.venta_detalle;
create policy venta_detalle_ver on public.venta_detalle for select to authenticated
  using (exists (select 1 from public.ventas v where v.id = venta_id
                 and (public.es_dueno() or (public.es_staff() and v.usuario = auth.uid()))));

revoke all on public.ventas, public.venta_detalle from anon;
revoke insert, update on public.ventas, public.venta_detalle from authenticated;

-- ---------- REPORTES (hora de México) ----------
create or replace view public.reporte_ventas_dia with (security_invoker = true) as
  select (fecha_hora at time zone 'America/Mexico_City')::date as dia,
         count(*) as ventas, sum(total) as total
  from public.ventas group by 1 order by 1 desc;

create or replace view public.reporte_ventas_hora with (security_invoker = true) as
  select (fecha_hora at time zone 'America/Mexico_City')::date as dia,
         extract(hour from fecha_hora at time zone 'America/Mexico_City')::int as hora,
         count(*) as ventas, sum(total) as total
  from public.ventas group by 1, 2 order by 1 desc, 2;

create or replace view public.reporte_mas_vendidos with (security_invoker = true) as
  select p.id as producto_id, p.nombre, sum(d.cantidad) as piezas, sum(d.subtotal) as importe,
         max(v.fecha_hora) as ultima_venta
  from public.venta_detalle d
  join public.ventas v on v.id = d.venta_id
  join public.productos p on p.id = d.producto_id
  group by p.id, p.nombre order by piezas desc;

grant select on public.reporte_ventas_dia, public.reporte_ventas_hora, public.reporte_mas_vendidos to authenticated;
