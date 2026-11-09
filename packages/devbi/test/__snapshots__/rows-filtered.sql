WITH "__model" AS (
  SELECT * FROM sales
)
SELECT *
FROM "__model"
WHERE "region" IN ('東')
  AND "order_date" >= DATE '2025-01-01' AND "order_date" < DATE '2026-01-01'
ORDER BY "order_date" DESC NULLS LAST, COLUMNS(*)
LIMIT 3