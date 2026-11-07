WITH "__model" AS (
  SELECT * FROM sales
),
"__cur" AS (
  SELECT
    CAST(date_trunc('month', "order_date") AS DATE) AS "order_date",
    SUM(amount) AS "total_revenue"
  FROM "__model"
  GROUP BY ALL
)
SELECT
  c."order_date",
  c."total_revenue" AS "total_revenue",
  SUM(c."total_revenue") OVER (PARTITION BY CAST(date_trunc('year', c."order_date") AS DATE) ORDER BY c."order_date" ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "revenue_cum"
FROM "__cur" AS c
ORDER BY "order_date" ASC NULLS LAST