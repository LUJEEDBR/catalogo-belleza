-- 04: endurecer seguridad (2026-11-06)
-- 1) Usuarios nuevos entran INACTIVOS; la dueña los activa (la dueña se activa sola por correo).
alter table public.usuarios alter column activo set default false;
create or replace function public.crear_perfil_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.usuarios (id, nombre, activo)
  values (new.id, coalesce(new.raw_user_meta_data->>'nombre', split_part(new.email,'@',1)), false)
  on conflict (id) do nothing;
  return new;
end $$;
create or replace function public.dueno_por_correo() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if lower(new.email) = 'CORREO_DE_LA_DUENA@ejemplo.com' then
    update public.usuarios set rol = 'dueno', activo = true where id = new.id;
  end if;
  return new;
end $$;

-- 2) Ventas: cantidades positivas y precio no menor al de lista (salvo la dueña).
create or replace function public.registrar_venta(p_id uuid, p_fecha_hora timestamptz, p_metodo_pago text, p_items jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  it jsonb; v_total numeric(10,2) := 0; v_min numeric; v_cant int; v_precio numeric;
begin
  if not public.es_staff() then
    raise exception 'Sin permiso para vender' using errcode = '42501';
  end if;
  if exists (select 1 from public.ventas where id = p_id) then return p_id; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'La venta no tiene productos';
  end if;

  insert into public.ventas (id, fecha_hora, usuario, metodo_pago)
  values (p_id, coalesce(p_fecha_hora, now()), auth.uid(), nullif(p_metodo_pago, ''));
  perform set_config('app.en_venta', '1', true);

  for it in select * from jsonb_array_elements(p_items) loop
    v_cant := (it->>'cantidad')::int; v_precio := (it->>'precio_unitario')::numeric;
    if v_cant is null or v_cant <= 0 then raise exception 'Cantidad inválida'; end if;
    if v_precio is null or v_precio < 0 then raise exception 'Precio inválido'; end if;
    if not public.es_dueno() then
      select least(precio_publico, coalesce(nullif(precio_mayoreo, 0), precio_publico)) into v_min
        from public.productos where id = (it->>'producto_id')::uuid;
      if v_min is not null and v_precio < v_min then
        raise exception 'Precio menor al autorizado' using errcode = '42501';
      end if;
    end if;
    insert into public.venta_detalle (venta_id, producto_id, cantidad, precio_unitario, foto_url)
    values (p_id, (it->>'producto_id')::uuid, v_cant, v_precio, nullif(it->>'foto_url', ''));
    update public.productos set existencia = existencia - v_cant where id = (it->>'producto_id')::uuid;
    v_total := v_total + v_cant * v_precio;
  end loop;

  update public.ventas set total = v_total where id = p_id;
  perform set_config('app.en_venta', '', true);
  return p_id;
end $$;
