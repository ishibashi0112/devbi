WITH "__model" AS (
  SELECT * FROM sales
)
SELECT
  "customer_name" AS "customer",
  SUM(amount) AS "total_revenue",
  COUNT(DISTINCT order_id) AS "orders"
FROM "__model"
GROUP BY ALL
ORDER BY "total_revenue" DESC NULLS LAST, "customer" ASC NULLS LAST
LIMIT 2