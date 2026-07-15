import assert from "node:assert/strict";
import test from "node:test";
import { validateReadOnlySql } from "./starrocks.js";

test("accepts supported read-only StarRocks statements", () => {
  const statements = [
    "SELECT * FROM orders WHERE note = 'delete from old_orders'",
    "WITH daily AS (SELECT dt, count(*) total FROM orders GROUP BY dt) SELECT * FROM daily",
    "SHOW TABLES",
    "SHOW CREATE TABLE orders",
    "DESCRIBE `orders`",
    "EXPLAIN SELECT * FROM orders",
    "SELECT /* DELETE is text in a normal comment */ 1;"
  ];

  for (const sql of statements) {
    assert.doesNotThrow(() => validateReadOnlySql(sql));
  }
});

test("rejects writes, multiple statements, unsafe functions, and session overrides", () => {
  const statements = [
    "DELETE FROM orders",
    "SELECT 1; DROP TABLE orders",
    "WITH changed AS (DELETE FROM orders) SELECT * FROM changed",
    "SELECT * FROM orders INTO OUTFILE '/tmp/orders.csv'",
    "SELECT LOAD_FILE('/etc/passwd')",
    "SELECT * FROM FILES('path' = 's3://bucket/data.csv')",
    "SELECT SLEEP(10)",
    "SELECT @row_limit := 1000000",
    "SELECT /*+ SET_VAR(query_timeout=259200) */ * FROM orders",
    "SELECT /*! DELETE FROM orders */ 1"
  ];

  for (const sql of statements) {
    assert.throws(() => validateReadOnlySql(sql), /readonly_sql_required/);
  }
});

test("rejects malformed and oversized SQL", () => {
  assert.throws(() => validateReadOnlySql(""), /invalid_sql/);
  assert.throws(() => validateReadOnlySql("SELECT 'unterminated"), /invalid_sql/);
  assert.throws(() => validateReadOnlySql("SELECT 12345", 5), /invalid_sql/);
});
