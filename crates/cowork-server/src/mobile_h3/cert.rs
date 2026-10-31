use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, TimeZone, Utc};
use cowork_config::{ensure_private_dir_sync, write_text_file_atomic};
use data_encoding::{BASE64, BASE64URL_NOPAD};
use rcgen::{
    CertificateParams, DnType, IsCa, KeyPair, KeyUsagePurpose, PKCS_ECDSA_P256_SHA256, SerialNumber,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

const CERT_COMMON_NAME: &str = "Cowork Mobile Pairing";
const MOBILE_PAIRING_DIRNAME: &str = "mobile-pairing";
const TLS_CERT_FILE_NAME: &str = "tls-cert.pem";
const TLS_KEY_FILE_NAME: &str = "tls-key.pem";
const LISTENER_CONFIG_FILE_NAME: &str = "listener.json";

pub const CERT_RENEWAL_BUFFER_MS: i64 = 5 * 60 * 1000;
pub const PERSISTED_CERT_LIFETIME_MS: i64 = 365 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertFingerprint {
    pub cert_der_base64: String,
    pub cert_sha256: String,
    pub spki_sha256: String,
    pub identity_pub: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EphemeralQuicCertificate {
    pub cert_pem: String,
    pub key_pem: String,
    pub cert_der_base64: String,
    pub cert_sha256: String,
    pub spki_sha256: String,
    pub identity_pub: String,
    pub not_before: String,
    pub not_after: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct H3ListenerConfig {
    version: u8,
    port: u16,
}

pub fn resolve_h3_pairing_store_dir(store_root: &Path) -> PathBuf {
    store_root.join(MOBILE_PAIRING_DIRNAME)
}

pub fn fingerprint_x509_der(der: &[u8]) -> anyhow::Result<CertFingerprint> {
    let (_, parsed) = x509_parser::parse_x509_certificate(der)
        .map_err(|e| anyhow::anyhow!("Invalid X.509 certificate DER: {e}"))?;
    let spki_der = parsed.public_key().raw;
    let cert_der_base64 = BASE64.encode(der);
    let cert_sha256 = hex::encode(Sha256::digest(der));
    let spki_sha256 = BASE64URL_NOPAD.encode(&Sha256::digest(spki_der));
    let identity_pub = BASE64URL_NOPAD.encode(spki_der);
    Ok(CertFingerprint {
        cert_der_base64,
        cert_sha256,
        spki_sha256,
        identity_pub,
    })
}

fn format_epoch_millis_iso(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn create_ephemeral_quic_certificate(
    now_ms: i64,
    lifetime_ms: i64,
) -> anyhow::Result<EphemeralQuicCertificate> {
    let key_pair = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)?;
    let mut params = CertificateParams::new(Vec::<String>::new())?;
    params
        .distinguished_name
        .push(DnType::CommonName, CERT_COMMON_NAME);

    let mut serial = [0u8; 16];
    rand::fill(&mut serial);
    // Keep top bit clear so ASN.1 INTEGER is positive and compact.
    serial[0] &= 0x7f;
    serial[0] |= 0x01;
    params.serial_number = Some(SerialNumber::from_slice(&serial));

    let not_before_sec = now_ms.div_euclid(1000);
    let end_ms = now_ms.saturating_add(lifetime_ms.max(1000));
    let not_after_sec = end_ms.div_euclid(1000);
    params.not_before = OffsetDateTime::from_unix_timestamp(not_before_sec)?;
    params.not_after = OffsetDateTime::from_unix_timestamp(not_after_sec)?;
    params.is_ca = IsCa::ExplicitNoCa;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.use_authority_key_identifier_extension = false;

    let cert = params.self_signed(&key_pair)?;
    let cert_der = cert.der().as_ref();
    let fp = fingerprint_x509_der(cert_der)?;

    Ok(EphemeralQuicCertificate {
        cert_pem: cert.pem(),
        key_pem: key_pair.serialize_pem(),
        cert_der_base64: fp.cert_der_base64,
        cert_sha256: fp.cert_sha256,
        spki_sha256: fp.spki_sha256,
        identity_pub: fp.identity_pub,
        not_before: format_epoch_millis_iso(not_before_sec * 1000),
        not_after: format_epoch_millis_iso(not_after_sec * 1000),
    })
}

pub fn certificate_from_pem(
    cert_pem: &str,
    key_pem: &str,
) -> anyhow::Result<EphemeralQuicCertificate> {
    let mut certs = CertificateDer::pem_slice_iter(cert_pem.as_bytes());
    let first_cert = certs
        .next()
        .ok_or_else(|| anyhow::anyhow!("Certificate PEM contained no CERTIFICATE block"))?
        .map_err(|e| anyhow::anyhow!("Invalid certificate PEM: {e}"))?;
    let _private_key = PrivateKeyDer::from_pem_slice(key_pem.as_bytes())
        .map_err(|e| anyhow::anyhow!("Invalid private key PEM: {e}"))?;

    let (_, parsed) = x509_parser::parse_x509_certificate(first_cert.as_ref())
        .map_err(|e| anyhow::anyhow!("Invalid X.509 certificate: {e}"))?;
    let fp = fingerprint_x509_der(first_cert.as_ref())?;
    let not_before_ms = parsed.validity().not_before.timestamp() * 1000;
    let not_after_ms = parsed.validity().not_after.timestamp() * 1000;

    Ok(EphemeralQuicCertificate {
        cert_pem: cert_pem.to_owned(),
        key_pem: key_pem.to_owned(),
        cert_der_base64: fp.cert_der_base64,
        cert_sha256: fp.cert_sha256,
        spki_sha256: fp.spki_sha256,
        identity_pub: fp.identity_pub,
        not_before: format_epoch_millis_iso(not_before_ms),
        not_after: format_epoch_millis_iso(not_after_ms),
    })
}

pub fn is_certificate_usable(cert: &EphemeralQuicCertificate, now_ms: i64) -> bool {
    let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(&cert.not_after) else {
        return false;
    };
    parsed.timestamp_millis().saturating_sub(now_ms) > CERT_RENEWAL_BUFFER_MS
}

pub fn clear_persisted_h3_listener_identity(store_root: &Path) {
    let dir = resolve_h3_pairing_store_dir(store_root);
    let _ = std::fs::remove_file(dir.join(TLS_CERT_FILE_NAME));
    let _ = std::fs::remove_file(dir.join(TLS_KEY_FILE_NAME));
}

pub fn load_or_create_persisted_quic_certificate(
    store_root: &Path,
    force_rotate: bool,
) -> anyhow::Result<EphemeralQuicCertificate> {
    let dir = resolve_h3_pairing_store_dir(store_root);
    let cert_path = dir.join(TLS_CERT_FILE_NAME);
    let key_path = dir.join(TLS_KEY_FILE_NAME);
    let now_ms = Utc::now().timestamp_millis();

    if force_rotate {
        clear_persisted_h3_listener_identity(store_root);
    } else if let (Ok(cert_pem), Ok(key_pem)) = (
        std::fs::read_to_string(&cert_path),
        std::fs::read_to_string(&key_path),
    ) && let Ok(existing) = certificate_from_pem(&cert_pem, &key_pem)
        && is_certificate_usable(&existing, now_ms)
    {
        return Ok(existing);
    }

    let cert = create_ephemeral_quic_certificate(now_ms, PERSISTED_CERT_LIFETIME_MS)?;
    ensure_private_dir_sync(&dir)?;
    write_text_file_atomic(&cert_path, &cert.cert_pem, Some(0o600))?;
    write_text_file_atomic(&key_path, &cert.key_pem, Some(0o600))?;
    Ok(cert)
}

pub fn resolve_persisted_h3_port(store_root: &Path, requested_port: Option<u16>) -> u16 {
    if let Some(p) = requested_port
        && p > 0
    {
        return p;
    }
    let path = resolve_h3_pairing_store_dir(store_root).join(LISTENER_CONFIG_FILE_NAME);
    let Ok(raw) = std::fs::read_to_string(path) else {
        return 0;
    };
    let Ok(cfg) = serde_json::from_str::<H3ListenerConfig>(&raw) else {
        return 0;
    };
    if cfg.version == 1 { cfg.port } else { 0 }
}

pub fn persist_h3_listener_port(store_root: &Path, port: u16) -> anyhow::Result<()> {
    if port == 0 {
        return Ok(());
    }
    let dir = resolve_h3_pairing_store_dir(store_root);
    ensure_private_dir_sync(&dir)?;
    let path = dir.join(LISTENER_CONFIG_FILE_NAME);
    let payload = serde_json::to_string_pretty(&H3ListenerConfig { version: 1, port })?;
    write_text_file_atomic(&path, &payload, Some(0o600))?;
    Ok(())
}
