-- DumpsterGames online profiles. Run this whole file in Supabase > SQL Editor.
-- Only use the public/publishable (anon) key on the website. Never expose service_role keys.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  pennies integer not null default 20 check (pennies >= 0),
  total_pennies_earned integer not null default 20 check (total_pennies_earned >= 0),
  avatar_skin text not null default '#f2c879',
  avatar_shirt text not null default '#59d6ff',
  avatar_hat text not null default 'cap',
  earned_badges text[] not null default array['fresh_diver']::text[],
  last_penny_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint profile_username_format check (username ~ '^[A-Za-z0-9_]{3,16}$'),
  constraint profile_skin_check check (avatar_skin in ('#f2c879','#b1e3ff','#c4ff4d','#ff7777','#d5a5ff','#f0f0ee','#ff9d38')),
  constraint profile_shirt_check check (avatar_shirt in ('#ff784f','#59d6ff','#b5ee65','#c58aff','#f5d75e','#f0f0ee','#292e42')),
  constraint profile_hat_check check (avatar_hat in ('none','cap','bucket','crown','cone'))
);
create unique index if not exists profiles_username_ci on public.profiles (lower(username));

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  constraint no_self_friendship check (requester_id <> addressee_id)
);
create unique index if not exists friendships_one_pair on public.friendships (
  least(requester_id, addressee_id), greatest(requester_id, addressee_id)
);

alter table public.profiles enable row level security;
alter table public.friendships enable row level security;
drop policy if exists "read own or friends profiles" on public.profiles;
create policy "read own or friends profiles" on public.profiles for select to authenticated using (
  id = auth.uid() or exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = auth.uid() and f.addressee_id = profiles.id)
        or (f.addressee_id = auth.uid() and f.requester_id = profiles.id))
  )
);
drop policy if exists "read own friendship rows" on public.friendships;
create policy "read own friendship rows" on public.friendships for select to authenticated using (requester_id = auth.uid() or addressee_id = auth.uid());
-- All balance, badge and friendship changes go through server-checked RPCs.
revoke insert, update, delete on public.profiles from anon, authenticated;
revoke insert, update, delete on public.friendships from anon, authenticated;
grant select on public.profiles to authenticated;
grant select on public.friendships to authenticated;

