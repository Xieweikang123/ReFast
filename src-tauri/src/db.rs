use rusqlite::{Connection, OpenFlags};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

const DB_NAME: &str = "re-fast.db";
const LEGACY_DB_NAME: &str = "data.db";

/// Database file path under the app data directory (new name).
pub fn get_db_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DB_NAME)
}

/// 进程内共享的单一数据库连接（串行化访问；WAL + FULL_MUTEX + busy_timeout 下线程安全）。
/// 替代此前每次访问都重新打开文件并重跑全部迁移的模式，消除热路径的连接冷开销。
static SHARED_CONNECTION: Mutex<Option<Connection>> = Mutex::new(None);

/// 确定活动数据库路径，必要时把旧版 data.db 复制迁移到新名称。
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

/// 获取共享的读写连接（锁被持有的时长 = 调用方使用连接的时长）。
/// 首次调用时打开连接并运行完整迁移；之后复用同一连接，不再重复迁移。
pub fn get_connection(app_data_dir: &Path) -> Result<SharedConnectionGuard, String> {
    let mut slot = SHARED_CONNECTION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if slot.is_none() {
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
        *slot = Some(conn);
    }

    Ok(SharedConnectionGuard { _slot: slot })
}

/// 关闭并清空共享连接（备份恢复等直接覆盖数据库文件的场景使用，
/// 下次 get_connection 会重新打开新文件并重新迁移）。
pub fn reset_shared_connection() {
    let mut slot = SHARED_CONNECTION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // 先做 WAL checkpoint 并关闭旧连接，确保文件句柄释放
    if let Some(conn) = slot.as_ref() {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
    *slot = None;
}

/// 持有共享连接锁的 guard，通过 Deref/DerefMut 暴露 Connection。
/// drop 时自动释放底层 Mutex 锁。
pub struct SharedConnectionGuard {
    _slot: MutexGuard<'static, Option<Connection>>,
}

impl std::ops::Deref for SharedConnectionGuard {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self._slot.as_ref().expect("connection must be present")
    }
}

impl std::ops::DerefMut for SharedConnectionGuard {
    fn deref_mut(&mut self) -> &mut Connection {
        self._slot.as_mut().expect("connection must be present")
    }
}

/// 打开一个独立的只读连接（用于只读查询，不参与共享连接的写锁竞争）。
/// 迁移由共享连接负责，这里不再执行迁移。
pub fn get_readonly_connection(app_data_dir: &Path) -> Result<Connection, String> {
    let db_path = ensure_db_path(app_data_dir)?;
    // 使用只读标志，减少文件锁竞争
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_FULL_MUTEX;

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

        CREATE TABLE IF NOT EXISTS word_records (
            id TEXT PRIMARY KEY,
            word TEXT NOT NULL,
            translation TEXT NOT NULL,
            context TEXT,
            phonetic TEXT,
            example_sentence TEXT,
            tags TEXT,
            ai_explanation TEXT,
            mastery_level INTEGER DEFAULT 0,
            review_count INTEGER DEFAULT 0,
            last_reviewed INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            is_favorite INTEGER DEFAULT 0,
            is_mastered INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_word_records_word ON word_records(word);
        CREATE INDEX IF NOT EXISTS idx_word_records_created_at ON word_records(created_at);
        CREATE INDEX IF NOT EXISTS idx_word_records_mastery_level ON word_records(mastery_level);
        CREATE INDEX IF NOT EXISTS idx_word_records_is_favorite ON word_records(is_favorite);
        
        -- Migration: Add ai_explanation column if it doesn't exist
        -- SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN
        -- We'll check and add it manually if needed
        -- Note: This will fail silently if the column already exists, which is fine
        -- We'll handle this gracefully by catching the error
        -- For now, we'll add it in a separate migration step
        
        -- Migration: Remove source_lang and target_lang columns if they exist
        -- SQLite doesn't support DROP COLUMN, so we need to recreate the table
        -- Check if old columns exist by trying to select them
    "#,
    )
    .map_err(|e| format!("Failed to run database migrations: {}", e))?;

    // Migration: Add ai_explanation column if it doesn't exist
    // Check if column exists by trying to select it
    let ai_explanation_exists = conn
        .prepare("SELECT ai_explanation FROM word_records LIMIT 1")
        .is_ok();
    
    if !ai_explanation_exists {
        // Column doesn't exist, add it
        conn.execute(
            "ALTER TABLE word_records ADD COLUMN ai_explanation TEXT",
            [],
        )
        .map_err(|e| format!("Failed to add ai_explanation column: {}", e))?;
    }

    // Migration: Remove source_lang and target_lang columns if they exist
    // SQLite doesn't support DROP COLUMN, so we need to recreate the table
    let old_columns_exist = conn
        .prepare("SELECT source_lang, target_lang FROM word_records LIMIT 1")
        .is_ok();
    
    ensure_window_config_geometry_columns(conn)?;

    if old_columns_exist {
        // Old columns exist, need to migrate
        conn.execute_batch(
            r#"
            -- Create new table without source_lang and target_lang
            CREATE TABLE IF NOT EXISTS word_records_new (
                id TEXT PRIMARY KEY,
                word TEXT NOT NULL,
                translation TEXT NOT NULL,
                context TEXT,
                phonetic TEXT,
                example_sentence TEXT,
                tags TEXT,
                ai_explanation TEXT,
                mastery_level INTEGER DEFAULT 0,
                review_count INTEGER DEFAULT 0,
                last_reviewed INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                is_favorite INTEGER DEFAULT 0,
                is_mastered INTEGER DEFAULT 0
            );
            
            -- Copy data from old table to new table (excluding source_lang and target_lang)
            INSERT INTO word_records_new 
            SELECT id, word, translation, context, phonetic, example_sentence, tags, 
                   ai_explanation, mastery_level, review_count, last_reviewed, 
                   created_at, updated_at, is_favorite, is_mastered
            FROM word_records;
            
            -- Drop old table
            DROP TABLE word_records;
            
            -- Rename new table
            ALTER TABLE word_records_new RENAME TO word_records;
            
            -- Recreate indexes
            CREATE INDEX IF NOT EXISTS idx_word_records_word ON word_records(word);
            CREATE INDEX IF NOT EXISTS idx_word_records_created_at ON word_records(created_at);
            CREATE INDEX IF NOT EXISTS idx_word_records_mastery_level ON word_records(mastery_level);
            CREATE INDEX IF NOT EXISTS idx_word_records_is_favorite ON word_records(is_favorite);
            "#,
        )
        .map_err(|e| format!("Failed to migrate word_records table: {}", e))?;
    }

    Ok(())
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
    conn.prepare(&format!("SELECT {column} FROM {table} LIMIT 1"))
        .is_ok()
}

fn ensure_window_config_geometry_columns(conn: &Connection) -> Result<(), String> {
    let columns = [
        ("width", "INTEGER"),
        ("height", "INTEGER"),
        ("maximized", "INTEGER NOT NULL DEFAULT 0"),
        ("fullscreen", "INTEGER NOT NULL DEFAULT 0"),
    ];

    for (column, definition) in columns {
        if !column_exists(conn, "window_config", column) {
            conn.execute(
                &format!("ALTER TABLE window_config ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(|e| format!("Failed to add window_config.{column}: {e}"))?;
        }
    }

    Ok(())
}

