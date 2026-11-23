-- 受注の明細を、受注日と地域で絞る（SSRS のレポートのパラメーターのように、値を選んで読む）。
-- 1 行 = 受注の 1 明細。「まで」を空にすると最後まで。地域は 1 つ以上選ぶ（候補は api/regions.sql）。
-- param: from date label=受注日（から） default=fiscal_year_start
-- param: to date label=受注日（まで） optional
-- param: regions text[] label=地域 values=regions default=all
-- key: 受注番号, 行番号
SELECT o.order_date AS 受注日, o.order_no AS 受注番号, l.line_no AS 行番号, c.name AS 顧客, c.region AS 地域,
       p.category AS 商品分類, p.name AS 商品, l.qty AS 数量, l.unit_price AS 単価, l.qty * l.unit_price AS 金額
  FROM orders o
  JOIN order_lines l ON l.order_no = o.order_no
  JOIN customers c ON c.id = o.customer_id
  JOIN products p ON p.id = l.product_id
 WHERE o.order_date >= :from
   AND (:to IS NULL OR o.order_date <= :to)
   AND c.region IN (:regions)
