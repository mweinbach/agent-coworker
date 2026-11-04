//! `/cowork/fs/open` and `/cowork/fs/reveal` directory responses are a navigable browser
//! (`renderDirectoryHtml` in the legacy `src/server/webDesktopRoutes.ts`): every entry links back
//! to `/cowork/fs/open` for that entry, an "Up one level" link appears only below the workspace
//! root, user-controlled names are HTML-escaped and paths URL-encoded, and following any link
//! re-runs the workspace confinement checks.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use cowork_server::http_fs::handle_fs_open;
use cowork_server::{ServerOptions, start_server};

/// A name exercising every character the renderer must escape or encode.
const TRICKY_NAME: &str = "a <b> \"c\" & d's \u{e9}\u{1F600}.txt";

fn root() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    (tmp, root)
}

fn query_for(path: &Path) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .append_pair("path", &path.to_string_lossy())
        .finish()
}

async fn open_query(
    workspace: &Path,
    query: &str,
    reveal: bool,
) -> Result<(String, String), (StatusCode, String)> {
    let resp = handle_fs_open(&[workspace.to_path_buf()], workspace, Some(query), reveal)
        .await
        .map_err(|err| (err.status, err.message))?;
    let content_type = resp.headers()["content-type"].to_str().unwrap().to_owned();
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    Ok((content_type, String::from_utf8_lossy(&body).into_owned()))
}

async fn open_listing(workspace: &Path, target: &Path, reveal: bool) -> String {
    let (content_type, body) = open_query(workspace, &query_for(target), reveal)
        .await
        .unwrap();
    assert_eq!(content_type, "text/html; charset=utf-8");
    body
}

fn html_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// Every `href` in `body`, HTML-unescaped, in document order.
fn hrefs(body: &str) -> Vec<String> {
    body.split("href=\"")
        .skip(1)
        .map(|rest| html_unescape(&rest[..rest.find('"').unwrap()]))
        .collect()
}

/// The `href` of the `<a>` whose class is `class` and whose markup contains `marker`.
fn link_href(body: &str, class: &str, marker: &str) -> Option<String> {
    let open_tag = format!("<a class=\"{class}\" href=\"");
    body.split(&open_tag).skip(1).find_map(|rest| {
        let anchor = &rest[..rest.find("</a>").unwrap()];
        anchor
            .contains(marker)
            .then(|| html_unescape(&anchor[..anchor.find('"').unwrap()]))
    })
}

/// The query string of an `/cowork/fs/open` link, which must be the only route links point at.
fn open_link_query(href: &str) -> &str {
    href.strip_prefix("/cowork/fs/open?")
        .unwrap_or_else(|| panic!("link must target /cowork/fs/open: {href}"))
}

fn link_path(href: &str) -> String {
    url::form_urlencoded::parse(open_link_query(href).as_bytes())
        .find(|(key, _)| key == "path")
        .map(|(_, value)| value.into_owned())
        .unwrap()
}

/// `<root>/workspace` with `docs/guide.md`, `docs/deeper/`, `notes.md`, `.env` and a file whose
/// name needs escaping, plus `<root>/secret.txt` outside the workspace.
fn sample_workspace() -> (tempfile::TempDir, PathBuf) {
    let (tmp, outer) = root();
    let workspace = outer.join("workspace");
    std::fs::create_dir_all(workspace.join("docs").join("deeper")).unwrap();
    std::fs::write(workspace.join("docs").join("guide.md"), "guide").unwrap();
    std::fs::write(workspace.join("notes.md"), "notes").unwrap();
    std::fs::write(workspace.join(".env"), "HIDDEN=1").unwrap();
    std::fs::write(workspace.join(TRICKY_NAME), "tricky").unwrap();
    std::fs::write(outer.join("secret.txt"), "top secret").unwrap();
    (tmp, workspace)
}

#[tokio::test]
async fn directory_listing_links_children_and_omits_parent_at_root() {
    let (_tmp, workspace) = sample_workspace();
    let body = open_listing(&workspace, &workspace, false).await;

    // Folders first, then files by case-insensitive name; hidden entries are listed and badged.
    let titles: Vec<&str> = body
        .split("<span class=\"entry-title\">")
        .skip(1)
        .map(|rest| &rest[..rest.find("</span>").unwrap()])
        .collect();
    assert_eq!(
        titles,
        [
            "docs",
            ".env",
            "a &lt;b&gt; &quot;c&quot; &amp; d&#39;s \u{e9}\u{1F600}.txt",
            "notes.md",
        ],
        "{body}"
    );
    assert!(
        body.contains("<span class=\"entry-meta\">Folder</span></a>"),
        "{body}"
    );
    assert!(
        body.contains("<span class=\"entry-meta\">File<span class=\"badge\">hidden</span></span>"),
        "{body}"
    );

    for (name, is_dir) in [("docs", true), ("notes.md", false), (".env", false)] {
        let href = link_href(&body, "entry-link", &format!(">{name}</span>"))
            .unwrap_or_else(|| panic!("no link for {name}: {body}"));
        assert_eq!(link_path(&href), workspace.join(name).to_string_lossy());
        assert_eq!(
            body.contains(&format!(">{name}</span><span class=\"entry-meta\">Folder")),
            is_dir
        );
    }

    // The workspace root has no "Up one level" link, and nothing links outside the root.
    assert!(!body.contains("class=\"parent-link\""), "{body}");
    assert!(!body.contains("Up one level"), "{body}");
    for href in hrefs(&body) {
        assert!(
            Path::new(&link_path(&href)).starts_with(&workspace),
            "{href}"
        );
    }

    let title = workspace.file_name().unwrap().to_string_lossy();
    assert!(body.contains(&format!("<title>{title}</title>")), "{body}");
    assert!(
        body.contains(&format!(
            "<p class=\"path\">{}</p>",
            workspace.to_string_lossy()
        )),
        "{body}"
    );
}

