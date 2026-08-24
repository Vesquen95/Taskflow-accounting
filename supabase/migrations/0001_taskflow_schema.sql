-- Taskflow v1 schema: boards, columns, tasks, labels, task_labels
-- RLS: users may only see/modify rows belonging to boards they own
-- (board.user_id = auth.uid()).
-- Also creates a trigger that provisions a default board + 3 columns
-- (Todo / In Progress / Done) whenever a new auth.users row is created.

-- ============================================================
-- Extensions
-- ============================================================
create extension if not exists "pgcrypto";

-- ============================================================
-- Tables
-- ============================================================

create table if not exists public.boards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'My Board',
  created_at timestamptz not null default now()
);

create table if not exists public.columns (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards(id) on delete cascade,
  name text not null,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.labels (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards(id) on delete cascade,
  name text not null,
  color text not null default '#6366f1',
  created_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards(id) on delete cascade,
  column_id uuid not null references public.columns(id) on delete cascade,
  title text not null,
  description text,
  due_date date,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint title_not_blank check (char_length(trim(title)) > 0)
);

create table if not exists public.task_labels (
  task_id uuid not null references public.tasks(id) on delete cascade,
  label_id uuid not null references public.labels(id) on delete cascade,
  primary key (task_id, label_id)
);

-- ============================================================
-- Indexes
-- ============================================================
create index if not exists idx_boards_user_id on public.boards(user_id);
create index if not exists idx_columns_board_id on public.columns(board_id);
create index if not exists idx_labels_board_id on public.labels(board_id);
create index if not exists idx_tasks_board_id on public.tasks(board_id);
create index if not exists idx_tasks_column_id on public.tasks(column_id);
create index if not exists idx_task_labels_task_id on public.task_labels(task_id);
create index if not exists idx_task_labels_label_id on public.task_labels(label_id);

-- ============================================================
-- updated_at trigger for tasks
-- ============================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tasks_set_updated_at on public.tasks;
create trigger trg_tasks_set_updated_at
  before update on public.tasks
  for each row
  execute function public.set_updated_at();

-- ============================================================
-- Row Level Security
-- ============================================================
alter table public.boards enable row level security;
alter table public.columns enable row level security;
alter table public.labels enable row level security;
alter table public.tasks enable row level security;
alter table public.task_labels enable row level security;

-- boards: user can CRUD their own boards
drop policy if exists "boards_select_own" on public.boards;
create policy "boards_select_own" on public.boards
  for select using (user_id = auth.uid());

drop policy if exists "boards_insert_own" on public.boards;
create policy "boards_insert_own" on public.boards
  for insert with check (user_id = auth.uid());

drop policy if exists "boards_update_own" on public.boards;
create policy "boards_update_own" on public.boards
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "boards_delete_own" on public.boards;
create policy "boards_delete_own" on public.boards
  for delete using (user_id = auth.uid());

-- columns: via parent board ownership
drop policy if exists "columns_select_own" on public.columns;
create policy "columns_select_own" on public.columns
  for select using (
    exists (select 1 from public.boards b where b.id = columns.board_id and b.user_id = auth.uid())
  );

drop policy if exists "columns_insert_own" on public.columns;
create policy "columns_insert_own" on public.columns
  for insert with check (
    exists (select 1 from public.boards b where b.id = columns.board_id and b.user_id = auth.uid())
  );

drop policy if exists "columns_update_own" on public.columns;
create policy "columns_update_own" on public.columns
  for update using (
    exists (select 1 from public.boards b where b.id = columns.board_id and b.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.boards b where b.id = columns.board_id and b.user_id = auth.uid())
  );

drop policy if exists "columns_delete_own" on public.columns;
create policy "columns_delete_own" on public.columns
  for delete using (
    exists (select 1 from public.boards b where b.id = columns.board_id and b.user_id = auth.uid())
  );

-- labels: via parent board ownership
drop policy if exists "labels_select_own" on public.labels;
create policy "labels_select_own" on public.labels
  for select using (
    exists (select 1 from public.boards b where b.id = labels.board_id and b.user_id = auth.uid())
  );

drop policy if exists "labels_insert_own" on public.labels;
create policy "labels_insert_own" on public.labels
  for insert with check (
    exists (select 1 from public.boards b where b.id = labels.board_id and b.user_id = auth.uid())
  );

drop policy if exists "labels_update_own" on public.labels;
create policy "labels_update_own" on public.labels
  for update using (
    exists (select 1 from public.boards b where b.id = labels.board_id and b.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.boards b where b.id = labels.board_id and b.user_id = auth.uid())
  );

drop policy if exists "labels_delete_own" on public.labels;
create policy "labels_delete_own" on public.labels
  for delete using (
    exists (select 1 from public.boards b where b.id = labels.board_id and b.user_id = auth.uid())
  );

-- tasks: via parent board ownership
drop policy if exists "tasks_select_own" on public.tasks;
create policy "tasks_select_own" on public.tasks
  for select using (
    exists (select 1 from public.boards b where b.id = tasks.board_id and b.user_id = auth.uid())
  );

drop policy if exists "tasks_insert_own" on public.tasks;
create policy "tasks_insert_own" on public.tasks
  for insert with check (
    exists (select 1 from public.boards b where b.id = tasks.board_id and b.user_id = auth.uid())
  );

drop policy if exists "tasks_update_own" on public.tasks;
create policy "tasks_update_own" on public.tasks
  for update using (
    exists (select 1 from public.boards b where b.id = tasks.board_id and b.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.boards b where b.id = tasks.board_id and b.user_id = auth.uid())
  );

drop policy if exists "tasks_delete_own" on public.tasks;
create policy "tasks_delete_own" on public.tasks
  for delete using (
    exists (select 1 from public.boards b where b.id = tasks.board_id and b.user_id = auth.uid())
  );

-- task_labels: via parent task -> board ownership
drop policy if exists "task_labels_select_own" on public.task_labels;
create policy "task_labels_select_own" on public.task_labels
  for select using (
    exists (
      select 1 from public.tasks t
      join public.boards b on b.id = t.board_id
      where t.id = task_labels.task_id and b.user_id = auth.uid()
    )
  );

drop policy if exists "task_labels_insert_own" on public.task_labels;
create policy "task_labels_insert_own" on public.task_labels
  for insert with check (
    exists (
      select 1 from public.tasks t
      join public.boards b on b.id = t.board_id
      where t.id = task_labels.task_id and b.user_id = auth.uid()
    )
    and exists (
      select 1 from public.labels l
      join public.boards b on b.id = l.board_id
      where l.id = task_labels.label_id and b.user_id = auth.uid()
    )
  );

drop policy if exists "task_labels_delete_own" on public.task_labels;
create policy "task_labels_delete_own" on public.task_labels
  for delete using (
    exists (
      select 1 from public.tasks t
      join public.boards b on b.id = t.board_id
      where t.id = task_labels.task_id and b.user_id = auth.uid()
    )
  );

-- ============================================================
-- Auto-provision a default board + 3 columns for every new user
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_board_id uuid;
begin
  insert into public.boards (user_id, name)
  values (new.id, 'My Board')
  returning id into new_board_id;

  insert into public.columns (board_id, name, position) values
    (new_board_id, 'Todo', 0),
    (new_board_id, 'In Progress', 1),
    (new_board_id, 'Done', 2);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();
