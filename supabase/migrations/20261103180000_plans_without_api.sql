-- 2026-11-03 (owner): "remove the API from the plans for now, it is not ready." No plan
-- includes integrations: the Integrations page is hidden and API keys are refused for
-- every organisation, older ones and trials too.
-- Rollback: add "integrations": true back to the pro and legacy plans.

begin;

update public.plans set feature_flags = feature_flags - 'integrations';

commit;
