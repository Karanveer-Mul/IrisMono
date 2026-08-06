import { migrate } from "drizzle-orm/node-postgres/migrator";
import { adminDb, adminPool } from "./index";
import * as path from "path";

/**
 * Migrations run as the admin identity (ADMIN_DATABASE_URL). The runtime roles
 * do not own the tables and cannot issue DDL - see 0002_row_level_security.sql.
 */
async function runMigrations() {
  console.log("Running migrations...");
  try {
    await migrate(adminDb, {
      migrationsFolder: path.join(__dirname, "migrations"),
    });
    console.log("Migrations applied successfully!");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  } finally {
    await adminPool.end();
  }
}

runMigrations();