#[tokio::test]
async fn subdirectory_listing_links_back_to_its_parent_inside_the_root() {
    let (_tmp, workspace) = sample_workspace();
    let docs = workspace.join("docs");
    let body = open_listing(&workspace, &docs, false).await;

    let parent = link_href(&body, "parent-link", "Up one level").expect("parent link");
    assert_eq!(link_path(&parent), workspace.to_string_lossy());
    let guide = link_href(&body, "entry-link", ">guide.md</span>").unwrap();
    assert_eq!(link_path(&guide), docs.join("guide.md").to_string_lossy());
    let deeper = link_href(&body, "entry-link", ">deeper</span>").unwrap();
    assert_eq!(link_path(&deeper), docs.join("deeper").to_string_lossy());

    // Following the parent link lands back on the root listing, which has no parent link.
    let (_, root_body) = open_query(&workspace, open_link_query(&parent), false)
        .await
        .unwrap();
    assert!(root_body.contains(">docs</span>"), "{root_body}");
    assert!(!root_body.contains("class=\"parent-link\""), "{root_body}");

    // Two levels down, the parent link points one level up, still inside the root.
    let (_, deeper_body) = open_query(&workspace, open_link_query(&deeper), false)
        .await
        .unwrap();
    assert!(
        deeper_body.contains("<div class=\"empty\">This directory is empty.</div>"),
        "{deeper_body}"
    );
    let up = link_href(&deeper_body, "parent-link", "Up one level").unwrap();
    assert_eq!(link_path(&up), docs.to_string_lossy());

    // Revealing a file renders its directory with the same navigation.
    let revealed = open_listing(&workspace, &docs.join("guide.md"), true).await;
    let parent = link_href(&revealed, "parent-link", "Up one level").unwrap();
    assert_eq!(link_path(&parent), workspace.to_string_lossy());
    let at_root = open_listing(&workspace, &workspace.join("notes.md"), true).await;
    assert!(!at_root.contains("class=\"parent-link\""), "{at_root}");
}

#[tokio::test]
async fn special_characters_in_names_are_escaped_and_encoded() {
    let (_tmp, workspace) = sample_workspace();
    let dir = workspace.join("odd <dir> \"&\" \u{e9}");
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join(TRICKY_NAME), "tricky inside").unwrap();
    let body = open_listing(&workspace, &dir, false).await;

    // No raw markup from a name ever reaches the page.
    assert!(!body.contains("<b>"), "{body}");
    assert!(!body.contains("<dir>"), "{body}");
    assert!(!body.contains("\"c\""), "{body}");
    let escaped_dir = "odd &lt;dir&gt; &quot;&amp;&quot; \u{e9}";
    assert!(
        body.contains(&format!("<title>{escaped_dir}</title>")),
        "{body}"
    );
    assert!(body.contains(&format!("<h1>{escaped_dir}</h1>")), "{body}");
    assert!(
        body.contains(&format!(
            "<p class=\"path\">{}/{escaped_dir}</p>",
            workspace.to_string_lossy()
        )),
        "{body}"
    );
    assert!(
        body.contains(
            "<span class=\"entry-title\">a &lt;b&gt; &quot;c&quot; &amp; d&#39;s \u{e9}\u{1F600}.txt</span>"
        ),
        "{body}"
    );

    // The raw href is percent-encoded like `encodeURIComponent`, so it holds no quote, space,
    // angle bracket, ampersand or non-ASCII byte that could break out of the attribute.
    let raw_hrefs: Vec<&str> = body
        .split("href=\"")
        .skip(1)
        .map(|rest| &rest[..rest.find('"').unwrap()])
        .collect();
    assert_eq!(raw_hrefs.len(), 2, "{body}");
    for raw in &raw_hrefs {
        // `'` is the one `encodeURIComponent`-safe character that is HTML-escaped as well.
        let encoded = raw
            .strip_prefix("/cowork/fs/open?path=")
            .unwrap()
            .replace("&#39;", "'");
        assert!(
            encoded
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"%-_.!~*'()".contains(&b)),
            "{raw}"
        );
    }
    let file_href = link_href(&body, "entry-link", "d&#39;s").unwrap();
    assert!(
        file_href.ends_with("a%20%3Cb%3E%20%22c%22%20%26%20d's%20%C3%A9%F0%9F%98%80.txt"),
        "{file_href}"
    );
    assert!(
        file_href.contains("odd%20%3Cdir%3E%20%22%26%22%20%C3%A9%2F"),
        "{file_href}"
    );

    // Following the encoded links returns the exact file and the parent directory.
    let (content_type, contents) = open_query(&workspace, open_link_query(&file_href), false)
        .await
        .unwrap();
    assert_eq!(content_type, "text/plain; charset=utf-8");
    assert_eq!(contents, "tricky inside");
    let parent = link_href(&body, "parent-link", "Up one level").unwrap();
    let (_, parent_body) = open_query(&workspace, open_link_query(&parent), false)
        .await
        .unwrap();
    assert!(parent_body.contains(escaped_dir), "{parent_body}");
}

