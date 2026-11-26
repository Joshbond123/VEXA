-- No-op: `requests` is created by 0001_init.sql. The original ALTER broke every fresh
-- database ("duplicate column name: requests"), so the column now comes from the table
-- definition and this file only keeps the migration name in sequence.
SELECT 1;
