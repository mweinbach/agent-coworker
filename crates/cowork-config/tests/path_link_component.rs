//! `path_has_link_component` mirrors Node's JS `realpathSync` aliasing rules: only symbolic
//! links (and Windows junctions/reparse points) make a path non-canonical.

use cowork_config::path_has_link_component;

#[test]
fn plain_directories_have_no_link_component() {
    let tmp = tempfile::tempdir().unwrap();
    let nested = tmp.path().join("a").join("b");
    std::fs::create_dir_all(&nested).unwrap();
    assert!(!path_has_link_component(&nested));
    // Missing tail components are not links either.
    assert!(!path_has_link_component(&nested.join("missing")));
}

#[cfg(unix)]
#[test]
fn symlinked_ancestor_is_a_link_component() {
    let tmp = tempfile::tempdir().unwrap();
    let real = tmp.path().join("real");
    std::fs::create_dir_all(real.join("inner")).unwrap();
    let link = tmp.path().join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    assert!(path_has_link_component(&link));
    assert!(path_has_link_component(&link.join("inner")));
    assert!(!path_has_link_component(&real.join("inner")));
}
