-- The roster is stored as a JSON array; logs and configuration remain objects.
-- Keep the key allow-list from 20260809000000 while permitting the roster shape.
drop policy if exists "DTR data can be created publicly" on public.dtr_storage_dtr;
create policy "DTR data can be created publicly"
  on public.dtr_storage_dtr for insert
  to anon, authenticated
  with check (
    public.dtr_storage_key_ok(storage_key)
    and (
      (storage_key = 'dtr:roster' and jsonb_typeof(payload) = 'array')
      or (storage_key <> 'dtr:roster' and jsonb_typeof(payload) = 'object')
    )
  );

drop policy if exists "DTR data can be updated publicly" on public.dtr_storage_dtr;
create policy "DTR data can be updated publicly"
  on public.dtr_storage_dtr for update
  to anon, authenticated
  using (public.dtr_storage_key_ok(storage_key))
  with check (
    public.dtr_storage_key_ok(storage_key)
    and (
      (storage_key = 'dtr:roster' and jsonb_typeof(payload) = 'array')
      or (storage_key <> 'dtr:roster' and jsonb_typeof(payload) = 'object')
    )
  );
