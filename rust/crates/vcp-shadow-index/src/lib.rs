//! Rebuildable full-text index shared by VCP JSON-backed products.
//!
//! This crate deliberately knows nothing about Electron, HTTP, Agent actors,
//! checkpoints or the VChat JSON tree. Callers project their authoritative
//! records into [`ShadowDocument`] values and may delete/rebuild this index at
//! any time without losing product data.

use std::{
    collections::HashSet,
    fs,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use anyhow::{Context, Result};
use jieba_rs::Jieba;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tantivy::{
    Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument, TantivyError, Term,
    collector::TopDocs,
    directory::error::LockError,
    doc,
    query::{BooleanQuery, Occur, Query, QueryParser, TermQuery},
    schema::{
        Field, IndexRecordOption, NumericOptions, STORED, STRING, Schema, TextFieldIndexing,
        TextOptions, Value,
    },
    tokenizer::{LowerCaser, RemoveLongFilter, TextAnalyzer, Token, TokenStream, Tokenizer},
};

const TOKENIZER: &str = "vcp_jieba";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShadowDocument {
    pub owner_id: String,
    pub topic_id: String,
    pub topic_title: String,
    pub message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub ordinal: u64,
    pub timestamp: i64,
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShadowSearchHit {
    pub owner_id: String,
    pub topic_id: String,
    pub topic_title: String,
    pub message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub ordinal: u64,
    pub timestamp: i64,
    pub role: String,
    pub content: String,
    pub score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShadowIndexStatus {
    pub available: bool,
    pub writable: bool,
    pub rebuilding: bool,
    pub document_count: u64,
    pub topic_count: u64,
}

#[derive(Debug, Clone)]
struct Fields {
    topic_key: Field,
    owner_id: Field,
    topic_id: Field,
    topic_title: Field,
    message_id: Field,
    turn_id: Field,
    ordinal: Field,
    timestamp: Field,
    role: Field,
    content: Field,
}

impl Fields {
    fn from_schema(schema: &Schema) -> Result<Self> {
        let field = |name| {
            schema
                .get_field(name)
                .with_context(|| format!("shadow index schema is missing field {name}"))
        };
        Ok(Self {
            topic_key: field("topic_key")?,
            owner_id: field("owner_id")?,
            topic_id: field("topic_id")?,
            topic_title: field("topic_title")?,
            message_id: field("message_id")?,
            turn_id: field("turn_id")?,
            ordinal: field("ordinal")?,
            timestamp: field("timestamp")?,
            role: field("role")?,
            content: field("content")?,
        })
    }
}

#[derive(Clone)]
struct JiebaTokenizer {
    jieba: Arc<Jieba>,
}

struct JiebaTokenStream {
    tokens: Vec<Token>,
    cursor: usize,
}

impl Tokenizer for JiebaTokenizer {
    type TokenStream<'a> = JiebaTokenStream;

    fn token_stream<'a>(&mut self, text: &'a str) -> Self::TokenStream<'a> {
        let mut tokens = Vec::new();
        let mut search_from = 0;
        for word in self.jieba.cut(text, false) {
            if word.trim().is_empty() {
                continue;
            }
            let relative = text[search_from..].find(word).unwrap_or(0);
            let start = search_from + relative;
            let end = start + word.len();
            tokens.push(Token {
                offset_from: start,
                offset_to: end,
                position: tokens.len(),
                text: word.to_lowercase(),
                position_length: 1,
            });
            search_from = end.min(text.len());
        }
        JiebaTokenStream { tokens, cursor: 0 }
    }
}

impl TokenStream for JiebaTokenStream {
    fn advance(&mut self) -> bool {
        if self.cursor >= self.tokens.len() {
            return false;
        }
        self.cursor += 1;
        true
    }

    fn token(&self) -> &Token {
        &self.tokens[self.cursor - 1]
    }

    fn token_mut(&mut self) -> &mut Token {
        &mut self.tokens[self.cursor - 1]
    }
}

#[derive(Clone)]
pub struct ShadowIndex {
    index: Index,
    reader: IndexReader,
    writer: Arc<Mutex<Option<IndexWriter>>>,
    fields: Fields,
    rebuilding: Arc<AtomicBool>,
    known_topics: Arc<Mutex<HashSet<String>>>,
}

impl ShadowIndex {
    pub fn open(directory: &Path) -> Result<Self> {
        fs::create_dir_all(directory).with_context(|| {
            format!(
                "failed to create shadow index directory {}",
                directory.display()
            )
        })?;
        let schema = build_schema();
        let index = if directory.join("meta.json").is_file() {
            Index::open_in_dir(directory)
                .with_context(|| format!("failed to open shadow index {}", directory.display()))?
        } else {
            Index::create_in_dir(directory, schema)
                .with_context(|| format!("failed to create shadow index {}", directory.display()))?
        };
        let tokenizer = TextAnalyzer::builder(JiebaTokenizer {
            jieba: Arc::new(Jieba::new()),
        })
        .filter(RemoveLongFilter::limit(256))
        .filter(LowerCaser)
        .build();
        index.tokenizers().register(TOKENIZER, tokenizer);
        let fields = Fields::from_schema(&index.schema())?;
        // Tantivy enforces one writer per directory. A second Agent frontend
        // may still open the committed index read-only; it must never create
        // another recovery truth or fail the daemon merely because the active
        // attachment owns the search writer lock.
        let writer = match index.writer(50_000_000) {
            Ok(writer) => Some(writer),
            Err(TantivyError::LockFailure(LockError::LockBusy, _)) => None,
            Err(error) => return Err(error).context("failed to open shadow index writer"),
        };
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;
        Ok(Self {
            index,
            reader,
            writer: Arc::new(Mutex::new(writer)),
            fields,
            rebuilding: Arc::new(AtomicBool::new(false)),
            known_topics: Arc::new(Mutex::new(HashSet::new())),
        })
    }

    pub fn status(&self) -> ShadowIndexStatus {
        ShadowIndexStatus {
            available: true,
            writable: self.writer.lock().is_some(),
            rebuilding: self.rebuilding.load(Ordering::Acquire),
            document_count: self.reader.searcher().num_docs(),
            topic_count: u64::try_from(self.known_topics.lock().len()).unwrap_or(u64::MAX),
        }
    }

    pub fn replace_topic(
        &self,
        owner_id: &str,
        topic_id: &str,
        documents: &[ShadowDocument],
    ) -> Result<()> {
        let mut writer_guard = self.writer.lock();
        let writer = writer_guard
            .as_mut()
            .context("shadow index is read-only because another process owns the writer")?;
        writer.delete_term(Term::from_field_text(
            self.fields.topic_key,
            &topic_key(owner_id, topic_id),
        ));
        for document in documents {
            if document.owner_id != owner_id || document.topic_id != topic_id {
                anyhow::bail!("shadow document escaped its requested Topic scope");
            }
            writer.add_document(self.document(document))?;
        }
        writer.commit()?;
        drop(writer_guard);
        self.reader.reload()?;
        let key = topic_key(owner_id, topic_id);
        if documents.is_empty() {
            self.known_topics.lock().remove(&key);
        } else {
            self.known_topics.lock().insert(key);
        }
        Ok(())
    }

    pub fn delete_topic(&self, owner_id: &str, topic_id: &str) -> Result<()> {
        self.replace_topic(owner_id, topic_id, &[])
    }

    pub fn rebuild(&self, documents: &[ShadowDocument]) -> Result<usize> {
        if self.rebuilding.swap(true, Ordering::AcqRel) {
            anyhow::bail!("shadow index rebuild is already running");
        }
        let result = (|| {
            let mut writer_guard = self.writer.lock();
            let writer = writer_guard
                .as_mut()
                .context("shadow index is read-only because another process owns the writer")?;
            writer.delete_all_documents()?;
            for document in documents {
                writer.add_document(self.document(document))?;
            }
            writer.commit()?;
            drop(writer_guard);
            self.reader.reload()?;
            let topics: HashSet<String> = documents
                .iter()
                .map(|document| topic_key(&document.owner_id, &document.topic_id))
                .collect();
            let topic_count = topics.len();
            *self.known_topics.lock() = topics;
            Ok(topic_count)
        })();
        self.rebuilding.store(false, Ordering::Release);
        result
    }

    pub fn search(
        &self,
        query_text: &str,
        owner_id: Option<&str>,
        topic_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ShadowSearchHit>> {
        if query_text.trim().is_empty() {
            anyhow::bail!("search query cannot be empty");
        }
        let parser = QueryParser::for_index(
            &self.index,
            vec![self.fields.content, self.fields.topic_title],
        );
        let content = parser
            .parse_query(&normalize_query_syntax(query_text))
            .context("invalid search query")?;
        let mut clauses: Vec<(Occur, Box<dyn Query>)> = vec![(Occur::Must, content)];
        if let Some(owner_id) = owner_id {
            clauses.push((
                Occur::Must,
                exact_term_query(self.fields.owner_id, owner_id),
            ));
        }
        if let Some(topic_id) = topic_id {
            clauses.push((
                Occur::Must,
                exact_term_query(self.fields.topic_id, topic_id),
            ));
        }
        let searcher = self.reader.searcher();
        let matches = searcher.search(
            &BooleanQuery::new(clauses),
            &TopDocs::with_limit(limit.clamp(1, 500)),
        )?;
        matches
            .into_iter()
            .map(|(score, address)| {
                let document: TantivyDocument = searcher.doc(address)?;
                Ok(ShadowSearchHit {
                    owner_id: required_text(&document, self.fields.owner_id)?,
                    topic_id: required_text(&document, self.fields.topic_id)?,
                    topic_title: required_text(&document, self.fields.topic_title)?,
                    message_id: required_text(&document, self.fields.message_id)?,
                    turn_id: optional_text(&document, self.fields.turn_id),
                    ordinal: document
                        .get_first(self.fields.ordinal)
                        .and_then(|value| value.as_u64())
                        .unwrap_or_default(),
                    timestamp: document
                        .get_first(self.fields.timestamp)
                        .and_then(|value| value.as_i64())
                        .unwrap_or_default(),
                    role: required_text(&document, self.fields.role)?,
                    content: required_text(&document, self.fields.content)?,
                    score,
                })
            })
            .collect()
    }

    fn document(&self, value: &ShadowDocument) -> TantivyDocument {
        let mut document = doc!(
            self.fields.topic_key => topic_key(&value.owner_id, &value.topic_id),
            self.fields.owner_id => value.owner_id.clone(),
            self.fields.topic_id => value.topic_id.clone(),
            self.fields.topic_title => value.topic_title.clone(),
            self.fields.message_id => value.message_id.clone(),
            self.fields.ordinal => value.ordinal,
            self.fields.timestamp => value.timestamp,
            self.fields.role => value.role.clone(),
            self.fields.content => value.content.clone(),
        );
        if let Some(turn_id) = &value.turn_id {
            document.add_text(self.fields.turn_id, turn_id);
        }
        document
    }
}

fn build_schema() -> Schema {
    let mut builder = Schema::builder();
    let exact = STRING | STORED;
    let numeric = NumericOptions::default()
        .set_indexed()
        .set_stored()
        .set_fast();
    let text = TextOptions::default()
        .set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer(TOKENIZER)
                .set_index_option(IndexRecordOption::WithFreqsAndPositions),
        )
        .set_stored();
    builder.add_text_field("topic_key", STRING);
    builder.add_text_field("owner_id", exact.clone());
    builder.add_text_field("topic_id", exact.clone());
    builder.add_text_field("topic_title", text.clone());
    builder.add_text_field("message_id", exact.clone());
    builder.add_text_field("turn_id", exact);
    builder.add_u64_field("ordinal", numeric.clone());
    builder.add_i64_field("timestamp", numeric);
    builder.add_text_field("role", STRING | STORED);
    builder.add_text_field("content", text);
    builder.build()
}

fn topic_key(owner_id: &str, topic_id: &str) -> String {
    format!("{owner_id}\u{1f}{topic_id}")
}

fn exact_term_query(field: Field, value: &str) -> Box<dyn Query> {
    Box::new(TermQuery::new(
        Term::from_field_text(field, value),
        IndexRecordOption::Basic,
    ))
}

fn required_text(document: &TantivyDocument, field: Field) -> Result<String> {
    optional_text(document, field).context("shadow index document is missing a stored field")
}

fn optional_text(document: &TantivyDocument, field: Field) -> Option<String> {
    document
        .get_first(field)
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
}

/// Preserve VChat's established weighted/exclusion query syntax so Agent and
/// normal chat search do not drift into two user-visible query languages.
pub fn normalize_query_syntax(query: &str) -> String {
    query
        .split([',', '，'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| {
            if let Some(inner) = part
                .strip_prefix('[')
                .and_then(|value| value.strip_suffix(']'))
            {
                let term = inner.split(':').next().unwrap_or_default().trim();
                return format!("-{term}");
            }
            if let Some(inner) = part
                .strip_prefix('{')
                .and_then(|value| value.strip_suffix('}'))
            {
                let (terms, weight) = match inner.rsplit_once(':') {
                    Some((terms, weight)) if weight.trim().parse::<f32>().is_ok() => {
                        (terms, Some(weight.trim()))
                    }
                    _ => (inner, None),
                };
                let group = format!(
                    "({})",
                    terms
                        .split('|')
                        .map(str::trim)
                        .filter(|term| !term.is_empty())
                        .collect::<Vec<_>>()
                        .join(" OR ")
                );
                return weight
                    .map(|weight| format!("{group}^{weight}"))
                    .unwrap_or(group);
            }
            if let Some(inner) = part
                .strip_prefix('(')
                .and_then(|value| value.strip_suffix(')'))
                && let Some((term, weight)) = inner.rsplit_once(':')
                && weight.trim().parse::<f32>().is_ok()
            {
                return format!("{}^{}", term.trim(), weight.trim());
            }
            part.to_string()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(topic_id: &str, message_id: &str, content: &str) -> ShadowDocument {
        ShadowDocument {
            owner_id: "Nova".into(),
            topic_id: topic_id.into(),
            topic_title: format!("Topic {topic_id}"),
            message_id: message_id.into(),
            turn_id: Some("turn-1".into()),
            ordinal: 0,
            timestamp: 42,
            role: "user".into(),
            content: content.into(),
        }
    }

    #[test]
    fn index_is_rebuildable_scoped_and_cjk_searchable() {
        let directory = tempfile::tempdir().unwrap();
        let index = ShadowIndex::open(directory.path()).unwrap();
        index
            .rebuild(&[
                document("topic-1", "msg-1", "请修复数据库同步问题"),
                document("topic-2", "msg-2", "ordinary weather chat"),
            ])
            .unwrap();
        let hits = index.search("数据库", Some("Nova"), None, 20).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message_id, "msg-1");
        assert_eq!(index.status().document_count, 2);
        assert_eq!(index.status().topic_count, 2);

        index
            .replace_topic(
                "Nova",
                "topic-1",
                &[document("topic-1", "msg-3", "新的索引内容")],
            )
            .unwrap();
        assert!(
            index
                .search("数据库", Some("Nova"), None, 20)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            index.search("索引", Some("Nova"), None, 20).unwrap()[0].message_id,
            "msg-3"
        );
    }

    #[test]
    fn preserves_vchat_weighted_query_syntax() {
        assert_eq!(
            normalize_query_syntax("VCP,[闲聊],{bug|修复:1.3},(代码:1.1)"),
            "VCP -闲聊 (bug OR 修复)^1.3 代码^1.1"
        );
    }

    #[test]
    fn second_owner_degrades_to_search_only_without_stealing_the_writer() {
        let directory = tempfile::tempdir().unwrap();
        let writer = ShadowIndex::open(directory.path()).unwrap();
        writer
            .rebuild(&[document("topic-1", "msg-1", "共享只读索引")])
            .unwrap();

        let reader = ShadowIndex::open(directory.path()).unwrap();
        assert!(writer.status().writable);
        assert!(!reader.status().writable);
        assert_eq!(reader.status().document_count, 1);
        assert_eq!(
            reader
                .search("只读索引", Some("Nova"), Some("topic-1"), 20)
                .unwrap()[0]
                .message_id,
            "msg-1"
        );
        assert!(reader.delete_topic("Nova", "topic-1").is_err());

        writer
            .replace_topic(
                "Nova",
                "topic-1",
                &[document("topic-1", "msg-2", "第一 writer 继续提交")],
            )
            .unwrap();
        assert_eq!(
            writer
                .search("继续提交", Some("Nova"), Some("topic-1"), 20)
                .unwrap()[0]
                .message_id,
            "msg-2"
        );
    }
}
