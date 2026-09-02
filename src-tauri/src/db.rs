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

/// 测试专用：直接占用共享连接锁（模拟持锁者卡死的场景）。
/// 仅供回归测试验证「锁被占时读路径能快速脱身」；生产代码不得调用。
#[cfg(test)]
pub(crate) fn test_lock_shared_connection() -> MutexGuard<'static, Option<Connection>> {
    SHARED_CONNECTION.lock().unwrap_or_else(|p| p.into_inner())
}

/// 测试专用：全局串行锁。
/// SHARED_CONNECTION / OPEN_HISTORY / LAUNCHER_POSITION_CACHE 都是进程级单例，
/// 任何触碰这些全局状态的测试必须先持有此锁，否则并行测试互相污染产生假失败。
#[cfg(test)]
pub(crate) fn test_global_serial_lock() -> std::sync::MutexGuard<'static, ()> {
    static GLOBAL_STATE_TEST_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
    GLOBAL_STATE_TEST_SERIAL
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

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

/// 获取锁的最大等待时间。
/// ⚠️ 死锁止血（三次挂死取证）：SHARED_CONNECTION 是进程级单锁，一旦某个持锁者
/// 卡住（跨 await / 慢 IO / 丢失唤醒），所有等锁线程永久悬挂；若等待者是主线程
/// （sync command），整个应用「未响应」。DB 操作失败可重试，应用卡死不可恢复 ——
/// 因此锁获取必须有上限，超时快速失败并给出可诊断的错误。
const CONNECTION_LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// 获取共享的读写连接（锁被持有的时长 = 调用方使用连接的时长）。
/// 首次调用时打开连接并运行完整迁移；之后复用同一连接，不再重复迁移。
///
/// 锁获取带 3s 超时：超时返回 Err 而不是永久阻塞。
/// 这保证了即使出现持锁者异常，主线程（sync command）也只会得到一次
/// 可重试的失败，而不是把整个事件循环拖死。
pub fn get_connection(app_data_dir: &Path) -> Result<SharedConnectionGuard, String> {
    let lock_start = std::time::Instant::now();
    let mut slot = lock_shared_connection_slot()?;

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

    let lock_wait = lock_start.elapsed();
    if lock_wait.as_millis() >= 100 {
        eprintln!(
            "[db] WARNING: SHARED_CONNECTION lock 获取耗时 {}ms（存在长时间持锁者，可能导致 UI 卡死）",
            lock_wait.as_millis()
        );
    }

    Ok(SharedConnectionGuard { _slot: slot })
}

