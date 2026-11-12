ALTER TABLE staff_directory
  ALTER COLUMN company_name SET DEFAULT 'ATHULYA';

UPDATE staff_directory
SET company_name = 'ATHULYA'
WHERE NULLIF(BTRIM(company_name), '') IS NULL;
