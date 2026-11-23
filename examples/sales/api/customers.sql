-- 顧客の一覧（api/order_lines.sql の顧客の候補。1 列目が値、2 列目が見出し）。選んだ地域の顧客だけ。
-- param: regions text[] label=地域 values=regions default=all
SELECT id AS 顧客ID, name AS 顧客 FROM customers WHERE region IN (:regions) ORDER BY name
