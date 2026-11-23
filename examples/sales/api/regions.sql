-- 地域の一覧（api/order_lines.sql の地域の候補）。毎朝 6:00 に作ったものを読む（パラメーターがないので 1 つ）。
-- snapshot: 06:00
SELECT DISTINCT region AS 地域 FROM customers ORDER BY 1
