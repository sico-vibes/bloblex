// Project icons (Gogo's lane): the icon a project stores, and the favicon inside its own folder.
// Included into `phase2a_tests` so it shares that module's fixtures: `state`, `real_project`,
// `dispatch`, `json!`, `PathBuf`, `Uuid` and `Value`.

/// A project whose icon is set, over `real_project`'s fixture.
async fn with_icon(st: &AppState, name: &str, icon: Value) -> (String, PathBuf) {
    let (id, dir) = real_project(st, name);
    dispatch(st, "project.icon.set", json!({"projectId":id,"icon":icon})).await.unwrap();
    (id, dir)
}

#[tokio::test]
async fn a_project_icon_is_set_cleared_and_validated() {
    let (st, mut events) = state();
    let (id, _) = real_project(&st, "Icon");
    while events.try_recv().is_ok() {}
    // No icon yet: the DTO keeps the five usual keys, so an existing save compares equal.
    assert!(st.db.project_get(&id).unwrap()["overrides"].get("icon").is_none());
    let set = dispatch(&st, "project.icon.set", json!({"projectId":id,"icon":{"kind":"emoji","value":"🚀","color":"#FF8800"}})).await.unwrap();
    assert_eq!(set["project"]["overrides"]["icon"], json!({"kind":"emoji","value":"🚀","color":"#ff8800"}), "the colour is stored in lower case");
    assert_eq!(set["project"]["id"], id.as_str());
    // The same event `project.update` emits, carrying the icon, so a window refreshes.
    let event = events.recv().await.unwrap();
    assert_eq!((event.event_type.as_str(), event.payload["action"].as_str()), ("project.changed", Some("updated")));
    assert_eq!(event.payload["project"]["overrides"]["icon"], json!({"kind":"emoji","value":"🚀","color":"#ff8800"}));
    assert_eq!(st.db.project_get(&id).unwrap()["overrides"]["icon"]["value"], "🚀");
    // A lucide name without a colour reads as null, and only a favicon may leave the value empty.
    assert_eq!(dispatch(&st, "project.icon.set", json!({"projectId":id,"icon":{"kind":"lucide","value":"rocket"}})).await.unwrap()["project"]["overrides"]["icon"], json!({"kind":"lucide","value":"rocket","color":null}));
    assert_eq!(dispatch(&st, "project.icon.set", json!({"projectId":id,"icon":{"kind":"favicon","value":"","color":null}})).await.unwrap()["project"]["overrides"]["icon"]["kind"], "favicon");
    // 40 characters is the limit; the 41st is refused.
    assert_eq!(dispatch(&st, "project.icon.set", json!({"projectId":id,"icon":{"kind":"lucide","value":"a".repeat(40)}})).await.unwrap()["project"]["overrides"]["icon"]["value"].as_str().unwrap().len(), 40);
    for bad in [
        json!({"kind":"png","value":"x"}),
        json!({"kind":"emoji"}),
        json!({"kind":"emoji","value":""}),
        json!({"kind":"lucide","value":""}),
        json!({"kind":"emoji","value":"a\nb"}),
        json!({"kind":"emoji","value":"a".repeat(41)}),
        json!({"kind":"emoji","value":"x","color":"#ff880"}),
        json!({"kind":"emoji","value":"x","color":"orange"}),
        json!({"kind":"emoji","value":"x","colour":"#ff8800"}),
        json!({"kind":"emoji","value":"x","extra":1}),
        json!("🚀"),
        json!(7),
    ] {
        assert_eq!(dispatch(&st, "project.icon.set", json!({"projectId":id,"icon":bad.clone()})).await.unwrap_err().1.code, "invalid_argument", "{bad}");
    }
    assert_eq!(st.db.project_get(&id).unwrap()["overrides"]["icon"]["value"].as_str().unwrap().len(), 40, "a refused write changes nothing");
    // Null clears it, and the key leaves the DTO again.
    while events.try_recv().is_ok() {}
    let cleared = dispatch(&st, "project.icon.set", json!({"projectId":id,"icon":null})).await.unwrap();
    assert!(cleared["project"]["overrides"].get("icon").is_none(), "no icon means the five usual keys");
    assert!(events.recv().await.unwrap().payload["project"]["overrides"].get("icon").is_none());
    // An unknown project is `not_found`; a missing id or a missing icon is `invalid_argument`.
    assert_eq!(dispatch(&st, "project.icon.set", json!({"projectId":"nope","icon":null})).await.unwrap_err().1.code, "not_found");
    assert_eq!(dispatch(&st, "project.icon.set", json!({"icon":null})).await.unwrap_err().1.code, "invalid_argument");
    assert_eq!(dispatch(&st, "project.icon.set", json!({"projectId":id})).await.unwrap_err().1.code, "invalid_argument", "an icon is always named: null clears it");
}

