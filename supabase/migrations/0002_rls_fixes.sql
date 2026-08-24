-- Taskflow v1.1: RLS hardening + input validation
-- Fixes from the security review of 0001_taskflow_schema.sql. This
-- migration is additive only — it does not alter or replace 0001, which
-- is already applied to the live project.
--
-- 1. tasks_insert_own / tasks_update_own: the `with check` clauses only
--    verified that `tasks.board_id` belongs to the caller, but never that
--    `tasks.column_id` actually belongs to that same `board_id`. Since the
--    FK on column_id only requires the column to exist (not to belong to
--    the same board), a user could attach one of their own tasks to a
--    column that belongs to a *different* board (their own or another
--    user's, as long as they can still guess/see the column id), causing
--    the task to appear in a column it does not logically belong to.
-- 2. task_labels_insert_own: verified task ownership and label ownership
--    independently, but never that the task and the label belong to the
--    *same* board — so a user could tag their own task with a label that
--    lives on a different one of their own boards (cross-board leakage of
--    label associations).
-- 3. Free-text columns had no length limits (name/title/description),
--    allowing unbounded payloads.
-- 4. labels.color accepted arbitrary text instead of a validated hex code.

-- ============================================================
-- 1 & 2: RLS policy fixes on tasks / task_labels
-- ============================================================

drop policy if exists "tasks_insert_own" on public.tasks;
create policy "tasks_insert_own" on public.tasks
  for insert with check (
    exists (select 1 from public.boards b where b.id = tasks.board_id and b.user_id = auth.uid())
    and exists (
      select 1 from public.columns c
      where c.id = tasks.column_id and c.board_id = tasks.board_id
    )
  );

drop policy if exists "tasks_update_own" on public.tasks;
create policy "tasks_update_own" on public.tasks
  for update using (
    exists (select 1 from public.boards b where b.id = tasks.board_id and b.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.boards b where b.id = tasks.board_id and b.user_id = auth.uid())
    and exists (
      select 1 from public.columns c
      where c.id = tasks.column_id and c.board_id = tasks.board_id
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
    and (select board_id from public.tasks where id = task_labels.task_id)
      = (select board_id from public.labels where id = task_labels.label_id)
  );

-- ============================================================
-- 3: length limits on free-text fields
-- ============================================================

alter table public.boards
  drop constraint if exists boards_name_length,
  add constraint boards_name_length check (char_length(name) <= 200);

alter table public.columns
  drop constraint if exists columns_name_length,
  add constraint columns_name_length check (char_length(name) <= 200);

alter table public.labels
  drop constraint if exists labels_name_length,
  add constraint labels_name_length check (char_length(name) <= 200);

alter table public.tasks
  drop constraint if exists tasks_title_length,
  add constraint tasks_title_length check (char_length(title) <= 200);

alter table public.tasks
  drop constraint if exists tasks_description_length,
  add constraint tasks_description_length check (description is null or char_length(description) <= 5000);

-- ============================================================
-- 4: validated hex color format on labels.color
-- ============================================================

alter table public.labels
  drop constraint if exists labels_color_hex,
  add constraint labels_color_hex check (color ~ '^#[0-9a-fA-F]{6}$');
