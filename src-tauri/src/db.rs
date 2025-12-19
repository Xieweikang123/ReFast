use rusqlite::{Connection, OpenFlags};
use std::fs;
use std::path::{Path, PathBuf};

const DB_NAME: &str = "re-fast.db";
const LEGACY_DB_NAME: &str = "data.db";

/// Database file path under the app data directory (new name).
pub fn get_db_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DB_NAME)
}

/// Determine the active DB path, migrating legacy `data.db` to the new name if needed.
fn ensure_db_path(app_data_dir: &Path) -> Result<PathBuf, String> {
    if !app_data_dir.exists() {
        fs::create_dir_all(app_data_dir)
            .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    }

    let new_path = app_data_dir.join(DB_NAME);
    let legacy_path = app_data_dir.join(LEGACY_DB_NAME);

    // If new exists, use it.
    if new_path.exists() {
        return Ok(new_path);
    }

    // If new missing but legacy exists, copy forward once.
    if legacy_path.exists() {
        fs::copy(&legacy_path, &new_path)
            .map_err(|e| format!("Failed to migrate legacy database: {}", e))?;
        return Ok(new_path);
    }

    // Default: return new path (will be created on open).
    Ok(new_path)
}

/// Open a SQLite connection with basic pragmas and run migrations.
pub fn get_connection(app_data_dir: &Path) -> Result<Connection, String> {
    let db_path = ensure_db_path(app_data_dir)?;
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_CREATE
        | OpenFlags::SQLITE_OPEN_FULL_MUTEX;

    let conn = Connection::open_with_flags(&db_path, flags)
        .map_err(|e| format!("Failed to open database: {}", e))?;

    // Basic pragmas for local desktop usage.
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
    "#,
    )
    .map_err(|e| format!("Failed to set SQLite pragmas: {}", e))?;

    run_migrations(&conn)?;
    Ok(conn)
}

/// Open a read-only SQLite connection for search operations.
/// This reduces file lock contention compared to read-write connections.
pub fn get_readonly_connection(app_data_dir: &Path) -> Result<Connection, String> {
    let db_path = ensure_db_path(app_data_dir)?;
    // 使用只读标志，减少文件锁竞争
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_FULL_MUTEX;

    let conn = Connection::open_with_flags(&db_path, flags)
        .map_err(|e| format!("Failed to open read-only database: {}", e))?;

    // 只读连接不需要设置 WAL 模式，减少开销
    conn.execute_batch(
        r#"
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
    "#,
    )
    .map_err(|e| format!("Failed to set SQLite pragmas: {}", e))?;

    Ok(conn)
}

fn run_migrations(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS shortcuts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            icon TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS file_history (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            last_used INTEGER NOT NULL,
            use_count INTEGER NOT NULL,
            is_folder INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_file_history_last_used ON file_history(last_used);

        CREATE TABLE IF NOT EXISTS open_history (
            key TEXT PRIMARY KEY,
            last_opened INTEGER NOT NULL,
            name TEXT,
            use_count INTEGER DEFAULT 1,
            is_folder INTEGER
        );
        
        -- Migrate existing open_history table to add new columns if they don't exist
        -- SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN, so we use a workaround
        -- Check if columns exist by trying to select them, and add if they don't exist
        -- This is safe because if the column exists, the ALTER TABLE will fail silently in a transaction
        -- We'll handle this in the application code instead
        CREATE INDEX IF NOT EXISTS idx_open_history_last_opened ON open_history(last_opened);

        CREATE TABLE IF NOT EXISTS memos (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS window_config (
            key TEXT PRIMARY KEY,
            x INTEGER,
            y INTEGER
        );

        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS plugin_usage (
            plugin_id TEXT PRIMARY KEY,
            name TEXT,
            open_count INTEGER NOT NULL,
            last_opened INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_plugin_usage_last_opened ON plugin_usage(last_opened);

        CREATE TABLE IF NOT EXISTS clipboard_history (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            content_type TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            is_favorite INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_clipboard_history_created_at ON clipboard_history(created_at);
        CREATE INDEX IF NOT EXISTS idx_clipboard_history_is_favorite ON clipboard_history(is_favorite);
    "#,
    )
    .map_err(|e| format!("Failed to run database migrations: {}", e))?;

    Ok(())
}