#[tokio::test]
async fn a_settings_save_keeps_the_icon_and_refuses_one_passed_in() {
    let (st, _) = state();
    let (id, _) = with_icon(&st, "Icon save", json!({"kind":"lucide","value":"rocket","color":"#123456"})).await;
    // A settings save keeps it, exactly as it keeps the stored trust in a `.bitbots.json`.
    let updated = dispatch(&st, "project.update", json!({"projectId":id,"overrides":{"setupScript":"echo hi","copyFiles":["note.txt"],"initSubmodules":true}})).await.unwrap();
    assert_eq!(updated["project"]["overrides"]["icon"], json!({"kind":"lucide","value":"rocket","color":"#123456"}));
    assert_eq!(updated["project"]["overrides"]["setupScript"], "echo hi");
    // A rename keeps it too.
    assert_eq!(dispatch(&st, "project.update", json!({"projectId":id,"name":"Renamed"})).await.unwrap()["project"]["overrides"]["icon"]["value"], "rocket");
    // But a save may not set, change or clear it.
    assert_eq!(dispatch(&st, "project.update", json!({"projectId":id,"overrides":{"icon":{"kind":"emoji","value":"🚀"}}})).await.unwrap_err().1.code, "invalid_argument");
    assert_eq!(st.db.project_get(&id).unwrap()["overrides"]["icon"]["value"], "rocket", "a refused save changes nothing");
    // Storage refuses the whole overrides key on its own public path as well.
    assert!(st.db.project_update(&id, &json!({"overrides":{}})).is_err());
}

#[tokio::test]
async fn a_favicon_comes_from_the_projects_own_folder() {
    let (st, _) = state();
    let (id, dir) = real_project(&st, "Favicon");
    assert_eq!(dispatch(&st, "project.favicon", json!({"projectId":id})).await.unwrap(), json!({"found":false}), "a project with no icon file answers empty");
    std::fs::create_dir_all(dir.join("public")).unwrap();
    std::fs::write(dir.join("public/favicon.svg"), "<svg/>").unwrap();
    let found = dispatch(&st, "project.favicon", json!({"projectId":id})).await.unwrap();
    assert_eq!((found["found"].clone(), found["path"].clone(), found["mime"].clone()), (json!(true), json!("public/favicon.svg"), json!("image/svg+xml")));
    use base64::Engine as _;
    assert_eq!(base64::engine::general_purpose::STANDARD.decode(found["dataBase64"].as_str().unwrap()).unwrap(), b"<svg/>");
    // The list is an order: a favicon at the root wins over `public/`.
    std::fs::write(dir.join("favicon.ico"), b"ico").unwrap();
    let root = dispatch(&st, "project.favicon", json!({"projectId":id})).await.unwrap();
    assert_eq!((root["path"].clone(), root["mime"].clone()), (json!("favicon.ico"), json!("image/x-icon")));
    // A file over 256 KiB is skipped, not read.
    std::fs::write(dir.join("favicon.ico"), vec![b'x'; 256 * 1024 + 1]).unwrap();
    assert_eq!(dispatch(&st, "project.favicon", json!({"projectId":id})).await.unwrap()["path"], "public/favicon.svg");
    // A project with no folder, an unknown project and a missing id.
    let bare = st.db.project_create("Bare", None).unwrap().0;
    assert_eq!(dispatch(&st, "project.favicon", json!({"projectId":bare["id"]})).await.unwrap(), json!({"found":false}));
    assert_eq!(dispatch(&st, "project.favicon", json!({"projectId":"nope"})).await.unwrap(), json!({"found":false}));
    assert_eq!(dispatch(&st, "project.favicon", json!({})).await.unwrap_err().1.code, "invalid_argument");
}

/// The rule the link test cannot always reach on Windows: creating a link needs a privilege, but the
/// comparison it feeds does not.
#[test]
fn a_resolved_file_must_stay_inside_the_project_folder() {
    let root = Path::new(r"C:\work\shop");
    assert!(crate::project_icon::stays_inside(root, Path::new(r"C:\work\shop\public\favicon.svg")));
    assert!(crate::project_icon::stays_inside(root, Path::new(r"C:\work\shop")));
    assert!(!crate::project_icon::stays_inside(root, Path::new(r"C:\work\shop-two\favicon.svg")), "a folder whose name starts the same is outside");
    assert!(!crate::project_icon::stays_inside(root, Path::new(r"C:\Users\Someone\secret.svg")));
    assert!(!crate::project_icon::stays_inside(root, Path::new(r"C:\work")));
}

#[tokio::test]
async fn a_favicon_link_that_leaves_the_project_is_refused() {
    let (st, _) = state();
    let (id, dir) = real_project(&st, "Favicon link");
    let outside = std::env::temp_dir().join(format!("bitbots-icon-outside-{}.svg", Uuid::new_v4()));
    std::fs::write(&outside, "<svg>outside</svg>").unwrap();
    // Where the account may make a link, point the project's favicon at a file outside it.
    if std::os::windows::fs::symlink_file(&outside, dir.join("favicon.svg")).is_ok() {
        assert_eq!(dispatch(&st, "project.favicon", json!({"projectId":id})).await.unwrap(), json!({"found":false}), "a link resolving outside the folder is refused");
        // A link that stays inside the folder is read like any other file.
        std::fs::write(dir.join("real.svg"), "<svg>real</svg>").unwrap();
        std::fs::remove_file(dir.join("favicon.svg")).unwrap();
        if std::os::windows::fs::symlink_file(dir.join("real.svg"), dir.join("icon.svg")).is_ok() {
            let inside = dispatch(&st, "project.favicon", json!({"projectId":id})).await.unwrap();
            assert_eq!((inside["found"].clone(), inside["path"].clone()), (json!(true), json!("icon.svg")));
        }
    }
    let _ = std::fs::remove_file(&outside);
}
