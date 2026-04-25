-- ============================================================
-- SHIFT SCHEDULER — PHASE 2: INITIAL SCHEMA
-- Migration: 20260413000000_phase2_initial_schema
-- Apply via: Supabase Dashboard → SQL Editor → Run
-- ============================================================

create extension if not exists "pgcrypto";


-- ============================================================
-- TABLE 1: users
-- Thin profile layer on top of Supabase auth.users.
-- Cascade from auth is intentional: deleting the auth identity
-- removes the profile. Nothing cascades further from here.
-- ============================================================
create table public.users (
  id         uuid        primary key references auth.users(id) on delete cascade,
  name       text        not null,
  role       text        not null check (role in ('employee', 'manager')),
  is_active  boolean     not null default true,
  created_at timestamptz not null default now()
);


-- ============================================================
-- TABLE 2: shift_types
-- Configurable shift definitions. Stored in DB so new variants
-- can be added without code changes.
-- ============================================================
create table public.shift_types (
  id               uuid        primary key default gen_random_uuid(),
  name             text        not null,
  period           text        not null check (period in ('morning', 'evening')),
  start_time       time        not null,
  end_time         time        not null,
  crosses_midnight boolean     not null default false,
  is_active        boolean     not null default true,
  created_at       timestamptz not null default now()
);

insert into public.shift_types (name, period, start_time, end_time, crosses_midnight) values
  ('בוקר 07:00–19:00', 'morning', '07:00', '19:00', false),
  ('בוקר 08:00–20:00', 'morning', '08:00', '20:00', false),
  ('ערב 19:00–07:00',  'evening', '19:00', '07:00', true),
  ('ערב 20:00–08:00',  'evening', '20:00', '08:00', true);


-- ============================================================
-- TABLE 3: schedule_periods
-- One row per scheduling cycle (20th of month → 19th of next).
-- ============================================================
create table public.schedule_periods (
  id           uuid        primary key default gen_random_uuid(),
  start_date   date        not null,
  end_date     date        not null,
  is_published boolean     not null default false,
  created_by   uuid        references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),

  constraint chk_period_dates check (end_date > start_date),
  constraint uq_period        unique (start_date, end_date)
);


-- ============================================================
-- TABLE 4: constraints
-- Hard blocks submitted by employees.
-- Rules enforced by triggers below.
-- ============================================================
create table public.constraints (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references public.users(id)
                                on delete restrict,
  period_id       uuid        not null references public.schedule_periods(id)
                                on delete cascade,
  constraint_date date        not null,
  constraint_type text        not null
                    check (constraint_type in ('full_day', 'morning', 'evening')),
  created_at      timestamptz not null default now(),

  constraint uq_constraint unique (user_id, constraint_date, constraint_type)
);

create index idx_constraints_user_period on public.constraints (user_id, period_id);
create index idx_constraints_date        on public.constraints (constraint_date);


-- Trigger function: constraint_date must fall within its period
create or replace function fn_check_constraint_in_period()
returns trigger language plpgsql as $$
declare
  v_start date;
  v_end   date;
begin
  select start_date, end_date
    into v_start, v_end
    from public.schedule_periods
   where id = new.period_id;

  if new.constraint_date < v_start or new.constraint_date > v_end then
    raise exception
      'תאריך האילוץ (%) חורג מגבולות התקופה (% עד %)',
      new.constraint_date, v_start, v_end;
  end if;

  return new;
end;
$$;

create trigger trg_constraint_in_period
  before insert or update on public.constraints
  for each row execute function fn_check_constraint_in_period();


-- Trigger function: max 10 constraints per employee per period
create or replace function fn_check_constraint_limit()
returns trigger language plpgsql as $$
begin
  if (
    select count(*)
    from public.constraints
    where user_id   = new.user_id
      and period_id = new.period_id
  ) >= 10 then
    raise exception 'עובד לא יכול לבקש יותר מ-10 אילוצים בתקופה אחת';
  end if;
  return new;
end;
$$;

create trigger trg_constraint_limit
  before insert on public.constraints
  for each row execute function fn_check_constraint_limit();


-- ============================================================
-- TABLE 5: shifts
-- One slot per (date × shift_type) within a period.
-- is_weekend and fairness_weight are stamped at generation time.
-- ============================================================
create table public.shifts (
  id              uuid         primary key default gen_random_uuid(),
  period_id       uuid         not null references public.schedule_periods(id)
                                 on delete cascade,
  shift_date      date         not null,
  shift_type_id   uuid         not null references public.shift_types(id),
  is_weekend      boolean      not null default false,
  fairness_weight numeric(3,1) not null default 1.0
                    check (fairness_weight > 0),
  created_at      timestamptz  not null default now(),

  constraint uq_shift unique (period_id, shift_date, shift_type_id)
);

create index idx_shifts_period on public.shifts (period_id);
create index idx_shifts_date   on public.shifts (shift_date);


-- ============================================================
-- TABLE 6: shift_assignments
-- Joins employees to shift slots. Max 2 per shift.
-- on delete restrict preserves history when a user is deactivated.
-- ============================================================
create table public.shift_assignments (
  id         uuid        primary key default gen_random_uuid(),
  shift_id   uuid        not null references public.shifts(id) on delete cascade,
  user_id    uuid        not null references public.users(id)
                           on delete restrict,
  is_manual  boolean     not null default false,
  created_at timestamptz not null default now(),

  constraint uq_assignment unique (shift_id, user_id)
);

create index idx_assignments_shift on public.shift_assignments (shift_id);
create index idx_assignments_user  on public.shift_assignments (user_id);


-- Trigger function: max 2 workers per shift
create or replace function fn_check_shift_capacity()
returns trigger language plpgsql as $$
begin
  if (
    select count(*)
    from public.shift_assignments
    where shift_id = new.shift_id
  ) >= 2 then
    raise exception 'לא ניתן לשבץ יותר מ-2 עובדים למשמרת';
  end if;
  return new;
end;
$$;

create trigger trg_shift_capacity
  before insert on public.shift_assignments
  for each row execute function fn_check_shift_capacity();


-- ============================================================
-- TABLE 7: employee_stats
-- Pre-aggregated per-period counts. Written by app after any
-- assignment change. on delete restrict preserves history.
-- ============================================================
create table public.employee_stats (
  id             uuid         primary key default gen_random_uuid(),
  user_id        uuid         not null references public.users(id)
                                on delete restrict,
  period_id      uuid         not null references public.schedule_periods(id)
                                on delete cascade,
  morning_count  int          not null default 0 check (morning_count  >= 0),
  evening_count  int          not null default 0 check (evening_count  >= 0),
  weekend_count  int          not null default 0 check (weekend_count  >= 0),
  total_shifts   int          not null default 0 check (total_shifts   >= 0),
  fairness_score numeric(6,2) not null default 0 check (fairness_score >= 0),
  updated_at     timestamptz  not null default now(),

  constraint uq_stats unique (user_id, period_id)
);
