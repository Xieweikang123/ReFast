use crate::db;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordRecord {
    pub id: String,
    pub word: String,
    pub translation: String,
    pub source_lang: String,
    pub target_lang: String,
    pub context: Option<String>,
    pub phonetic: Option<String>,
    pub example_sentence: Option<String>,
    pub tags: Vec<String>,
    pub mastery_level: i32,
    pub review_count: i32,
    pub last_reviewed: Option<u64>,
    pub created_at: u64,
    pub updated_at: u64,
    pub is_favorite: bool,
    pub is_mastered: bool,
}

fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn get_all_word_records(app_data_dir: &Path) -> Result<Vec<WordRecord>, String> {
    let mut conn = db::get_connection(app_data_dir)?;

    let mut stmt = conn
        .prepare(
            "SELECT id, word, translation, source_lang, target_lang, context, phonetic, 
                    example_sentence, tags, mastery_level, review_count, last_reviewed, 
                    created_at, updated_at, is_favorite, is_mastered 
             FROM word_records ORDER BY mastery_level ASC",
        )
        .map_err(|e| format!("Failed to prepare word_records query: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            let tags_json: Option<String> = row.get(8)?;
            let tags = if let Some(json) = tags_json {
                serde_json::from_str(&json).unwrap_or_default()
            } else {
                Vec::new()
            };

            Ok(WordRecord {
                id: row.get(0)?,
                word: row.get(1)?,
                translation: row.get(2)?,
                source_lang: row.get(3)?,
                target_lang: row.get(4)?,
                context: row.get(5)?,
                phonetic: row.get(6)?,
                example_sentence: row.get(7)?,
                tags,
                mastery_level: row.get(9)?,
                review_count: row.get(10)?,
                last_reviewed: row.get::<_, Option<i64>>(11)?.map(|v| v as u64),
                created_at: row.get::<_, i64>(12)? as u64,
                updated_at: row.get::<_, i64>(13)? as u64,
                is_favorite: row.get::<_, i32>(14)? != 0,
                is_mastered: row.get::<_, i32>(15)? != 0,
            })
        })
        .map_err(|e| format!("Failed to iterate word_records: {}", e))?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|e| format!("Failed to read word_record row: {}", e))?);
    }
    Ok(items)
}

pub fn add_word_record(
    word: String,
    translation: String,
    source_lang: String,
    target_lang: String,
    context: Option<String>,
    phonetic: Option<String>,
    example_sentence: Option<String>,
    tags: Vec<String>,
    app_data_dir: &Path,
) -> Result<WordRecord, String> {
    let now = now_ts();
    let id = format!("word-{}", now);

    let tags_json = serde_json::to_string(&tags)
        .map_err(|e| format!("Failed to serialize tags: {}", e))?;

    let item = WordRecord {
        id: id.clone(),
        word: word.clone(),
        translation: translation.clone(),
        source_lang: source_lang.clone(),
        target_lang: target_lang.clone(),
        context: context.clone(),
        phonetic: phonetic.clone(),
        example_sentence: example_sentence.clone(),
        tags: tags.clone(),
        mastery_level: 0,
        review_count: 0,
        last_reviewed: None,
        created_at: now,
        updated_at: now,
        is_favorite: false,
        is_mastered: false,
    };

    let mut conn = db::get_connection(app_data_dir)?;
    conn.execute(
        "INSERT INTO word_records (id, word, translation, source_lang, target_lang, context, 
                                   phonetic, example_sentence, tags, mastery_level, review_count, 
                                   last_reviewed, created_at, updated_at, is_favorite, is_mastered)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            item.id,
            item.word,
            item.translation,
            item.source_lang,
            item.target_lang,
            item.context,
            item.phonetic,
            item.example_sentence,
            tags_json,
            item.mastery_level,
            item.review_count,
            item.last_reviewed.map(|v| v as i64),
            item.created_at as i64,
            item.updated_at as i64,
            if item.is_favorite { 1 } else { 0 },
            if item.is_mastered { 1 } else { 0 }
        ],
    )
    .map_err(|e| format!("Failed to insert word_record: {}", e))?;

    Ok(item)
}

