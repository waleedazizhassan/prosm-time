-- User-directed data cleanup: remove the stray leftover QA-test-site
-- assignment on the real "Lido" account (waleedelnhrawee@gmail.com) so
-- self clock-in falls back to the no-site GPS-only walk-in path until
-- the user adds their own real site(s) with real coordinates.
delete from site_assignments
where user_id = '347ea231-ad1e-4481-a633-dba1ed3c4246'
  and site_id = 'bc2564d0-44ea-42d1-888b-927cc0a4fd10';
