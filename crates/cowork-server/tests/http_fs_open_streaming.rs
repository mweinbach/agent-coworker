//! `/cowork/fs/open` streams file bodies instead of buffering them (legacy `handleOpenPathRequest`
//! in `src/server/webDesktopRoutes.ts` returned a `Bun.file` body), while keeping the workspace
//! confinement checks and response headers. The `/cowork/fs/*` read routes also re-validate the
//! real path of the opened handle, so a workspace directory swapped for a symlink after the
//! containment check cannot leak a file outside the roots (`openAuthorizedFile`).

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use axum::body::{Body, HttpBody};
use axum::http::{Response, StatusCode, header};
use cowork_server::http_fs::{
    handle_fs_open, handle_fs_preview, handle_fs_read, open_confined_regular_file,
};
use cowork_server::{ServerOptions, start_server};
use futures_util::StreamExt;

const LARGE_FILE_BYTES: u64 = 50 * 1024 * 1024;
/// Upper bound on one streamed chunk; a buffered body would arrive as one 50 MB frame.
const MAX_EXPECTED_CHUNK_BYTES: usize = 1024 * 1024;

fn root() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    (tmp, root)
}

/// A sparse 50 MB file with distinct markers at the start, middle and end, so a byte-exact
/// comparison catches offset or truncation bugs without writing 50 MB to disk.
fn write_large_sparse_file(path: &Path) {
    let mut file = std::fs::File::create(path).unwrap();
    file.set_len(LARGE_FILE_BYTES).unwrap();
    for (offset, marker) in [
        (0, b"START-MARKER".as_slice()),
        (LARGE_FILE_BYTES / 2 + 7, b"MIDDLE-MARKER".as_slice()),
        (LARGE_FILE_BYTES - 10, b"END-MARKER".as_slice()),
    ] {
        file.seek(SeekFrom::Start(offset)).unwrap();
        file.write_all(marker).unwrap();
    }
    assert_eq!(file.metadata().unwrap().len(), LARGE_FILE_BYTES);
}

fn query_for(path: &Path) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .append_pair("path", &path.to_string_lossy())
        .finish()
}

async fn open(
    root: &Path,
    target: &Path,
    reveal_parent_if_file: bool,
) -> Result<Response<Body>, (StatusCode, String)> {
    let query = query_for(target);
    handle_fs_open(
        &[root.to_path_buf()],
        root,
        Some(&query),
        reveal_parent_if_file,
    )
    .await
    .map_err(|err| (err.status, err.message))
}

/// Compares a streamed body chunk-by-chunk against the file on disk, returning the chunk count.
async fn assert_stream_matches_file<S, E>(mut stream: S, path: &Path) -> usize
where
    S: futures_util::Stream<Item = Result<bytes::Bytes, E>> + Unpin,
    E: std::fmt::Debug,
{
    let mut expected = std::fs::File::open(path).unwrap();
    let mut chunks = 0usize;
    let mut total = 0u64;
    let mut expected_buf = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.expect("body chunk");
        assert!(
            chunk.len() <= MAX_EXPECTED_CHUNK_BYTES,
            "chunk of {} bytes suggests the body was buffered",
            chunk.len()
        );
        expected_buf.resize(chunk.len(), 0);
        expected.read_exact(&mut expected_buf).unwrap();
        assert!(
            chunk.as_ref() == expected_buf.as_slice(),
            "bytes differ in the chunk starting at offset {total}"
        );
        total += chunk.len() as u64;
        chunks += 1;
    }
    assert_eq!(total, LARGE_FILE_BYTES);
    assert_eq!(expected.read(&mut [0u8; 1]).unwrap(), 0, "body ended early");
    chunks
}

#[tokio::test]
async fn fs_open_streams_large_file_with_exact_length_and_bytes() {
    let (_tmp, root) = root();
    let file = root.join("artifact.bin");
    write_large_sparse_file(&file);

    let resp = open(&root, &file, false).await.expect("open large file");
    assert_eq!(resp.status(), StatusCode::OK);
    let headers = resp.headers();
    assert_eq!(
        headers[header::CONTENT_LENGTH],
        LARGE_FILE_BYTES.to_string().as_str()
    );
    assert_eq!(headers[header::CONTENT_TYPE], "application/octet-stream");
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(
        headers[header::CONTENT_DISPOSITION],
        "inline; filename*=UTF-8''artifact.bin"
    );
    // A buffered body knows its exact size up front; a streamed one does not.
    assert_eq!(resp.body().size_hint().exact(), None);

    let chunks = assert_stream_matches_file(resp.into_body().into_data_stream(), &file).await;
    assert!(chunks > 1, "a 50 MB file should arrive in many chunks");
}

