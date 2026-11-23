-- 顧客ごとの受注の数・数量・金額を、受注日と地域で絞る（1 行 = 1 顧客）。
-- レポートでは地域ごとにまとめて合計を出し、行をクリックするとその顧客の明細が下の表に出る（options.click）。
-- param: from date label=受注日（から） default=fiscal_year_start
-- param: to date label=受注日（まで） optional
-- param: regions text[] label=地域 values=regions default=all
-- key: 顧客ID
SELECT c.id AS 顧客ID, c.region AS 地域, c.name AS 顧客,
       COUNT(DISTINCT o.order_no) AS 受注数, SUM(l.qty) AS 数量, SUM(l.qty * l.unit_price) AS 金額
  FROM orders o
  JOIN order_lines l ON l.order_no = o.order_no
  JOIN customers c ON c.id = o.customer_id
 WHERE o.order_date >= :from
   AND (:to IS NULL OR o.order_date <= :to)
   AND c.region IN (:regions)
 GROUP BY c.id, c.region, c.name
 ORDER BY SUM(l.qty * l.unit_price) DESC
