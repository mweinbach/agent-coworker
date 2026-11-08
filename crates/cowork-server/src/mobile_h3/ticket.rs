use chrono::Utc;
use data_encoding::BASE64URL_NOPAD;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

pub const TICKET_PREFIX: &str = "cowork-pair://";
const BASE32_ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CoworkTicketScheme {
    H3,
    Opentunnel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoworkPairingTicket {
    pub v: u8,
    pub scheme: CoworkTicketScheme,
    pub hosts: Vec<String>,
    pub port: u16,
    pub cert_sha256: String,
    pub spki_sha256: String,
    pub identity_pub: String,
    pub nonce: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct H3PairingSession {
    pub nonce: String,
    pub expires_at: i64,
}

fn is_base64url_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

pub fn validate_cowork_pairing_ticket(
    ticket: &CoworkPairingTicket,
) -> anyhow::Result<CoworkPairingTicket> {
    if ticket.v != 1 {
        anyhow::bail!("Pairing ticket version must be 1.");
    }
    if ticket.hosts.is_empty() {
        anyhow::bail!("Pairing ticket must include at least one host.");
    }
    let mut normalized_hosts = Vec::with_capacity(ticket.hosts.len());
    for h in &ticket.hosts {
        let trimmed = h.trim();
        if trimmed.is_empty() {
            anyhow::bail!("Pairing ticket host cannot be empty.");
        }
        normalized_hosts.push(trimmed.to_owned());
    }
    if ticket.port == 0 {
        anyhow::bail!("Pairing ticket port must be between 1 and 65535.");
    }
    if ticket.cert_sha256.len() != 64
        || !ticket
            .cert_sha256
            .chars()
            .all(|c| matches!(c, '0'..='9' | 'a'..='f'))
    {
        anyhow::bail!("Pairing ticket certSha256 must be 64 lowercase hex characters.");
    }
    if ticket.spki_sha256.len() != 43 || !ticket.spki_sha256.chars().all(is_base64url_char) {
        anyhow::bail!("Pairing ticket spkiSha256 must be 43 base64url characters.");
    }
    let identity_pub = ticket.identity_pub.trim().to_owned();
    if identity_pub.is_empty() {
        anyhow::bail!("Pairing ticket identityPub cannot be empty.");
    }
    if ticket.nonce.len() < 22 || !ticket.nonce.chars().all(is_base64url_char) {
        anyhow::bail!("Pairing ticket nonce must be at least 22 base64url characters.");
    }
    if ticket.expires_at <= 0 {
        anyhow::bail!("Pairing ticket expiresAt must be positive.");
    }

    Ok(CoworkPairingTicket {
        v: 1,
        scheme: ticket.scheme,
        hosts: normalized_hosts,
        port: ticket.port,
        cert_sha256: ticket.cert_sha256.clone(),
        spki_sha256: ticket.spki_sha256.clone(),
        identity_pub,
        nonce: ticket.nonce.clone(),
        expires_at: ticket.expires_at,
    })
}

pub fn base32_encode_lower(bytes: &[u8]) -> String {
    let mut output = String::with_capacity((bytes.len() * 8).div_ceil(5));
    let mut value: u32 = 0;
    let mut bits: u32 = 0;

    for &byte in bytes {
        value = (value << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            let idx = ((value >> (bits - 5)) & 31) as usize;
            output.push(BASE32_ALPHABET[idx] as char);
            bits -= 5;
        }
    }

    if bits > 0 {
        let idx = ((value << (5 - bits)) & 31) as usize;
        output.push(BASE32_ALPHABET[idx] as char);
    }

    output
}

pub fn base32_decode_lenient(input: &str) -> anyhow::Result<Vec<u8>> {
    let normalized = input.trim_end_matches('=').to_ascii_lowercase();
    let mut bytes = Vec::with_capacity(normalized.len() * 5 / 8);
    let mut value: u32 = 0;
    let mut bits: u32 = 0;

    for ch in normalized.chars() {
        let chunk: u32 = match ch {
            'a'..='z' => u32::from(ch as u8 - b'a'),
            '2'..='7' => u32::from(ch as u8 - b'2') + 26,
            _ => anyhow::bail!("Pairing ticket contains invalid base32 data."),
        };
        value = (value << 5) | chunk;
        bits += 5;
        if bits >= 8 {
            bytes.push(((value >> (bits - 8)) & 0xff) as u8);
            bits -= 8;
        }
    }

    Ok(bytes)
}

pub fn encode_cowork_pairing_ticket(ticket: &CoworkPairingTicket) -> anyhow::Result<String> {
    let validated = validate_cowork_pairing_ticket(ticket)?;
    let json_bytes = serde_json::to_vec(&validated)?;
    Ok(format!(
        "{TICKET_PREFIX}{}",
        base32_encode_lower(&json_bytes)
    ))
}

pub fn decode_cowork_pairing_ticket(raw_ticket: &str) -> anyhow::Result<CoworkPairingTicket> {
    let trimmed = raw_ticket.trim();
    let Some(payload) = trimmed.strip_prefix(TICKET_PREFIX) else {
        anyhow::bail!("Pairing ticket must start with cowork-pair://.");
    };
    if payload.is_empty() {
        anyhow::bail!("Pairing ticket is empty.");
    }
    let decoded_bytes = base32_decode_lenient(payload)?;
    let raw_str = std::str::from_utf8(&decoded_bytes)
        .map_err(|_| anyhow::anyhow!("Pairing ticket payload is not valid UTF-8."))?;
    let parsed: CoworkPairingTicket = serde_json::from_str(raw_str)
        .map_err(|e| anyhow::anyhow!("Invalid pairing ticket JSON: {e}"))?;
    validate_cowork_pairing_ticket(&parsed)
}

pub fn create_pairing_nonce(byte_length: usize) -> String {
    let mut buf = vec![0u8; byte_length];
    rand::fill(&mut buf[..]);
    BASE64URL_NOPAD.encode(&buf)
}

pub fn create_h3_pairing_session(lifetime_ms: i64) -> H3PairingSession {
    H3PairingSession {
        nonce: create_pairing_nonce(24),
        expires_at: Utc::now().timestamp_millis().saturating_add(lifetime_ms),
    }
}

pub fn verify_h3_pairing_nonce(session: &H3PairingSession, nonce: &str) -> bool {
    if Utc::now().timestamp_millis() > session.expires_at {
        return false;
    }
    let expected = session.nonce.as_bytes();
    let actual = nonce.as_bytes();
    expected.len() == actual.len() && bool::from(expected.ct_eq(actual))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn valid_value() -> Value {
        json!({
            "v": 1,
            "scheme": "h3",
            "hosts": ["192.168.1.40", "100.88.12.9"],
            "port": 49_555,
            "certSha256": "a".repeat(64),
            "spkiSha256": format!("{}-_{}", "b".repeat(21), "B".repeat(20)),
            "identityPub": "identity-pub",
            "nonce": format!("{}-_{}", "d".repeat(10), "D".repeat(10)),
            "expiresAt": 1_777_329_000_000i64,
        })
    }

    fn encode_raw(value: &Value) -> String {
        format!(
            "{TICKET_PREFIX}{}",
            base32_encode_lower(value.to_string().as_bytes())
        )
    }

    fn assert_ticket_err(result: anyhow::Result<impl std::fmt::Debug>, needle: &str) {
        let err = result.expect_err(needle).to_string();
        assert!(err.contains(needle), "{err}");
    }

    #[test]
    fn decode_trims_hosts_and_identity_and_accepts_both_schemes() {
        let mut value = valid_value();
        value["hosts"] = json!(["  192.168.1.40  ", "\t100.88.12.9\n"]);
        value["identityPub"] = json!("  identity-pub  ");
        let decoded = decode_cowork_pairing_ticket(&format!("  {}  ", encode_raw(&value))).unwrap();
        assert_eq!(
            decoded.hosts,
            vec!["192.168.1.40".to_owned(), "100.88.12.9".to_owned()]
        );
        assert_eq!(decoded.identity_pub, "identity-pub");
        assert_eq!(decoded.scheme, CoworkTicketScheme::H3);
        assert_eq!(decoded.port, 49_555);
        assert_eq!(decoded.spki_sha256, value["spkiSha256"].as_str().unwrap());

        value["scheme"] = json!("opentunnel");
        value["hosts"] = json!(["desktop.local"]);
        let opentunnel = decode_cowork_pairing_ticket(&encode_raw(&value)).unwrap();
        assert_eq!(opentunnel.scheme, CoworkTicketScheme::Opentunnel);
        assert_eq!(opentunnel.hosts, vec!["desktop.local".to_owned()]);
    }

    #[test]
    fn validate_rejects_tickets_that_would_weaken_pairing() {
        let base = decode_cowork_pairing_ticket(&encode_raw(&valid_value())).unwrap();
        let reject = |mutate: fn(&mut CoworkPairingTicket), needle: &str| {
            let mut ticket = base.clone();
            mutate(&mut ticket);
            assert_ticket_err(validate_cowork_pairing_ticket(&ticket), needle);
            assert_ticket_err(encode_cowork_pairing_ticket(&ticket), needle);
        };

        reject(|t| t.v = 0, "Pairing ticket version must be 1.");
        reject(|t| t.v = 2, "Pairing ticket version must be 1.");
        reject(|t| t.hosts.clear(), "at least one host");
        reject(
            |t| t.hosts = vec!["ok".into(), "   ".into()],
            "host cannot be empty",
        );
        reject(|t| t.port = 0, "port must be between 1 and 65535");
        reject(
            |t| t.cert_sha256 = "A".repeat(64),
            "certSha256 must be 64 lowercase hex",
        );
        reject(
            |t| t.cert_sha256 = "a".repeat(63),
            "certSha256 must be 64 lowercase hex",
        );
        reject(
            |t| t.cert_sha256 = format!("{}g", "a".repeat(63)),
            "certSha256 must be 64 lowercase hex",
        );
        reject(
            |t| t.spki_sha256 = "b".repeat(42),
            "spkiSha256 must be 43 base64url",
        );
        reject(
            |t| t.spki_sha256 = "b".repeat(44),
            "spkiSha256 must be 43 base64url",
        );
        reject(
            |t| t.spki_sha256 = format!("{}+", "b".repeat(42)),
            "spkiSha256 must be 43 base64url",
        );
        reject(
            |t| t.spki_sha256 = format!("{}/", "b".repeat(42)),
            "spkiSha256 must be 43 base64url",
        );
        reject(
            |t| t.identity_pub = "   ".into(),
            "identityPub cannot be empty",
        );
        reject(
            |t| t.nonce = "d".repeat(21),
            "nonce must be at least 22 base64url",
        );
        reject(
            |t| t.nonce = format!("{}+", "d".repeat(21)),
            "nonce must be at least 22 base64url",
        );
        reject(|t| t.expires_at = 0, "expiresAt must be positive");
        reject(|t| t.expires_at = -1, "expiresAt must be positive");

        let mut edge = base.clone();
        edge.port = u16::MAX;
        edge.nonce = "d".repeat(22);
        edge.expires_at = 1;
        assert_eq!(
            validate_cowork_pairing_ticket(&edge).unwrap().port,
            u16::MAX
        );
    }

    #[test]
    fn decode_rejects_malformed_or_extended_payloads_before_use() {
        assert_ticket_err(
            decode_cowork_pairing_ticket("https://example.invalid/pair"),
            "must start with cowork-pair://",
        );
        assert_ticket_err(
            decode_cowork_pairing_ticket("  cowork-pair://  "),
            "Pairing ticket is empty.",
        );
        assert_ticket_err(
            decode_cowork_pairing_ticket(&format!("{TICKET_PREFIX}1")),
            "invalid base32",
        );
        assert_ticket_err(
            decode_cowork_pairing_ticket(&format!("{TICKET_PREFIX}abc def")),
            "invalid base32",
        );
        assert_ticket_err(
            decode_cowork_pairing_ticket(&format!(
                "{TICKET_PREFIX}{}",
                base32_encode_lower(&[0xff, 0xfe])
            )),
            "not valid UTF-8",
        );

        let mut extra = valid_value();
        extra["admin"] = json!(true);
        assert_ticket_err(
            decode_cowork_pairing_ticket(&encode_raw(&extra)),
            "Invalid pairing ticket JSON",
        );

        let mut scheme = valid_value();
        scheme["scheme"] = json!("H3");
        assert_ticket_err(
            decode_cowork_pairing_ticket(&encode_raw(&scheme)),
            "Invalid pairing ticket JSON",
        );

        let mut missing = valid_value();
        missing.as_object_mut().unwrap().remove("nonce");
        assert_ticket_err(
            decode_cowork_pairing_ticket(&encode_raw(&missing)),
            "Invalid pairing ticket JSON",
        );

        let mut bad_pin = valid_value();
        bad_pin["certSha256"] = json!("A".repeat(64));
        assert_ticket_err(
            decode_cowork_pairing_ticket(&encode_raw(&bad_pin)),
            "certSha256 must be 64 lowercase hex",
        );
    }

    #[test]
    fn verify_h3_pairing_nonce_rejects_expired_and_unequal_nonces() {
        let nonce = "n".repeat(32);
        let live = H3PairingSession {
            nonce: nonce.clone(),
            expires_at: Utc::now().timestamp_millis() + 60_000,
        };
        assert!(verify_h3_pairing_nonce(&live, &nonce));

        let mut same_length = nonce.clone();
        same_length.replace_range(31..32, "m");
        assert!(!verify_h3_pairing_nonce(&live, &same_length));
        assert!(!verify_h3_pairing_nonce(&live, &nonce[..31]));
        assert!(!verify_h3_pairing_nonce(&live, &format!("{nonce}n")));

        let expired = H3PairingSession {
            nonce: nonce.clone(),
            expires_at: Utc::now().timestamp_millis() - 1,
        };
        assert!(!verify_h3_pairing_nonce(&expired, &nonce));
    }
}