#[tokio::test]
async fn crafted_links_outside_the_root_are_rejected() {
    let (_tmp, workspace) = sample_workspace();
    let outer = workspace.parent().unwrap();
    for reveal in [false, true] {
        for target in [
            outer.to_path_buf(),
            outer.join("secret.txt"),
            workspace.join(".."),
            workspace.join("docs/../../secret.txt"),
        ] {
            let query = query_for(&target);
            let (status, _) = open_query(&workspace, &query, reveal).await.unwrap_err();
            assert_eq!(status, StatusCode::FORBIDDEN, "{}", target.display());
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn listed_symlink_to_outside_stays_confined_when_followed() {
    let (_tmp, workspace) = sample_workspace();
    let outer = workspace.parent().unwrap().to_path_buf();
    std::os::unix::fs::symlink(&outer, workspace.join("escape")).unwrap();
    std::os::unix::fs::symlink(outer.join("secret.txt"), workspace.join("secret-link")).unwrap();

    let body = open_listing(&workspace, &workspace, false).await;
    for name in ["escape", "secret-link"] {
        let href = link_href(&body, "entry-link", &format!(">{name}</span>")).unwrap();
        let (status, _) = open_query(&workspace, open_link_query(&href), false)
            .await
            .unwrap_err();
        assert_eq!(status, StatusCode::FORBIDDEN, "{name}");
    }
}

#[tokio::test]
async fn directory_links_do_not_echo_the_browser_access_token() {
    let (_tmp, workspace) = sample_workspace();
    let query = format!(
        "{}&coworkBrowserToken=secret-token-value",
        query_for(&workspace.join("docs"))
    );
    let (_, body) = open_query(&workspace, &query, false).await.unwrap();
    assert!(!body.contains("secret-token-value"), "{body}");
    assert!(!body.contains("coworkBrowserToken"), "{body}");
    for href in hrefs(&body) {
        assert!(!open_link_query(&href).contains('&'), "{href}");
    }
}

#[tokio::test]
async fn directory_links_navigate_over_http() {
    let (_tmp, base) = root();
    let home = base.join("home");
    let userdata = base.join("userdata");
    let workspace = base.join("workspace");
    for dir in [&home, &userdata, &workspace.join("docs")] {
        std::fs::create_dir_all(dir).unwrap();
    }
    std::fs::write(workspace.join("docs").join(TRICKY_NAME), "over http").unwrap();
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
    let origin = format!("http://127.0.0.1:{}", handle.port());
    let client = reqwest::Client::new();
    let get = |href: String| {
        let client = client.clone();
        let url = format!("{origin}{href}");
        async move { client.get(url).send().await.unwrap() }
    };

    let root_page = get(format!("/cowork/fs/open?{}", query_for(&workspace)))
        .await
        .text()
        .await
        .unwrap();
    assert!(!root_page.contains("class=\"parent-link\""), "{root_page}");
    let docs_href = link_href(&root_page, "entry-link", ">docs</span>").unwrap();
    let docs_page = get(docs_href).await.text().await.unwrap();
    let file_href = link_href(&docs_page, "entry-link", "d&#39;s").unwrap();
    let file = get(file_href).await;
    assert_eq!(file.status(), 200);
    assert_eq!(file.text().await.unwrap(), "over http");
    let parent_href = link_href(&docs_page, "parent-link", "Up one level").unwrap();
    let parent_page = get(parent_href).await.text().await.unwrap();
    assert!(parent_page.contains(">docs</span>"), "{parent_page}");

    let escape = get(format!(
        "/cowork/fs/open?{}",
        query_for(&workspace.join(".."))
    ))
    .await;
    assert_eq!(escape.status(), 403);

    handle.shutdown().await;
}