#[tokio::test]
async fn fs_open_response_starts_before_the_file_is_read() {
    let (_tmp, root) = root();
    let file = root.join("artifact.bin");
    write_large_sparse_file(&file);

    let resp = open(&root, &file, false).await.expect("open large file");
    let mut stream = resp.into_body().into_data_stream();
    let first = stream.next().await.expect("first chunk").expect("chunk ok");
    assert!(!first.is_empty());
    assert!(first.len() <= MAX_EXPECTED_CHUNK_BYTES);
    assert!(first.starts_with(b"START-MARKER"));

    // The rest is read on demand: truncating the file now cuts the stream short instead of
    // the bytes already sitting in memory.
    std::fs::OpenOptions::new()
        .write(true)
        .open(&file)
        .unwrap()
        .set_len(first.len() as u64)
        .unwrap();
    let mut rest = 0usize;
    while let Some(chunk) = stream.next().await {
        rest += chunk.expect("chunk ok").len();
    }
    assert!(
        (rest as u64) < LARGE_FILE_BYTES - first.len() as u64,
        "the remaining {rest} bytes were already buffered"
    );
}

#[tokio::test]
async fn fs_open_keeps_mime_disposition_and_directory_listing() {
    let (_tmp, root) = root();
    std::fs::write(root.join("page.html"), "<p>hi</p>").unwrap();
    std::fs::write(root.join("notes.md"), "# notes").unwrap();

    let html = open(&root, &root.join("page.html"), false).await.unwrap();
    assert_eq!(
        html.headers()[header::CONTENT_TYPE],
        "text/html; charset=utf-8"
    );
    assert_eq!(html.headers()[header::CONTENT_LENGTH], "9");
    assert_eq!(
        html.headers()[header::CONTENT_DISPOSITION],
        "attachment; filename*=UTF-8''page.html"
    );
    let body = axum::body::to_bytes(html.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(body.as_ref(), b"<p>hi</p>");

    let empty_path = root.join("empty.txt");
    std::fs::write(&empty_path, "").unwrap();
    let empty = open(&root, &empty_path, false).await.unwrap();
    assert_eq!(empty.headers()[header::CONTENT_LENGTH], "0");
    let body = axum::body::to_bytes(empty.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(body.is_empty());

    for (target, reveal) in [(root.clone(), false), (root.join("notes.md"), true)] {
        let listing = open(&root, &target, reveal).await.unwrap();
        assert_eq!(listing.status(), StatusCode::OK);
        assert_eq!(
            listing.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
        let body = axum::body::to_bytes(listing.into_body(), usize::MAX)
            .await
            .unwrap();
        let body = String::from_utf8(body.to_vec()).unwrap();
        assert!(
            body.contains("<span class=\"entry-title\">notes.md</span>"),
            "{body}"
        );
        assert!(
            body.contains("<span class=\"entry-title\">page.html</span>"),
            "{body}"
        );
    }
}

#[tokio::test]
async fn fs_open_rejects_paths_outside_the_workspace() {
    let (_outer_tmp, outer) = root();
    let workspace = outer.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let secret = outer.join("secret.txt");
    std::fs::write(&secret, "top secret").unwrap();

    for reveal in [false, true] {
        let (status, _) = open(&workspace, &secret, reveal).await.unwrap_err();
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = open(&workspace, &workspace.join("../secret.txt"), reveal)
            .await
            .unwrap_err();
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    let (status, _) = open(&workspace, &workspace.join("missing.bin"), false)
        .await
        .unwrap_err();
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, message) =
        handle_fs_open(std::slice::from_ref(&workspace), &workspace, None, false)
            .await
            .map_err(|err| (err.status, err.message))
            .unwrap_err();
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(message, "Missing path parameter");
}

#[cfg(unix)]
#[tokio::test]
async fn fs_open_rejects_symlink_escapes_and_non_regular_files() {
    let (_outer_tmp, outer) = root();
    let workspace = outer.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let secret = outer.join("secret.txt");
    std::fs::write(&secret, "top secret").unwrap();
    let escape_link = workspace.join("escape-link.txt");
    std::os::unix::fs::symlink(&secret, &escape_link).unwrap();
    let escape_dir = workspace.join("escape-dir");
    std::os::unix::fs::symlink(&outer, &escape_dir).unwrap();

    for target in [&escape_link, &escape_dir.join("secret.txt")] {
        let (status, _) = open(&workspace, target, false).await.unwrap_err();
        assert_eq!(status, StatusCode::FORBIDDEN, "{}", target.display());
    }

    // An in-workspace symlink to an in-workspace file still opens its target.
    std::fs::write(workspace.join("real.txt"), "inside").unwrap();
    let inner_link = workspace.join("inner-link.txt");
    std::os::unix::fs::symlink(workspace.join("real.txt"), &inner_link).unwrap();
    let resp = open(&workspace, &inner_link, false).await.unwrap();
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(body.as_ref(), b"inside");

    // A FIFO would block the open (and a device would never end); both are refused up front.
    let fifo = workspace.join("pipe");
    let c_path = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    let (status, message) = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        open(&workspace, &fifo, false),
    )
    .await
    .expect("opening a FIFO must not hang")
    .unwrap_err();
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(message, "Path is not a regular file");
}

#[tokio::test]
async fn fs_open_route_streams_large_file_over_http() {
    let (_tmp, base) = root();
    let home = base.join("home");
    let userdata = base.join("userdata");
    let workspace = base.join("workspace");
    for dir in [&home, &userdata, &workspace] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let mut env = HashMap::new();
    for key in ["HOME", "COWORK_HOME_OVERRIDE"] {
        env.insert(key.to_owned(), home.to_string_lossy().into_owned());
    }
    for key in [
        "COWORK_ELECTRON_USER_DATA_DIR",
        "COWORK_DESKTOP_USER_DATA_DIR",
    ] {
        env.insert(key.to_owned(), userdata.to_string_lossy().into_owned());
    }
    env.insert("COWORK_DISABLE_RUNTIME".into(), "1".into());
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".into(), "0".into());
    let handle = start_server(ServerOptions {
        working_directory: workspace.clone(),
        host: "127.0.0.1".into(),
        port: 0,
        yolo: false,
        mobile_h3: false,
        mobile_h3_host: "127.0.0.1".into(),
        mobile_h3_port: 0,
        homedir: Some(home.clone()),
        built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
        env,
    })
    .await
    .unwrap();
    let url = |route: &str, path: &Path| {
        format!(
            "http://127.0.0.1:{}/cowork/fs/{route}?{}",
            handle.port(),
            query_for(path)
        )
    };
    let client = reqwest::Client::new();

    let file = workspace.join("artifact.bin");
    write_large_sparse_file(&file);
    let resp = client.get(url("open", &file)).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.content_length(), Some(LARGE_FILE_BYTES));
    assert_eq!(resp.headers()["cache-control"], "no-store");
    assert_eq!(resp.headers()["x-content-type-options"], "nosniff");
    assert_stream_matches_file(resp.bytes_stream(), &file).await;

    let secret = base.join("secret.txt");
    std::fs::write(&secret, "top secret").unwrap();
    for route in ["open", "reveal"] {
        let denied = client.get(url(route, &secret)).send().await.unwrap();
        assert_eq!(denied.status(), 403, "{route}");
        let traversal = client
            .get(url(route, &workspace.join("../secret.txt")))
            .send()
            .await
            .unwrap();
        assert_eq!(traversal.status(), 403, "{route}");
    }

    let reveal = client.get(url("reveal", &file)).send().await.unwrap();
    assert_eq!(reveal.status(), 200);
    assert!(
        reveal
            .text()
            .await
            .unwrap()
            .contains("<span class=\"entry-title\">artifact.bin</span>")
    );

    handle.shutdown().await;
}

/// Builds `<outer>/workspace` plus `<outer>/workspace-outside/data.txt` ("SECRET"), a sibling
/// whose name shares the workspace's prefix, and `workspace/linked` -> that sibling.
#[cfg(unix)]
fn workspace_with_symlinked_dir() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let (tmp, outer) = root();
    let workspace = outer.join("workspace");
    let outside = outer.join("workspace-outside");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("data.txt"), "SECRET").unwrap();
    std::os::unix::fs::symlink(&outside, workspace.join("linked")).unwrap();
    (tmp, workspace, outside)
}

