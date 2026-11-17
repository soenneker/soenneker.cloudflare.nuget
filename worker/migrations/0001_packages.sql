CREATE TABLE packages (
 id TEXT NOT NULL COLLATE NOCASE,
 version TEXT NOT NULL COLLATE NOCASE,
 object_key TEXT NOT NULL UNIQUE,
 metadata TEXT NOT NULL,
 listed INTEGER NOT NULL DEFAULT 1 CHECK (listed IN (0,1)),
 prerelease INTEGER NOT NULL CHECK (prerelease IN (0,1)),
 semver2 INTEGER NOT NULL CHECK (semver2 IN (0,1)),
 published TEXT NOT NULL,
 search_text TEXT NOT NULL,
 PRIMARY KEY (id, version)
);
CREATE INDEX packages_search ON packages(listed, prerelease, semver2, id);
-- Track uploads before R2 writes so a scheduled sweep can recover abandoned objects.
CREATE TABLE uploads (object_key TEXT PRIMARY KEY, created TEXT NOT NULL, expired INTEGER NOT NULL DEFAULT 0);
CREATE INDEX uploads_created ON uploads(created);
