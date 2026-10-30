create extension if not exists pgcrypto;
grant usage on schema public to anon, authenticated;

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 100),
  price numeric(14, 2) not null check (price > 0),
  category text not null check (char_length(category) between 1 and 50),
  image text not null default '',
  description text not null check (char_length(description) between 1 and 600),
  available boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.store_settings (
  id boolean primary key default true check (id),
  store_name text not null default 'SHARK | SHOP | GURLAN',
  phone text not null default '+998931150389',
  delivery_info text not null default 'Yetkazib berish vaqti buyurtma tasdiqlangandan so‘ng kelishiladi.',
  updated_at timestamptz not null default now()
);

insert into public.store_settings (id)
values (true)
on conflict (id) do nothing;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_name text not null,
  phone text not null,
  fulfillment text not null check (fulfillment in ('Yetkazib berish', 'Olib ketish')),
  address text not null default '',
  coordinates jsonb,
  map_link text not null default '',
  note text not null default '',
  items jsonb not null,
  total numeric(14, 2) not null check (total > 0),
  status text not null default 'Yangi'
    check (status in ('Yangi', 'Tasdiqlandi', 'Tayyorlanmoqda', 'Yetkazilmoqda', 'Yetkazildi', 'Bekor qilindi')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.is_shark_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_users
    where user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_shark_admin() from public;
grant execute on function public.is_shark_admin() to anon, authenticated;

alter table public.admin_users enable row level security;
alter table public.products enable row level security;
alter table public.store_settings enable row level security;
alter table public.orders enable row level security;

drop policy if exists "Admins can read their own admin record" on public.admin_users;
create policy "Admins can read their own admin record"
  on public.admin_users for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Public can read available products" on public.products;
create policy "Public can read available products"
  on public.products for select to anon, authenticated
  using (available or (select public.is_shark_admin()));

drop policy if exists "Admins can add products" on public.products;
create policy "Admins can add products"
  on public.products for insert to authenticated
  with check ((select public.is_shark_admin()));

drop policy if exists "Admins can edit products" on public.products;
create policy "Admins can edit products"
  on public.products for update to authenticated
  using ((select public.is_shark_admin()))
  with check ((select public.is_shark_admin()));

drop policy if exists "Admins can delete products" on public.products;
create policy "Admins can delete products"
  on public.products for delete to authenticated
  using ((select public.is_shark_admin()));

drop policy if exists "Public can read store settings" on public.store_settings;
create policy "Public can read store settings"
  on public.store_settings for select to anon, authenticated
  using (id = true);

drop policy if exists "Admins can update store settings" on public.store_settings;
create policy "Admins can update store settings"
  on public.store_settings for update to authenticated
  using ((select public.is_shark_admin()))
  with check ((select public.is_shark_admin()));

drop policy if exists "Admins can read orders" on public.orders;
create policy "Admins can read orders"
  on public.orders for select to authenticated
  using ((select public.is_shark_admin()));

drop policy if exists "Admins can update orders" on public.orders;
create policy "Admins can update orders"
  on public.orders for update to authenticated
  using ((select public.is_shark_admin()))
  with check ((select public.is_shark_admin()));

grant select on public.products to anon, authenticated;
grant insert, update, delete on public.products to authenticated;
grant select on public.store_settings to anon, authenticated;
grant update on public.store_settings to authenticated;
grant select, update on public.orders to authenticated;
grant select on public.admin_users to authenticated;

create or replace function public.place_shark_order(
  p_customer_name text,
  p_phone text,
  p_fulfillment text,
  p_address text default '',
  p_coordinates jsonb default null,
  p_note text default '',
  p_items jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_customer_name, ''));
  v_phone_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_phone text;
  v_address text := btrim(coalesce(p_address, ''));
  v_note text := left(btrim(coalesce(p_note, '')), 1000);
  v_order_items jsonb := '[]'::jsonb;
  v_requested jsonb;
  v_product public.products%rowtype;
  v_product_id uuid;
  v_quantity integer;
  v_total numeric(14, 2) := 0;
  v_order public.orders%rowtype;
  v_map_link text := '';