#[cfg(unix)]
#[test]
fn confined_open_rejects_handle_reached_through_swapped_directory() {
    let (_tmp, workspace, _outside) = workspace_with_symlinked_dir();
    // The path a containment check would have accepted before `linked` became a symlink.
    let swapped = workspace.join("linked").join("data.txt");
    let err = open_confined_regular_file(std::slice::from_ref(&workspace), &swapped).unwrap_err();
    assert_eq!(err.status, StatusCode::FORBIDDEN, "{}", err.message);

    std::fs::write(workspace.join("inside.txt"), "inside").unwrap();
    let mut opened = open_confined_regular_file(
        std::slice::from_ref(&workspace),
        &workspace.join("inside.txt"),
    )
    .expect("in-root file opens");
    let mut text = String::new();
    opened.file.read_to_string(&mut text).unwrap();
    assert_eq!(text, "inside");
    assert_eq!(opened.fstat.len(), 6);
}

#[cfg(unix)]
#[tokio::test]
async fn fs_read_routes_deny_intermediate_directory_symlink_outside_roots() {
    let (_tmp, workspace, _outside) = workspace_with_symlinked_dir();
    let target = workspace.join("linked").join("data.txt");
    let query = query_for(&target);
    let roots = [workspace.clone()];

    let read = handle_fs_read(&roots, &workspace, Some(&query)).unwrap_err();
    assert_eq!(read.status, StatusCode::FORBIDDEN);
    let preview = handle_fs_preview(&roots, &workspace, Some(&query)).unwrap_err();
    assert_eq!(preview.status, StatusCode::FORBIDDEN);
    let (status, _) = open(&workspace, &target, false).await.unwrap_err();
    assert_eq!(status, StatusCode::FORBIDDEN);
}

