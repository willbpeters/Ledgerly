use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct Account {
    pub id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub institution: Option<String>,
    pub currency: String,
    pub created_at: String,
    /// "manual" or "simplefin"
    pub source: String,
    /// SimpleFIN account id when source == "simplefin"
    pub external_id: Option<String>,
    /// Cash balance reported by SimpleFIN at the last sync
    pub synced_balance: Option<f64>,
    /// RFC3339 timestamp of the last successful sync
    pub last_synced_at: Option<String>,
}

#[derive(Deserialize)]
pub struct NewAccount {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub institution: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Security {
    pub id: i64,
    pub ticker: String,
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub type_: String,
    pub currency: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Transaction {
    pub id: i64,
    pub account_id: i64,
    pub security_id: Option<i64>,
    #[serde(rename = "type")]
    pub type_: String,
    pub date: String,
    pub quantity: f64,
    pub price: f64,
    pub amount: f64,
    pub fees: f64,
    pub note: Option<String>,
}

#[derive(Deserialize)]
pub struct NewTransaction {
    pub account_id: i64,
    pub security_id: Option<i64>,
    #[serde(rename = "type")]
    pub type_: String,
    pub date: String,
    pub quantity: f64,
    pub price: f64,
    pub amount: f64,
    pub fees: f64,
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Snapshot {
    pub date: String,
    pub total_value: f64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SyncedHolding {
    pub id: i64,
    pub account_id: i64,
    pub security_id: i64,
    pub shares: f64,
    pub cost_basis: f64,
    pub market_value: f64,
    pub as_of: String,
}
