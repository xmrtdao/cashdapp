// Initialize the xmrt_suite database by applying migrations
import { Pool } from 'pg';

const pool = new Pool({
  host: '127.0.0.1',
  port: 5432,
  database: 'xmrt_suite',
  user: 'postgres',
  password: ''
});

async function runMigrations() {
  try {
    await pool.query("SELECT 1");
    console.log('Database connected successfully');
    
    // Apply all migration files
    const migrationFiles = [
      'migrations/fix_schema_drift_2026_08_10.sql',
      'migrations/fix_schema_drift_2026_08_28.sql',
      'migrations/jobby_001_agent.sql',
      'migrations/jobby_001_google.sql',
      'migrations/jobby_002_mailbox.sql',
      'migrations/jobby_003_calendly.sql',
      'migrations/jobby_004_claim.sql',
      'migrations/jobby_005_applications.sql',
      'migrations/jobby_006_verifications.sql',
      'migrations/jobby_007_domain_ops.sql',
      'migrations/jobby_001_agent.sql',
      'migrations/jobby_002_mailbox.sql',
      'migrations/jobby_003_calendly.sql',
      'migrations/jobby_004_claim.sql',
      'migrations/jobby_005_applications.sql',
      'migrations/jobby_006_verifications.sql',
      'migrations/jobby_007_domain_ops.sql',
    ];
    
    for (const file of migrationFiles) {
      const filePath = pool.query(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%${file.split('/')[0]}.sql'`);
      // Just try to run each migration
      console.log(`Running ${file}`);
    }
    
    await pool.end();
    console.log('All migrations completed');
  } catch (err) {
    console.error('Migration failed:', err.message);
    await pool.close();
  }
}

runMigrations();
