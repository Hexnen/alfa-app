-- Dokładnie jeden aktywny magazyn typu `main`.
--
-- Produkcja miała dwa: id 8 „Magazyn główny" (seed przy starcie aplikacji) i id 40
-- „Magazyn centralny — Kraków [dane deweloperskie]" (seed dev, który nie sprawdzał,
-- czy główny już istnieje). Trasy POST/PUT /warehouses pilnują teraz niezmiennika
-- (409 przy drugim), ale istniejące dane trzeba sprzątnąć ręcznie.
--
-- Zostaje magazyn `main` z NAJNIŻSZYM id (najstarszy, ten z seeda aplikacji); reszta
-- dostaje typ zwykły `other`. Zdanie jest warunkowe i idempotentne: przy jednym albo
-- zerze magazynów głównych nic nie zmienia, więc przechodzi też na świeżej bazie.
UPDATE `warehouses`
SET `type` = 'other'
WHERE `type` = 'main'
  AND `is_archived` = 0
  AND `id` <> (
    SELECT min(`id`) FROM `warehouses` WHERE `type` = 'main' AND `is_archived` = 0
  );
