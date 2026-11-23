-- 利用者の属性（devbi-serve --user-header で、ID だけが届くとき）。:user.id はログイン名。
-- 見本なので表の代わりに VALUES で書いています。ふつうは社員の表から引きます。
-- 文字は SQLite の書き方です。SQL Server では N'関東' のように N を付けます（付けないと ?? になり、だれの行も出ません）。
SELECT region, roles
  FROM (SELECT 'CORP\yamada' AS login, '関東' AS region, '営業' AS roles
        UNION ALL SELECT 'CORP\suzuki', '近畿', '営業') AS u
 WHERE login = :user.id
