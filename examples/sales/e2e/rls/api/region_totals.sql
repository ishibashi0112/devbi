-- 地域ごとの売上の合計（明細は送らない）。全社の数字なので、だれにでも全部の行を見せる。
-- access: all
SELECT c.region AS 地域, SUM(l.qty * l.unit_price) AS 金額
  FROM orders o
  JOIN order_lines l ON l.order_no = o.order_no
  JOIN customers c ON c.id = o.customer_id
 GROUP BY c.region
 ORDER BY 金額 DESC
