const fs = require('fs');
const path = require('path');
const { pool } = require('../database/db');

async function run() {
  const sqlPath = path.join(__dirname, '..', 'database', 'schema_and_seed.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  console.log('جاري تنفيذ ملف database/schema_and_seed.sql على قاعدة البيانات...');
  await pool.query(sql);
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM jobs) AS jobs_count,
      (SELECT COUNT(*) FROM candidates) AS candidates_count,
      (SELECT COUNT(*) FROM applications) AS applications_count
  `);
  console.log('تمت التهيئة بنجاح:', rows[0]);
  await pool.end();
}

run().catch((err) => {
  console.error('فشل تهيئة قاعدة البيانات:', err);
  process.exit(1);
});
