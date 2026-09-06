-- Backfill rodzaju rozliczenia: dotąd "biurowy" znaczyło tyle, co "ma wiersze
-- w zestawieniu biura". Po dodaniu hr_employees.kind przenosimy tę wiedzę do kartoteki.
UPDATE `hr_employees` SET `kind` = 'biuro'
WHERE `id` IN (SELECT DISTINCT `employee_id` FROM `hr_office_payroll`);