begin
  if char_length(v_name) < 3 or char_length(v_name) > 120 then
    raise exception 'Ism va familiyani to‘g‘ri kiriting.';
  end if;

  if char_length(v_phone_digits) = 9 then
    v_phone_digits := '998' || v_phone_digits;
  end if;
  if v_phone_digits !~ '^998[0-9]{9}$' then
    raise exception 'O‘zbekiston telefon raqamini to‘g‘ri kiriting.';
  end if;
  v_phone := '+' || v_phone_digits;

  if p_fulfillment not in ('Yetkazib berish', 'Olib ketish') then
    raise exception 'Buyurtma usuli noto‘g‘ri.';
  end if;
  if p_fulfillment = 'Yetkazib berish' and char_length(v_address) < 5 then
    raise exception 'Yetkazib berish manzilini kiriting.';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Buyurtma mahsulotlari ro‘yxati noto‘g‘ri.';
  end if;
  if jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 50 then
    raise exception 'Buyurtma mahsulotlari ro‘yxati noto‘g‘ri.';
  end if;

  for v_requested in select value from jsonb_array_elements(p_items)
  loop
    if coalesce(v_requested->>'productId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(v_requested->>'quantity', '') !~ '^[0-9]{1,3}$' then
      raise exception 'Buyurtma mahsuloti yoki miqdori noto‘g‘ri.';
    end if;

    v_product_id := (v_requested->>'productId')::uuid;
    v_quantity := (v_requested->>'quantity')::integer;
    if v_quantity < 1 or v_quantity > 99 then
      raise exception 'Mahsulot miqdori ruxsat etilgan chegaradan tashqarida.';
    end if;

    select * into v_product
    from public.products
    where id = v_product_id and available = true;
    if not found then
      raise exception 'Mahsulot topilmadi yoki sotuvda mavjud emas.';
    end if;

    v_total := v_total + v_product.price * v_quantity;
    v_order_items := v_order_items || jsonb_build_array(jsonb_build_object(
      'productId', v_product.id,
      'title', v_product.title,
      'price', v_product.price,
      'quantity', v_quantity
    ));
  end loop;

  if p_coordinates is not null
    and jsonb_typeof(p_coordinates) = 'object'
    and (p_coordinates->>'latitude') ~ '^-?[0-9]+(\.[0-9]+)?$'
    and (p_coordinates->>'longitude') ~ '^-?[0-9]+(\.[0-9]+)?$' then
    v_map_link := format(
      'https://www.google.com/maps?q=%s,%s',
      p_coordinates->>'latitude',
      p_coordinates->>'longitude'
    );
  else
    p_coordinates := null;
  end if;

  insert into public.orders (
    order_number, customer_name, phone, fulfillment, address,
    coordinates, map_link, note, items, total
  )
  values (
    'SH-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
    v_name,
    v_phone,
    p_fulfillment,
    case when p_fulfillment = 'Yetkazib berish' then v_address else '' end,
    case when p_fulfillment = 'Yetkazib berish' then p_coordinates else null end,
    case when p_fulfillment = 'Yetkazib berish' then v_map_link else '' end,
    v_note,
    v_order_items,
    v_total
  )
  returning * into v_order;

  return jsonb_build_object(
    'id', v_order.id,
    'orderNumber', v_order.order_number,
    'createdAt', v_order.created_at,
    'status', v_order.status,
    'items', v_order.items,
    'total', v_order.total
  );
end;
$$;

revoke all on function public.place_shark_order(text, text, text, text, jsonb, text, jsonb) from public;
grant execute on function public.place_shark_order(text, text, text, text, jsonb, text, jsonb) to anon, authenticated;

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

drop policy if exists "Public can view Shark product images" on storage.objects;
create policy "Public can view Shark product images"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'product-images');

drop policy if exists "Admins can upload Shark product images" on storage.objects;
create policy "Admins can upload Shark product images"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and (select public.is_shark_admin()));

drop policy if exists "Admins can update Shark product images" on storage.objects;
create policy "Admins can update Shark product images"
  on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and (select public.is_shark_admin()))
  with check (bucket_id = 'product-images' and (select public.is_shark_admin()));

drop policy if exists "Admins can delete Shark product images" on storage.objects;
create policy "Admins can delete Shark product images"
  on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and (select public.is_shark_admin()));

-- After creating the administrator in Supabase Authentication > Users,
-- replace the email below and run this statement to grant admin access:
-- insert into public.admin_users (user_id)
-- select id from auth.users where email = 'admin@example.com'
-- on conflict (user_id) do nothing;