create or replace function public.award_badge(p_user_id uuid, p_badge text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_reward integer;
begin
  v_reward := case p_badge
    when 'fresh_diver' then 10
    when 'style_icon' then 15
    when 'crew_starter' then 25
    when 'crew_builder' then 50
    when 'penny_hoarder' then 35
    else null end;
  if v_reward is null then return false; end if;
  update public.profiles
     set earned_badges = array_append(earned_badges, p_badge),
         pennies = pennies + v_reward,
         total_pennies_earned = total_pennies_earned + v_reward
   where id = p_user_id and not (p_badge = any(earned_badges));
  return found;
end; $$;
revoke all on function public.award_badge(uuid,text) from public, anon, authenticated;

create or replace function public.handle_new_diver()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  v_name := coalesce(new.raw_user_meta_data->>'username','');
  v_name := left(regexp_replace(v_name, '[^A-Za-z0-9_]', '', 'g'),16);
  if length(v_name) < 3 then v_name := 'Diver_' || substr(replace(new.id::text,'-',''),1,8); end if;
  insert into public.profiles(id,username,pennies,total_pennies_earned,earned_badges,last_penny_at)
  values(new.id,v_name,20,20,array['fresh_diver']::text[],now());
  return new;
exception when unique_violation then
  raise exception 'That diver username is already taken. Please choose another one.';
end; $$;
drop trigger if exists on_auth_user_created_diver on auth.users;
create trigger on_auth_user_created_diver after insert on auth.users for each row execute procedure public.handle_new_diver();

create or replace function public.claim_pennies()
returns integer language plpgsql security definer set search_path = public as $$
declare v_id uuid := auth.uid(); v_count integer := 0; v_total integer; v_last timestamptz;
begin
  if v_id is null then raise exception 'Please sign in first.'; end if;
  select last_penny_at into v_last from public.profiles where id = v_id for update;
  if v_last is null then raise exception 'Profile not found.'; end if;
  v_count := floor(extract(epoch from (clock_timestamp() - v_last)) / 900)::integer;
  if coalesce(v_count,0) > 0 then
    update public.profiles
      set pennies = pennies + v_count,
          total_pennies_earned = total_pennies_earned + v_count,
          last_penny_at = v_last + make_interval(secs => (v_count * 900))
      where id = v_id;
  end if;
  select total_pennies_earned into v_total from public.profiles where id=v_id;
  if coalesce(v_total,0) >= 100 then perform public.award_badge(v_id,'penny_hoarder'); end if;
  return greatest(coalesce(v_count,0),0);
end; $$;
grant execute on function public.claim_pennies() to authenticated;

create or replace function public.save_avatar(p_skin text, p_shirt text, p_hat text)
returns void language plpgsql security definer set search_path = public as $$
declare v_id uuid := auth.uid();
begin
  if v_id is null then raise exception 'Please sign in first.'; end if;
  if p_skin not in ('#f2c879','#b1e3ff','#c4ff4d','#ff7777','#d5a5ff','#f0f0ee','#ff9d38') then raise exception 'Skin colour is not available.'; end if;
  if p_shirt not in ('#ff784f','#59d6ff','#b5ee65','#c58aff','#f5d75e','#f0f0ee','#292e42') then raise exception 'Hoodie colour is not available.'; end if;
  if p_hat not in ('none','cap','bucket','crown','cone') then raise exception 'Hat is not available.'; end if;
  update public.profiles set avatar_skin=p_skin,avatar_shirt=p_shirt,avatar_hat=p_hat where id=v_id;
  if p_skin <> '#f2c879' or p_shirt <> '#59d6ff' or p_hat <> 'cap' then perform public.award_badge(v_id,'style_icon'); end if;
end; $$;
grant execute on function public.save_avatar(text,text,text) to authenticated;

create or replace function public.search_profiles(p_term text)
returns table(id uuid, username text, avatar_skin text, avatar_shirt text, avatar_hat text, pennies integer, earned_badges text[])
language sql stable security definer set search_path = public as $$
  select p.id,p.username,p.avatar_skin,p.avatar_shirt,p.avatar_hat,p.pennies,p.earned_badges
  from public.profiles p
  where auth.uid() is not null and p.id <> auth.uid()
    and lower(p.username) like '%' || lower(left(trim(coalesce(p_term,'')),32)) || '%'
  order by p.username limit 20;
$$;
grant execute on function public.search_profiles(text) to authenticated;

create or replace function public.send_friend_request(p_target uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_status text;
begin
  if v_me is null then raise exception 'Please sign in first.'; end if;
  if p_target = v_me then raise exception 'You cannot add yourself.'; end if;
  if not exists(select 1 from public.profiles where id=p_target) then raise exception 'Diver not found.'; end if;
  select status into v_status from public.friendships
   where least(requester_id,addressee_id)=least(v_me,p_target)
     and greatest(requester_id,addressee_id)=greatest(v_me,p_target) limit 1;
  if v_status='accepted' then raise exception 'You are already friends.'; end if;
  if v_status='pending' then raise exception 'A request is already waiting. Check your incoming requests.'; end if;
  insert into public.friendships(requester_id,addressee_id,status) values(v_me,p_target,'pending');
end; $$;
grant execute on function public.send_friend_request(uuid) to authenticated;

create or replace function public.accept_friend_request(p_request_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_sender uuid; v_a_count integer; v_b_count integer; v_total integer;
begin
  if v_me is null then raise exception 'Please sign in first.'; end if;
  update public.friendships set status='accepted',accepted_at=now()
   where id=p_request_id and addressee_id=v_me and status='pending'
   returning requester_id into v_sender;
  if v_sender is null then raise exception 'That request is gone or is not yours to accept.'; end if;
  perform public.award_badge(v_me,'crew_starter');
  perform public.award_badge(v_sender,'crew_starter');
  select count(*) into v_a_count from public.friendships where status='accepted' and (requester_id=v_me or addressee_id=v_me);
  select count(*) into v_b_count from public.friendships where status='accepted' and (requester_id=v_sender or addressee_id=v_sender);
  if v_a_count >= 3 then perform public.award_badge(v_me,'crew_builder'); end if;
  if v_b_count >= 3 then perform public.award_badge(v_sender,'crew_builder'); end if;
  select total_pennies_earned into v_total from public.profiles where id=v_me;
  if coalesce(v_total,0)>=100 then perform public.award_badge(v_me,'penny_hoarder'); end if;
  select total_pennies_earned into v_total from public.profiles where id=v_sender;
  if coalesce(v_total,0)>=100 then perform public.award_badge(v_sender,'penny_hoarder'); end if;
end; $$;
grant execute on function public.accept_friend_request(uuid) to authenticated;

create or replace function public.reject_friend_request(p_request_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.friendships where id=p_request_id and addressee_id=auth.uid() and status='pending';
end; $$;
grant execute on function public.reject_friend_request(uuid) to authenticated;

create or replace function public.remove_friend(p_friend_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.friendships where status='accepted' and (
    (requester_id=auth.uid() and addressee_id=p_friend_id) or
    (addressee_id=auth.uid() and requester_id=p_friend_id)
  );
end; $$;
grant execute on function public.remove_friend(uuid) to authenticated;

create or replace function public.get_my_friends()
returns table(id uuid,username text,pennies integer,avatar_skin text,avatar_shirt text,avatar_hat text,earned_badges text[],total_pennies_earned integer,last_penny_at timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id,p.username,p.pennies,p.avatar_skin,p.avatar_shirt,p.avatar_hat,p.earned_badges,p.total_pennies_earned,p.last_penny_at
  from public.profiles p join public.friendships f on f.status='accepted'
  where (f.requester_id=auth.uid() and f.addressee_id=p.id) or (f.addressee_id=auth.uid() and f.requester_id=p.id)
  order by lower(p.username);
$$;
grant execute on function public.get_my_friends() to authenticated;

create or replace function public.get_friend_requests()
returns table(request_id uuid,sender_id uuid,username text,pennies integer,avatar_skin text,avatar_shirt text,avatar_hat text,earned_badges text[])
language sql stable security definer set search_path = public as $$
  select f.id,p.id,p.username,p.pennies,p.avatar_skin,p.avatar_shirt,p.avatar_hat,p.earned_badges
  from public.friendships f join public.profiles p on p.id=f.requester_id
  where f.addressee_id=auth.uid() and f.status='pending' order by f.created_at desc;
$$;
grant execute on function public.get_friend_requests() to authenticated;

create or replace function public.get_leaderboard()
returns table(id uuid,username text,pennies integer,avatar_skin text,avatar_shirt text,avatar_hat text,earned_badges text[])
language sql stable security definer set search_path = public as $$
  select p.id,p.username,p.pennies,p.avatar_skin,p.avatar_shirt,p.avatar_hat,p.earned_badges
  from public.profiles p where auth.uid() is not null order by p.pennies desc,lower(p.username) limit 10;
$$;
grant execute on function public.get_leaderboard() to authenticated;

-- Explicitly keep internal helper functions inaccessible to website users.
revoke all on function public.handle_new_diver() from public, anon, authenticated;
