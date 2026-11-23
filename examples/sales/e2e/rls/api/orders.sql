-- 受注の明細（1 行 = 受注の 1 明細）。ログインした人の担当の地域（:user.region）の行だけ。
-- :user.region は、ホスト（ここでは vite.config の devUsers）が渡すログインした人の属性で、ブラウザからは変えられない。
-- param: from date label=受注日（から）
SELECT o.order_date AS 受注日, o.order_no AS 受注番号, c.name AS 顧客, c.region AS 地域,
       p.category AS 商品分類, p.name AS 商品, l.qty AS 数量, l.unit_price AS 単価, l.qty * l.unit_price AS 金額
  FROM orders o
  JOIN order_lines l ON l.order_no = o.order_no
  JOIN customers c ON c.id = o.customer_id
  JOIN products p ON p.id = l.product_id
 WHERE o.order_date >= :from
   AND c.region = :user.region
