-- Run manually using an existing approved local MySQL login path.
-- No password on the command line; no SET GLOBAL, DDL, writes or SQL text dumps.
SELECT UTC_TIMESTAMP() AS captured_utc, VERSION() AS mysql_version;
SHOW GLOBAL VARIABLES WHERE Variable_name IN
 ('max_connections','innodb_buffer_pool_size','innodb_buffer_pool_instances',
  'performance_schema','slow_query_log','long_query_time','transaction_isolation');
SHOW GLOBAL STATUS WHERE Variable_name IN
 ('Threads_connected','Threads_running','Max_used_connections','Connections',
  'Aborted_connects','Slow_queries','Created_tmp_tables','Created_tmp_disk_tables',
  'Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads','Innodb_row_lock_waits',
  'Innodb_row_lock_time','Innodb_data_pending_reads','Innodb_data_pending_writes');
SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH
 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE();
SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, CARDINALITY
 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
 ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;
-- Digests omit SQL text, bindings and customer values. Counters are cumulative;
-- repeat at a known interval and compare deltas, not totals as rates.
SELECT DIGEST, COUNT_STAR, ROUND(SUM_TIMER_WAIT/1e12,3) AS total_seconds,
 ROUND(AVG_TIMER_WAIT/1e9,3) AS mean_ms, SUM_ROWS_EXAMINED, SUM_ROWS_SENT,
 SUM_CREATED_TMP_DISK_TABLES, SUM_ERRORS
 FROM performance_schema.events_statements_summary_by_digest
 WHERE SCHEMA_NAME=DATABASE() ORDER BY SUM_TIMER_WAIT DESC LIMIT 15;
SELECT COUNT(*) AS pending_data_lock_waits FROM performance_schema.data_lock_waits;
-- If a supported view/privilege is absent, record it as unavailable; do not
-- grant additional privileges or enable consumers without production approval.
