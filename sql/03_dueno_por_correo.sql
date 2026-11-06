-- Ejecutado 2026-11-03 vía API: la cuenta CORREO_DE_LA_DUENA@ejemplo.com queda como dueña al crearse.
create or replace function public.dueno_por_correo() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if lower(new.email) = 'CORREO_DE_LA_DUENA@ejemplo.com' then
    update public.usuarios set rol = 'dueno' where id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists zz_dueno_por_correo on auth.users;
create trigger zz_dueno_por_correo after insert on auth.users
  for each row execute function public.dueno_por_correo();
