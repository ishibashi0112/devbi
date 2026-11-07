WITH "__model" AS (
  SELECT * FROM sales
)
SELECT
  CAST(date_trunc('month', "order_date") AS DATE) AS "order_date",
  SUM(amount) AS "total_revenue"
FROM "__model"
WHERE ("region" IN ('東') OR "region" IS NULL)
  AND "order_date" >= DATE '2025-01-01' AND "order_date" < DATE '2026-01-01'
GROUP BY ALL
ORDER BY "order_date" ASC NULLS LAST