/// Races the read routes against a directory that keeps flipping between a real in-workspace
/// directory and a symlink to outside the roots. Whatever interleaving happens, no route may
/// ever return the outside file's bytes.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fs_read_routes_never_leak_through_a_directory_swapped_mid_request() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    let (_tmp, outer) = root();
    let workspace = outer.join("workspace");
    let outside = outer.join("outside");
    std::fs::create_dir_all(workspace.join("dir")).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(workspace.join("dir").join("data.txt"), "inside").unwrap();
    std::fs::write(outside.join("data.txt"), "SECRET").unwrap();

    let stop = Arc::new(AtomicBool::new(false));
    let swapper = {
        let (stop, workspace, outside) = (stop.clone(), workspace.clone(), outside.clone());
        std::thread::spawn(move || {
            let (dir, parked) = (workspace.join("dir"), workspace.join("dir-parked"));
            while !stop.load(Ordering::Relaxed) {
                std::fs::rename(&dir, &parked).unwrap();
                std::os::unix::fs::symlink(&outside, &dir).unwrap();
                std::thread::yield_now();
                std::fs::remove_file(&dir).unwrap();
                std::fs::rename(&parked, &dir).unwrap();
                std::thread::yield_now();
            }
        })
    };

    let target = workspace.join("dir").join("data.txt");
    let query = query_for(&target);
    let roots = [workspace.clone()];
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
    let mut served = 0usize;
    while std::time::Instant::now() < deadline {
        if let Ok(resp) = handle_fs_read(&roots, &workspace, Some(&query)) {
            let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .unwrap();
            assert!(!body.windows(6).any(|w| w == b"SECRET"), "fs/read leaked");
            served += 1;
        }
        if let Ok(resp) = handle_fs_preview(&roots, &workspace, Some(&query)) {
            let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .unwrap();
            assert_ne!(body.as_ref(), b"SECRET", "fs/preview leaked");
            served += 1;
        }
        if let Ok(resp) = open(&workspace, &target, false).await {
            let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .unwrap();
            assert_ne!(body.as_ref(), b"SECRET", "fs/open leaked");
            served += 1;
        }
    }
    stop.store(true, Ordering::Relaxed);
    swapper.join().unwrap();
    assert!(
        served > 0,
        "no request was ever served while the directory was in place"
    );
}
