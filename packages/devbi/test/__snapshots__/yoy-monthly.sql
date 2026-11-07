WITH "__model" AS (
  SELECT * FROM sales
),
"__cur" AS (
  SELECT
    CAST(date_trunc('month', "order_date") AS DATE) AS "order_date",
    SUM(amount) AS "total_revenue"
  FROM "__model"
  GROUP BY ALL
),
"__previous_year" AS (
  SELECT
    CAST(date_trunc('month', ("order_date" + INTERVAL 1 YEAR)) AS DATE) AS "order_date",
    SUM(amount) AS "total_revenue"
  FROM "__model"
  GROUP BY ALL
)
SELECT
  c."order_date",
  c."total_revenue" AS "total_revenue",
  p1."total_revenue" AS "revenue_ly",
  c."total_revenue" / NULLIF(p1."total_revenue", 0) AS "revenue_yoy"
FROM "__cur" AS c
LEFT JOIN "__previous_year" AS p1
  ON c."order_date" IS NOT DISTINCT FROM p1."order_date"
ORDER BY "order_date" ASC NULLS LAST