pub fn update_word_record(
    id: String,
    word: Option<String>,
    translation: Option<String>,
    context: Option<String>,
    phonetic: Option<String>,
    example_sentence: Option<String>,
    tags: Option<Vec<String>>,
    mastery_level: Option<i32>,
    is_favorite: Option<bool>,
    is_mastered: Option<bool>,
    app_data_dir: &Path,
) -> Result<WordRecord, String> {
    let mut conn = db::get_connection(app_data_dir)?;

    let existing: Option<WordRecord> = conn
        .query_row(
            "SELECT id, word, translation, source_lang, target_lang, context, phonetic, 
                    example_sentence, tags, mastery_level, review_count, last_reviewed, 
                    created_at, updated_at, is_favorite, is_mastered 
             FROM word_records WHERE id = ?1",
            params![id],
            |row| {
                let tags_json: Option<String> = row.get(8)?;
                let tags = if let Some(json) = tags_json {
                    serde_json::from_str(&json).unwrap_or_default()
                } else {
                    Vec::new()
                };

                Ok(WordRecord {
                    id: row.get(0)?,
                    word: row.get(1)?,
                    translation: row.get(2)?,
                    source_lang: row.get(3)?,
                    target_lang: row.get(4)?,
                    context: row.get(5)?,
                    phonetic: row.get(6)?,
                    example_sentence: row.get(7)?,
                    tags,
                    mastery_level: row.get(9)?,
                    review_count: row.get(10)?,
                    last_reviewed: row.get::<_, Option<i64>>(11)?.map(|v| v as u64),
                    created_at: row.get::<_, i64>(12)? as u64,
                    updated_at: row.get::<_, i64>(13)? as u64,
                    is_favorite: row.get::<_, i32>(14)? != 0,
                    is_mastered: row.get::<_, i32>(15)? != 0,
                })
            },
        )
        .optional()
        .map_err(|e| format!("Failed to load word_record: {}", e))?;

    let mut record = existing.ok_or_else(|| format!("WordRecord {} not found", id))?;

    if let Some(w) = word {
        record.word = w;
    }
    if let Some(t) = translation {
        record.translation = t;
    }
    if let Some(c) = context {
        record.context = Some(c);
    }
    if let Some(p) = phonetic {
        record.phonetic = Some(p);
    }
    if let Some(e) = example_sentence {
        record.example_sentence = Some(e);
    }
    if let Some(tags) = tags {
        record.tags = tags;
    }
    if let Some(ml) = mastery_level {
        record.mastery_level = ml;
    }
    if let Some(fav) = is_favorite {
        record.is_favorite = fav;
    }
    if let Some(mas) = is_mastered {
        record.is_mastered = mas;
    }
    record.updated_at = now_ts();

    let tags_json = serde_json::to_string(&record.tags)
        .map_err(|e| format!("Failed to serialize tags: {}", e))?;

    conn.execute(
        "UPDATE word_records 
         SET word = ?1, translation = ?2, context = ?3, phonetic = ?4, example_sentence = ?5, 
             tags = ?6, mastery_level = ?7, updated_at = ?8, is_favorite = ?9, is_mastered = ?10 
         WHERE id = ?11",
        params![
            record.word,
            record.translation,
            record.context,
            record.phonetic,
            record.example_sentence,
            tags_json,
            record.mastery_level,
            record.updated_at as i64,
            if record.is_favorite { 1 } else { 0 },
            if record.is_mastered { 1 } else { 0 },
            record.id
        ],
    )
    .map_err(|e| format!("Failed to update word_record: {}", e))?;

    Ok(record)
}

pub fn delete_word_record(id: String, app_data_dir: &Path) -> Result<(), String> {
    let mut conn = db::get_connection(app_data_dir)?;
    let affected = conn
        .execute("DELETE FROM word_records WHERE id = ?1", params![id])
        .map_err(|e| format!("Failed to delete word_record: {}", e))?;
    if affected == 0 {
        return Err("WordRecord not found".to_string());
    }
    Ok(())
}

pub fn search_word_records(query: &str, app_data_dir: &Path) -> Result<Vec<WordRecord>, String> {
    let mut conn = db::get_connection(app_data_dir)?;

    let like = format!("%{}%", query.to_lowercase());
    let mut stmt = conn
        .prepare(
            "SELECT id, word, translation, source_lang, target_lang, context, phonetic, 
                    example_sentence, tags, mastery_level, review_count, last_reviewed, 
                    created_at, updated_at, is_favorite, is_mastered 
             FROM word_records
             WHERE lower(word) LIKE ?1 OR lower(translation) LIKE ?1
             ORDER BY mastery_level ASC",
        )
        .map_err(|e| format!("Failed to prepare word_record search: {}", e))?;

    let rows = stmt
        .query_map(params![like], |row| {
            let tags_json: Option<String> = row.get(8)?;
            let tags = if let Some(json) = tags_json {
                serde_json::from_str(&json).unwrap_or_default()
            } else {
                Vec::new()
            };

            Ok(WordRecord {
                id: row.get(0)?,
                word: row.get(1)?,
                translation: row.get(2)?,
                source_lang: row.get(3)?,
                target_lang: row.get(4)?,
                context: row.get(5)?,
                phonetic: row.get(6)?,
                example_sentence: row.get(7)?,
                tags,
                mastery_level: row.get(9)?,
                review_count: row.get(10)?,
                last_reviewed: row.get::<_, Option<i64>>(11)?.map(|v| v as u64),
                created_at: row.get::<_, i64>(12)? as u64,
                updated_at: row.get::<_, i64>(13)? as u64,
                is_favorite: row.get::<_, i32>(14)? != 0,
                is_mastered: row.get::<_, i32>(15)? != 0,
            })
        })
        .map_err(|e| format!("Failed to iterate word_record search: {}", e))?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|e| format!("Failed to read word_record row: {}", e))?);
    }
    Ok(items)
}

