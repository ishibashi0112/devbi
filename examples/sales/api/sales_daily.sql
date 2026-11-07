-- 日・地域・商品分類ごとの売上と数量。受注日が :from 以降のもの。
-- 明細を 1 行ずつ渡す api/orders.sql と違い、データベースで集計して行を減らし、毎朝 6:00 に作ったものを読む。
-- snapshot: 06:00
SELECT o.order_date AS 受注日, c.region AS 地域, p.category AS 商品分類,
       SUM(l.qty * l.unit_price) AS 金額, SUM(l.qty) AS 数量, COUNT(*) AS 明細数
  FROM orders o
  JOIN order_lines l ON l.order_no = o.order_no
  JOIN customers c ON c.id = o.customer_id
  JOIN products p ON p.id = l.product_id
 WHERE o.order_date >= :from
 GROUP BY o.order_date, c.region, p.category
