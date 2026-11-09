-- 2026-11-09 (owner): "turn the API on normally and show it; which plan gets it is decided
-- later in the packages session." For now every plan includes integrations, so the
-- Integrations page shows and API v1 keys and webhooks work for every organisation.
-- Rollback: update public.plans set feature_flags = feature_flags - 'integrations';

begin;

update public.plans set feature_flags = feature_flags || '{"integrations": true}'::jsonb;

commit;
