-- =====================================================================
-- Catálogo Belleza · Fase 1 · Esquema + RLS + bucket de fotos
-- Pegar completo en Supabase > SQL Editor > New query > Run
-- Se puede volver a correr sin romper nada (idempotente en lo posible)
-- =====================================================================

create extension if not exists pg_trgm;

-- ---------- USUARIOS (perfil ligado a Supabase Auth) ----------
create table if not exists public.usuarios (
  id         uuid primary key references auth.users(id) on delete cascade,
  nombre     text not null default '',
  rol        text not null default 'empleado' check (rol in ('dueno','empleado')),
  activo     boolean not null default true,
  creado_en  timestamptz not null default now()
);

-- Funciones de rol (security definer para que RLS no se muerda la cola)
create or replace function public.es_dueno() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.usuarios
                 where id = auth.uid() and rol = 'dueno' and activo);
$$;

create or replace function public.es_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.usuarios
                 where id = auth.uid() and activo);
$$;

-- Al registrarse alguien en Auth, se crea su perfil como empleado
create or replace function public.crear_perfil_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.usuarios (id, nombre)
  values (new.id, coalesce(new.raw_user_meta_data->>'nombre', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists al_crear_usuario on auth.users;
create trigger al_crear_usuario after insert on auth.users
  for each row execute function public.crear_perfil_usuario();

-- ---------- MARCAS ----------
create table if not exists public.marcas (
  id        uuid primary key default gen_random_uuid(),
  nombre    text not null unique,
  logo_url  text,
  creado_en timestamptz not null default now()
);

-- ---------- CATEGORÍAS (con subcategorías vía padre_id) ----------
create table if not exists public.categorias (
  id        uuid primary key default gen_random_uuid(),
  nombre    text not null,
  padre_id  uuid references public.categorias(id) on delete set null,
  creado_en timestamptz not null default now(),
  unique (nombre, padre_id)
);

-- ---------- PRODUCTOS ----------
create sequence if not exists public.codigo_interno_seq;

create table if not exists public.productos (
  id                    uuid primary key default gen_random_uuid(),
  codigo_barras         text unique,
  codigo_interno        text unique,
  nombre                text not null,
  marca_id              uuid references public.marcas(id) on delete set null,
  categoria_id          uuid references public.categorias(id) on delete set null,
  subcategoria_id       uuid references public.categorias(id) on delete set null,
  genero                text check (genero in ('hombre','mujer','unisex')),
  presentacion_cantidad numeric(10,2),
  presentacion_unidad   text check (presentacion_unidad in ('ml','g','pzas')),
  descripcion           text,
  foto_url              text,
  precio_publico        numeric(10,2) check (precio_publico >= 0),
  precio_mayoreo        numeric(10,2) check (precio_mayoreo >= 0),
  costo                 numeric(10,2) check (costo >= 0),
  existencia            integer not null default 0,
  ubicacion             text check (ubicacion in ('anaquel','bodega')),
  ubicacion_detalle     text,              -- ej. "Anaquel 3, repisa 2"
  publicado_en_linea    boolean not null default false,
  actualizado_por       uuid references public.usuarios(id) on delete set null,
  actualizado_en        timestamptz not null default now(),
  cambio_cliente_en     timestamptz,       -- hora del cambio en el teléfono (cola offline)
  creado_en             timestamptz not null default now(),
  constraint tiene_algun_codigo check (codigo_barras is not null or codigo_interno is not null)
);

create index if not exists productos_nombre_trgm on public.productos using gin (nombre gin_trgm_ops);
create index if not exists productos_marca_idx on public.productos (marca_id);
create index if not exists productos_categoria_idx on public.productos (categoria_id);
create index if not exists productos_publicados_idx on public.productos (publicado_en_linea) where publicado_en_linea;

-- ---------- REGLAS DE PRECIO ----------
create table if not exists public.reglas_precio (
  id           uuid primary key default gen_random_uuid(),
  alcance      text not null check (alcance in ('marca','categoria','todo')),
  marca_id     uuid references public.marcas(id) on delete cascade,
  categoria_id uuid references public.categorias(id) on delete cascade,
  margen_pct   numeric(6,2) not null,            -- ej. 35 = 35% sobre costo
  redondeo     numeric(10,2) not null default 1, -- ej. 5 = redondear al múltiplo de $5
  activo       boolean not null default true,
  creado_en    timestamptz not null default now(),
  constraint alcance_coherente check (
    (alcance = 'marca'     and marca_id is not null and categoria_id is null) or
    (alcance = 'categoria' and categoria_id is not null and marca_id is null) or
    (alcance = 'todo'      and marca_id is null and categoria_id is null))
);

-- ---------- HISTORIALES ----------
create table if not exists public.historial_precios (
  id              bigint generated always as identity primary key,
  producto_id     uuid not null references public.productos(id) on delete cascade,
  campo           text not null check (campo in ('precio_publico','precio_mayoreo','costo')),
  precio_anterior numeric(10,2),
  precio_nuevo    numeric(10,2),
  usuario         uuid references public.usuarios(id) on delete set null,
  fecha           timestamptz not null default now()
);
create index if not exists historial_precios_producto_idx on public.historial_precios (producto_id, fecha desc);

create table if not exists public.historial_cambios (
  id              bigint generated always as identity primary key,
  producto_id     uuid not null references public.productos(id) on delete cascade,
  usuario         uuid references public.usuarios(id) on delete set null,
  datos_anteriores jsonb not null,
  fecha           timestamptz not null default now()
);

-- ---------- TRIGGERS DE PRODUCTOS ----------
-- Antes de guardar: sella quién/cuándo, código interno si no hay código,
-- "último cambio gana" según la hora del teléfono, y bloqueo de precios.
create or replace function public.productos_antes_guardar() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    -- Cambio offline más viejo que el que ya está guardado: se ignora
    if new.cambio_cliente_en is not null and old.cambio_cliente_en is not null
       and new.cambio_cliente_en < old.cambio_cliente_en then
      return null;
    end if;
    -- Solo la dueña cambia precios (auth.uid() nulo = SQL Editor / servidor)
    if auth.uid() is not null and not public.es_dueno() and (
         new.precio_publico is distinct from old.precio_publico or
         new.precio_mayoreo is distinct from old.precio_mayoreo or
         new.costo          is distinct from old.costo) then
      raise exception 'Solo el dueño puede cambiar precios' using errcode = '42501';
    end if;
  end if;

  if new.codigo_barras is null and new.codigo_interno is null then
    new.codigo_interno := 'INT-' || lpad(nextval('public.codigo_interno_seq')::text, 6, '0');
  end if;

  new.actualizado_en  := now();
  new.actualizado_por := coalesce(auth.uid(), new.actualizado_por);
  return new;
end $$;

drop trigger if exists productos_antes_guardar on public.productos;
create trigger productos_antes_guardar before insert or update on public.productos
  for each row execute function public.productos_antes_guardar();

-- Después de actualizar: historial de precios y respaldo del registro anterior
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
  insert into public.historial_cambios (producto_id, usuario, datos_anteriores)
  values (old.id, auth.uid(), to_jsonb(old));
  return new;
end $$;

drop trigger if exists productos_despues_actualizar on public.productos;
create trigger productos_despues_actualizar after update on public.productos
  for each row execute function public.productos_despues_actualizar();

-- =====================================================================
-- RLS
-- =====================================================================
alter table public.usuarios          enable row level security;
alter table public.marcas            enable row level security;
alter table public.categorias        enable row level security;
alter table public.productos         enable row level security;
alter table public.reglas_precio     enable row level security;
alter table public.historial_precios enable row level security;
alter table public.historial_cambios enable row level security;

-- Usuarios: cada quien ve su perfil; la dueña ve y edita a todos
drop policy if exists usuarios_ver on public.usuarios;
create policy usuarios_ver on public.usuarios for select to authenticated
  using (id = auth.uid() or public.es_dueno());
drop policy if exists usuarios_editar on public.usuarios;
create policy usuarios_editar on public.usuarios for update to authenticated
  using (public.es_dueno()) with check (public.es_dueno());

-- Marcas y categorías: lectura pública; staff captura; dueña borra
drop policy if exists marcas_ver on public.marcas;
create policy marcas_ver on public.marcas for select using (true);
drop policy if exists marcas_crear on public.marcas;
create policy marcas_crear on public.marcas for insert to authenticated with check (public.es_staff());
drop policy if exists marcas_editar on public.marcas;
create policy marcas_editar on public.marcas for update to authenticated using (public.es_staff());
drop policy if exists marcas_borrar on public.marcas;
create policy marcas_borrar on public.marcas for delete to authenticated using (public.es_dueno());

drop policy if exists categorias_ver on public.categorias;
create policy categorias_ver on public.categorias for select using (true);
drop policy if exists categorias_crear on public.categorias;
create policy categorias_crear on public.categorias for insert to authenticated with check (public.es_staff());
drop policy if exists categorias_editar on public.categorias;
create policy categorias_editar on public.categorias for update to authenticated using (public.es_staff());
drop policy if exists categorias_borrar on public.categorias;
create policy categorias_borrar on public.categorias for delete to authenticated using (public.es_dueno());

-- Productos: el público solo ve publicados; staff ve todo y captura; dueña borra
drop policy if exists productos_ver_publico on public.productos;
create policy productos_ver_publico on public.productos for select to anon
  using (publicado_en_linea);
drop policy if exists productos_ver_staff on public.productos;
create policy productos_ver_staff on public.productos for select to authenticated
  using (public.es_staff() or publicado_en_linea);
drop policy if exists productos_crear on public.productos;
create policy productos_crear on public.productos for insert to authenticated
  with check (public.es_staff());
drop policy if exists productos_editar on public.productos;
create policy productos_editar on public.productos for update to authenticated
  using (public.es_staff()) with check (public.es_staff());
drop policy if exists productos_borrar on public.productos;
create policy productos_borrar on public.productos for delete to authenticated
  using (public.es_dueno());

-- El público nunca ve costo, mayoreo ni existencia (permiso por columna)
revoke select on public.productos from anon;
grant select (id, codigo_barras, codigo_interno, nombre, marca_id, categoria_id,
              subcategoria_id, genero, presentacion_cantidad, presentacion_unidad,
              descripcion, foto_url, precio_publico, publicado_en_linea)
  on public.productos to anon;
revoke insert, update, delete on all tables in schema public from anon;

-- Reglas de precio: staff las lee (para sugerir precio); solo dueña las cambia
drop policy if exists reglas_ver on public.reglas_precio;
create policy reglas_ver on public.reglas_precio for select to authenticated using (public.es_staff());
drop policy if exists reglas_dueno on public.reglas_precio;
create policy reglas_dueno on public.reglas_precio for all to authenticated
  using (public.es_dueno()) with check (public.es_dueno());

-- Historiales: solo lectura para staff (los llenan los triggers)
drop policy if exists historial_precios_ver on public.historial_precios;
create policy historial_precios_ver on public.historial_precios for select to authenticated using (public.es_staff());
drop policy if exists historial_cambios_ver on public.historial_cambios;
create policy historial_cambios_ver on public.historial_cambios for select to authenticated using (public.es_dueno());

-- =====================================================================
-- STORAGE: bucket público de fotos (WebP/JPEG, máx 1 MB)
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos', 'fotos', true, 1048576, array['image/webp','image/jpeg'])
on conflict (id) do update set public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists fotos_ver on storage.objects;
create policy fotos_ver on storage.objects for select using (bucket_id = 'fotos');
drop policy if exists fotos_subir on storage.objects;
create policy fotos_subir on storage.objects for insert to authenticated
  with check (bucket_id = 'fotos' and public.es_staff());
drop policy if exists fotos_reemplazar on storage.objects;
create policy fotos_reemplazar on storage.objects for update to authenticated
  using (bucket_id = 'fotos' and public.es_staff());
drop policy if exists fotos_borrar on storage.objects;
create policy fotos_borrar on storage.objects for delete to authenticated
  using (bucket_id = 'fotos' and public.es_dueno());

-- =====================================================================
-- DESPUÉS de crear tu usuario en Authentication > Users, hazte dueña:
-- update public.usuarios set rol = 'dueno'
--   where id = (select id from auth.users where email = 'TU_CORREO_AQUI');
-- =====================================================================