/// 带超时的 SHARED_CONNECTION 锁获取。
/// std Mutex 没有原生 try_lock_timeout，这里用 try_lock + 短睡眠轮询实现：
/// - 空闲锁：一次 try_lock 即成功（零开销路径）
/// - 争用锁：轮询直至拿到或超时，主线程永远不会再永久卡死
fn lock_shared_connection_slot(
) -> Result<MutexGuard<'static, Option<Connection>>, String> {
    let start = std::time::Instant::now();
    let mut warned_slow = false;
    loop {
        match SHARED_CONNECTION.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(std::sync::TryLockError::WouldBlock) => {
                let waited = start.elapsed();
                // 首次超过 100ms 记录一次慢锁告警（诊断用，不刷屏）
                if !warned_slow && waited.as_millis() >= 100 {
                    eprintln!(
                        "[db] WARNING: SHARED_CONNECTION lock 争用，已等待 {}ms（持锁者可能卡住）",
                        waited.as_millis()
                    );
                    warned_slow = true;
                }
                if waited >= CONNECTION_LOCK_TIMEOUT {
                    return Err(format!(
                        "DB_LOCK_TIMEOUT: 数据库连接锁等待超过 {}s（持锁线程异常），操作已取消。请重试；若反复出现请重启应用并反馈日志",
                        CONNECTION_LOCK_TIMEOUT.as_secs()
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                // 锁被 poison（持锁线程 panic）：恢复数据继续用，与原行为一致
                return Ok(poisoned.into_inner());
            }
        }
    }
}

/// 关闭并清空共享连接（备份恢复等直接覆盖数据库文件的场景使用，
/// 下次 get_connection 会重新打开新文件并重新迁移）。
pub fn reset_shared_connection() {
    let mut slot = match lock_shared_connection_slot() {
        Ok(slot) => slot,
        Err(_) => return, // 超时时放弃重置（极少发生；下次 get_connection 会重试）
    };
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 生成唯一的临时目录（每个测试独立，避免并行干扰）
    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "refast-db-test-{}-{}-{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// ⚠️ SHARED_CONNECTION 是进程级单例，所有 db 测试必须串行执行，
    /// 否则测试之间互相抢锁导致假失败（超时路径会被其他测试的锁触发）。
    /// 用法：cargo test db::tests -- --test-threads=1
    /// （CI 中 cargo test 默认并行，这里通过下方每个测试持有的全局串行锁保证安全）


    /// 基本回归：get_connection 打开连接并完成迁移，核心表存在
    #[test]
    fn get_connection_initializes_and_migrates() {
        let _serial = test_global_serial_lock();
        let dir = test_dir("init");
        reset_shared_connection();
        {
            let conn = get_connection(&dir).expect("首次 get_connection 应成功");
            // 核心表存在（迁移完成）
            for table in [
                "settings",
                "shortcuts",
                "file_history",
                "open_history",
                "memos",
                "window_config",
                "meta",
                "plugin_usage",
                "clipboard_history",
                "word_records",
            ] {
                let ok = conn
                    .prepare(&format!("SELECT 1 FROM {table} LIMIT 1"))
                    .is_ok();
                assert!(ok, "表 {table} 应已由迁移创建");
            }
        } // guard drop 释放锁
    }

    /// 核心回归（死锁止血）：持锁线程卡住时，get_connection 必须在超时后快速失败，
    /// 而不是永久阻塞 —— 这是三次「未响应」挂死的直接教训。
    #[test]
    fn lock_timeout_fails_fast_when_held() {
        let _serial = test_global_serial_lock();
        let dir = test_dir("timeout");
        reset_shared_connection();

        // 初始化连接（预热）
        {
            let _conn = get_connection(&dir).unwrap();
        }

        // 模拟持锁者卡住：直接锁住 SHARED_CONNECTION 3.5s（超过 3s 超时）
        let held = SHARED_CONNECTION.lock().unwrap();
        let start = std::time::Instant::now();
        let result = get_connection(&dir);
        let elapsed = start.elapsed();

        assert!(result.is_err(), "锁被占时应返回 Err 而非阻塞成功");
        let err = match result {
            Err(e) => e,
            Ok(_) => unreachable!("上面已 assert is_err"),
        };
        assert!(
            err.contains("DB_LOCK_TIMEOUT"),
            "错误应标记为锁超时，实际: {err}"
        );
        // 超时应约等于 CONNECTION_LOCK_TIMEOUT（3s），且必须有限 —— 允许轮询开销的余量
        assert!(
            elapsed >= std::time::Duration::from_secs(2),
            "应在超时前保持等待，实际仅 {:?}",
            elapsed
        );
        assert!(
            elapsed <= std::time::Duration::from_secs(5),
            "超时应在 3s 附近快速失败，不应远超，实际 {:?}",
            elapsed
        );
        drop(held);
        reset_shared_connection();
    }

    /// 核心回归：持锁者释放后，后续 get_connection 立即恢复成功（无永久残留状态）
    #[test]
    fn lock_recovers_after_holder_releases() {
        let _serial = test_global_serial_lock();
        let dir = test_dir("recover");
        reset_shared_connection();

        // 持锁 200ms 后释放
        let holder = std::thread::spawn(|| {
            let _held = SHARED_CONNECTION.lock().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(200));
        });
        holder.join().unwrap();

        // 释放后必须立即可用
        let conn = get_connection(&dir).expect("持锁者释放后应恢复");
        let _ = conn
            .query_row("SELECT COUNT(*) FROM settings", [], |row| row.get::<_, i64>(0))
            .expect("连接应可用");
        reset_shared_connection();
    }

    /// 并发回归：多线程同时 get_connection + 执行 SQL，全部成功且无死锁
    /// （复现场景：剪贴板线程 + 打开历史线程 + 主线程同时访问）
    #[test]
    fn concurrent_access_all_succeed() {
        let _serial = test_global_serial_lock();
        let dir = test_dir("concurrent");
        reset_shared_connection();
        // 预热（初始化 + 迁移）
        {
            let _ = get_connection(&dir).unwrap();
        }

        let dir = std::sync::Arc::new(dir);
        let mut handles = Vec::new();
        for i in 0..8 {
            let dir = dir.clone();
            handles.push(std::thread::spawn(move || {
                for round in 0..10 {
                    let conn = get_connection(&dir)
                        .unwrap_or_else(|e| panic!("线程 {i} 轮 {round} 获取连接失败: {e}"));
                    conn.execute(
                        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
                        rusqlite::params![format!("thread_{i}"), round.to_string()],
                    )
                    .expect("写入应成功");
                }
            }));
        }
        for h in handles {
            h.join().expect("工作线程不应 panic");
        }

        // 校验写入完整
        let conn = get_connection(&dir).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM meta WHERE key LIKE 'thread_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 8, "每个线程应各写入一条记录");
        reset_shared_connection();
    }

    /// guard drop 语义回归：guard 离开作用域后锁被释放（其他线程立即可获取）
    #[test]
    fn guard_drop_releases_lock() {
        let _serial = test_global_serial_lock();
        let dir = test_dir("guard_drop");
        reset_shared_connection();
        {
            let conn = get_connection(&dir).unwrap();
            let _ = conn.query_row("SELECT 1", [], |row| row.get::<_, i64>(0));
            // guard 在此作用域结束时 drop
        }
        // 另一线程应能立即拿到锁
        let h = std::thread::spawn(move || {
            let start = std::time::Instant::now();
            let _conn = get_connection(&dir).expect("guard drop 后另一线程应立即拿到锁");
            start.elapsed()
        });
        let elapsed = h.join().unwrap();
        assert!(
            elapsed < std::time::Duration::from_millis(500),
            "锁释放应即时，实际等待 {:?}",
            elapsed
        );
        reset_shared_connection();
    }

    /// WAL 模式回归：确认 PRAGMA journal_mode=WAL 生效（并发读写的基础）
    #[test]
    fn wal_mode_enabled() {
        let _serial = test_global_serial_lock();
        let dir = test_dir("wal");
        reset_shared_connection();
        let conn = get_connection(&dir).unwrap();
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal", "应为 WAL 模式以支持并发");
        reset_shared_connection();
    }
}



